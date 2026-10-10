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
        # Where a swipe scrolls the list: its top and bottom y. A screen whose upper part
        # does not scroll (Preview's toolpath view) narrows it to the part that does.
        self.scroll = (450, 900)

    def adb(self, *command, timeout=120):
        return subprocess.check_output(["adb", "-s", self.serial, *command], text=True, timeout=timeout).strip()

    def api(self):
        return int(self.adb("shell", "getprop", "ro.build.version.sdk"))

    def nodes(self):
        self.adb("shell", "uiautomator", "dump", self.dump)
        return list(ET.fromstring(self.adb("shell", "cat", self.dump)).iter("node"))

    @staticmethod
    def center(node):
        left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
        return (left + right) // 2, (top + bottom) // 2

    def find(self, text, timeout=20, exact=True):
        """The node showing [text], scrolling the list on to its end (where nothing moves any
        more) and back to its start until it shows."""
        deadline = time.monotonic() + timeout
        onward, placed, seen = True, None, []
        while time.monotonic() < deadline:
            current = self.nodes()
            for node in current:
                value = node.get("text") or node.get("content-desc") or ""
                if value == text or (not exact and text in value):
                    return node
                if value and value not in seen:
                    seen.append(value)
            layout = [node.get("bounds") for node in current]
            if layout == placed:
                onward = not onward
            placed = layout
            top, bottom = self.scroll
            start, end = (bottom, top) if onward else (top, bottom)
            self.adb("shell", "input", "swipe", "360", str(start), "360", str(end), "300")
            time.sleep(0.3)
        (self.output / f"{self.name}-smoke-failed.xml").write_text(self.adb("shell", "cat", self.dump))
        (self.output / f"{self.name}-smoke-seen.txt").write_text("\n".join(seen) + "\n")
        raise AssertionError(f"'{text}' never appeared")

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

    def to_top(self):
        """Flings the screen's list back to its first item."""
        for _ in range(6):
            self.adb("shell", "input", "swipe", "360", "300", "360", "1100", "100")
        time.sleep(0.5)

    def hide_keyboard(self):
        """Closes the soft keyboard, which would cover the next field or button. Back closes it; a
        second Back while it is still animating away would dismiss the dialog behind it, so each
        press waits for it to go."""
        shown = lambda: "mInputShown=true" in self.adb("shell", "dumpsys", "input_method")
        for _ in range(5):
            if not shown():
                return
            self.key(4)
            deadline = time.monotonic() + 3
            while shown() and time.monotonic() < deadline:
                time.sleep(0.2)
        raise AssertionError("The soft keyboard would not close")

    def field(self, label):
        """The text field labelled [label] (its label is a child node), else the node showing it."""
        for node in self.nodes():
            if node.get("class") == "android.widget.EditText" and any(
                (child.get("text") or "") == label for child in node.iter("node")
            ):
                return node
        return self.find(label)

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

