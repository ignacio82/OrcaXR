"""Let the hosted OrcaXR app read this printer's camera.

The printer serves its camera from nginx on port 80 (`/webcam/` proxied to
mjpg-streamer) and answers with no `access-control-*` header at all. That is
fine for Fluidd, which is served from the same origin, and fatal for a page
served from anywhere else: an HTTPS page cannot display a plain-HTTP image at
all, so its only route is reading the bytes, and a cross-origin read without
that header is refused by the browser.

This adds the header, named to specific origins rather than `*`. The camera
takes no credential, so the header does not weaken authentication — but `*`
would let *any* site the operator visits read their printer's camera, and this
is a machine in somebody's home.

Safe to run more than once: it patches nothing it has already patched, keeps a
timestamped backup beside the file, validates with `nginx -t`, and puts the
backup back if that fails.
"""

import base64
import sys

import pexpect

HOST = 'root@192.168.1.228'
PASSWORD = 'snapmaker'

# Origins allowed to read a frame: the hosted app, and a local dev server.
# An OrcaXR page served over plain HTTP needs nothing here — the browser can
# display the camera directly, and only an HTTPS page has to read bytes.
ALLOWED = r"^https?://(orcaxr\.martinez\.fyi|localhost(:[0-9]+)?|127\.0\.0\.1(:[0-9]+)?)$"

# The remote half, run by the printer's own python3. `__ALLOWED__` is filled in
# below rather than by %-formatting, because this text is itself full of the
# %-signs and braces nginx configuration is made of.
REMOTE_TEMPLATE = r"""
import os, re, shutil, subprocess, sys, time

SITE = "/etc/nginx/sites-enabled/fluidd"
MARK = "# OrcaXR: allow named origins to read a frame"

path = os.path.realpath(SITE)
if not os.path.exists(path):
    print("NO-SITE", path)
    sys.exit(2)

source = open(path).read()
if MARK in source:
    print("ALREADY-PRESENT", path)
    sys.exit(0)

block = (
    "\n        " + MARK + "\n"
    "        # The camera takes no credential; this only names which pages may\n"
    "        # read it. Added by OrcaXR's fix-webcam-cors.py.\n"
    "        if ($http_origin ~* '" + __ALLOWED__ + "') {\n"
    "            add_header 'Access-Control-Allow-Origin' $http_origin always;\n"
    "            add_header 'Vary' 'Origin' always;\n"
    "        }\n"
)

patched, count = re.subn(r"(location /webcam[0-9]*/ \{\n)", lambda m: m.group(1) + block, source)
if count == 0:
    print("NO-WEBCAM-LOCATION", path)
    sys.exit(2)

backup = path + ".orcaxr-" + time.strftime("%Y%m%d%H%M%S")
shutil.copy2(path, backup)
open(path, "w").write(patched)

test = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
if test.returncode != 0:
    shutil.copy2(backup, path)
    print("TEST-FAILED-ROLLED-BACK")
    print(test.stderr.strip())
    sys.exit(3)

reload_result = subprocess.run(["nginx", "-s", "reload"], capture_output=True, text=True)
if reload_result.returncode != 0:
    shutil.copy2(backup, path)
    subprocess.run(["nginx", "-s", "reload"], capture_output=True, text=True)
    print("RELOAD-FAILED-ROLLED-BACK")
    print(reload_result.stderr.strip())
    sys.exit(4)

print("PATCHED", count, "location(s); backup at", backup)
"""

REMOTE = REMOTE_TEMPLATE.replace('__ALLOWED__', repr(ALLOWED))


def run() -> None:
    child = pexpect.spawn(
        f'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {HOST}',
        encoding='utf-8',
        timeout=30,
    )
    try:
        child.expect(['[P|p]assword:'])
        child.sendline(PASSWORD)
        child.expect(['# ', r'\$ '])

        # Sent base64-encoded: a heredoc over an interactive shell mangles
        # quoting, and this script is mostly quoting.
        payload = base64.b64encode(REMOTE.encode()).decode()
        child.sendline(f'echo {payload} | base64 -d > /tmp/orcaxr-webcam-cors.py')
        child.expect(['# ', r'\$ '])

        child.sendline('python3 /tmp/orcaxr-webcam-cors.py; echo EXIT=$?')
        child.expect(['# ', r'\$ '], timeout=60)
        print(child.before.strip())

        child.sendline('rm -f /tmp/orcaxr-webcam-cors.py')
        child.expect(['# ', r'\$ '])
        child.sendline('exit')
    except Exception as error:  # noqa: BLE001 - report and fail, whatever went wrong
        print(f'Error: {error}')
        sys.exit(1)


run()
