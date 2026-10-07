"""Verify native ZIP payloads and metadata with Python's independent reader."""
from pathlib import Path
import hashlib
import json
import sys
import zipfile

manifest = Path(sys.argv[1]).resolve()
cases = json.loads(manifest.read_text())
for case in cases:
    with zipfile.ZipFile(manifest.parent / case["path"]) as archive:
        if "emptyMemberCount" in case:
            expected = {f"member-{i:05}": (0, hashlib.sha256(b"").hexdigest())
                        for i in range(case["emptyMemberCount"])}
        else:
            expected = {e["path"]: (e["bytes"], e["sha256"]) for e in case["entries"]}
        assert set(archive.namelist()) == set(expected)
        for entry in archive.infolist():
            data = archive.read(entry)
            assert (len(data), hashlib.sha256(data).hexdigest()) == expected[entry.filename]
            assert entry.date_time == (1980, 1, 1, 0, 0, 0)
            assert entry.create_system == 3 and entry.external_attr == 0o644 << 16
            assert entry.flag_bits == 0x800
print(f"Python independently verified {len(cases)} native ZIP archives")
