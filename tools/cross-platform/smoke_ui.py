"""Driving the app's screens on an explicitly selected emulator through adb and uiautomator.

Shared by the emulator smokes (Device area, Project area, local-network
permission). Every read is a fresh uiautomator dump; a text is looked for by
scrolling the screen's list on to its end and back, and what was seen is
written next to the results when it never shows.
"""
import re
import subprocess
import time
import xml.etree.ElementTree as ET


class Screen:
    def __init__(self, serial, output, name):
        if not re.fullmatch(r"emulator-\d+", serial):
            raise SystemExit("This unattended smoke test only installs on an explicitly selected emulator")
        self.serial = serial
        self.output = output
        self.name = name
        self.dump = f"/data/local/tmp/orcaxr-{name}.xml"

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
            start, end = ("900", "450") if onward else ("450", "900")
            self.adb("shell", "input", "swipe", "360", start, "360", end, "300")
            time.sleep(0.3)
        (self.output / f"{self.name}-smoke-failed.xml").write_text(self.adb("shell", "cat", self.dump))
        (self.output / f"{self.name}-smoke-seen.txt").write_text("\n".join(seen) + "\n")
        raise AssertionError(f"'{text}' never appeared")

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

    def type_into(self, label, value):
        """Focuses the text field labelled [label] and types [value]."""
        field = None
        for node in self.nodes():
            if node.get("class") == "android.widget.EditText" and any(
                (child.get("text") or "") == label for child in node.iter("node")
            ):
                field = node
        if field is None:
            field = self.find(label)
        x, y = self.center(field)
        self.adb("shell", "input", "tap", str(x), str(y))
        self.adb("shell", "input", "text", value.replace(" ", "%s"))
        self.hide_keyboard()

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
