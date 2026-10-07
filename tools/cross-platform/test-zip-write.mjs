// Independent production-browser interpretation of native ZIP output. Compressed
// byte identity with fflate is not required; paths, bytes, CRCs and limits are.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { readSafeZip } from "../../web/src/project/serialization/deterministicZip.ts";
const manifest = resolve(process.argv[2]);
const cases = JSON.parse(readFileSync(manifest, "utf8"));
for (const row of cases) {
  const bytes = new Uint8Array(
    readFileSync(resolve(dirname(manifest), row.path)),
  );
  assert.equal(bytes.length, row.bytes);
  const files = readSafeZip(bytes, { maxEntries: 70000 });
  if (row.emptyMemberCount) {
    assert.equal(files.size, row.emptyMemberCount);
    for (let i = 0; i < files.size; i++)
      assert.equal(files.get(`member-${String(i).padStart(5, "0")}`).length, 0);
  } else {
    assert.equal(files.size, row.entries.length);
    assert.deepEqual([...files.keys()], row.entries.map((e) => e.path).sort());
    for (const entry of row.entries) {
      const b = files.get(entry.path);
      assert.equal(b.length, entry.bytes);
      assert.equal(createHash("sha256").update(b).digest("hex"), entry.sha256);
    }
  }
  const end = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - 22,
    22,
  );
  assert.equal(end.getUint32(0, true), 0x06054b50);
  // DOS date/time, Unix host and permission fields are checked independently of
  // the Rust encoder and its own decoder, including ZIP64 directory offsets.
  let offset = end.getUint32(16, true);
  if (offset === 0xffffffff) {
    const view = new DataView(bytes.buffer);
    const wide = Number(view.getBigUint64(bytes.length - 22 - 20 + 8, true));
    offset = Number(view.getBigUint64(wide + 48, true));
  }
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < files.size; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint8(offset + 5), 3);
    assert.equal(view.getUint16(offset + 12, true), 0);
    assert.equal(view.getUint16(offset + 14, true), 33);
    assert.equal(view.getUint32(offset + 38, true), 0o644 << 16);
    assert.equal(view.getUint16(offset + 8, true), 0x800);
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
}
console.log(
  `Browser independently verified ${cases.length} native ZIP archives`,
);
