"""Driving the app's screens on an explicitly selected emulator through adb and uiautomator.

Shared by the emulator smokes (Device area, Project area, local-network
permission). Every read is a fresh uiautomator dump; a text is looked for by
scrolling the screen's list on to its end and back, and what was seen is
written next to the results when it never shows.
"""
import re
import struct
import subprocess
import time
import xml.etree.ElementTree as ET
import zlib


class Screen:
    def __init__(self, serial, output, name):
        if not re.fullmatch(r"emulator-\d+", serial):
            raise SystemExit("This unattended smoke test only installs on an explicitly selected emulator")
        self.serial = serial
        self.output = output
        self.name = name
        self.dump = f"/data/local/tmp/orcaxr-{name}.xml"
        # Where a swipe scrolls when the screen shows no scrolling container: top and bottom y.
        self.scroll = (450, 900)

    def adb(self, *command, timeout=120):
        return subprocess.check_output(["adb", "-s", self.serial, *command], text=True, timeout=timeout).strip()

    def api(self):
        return int(self.adb("shell", "getprop", "ro.build.version.sdk"))

    def nodes(self):
        """The screen's nodes. While a window is being replaced (an activity recreated, say) the
        dump finds no root and writes nothing, and on a loaded emulator the dump itself can fail;
        it is taken again once the new window is up."""
        for attempt in range(10):
            try:
                self.adb("shell", "rm", "-f", self.dump)
                self.adb("shell", "uiautomator", "dump", self.dump)
                return list(ET.fromstring(self.adb("shell", "cat", self.dump)).iter("node"))
            except subprocess.CalledProcessError:
                if attempt == 9:
                    raise
                time.sleep(0.5)

    @staticmethod
    def center(node):
        left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
        return (left + right) // 2, (top + bottom) // 2

    def find(self, text, timeout=120, exact=True):
        """The node showing [text]. Not on screen, the list is searched on down to its end a screen
        at a time, then back up to its start the same way, until the time is up — and in any case
        once down and back, so that [timeout] bounds how long the app may take to show [text], not
        how long a search of a long list takes on a slow emulator. Each screen is dragged (`drag`),
        not flung, so no row is passed over, and what lies just above the screen (a panel's status
        line over the row just acted on) is reached in a few screens rather than after a search down
        from the list's start. Where a list ends is told by the words shown, not the bounds, which
        Android's stretch overscroll keeps moving. (Searching down first spares the system picker's
        pull to refresh.) Lists such as Prepare's run to many screens, so a search takes a while."""
        deadline = time.monotonic() + timeout
        seen = []

        def look():
            current = self.nodes()
            for node in current:
                value = node.get("text") or node.get("content-desc") or ""
                if value == text or (not exact and text in value):
                    return node, current
                if value and value not in seen:
                    seen.append(value)
            return None, current

        def words(nodes):
            # Only what the list scrolls: a status line above it may change every second.
            lists = [node for node in nodes if node.get("scrollable") == "true"]
            if not lists:
                return [node.get("text") or node.get("content-desc") or "" for node in nodes]
            area = lambda node: (lambda b: (b[2] - b[0]) * (b[3] - b[1]))(list(map(int, re.findall(r"\d+", node.get("bounds")))))
            largest = max(lists, key=area)
            return [node.get("text") or node.get("content-desc") or "" for node in largest.iter("node")]

        found, current = look()
        if found is None:
            # A menu or dialog may still be opening: a swipe now would land outside it and close it.
            time.sleep(1.5)
            found, current = look()
        swept = False
        searching = lambda: found is None and (time.monotonic() < deadline or not swept)
        while searching():
            # On down to the end, then back up to the start, a screen at a time, until what shows no
            # longer changes. A drag leaves nothing moving, so the screen is read again at once.
            for down in (True, False):
                while searching():
                    x, top, bottom = self.scroll_band(current, inset=12)
                    self.drag(x, *((bottom, top) if down else (top, bottom)))
                    time.sleep(0.2)
                    before = words(current)
                    found, current = look()
                    if found is None and words(current) == before:
                        break
            swept = True
        if found is not None:
            return found
        (self.output / f"{self.name}-smoke-failed.xml").write_text(self.adb("shell", "cat", self.dump))
        (self.output / f"{self.name}-smoke-seen.txt").write_text("\n".join(seen) + "\n")
        raise AssertionError(f"'{text}' never appeared")

    def scroll_band(self, nodes, inset=6):
        """Where to swipe: inside the largest scrolling container shown (a dialog's own list, or
        the part of a screen that scrolls — never a view beside it that a swipe would turn), as its
        centre x and a top and bottom y inset from its edges by 1/[inset] of its height."""
        containers = []
        for node in nodes:
            if node.get("scrollable") == "true":
                left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
                containers.append(((right - left) * (bottom - top), (left + right) // 2, top, bottom))
        if not containers:
            return 360, *self.scroll
        _, x, top, bottom = max(containers)
        margin = (bottom - top) // inset
        return x, top + margin, bottom - margin

    def lift(self, node, nodes=None):
        """Drags the list holding [node] (the largest scrolling container around it) until [node]
        sits near the list's top, so that what follows it shows — a group's rows, a row's second
        line: `find` stops at the first screen showing its text, which may be the list's last line.
        Without a fling the list moves just that far, or as far as its end allows. Answers the
        screen's nodes afterwards."""
        nodes = self.nodes() if nodes is None else nodes
        bounds = lambda n: tuple(map(int, re.findall(r"\d+", n.get("bounds"))))
        left, top, right, bottom = bounds(node)
        x, y = (left + right) // 2, (top + bottom) // 2
        holders = [b for b in (bounds(n) for n in nodes if n.get("scrollable") == "true")
                   if b[0] <= x <= b[2] and b[1] <= y <= b[3]]
        if not holders:
            return nodes
        list_left, list_top, list_right, list_bottom = max(holders, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        target = list_top + (list_bottom - list_top) // 12
        if top <= list_top + (list_bottom - list_top) // 3:
            return nodes
        self.drag((list_left + list_right) // 2, top, target)
        time.sleep(0.2)
        return self.nodes()

    def drag(self, x, start, end):
        """Drags the screen at [x] from y [start] to [end] and lets go without a fling, so the list
        moves by just that much (less the touch slop). A swipe's release flings it further — a
        quarter as far again for a 300 ms swipe on a phone emulator — and a fling can carry a row
        past the edge of the next screen and out of every dump. Here each touch event is its own
        `input` command, paced (injected unpaced they can arrive out of order and scroll nothing),
        and the finger rests at the end before it lifts, longer than the 100 ms over which a
        velocity is measured, so the list reads it as stopped."""
        events = [f"input motionevent DOWN {x} {start}", f"input motionevent MOVE {x} {(start + end) // 2}",
                  f"input motionevent MOVE {x} {end}", "sleep 0.15", f"input motionevent UP {x} {end}"]
        self.adb("shell", "; sleep 0.05; ".join(events))

    def enabled(self, text, **kwargs):
        """Whether the control showing [text] is enabled: a Compose button reports it on its
        clickable node, not on the text inside, which always reads enabled."""
        self.find(text, **kwargs)
        root = ET.fromstring(self.adb("shell", "cat", self.dump))
        parents = {child: parent for parent in root.iter("node") for child in parent}
        node = next(node for node in root.iter("node") if (node.get("text") or node.get("content-desc") or "") == text)
        while node is not None and node.get("clickable") != "true":
            node = parents.get(node)
        assert node is not None, f"'{text}' is not inside a control"
        return node.get("enabled") == "true"

    def absent(self, text, timeout=20):
        deadline = time.monotonic() + timeout
        while any((node.get("text") or "") == text for node in self.nodes()):
            assert time.monotonic() < deadline, f"'{text}' never went away"
            time.sleep(0.5)

    def tap(self, text, **kwargs):
        x, y = self.center(self.find(text, **kwargs))
        self.adb("shell", "input", "tap", str(x), str(y))

    def key(self, code):
        self.adb("shell", "input", "keyevent", str(code))

    def below_toolbar(self, top):
        """[top], or the first row below the Workspace's model toolbar when the toolbar reaches lower (a
        phone's, under the strip): its buttons change as the core enables them, so a pixel comparison of
        the 3D view leaves the toolbar out. Read while the Workspace shows."""
        for node in self.nodes():
            if (node.get("content-desc") or "") == "Model tools":
                return max(top, int(re.findall(r"\d+", node.get("bounds"))[3]) + 12)
        return top

    def to_top(self):
        """Flings the screen's list back to its first item, inside the list (a bar above it, such as
        Prepare's pinned Slice, takes no swipe), and lets it come to rest: a tap on a list still
        flinging only stops it."""
        x, top, bottom = self.scroll_band(self.nodes())
        for _ in range(6):
            self.adb("shell", "input", "swipe", str(x), str(top), str(x), str(bottom), "100")
        time.sleep(2)

    def hide_keyboard(self):
        """Closes the soft keyboard, which would cover the next field or button. Back closes it; a
        second Back while it is still animating away would dismiss the dialog behind it, so each
        press waits for it to go. A field that commits on Enter closes the keyboard itself, a moment
        later: a Back sent then would reach the screen (and ask to leave the project), so it waits
        that moment first."""
        shown = lambda: "mInputShown=true" in self.adb("shell", "dumpsys", "input_method")
        for _ in range(5):
            settle = time.monotonic() + 1
            while shown() and time.monotonic() < settle:
                time.sleep(0.2)
            if not shown():
                return
            self.key(4)
            deadline = time.monotonic() + 3
            while shown() and time.monotonic() < deadline:
                time.sleep(0.2)
        raise AssertionError("The soft keyboard would not close")

    def field(self, label):
        """The text field labelled [label] (its label is a child node), else the node showing it. A
        field can lie far down a long list (Prepare's runs to many screens with a project's virtual
        filaments), so the search may take a while on a loaded emulator."""
        for node in self.nodes():
            if node.get("class") == "android.widget.EditText" and any(
                (child.get("text") or "") == label for child in node.iter("node")
            ):
                return node
        return self.find(label, timeout=90)

    def type_into(self, label, value):
        """Focuses the field labelled [label] and types [value], checking what landed. Typing
        before the keyboard is connected can drop or misplace the first keys on a slow
        emulator, so it waits for the keyboard, types in short bursts and, when the field
        shows something else (a masked field by its length), clears it and types again."""
        shown = lambda: "mInputShown=true" in self.adb("shell", "dumpsys", "input_method")
        for attempt in range(3):
            x, y = self.center(self.field(label))
            self.adb("shell", "input", "tap", str(x), str(y))
            deadline = time.monotonic() + 3
            while not shown() and time.monotonic() < deadline:
                time.sleep(0.2)
            time.sleep(0.3)
            if attempt:
                # Select everything in the field and delete it before typing again.
                self.adb("shell", "input", "keycombination", "113", "29")
                self.key(67)
            for start in range(0, len(value), 6):
                self.adb("shell", "input", "text", value[start:start + 6].replace(" ", "%s"))
                time.sleep(0.1)
            node = self.field(label)
            typed = node.get("text") or ""
            masked = node.get("password") == "true"
            if (len(typed) == len(value)) if masked else (typed == value):
                self.hide_keyboard()
                return
        raise AssertionError(f"Could not type into '{label}'")

    def focused(self):
        """The window that has the focus, as the window manager reports it."""
        lines = [line for line in self.adb("shell", "dumpsys", "window").splitlines() if "mCurrentFocus=" in line]
        assert lines, "The window manager reported no focus"
        return lines[0]

    def launch(self, package, activity=".MainActivity"):
        """Starts [package] afresh and waits until it has the focus. Retried while the system
        still tears down a task (`pm clear` removes it asynchronously and can swallow a start),
        with the notification shade, which a swipe on the home screen opens, collapsed."""
        for _ in range(5):
            self.adb("shell", "am", "force-stop", package)
            time.sleep(1)
            self.adb("shell", "cmd", "statusbar", "collapse")
            self.adb("shell", "am", "start", "-W", "-n", f"{package}/{activity}")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if package in self.focused():
                    return
                self.adb("shell", "cmd", "statusbar", "collapse")
                time.sleep(0.5)
        raise AssertionError(f"{package} never came to the front")

    def screenshot(self):
        """The screen as (width, height, rows of RGBA bytes), from `screencap`'s PNG."""
        png = subprocess.check_output(["adb", "-s", self.serial, "exec-out", "screencap", "-p"], timeout=60)
        return decode_png(png)


def decode_png(png):
    """A non-interlaced 8-bit RGB or RGBA PNG as (width, height, rows of RGBA bytes): enough for
    `screencap`, without an imaging library on the host."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "Not a PNG"
    at, data, width, height, channels = 8, b"", 0, 0, 4
    while at < len(png):
        length, kind = struct.unpack(">I4s", png[at:at + 8])
        body = png[at + 8:at + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and color in (2, 6) and interlace == 0, "Unsupported PNG layout"
            channels = 4 if color == 6 else 3
        elif kind == b"IDAT":
            data += body
        at += 12 + length
    raw = zlib.decompress(data)
    stride = width * channels
    rows, previous = [], bytearray(stride)
    for y in range(height):
        kind = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + ((left + up) >> 1)) & 0xFF
            elif kind == 4:
                estimate = left + up - corner
                pa, pb, pc = abs(estimate - left), abs(estimate - up), abs(estimate - corner)
                line[x] = (line[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        rows.append(bytes(line) if channels == 4 else bytes(b for i in range(width) for b in (*line[i * 3:i * 3 + 3], 255)))
        previous = line
    return width, height, rows


def bright_pixels(image, left, top, right, bottom, threshold=60):
    """How many pixels in the box are brighter than [threshold] in every channel's mean."""
    _, _, rows = image
    count = 0
    for y in range(top, bottom):
        row = rows[y]
        for x in range(left, right):
            r, g, b = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
            if (r + g + b) / 3 > threshold:
                count += 1
    return count


def changed_pixels(first, second, left, top, right, bottom, delta=40):
    """The pixels in the box whose colour differs by more than [delta] in some channel between two
    screenshots, as a list of (x, y)."""
    _, _, a = first
    _, _, b = second
    changed = []
    for y in range(top, bottom):
        row_a, row_b = a[y], b[y]
        for x in range(left, right):
            at = x * 4
            if (abs(row_a[at] - row_b[at]) > delta or abs(row_a[at + 1] - row_b[at + 1]) > delta
                    or abs(row_a[at + 2] - row_b[at + 2]) > delta):
                changed.append((x, y))
    return changed


def saturated_pixels(image, left, top, right, bottom, spread=60):
    """How many pixels in the box are strongly coloured (channels differing by more than [spread]):
    toolpaths and tinted models, not the grey-blue bed or the dark background."""
    _, _, rows = image
    count = 0
    for y in range(top, bottom):
        row = rows[y]
        for x in range(left, right):
            r, g, b = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
            if max(r, g, b) - min(r, g, b) > spread:
                count += 1
    return count

