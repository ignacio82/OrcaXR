// Independent browser safe-ZIP authority. These are container fixtures, not
// evidence of native canonical/BBS semantic decoding or file-provider behavior.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  zipSync,
  Zip,
  ZipPassThrough,
  ZipDeflate,
} from "../../web/node_modules/fflate/esm/index.mjs";
import {
  readSafeZip,
  writeDeterministicZip,
  validatePackagePath,
} from "../../web/src/project/serialization/deterministicZip.ts";
import { fnv1a64 } from "../../web/src/project/domain/canonical.ts";

const root = new URL("../../", import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enc = new TextEncoder();
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const date = new Date(1980, 0, 1);
const cases = [];
function add(name, bytes, limits = {}) {
  let entries = null;
  try {
    entries = [...readSafeZip(bytes, limits)].map(([path, value]) => ({
      path,
      bytes: value.length,
      sha256: sha(value),
    }));
  } catch {
    /* Refusal is part of the independent reference. */
  }
  cases.push({
    name,
    archiveHex: hex(bytes),
    archiveHash: fnv1a64(bytes),
    limits,
    entries,
  });
}
function locate(bytes, signature) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = [];
  for (let i = 0; i + 4 <= bytes.length; i++)
    if (view.getUint32(i, true) === signature) offsets.push(i);
  return offsets;
}
function mutate(name, original, fn, limits = {}) {
  const bytes = original.slice();
  fn(new DataView(bytes.buffer), bytes);
  add(name, bytes, limits);
}
function streamZip(compressed) {
  const chunks = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    chunks.push(bytes);
  });
  const file = compressed
    ? new ZipDeflate("stream/data.txt", { level: 6 })
    : new ZipPassThrough("stream/data.txt");
  file.mtime = date;
  zip.add(file);
  file.push(enc.encode("streamed member ".repeat(300)), true);
  zip.end();
  return new Uint8Array(Buffer.concat(chunks));
}
function zip64(bytes, mode = "all") {
  assert.equal(locate(bytes, 0x02014b50).length, 1);
  const local = locate(bytes, 0x04034b50)[0],
    central = locate(bytes, 0x02014b50)[0],
    end = locate(bytes, 0x06054b50)[0];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = bytes.slice(
    local + 30,
    local + 30 + v.getUint16(local + 26, true),
  );
  const payload = bytes.slice(local + 30 + name.length, central);
  const originalC = v.getUint32(central + 20, true),
    originalU = v.getUint32(central + 24, true);
  const all = mode === "all";
  const extra = new Uint8Array(all ? 20 : 12),
    ex = new DataView(extra.buffer);
  ex.setUint16(0, 1, true);
  ex.setUint16(2, extra.length - 4, true);
  ex.setBigUint64(
    4,
    BigInt(all || mode === "uncompressed" ? originalU : originalC),
    true,
  );
  if (all) ex.setBigUint64(12, BigInt(originalC), true);
  const lh = bytes.slice(local, local + 30),
    lv = new DataView(lh.buffer);
  lv.setUint16(4, 45, true);
  lv.setUint16(28, extra.length, true);
  if (all || mode === "compressed") lv.setUint32(18, 0xffffffff, true);
  if (all || mode === "uncompressed") lv.setUint32(22, 0xffffffff, true);
  const ch = bytes.slice(central, central + 46),
    cv = new DataView(ch.buffer);
  cv.setUint16(6, 45, true);
  cv.setUint16(30, extra.length, true);
  if (all || mode === "compressed") cv.setUint32(20, 0xffffffff, true);
  if (all || mode === "uncompressed") cv.setUint32(24, 0xffffffff, true);
  const before = Buffer.concat([lh, name, extra, payload]);
  const directory = Buffer.concat([ch, name, extra]);
  const wide = new Uint8Array(56),
    w = new DataView(wide.buffer);
  w.setUint32(0, 0x06064b50, true);
  w.setBigUint64(4, 44n, true);
  w.setUint16(12, 45, true);
  w.setUint16(14, 45, true);
  w.setBigUint64(24, 1n, true);
  w.setBigUint64(32, 1n, true);
  w.setBigUint64(40, BigInt(directory.length), true);
  w.setBigUint64(48, BigInt(before.length), true);
  const locator = new Uint8Array(20),
    l = new DataView(locator.buffer);
  l.setUint32(0, 0x07064b50, true);
  l.setBigUint64(8, BigInt(before.length + directory.length), true);
  l.setUint32(16, 1, true);
  const ending = bytes.slice(end),
    e = new DataView(ending.buffer);
  e.setUint16(8, 0xffff, true);
  e.setUint16(10, 0xffff, true);
  e.setUint32(12, 0xffffffff, true);
  e.setUint32(16, 0xffffffff, true);
  return new Uint8Array(
    Buffer.concat([before, directory, wide, locator, ending]),
  );
}

const basic = writeDeterministicZip(
  new Map([["a.txt", enc.encode("canonical archive payload")]]),
);
const stored = writeDeterministicZip(
  new Map([["mesh.png", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]]),
);
add("deflate", basic);
add(
  "distinct leading BOM names",
  writeDeterministicZip(
    new Map([
      ["a.txt", new Uint8Array([1])],
      ["\ufeffa.txt", new Uint8Array([2])],
      ["\ufeff\ufeffa.txt", new Uint8Array([3])],
      ["__proto__", new Uint8Array([4])],
    ]),
  ),
);
const dishonest = writeDeterministicZip(
  new Map([["payload.txt", new Uint8Array(4096)]]),
);
for (const [size, crc] of [
  [1, 0xd202ef8d],
  [0, 0],
]) {
  mutate(`dishonest expansion prefix ${size}`, dishonest, (v) => {
    const c = locate(dishonest, 0x02014b50)[0];
    v.setUint32(22, size, true);
    v.setUint32(c + 24, size, true);
    v.setUint32(14, crc, true);
    v.setUint32(c + 16, crc, true);
  });
}
add("stored", stored);
add("empty", writeDeterministicZip(new Map()));
add(
  "unicode and directories",
  zipSync({
    "folder/": [new Uint8Array(), { mtime: date }],
    "folder/火🔥.txt": [enc.encode("hello"), { mtime: date }],
  }),
);
const prototype = writeDeterministicZip(
  new Map([["prototype", new Uint8Array([9])]]),
);
mutate("prototype member name", prototype, (_, b) => {
  b.set(enc.encode("__proto__"), 30);
  b.set(enc.encode("__proto__"), locate(prototype, 0x02014b50)[0] + 46);
});
assert.equal(
  hex(writeDeterministicZip(new Map([["__proto__", new Uint8Array([9])]]))),
  cases.find((c) => c.name === "prototype member name").archiveHex,
  "The special-name writer must match independently patched ZIP headers exactly",
);
add("streamed stored descriptor", streamZip(false));
add("streamed deflate descriptor", streamZip(true));
for (const mode of ["all", "compressed", "uncompressed"])
  add(`zip64 ${mode}`, zip64(basic, mode));
const compressed = writeDeterministicZip(
  new Map([["long.txt", enc.encode("abcdefghi".repeat(116_509))]]),
);
add("compression ratio refused", compressed);
add("compression ratio allowed", compressed, { maxCompressionRatio: 2000 });
const short = writeDeterministicZip(
  new Map([["short.txt", new Uint8Array(1 << 20)]]),
);
add("ratio threshold inclusive", short);
for (const path of [
  "../escape",
  "/absolute",
  "C:/drive",
  "a\\b",
  "a//b",
  "a/./b",
  "a/../b",
  "a\u0000b",
  "a\u007fb",
  "a\u001fb",
]) {
  add(
    `unsafe ${JSON.stringify(path)}`,
    zipSync({ [path]: [new Uint8Array([1]), { mtime: date }] }),
  );
}
const central = locate(basic, 0x02014b50)[0],
  end = locate(basic, 0x06054b50)[0];
for (const flags of [1, 0x20, 0x40, 0x2000])
  mutate(`unsupported flags ${flags}`, basic, (v) =>
    v.setUint16(central + 8, flags, true),
  );
mutate("unknown compression", basic, (v) =>
  v.setUint16(central + 10, 99, true),
);
mutate("local flags mismatch", basic, (v) => v.setUint16(6, 8, true));
mutate("local name mismatch", basic, (_, b) => (b[30] ^= 1));
mutate("crc mismatch both headers", stored, (v) => {
  const c = locate(stored, 0x02014b50)[0];
  v.setUint32(14, 0, true);
  v.setUint32(c + 16, 0, true);
});
mutate("central size mismatch", basic, (v) =>
  v.setUint32(central + 24, 999, true),
);
mutate("local offset invalid", basic, (v) =>
  v.setUint32(central + 42, 0xffff_ff00, true),
);
mutate("entry disk invalid", basic, (v) => v.setUint16(central + 34, 1, true));
mutate("multi disk end", basic, (v) => v.setUint16(end + 4, 1, true));
mutate("counts disagree", basic, (v) => v.setUint16(end + 8, 2, true));
mutate("central bounds", basic, (v) => v.setUint32(end + 12, 1, true));
mutate("central signature", basic, (v) => v.setUint32(central, 0, true));
mutate("local signature", basic, (v) => v.setUint32(0, 0, true));
mutate("deflate corrupt", basic, (_, b) => (b[35] = 0xff));
for (const count of [0, 1, 5, 21, 22, 30, basic.length - 1])
  add(`truncated ${count}`, basic.slice(0, count));
for (const [key, value] of Object.entries({
  maxArchiveBytes: basic.length - 1,
  maxEntries: 0,
  maxEntryBytes: 24,
  maxTotalUncompressedBytes: 24,
  maxCompressionRatio: 0.5,
  maxPathBytes: 4,
}))
  add(`limit ${key}`, basic, { [key]: value });
add("exact budget", basic, {
  maxArchiveBytes: basic.length,
  maxEntryBytes: 25,
  maxTotalUncompressedBytes: 25,
  maxPathBytes: 5,
  maxEntries: 1,
});
const z64 = zip64(basic);
for (const [field, at] of [
  ["locator", locate(z64, 0x07064b50)[0]],
  ["record", locate(z64, 0x06064b50)[0]],
])
  mutate(`zip64 corrupt ${field}`, z64, (_, b) => (b[at + 3] = 0));
mutate("zip64 unsafe integer", z64, (v) =>
  v.setBigUint64(locate(z64, 0x06064b50)[0] + 32, 1n << 60n, true),
);
mutate("zip64 missing extra", z64, (v) => v.setUint16(30 + 5, 2, true));
mutate("zip64 short extra", z64, (v) => v.setUint16(30 + 5 + 2, 2, true));
const wideAt = locate(z64, 0x06064b50)[0],
  endAt = locate(z64, 0x06054b50)[0];
mutate("zip64 record size invalid", z64, (v) =>
  v.setBigUint64(wideAt + 4, 0n, true),
);
mutate("zip64 record overlaps locator", z64, (v) =>
  v.setBigUint64(wideAt + 4, 45n, true),
);
mutate("zip64 record disk invalid", z64, (v) =>
  v.setUint32(wideAt + 16, 1, true),
);
mutate("zip64 record central disk invalid", z64, (v) =>
  v.setUint32(wideAt + 20, 1, true),
);
mutate("zip64 classic count disagrees", z64, (v) =>
  v.setUint16(endAt + 10, 2, true),
);
const two = writeDeterministicZip(
  new Map([
    ["one", enc.encode("one")],
    ["two", enc.encode("two")],
  ]),
);
const cs = locate(two, 0x02014b50),
  ls = locate(two, 0x04034b50);
mutate("duplicate paths", two, (_, b) => {
  b.set(enc.encode("one"), ls[1] + 30);
  b.set(enc.encode("one"), cs[1] + 46);
});
add("entry count budget", two, { maxEntries: 1 });
add("aggregate budget", two, { maxTotalUncompressedBytes: 5 });
const reversed = new Uint8Array(
  Buffer.concat([
    two.slice(0, cs[0]),
    two.slice(cs[1], locate(two, 0x06054b50)[0]),
    two.slice(cs[0], cs[1]),
    two.slice(locate(two, 0x06054b50)[0]),
  ]),
);
add("central order differs from local order", reversed);
const inner = writeDeterministicZip(
  new Map([["inner.png", new Uint8Array([1, 2, 3])]]),
);
const innerCentral = locate(inner, 0x02014b50)[0],
  innerEnd = locate(inner, 0x06054b50)[0];
const outer = writeDeterministicZip(
  new Map([["outer.png", inner.slice(0, innerCentral)]]),
);
const outerCentral = locate(outer, 0x02014b50)[0],
  outerEnd = locate(outer, 0x06054b50)[0];
const innerRecord = inner.slice(innerCentral, innerEnd),
  iv = new DataView(innerRecord.buffer);
iv.setUint32(42, 30 + "outer.png".length, true);
const overlapEnd = outer.slice(outerEnd),
  ov = new DataView(overlapEnd.buffer);
ov.setUint16(8, 2, true);
ov.setUint16(10, 2, true);
ov.setUint32(12, outerEnd - outerCentral + innerRecord.length, true);
add(
  "overlapping valid local records",
  new Uint8Array(
    Buffer.concat([outer.slice(0, outerEnd), innerRecord, overlapEnd]),
  ),
);
const ascii = writeDeterministicZip(new Map([["abc", new Uint8Array([1])]])),
  ac = locate(ascii, 0x02014b50)[0];
mutate("invalid utf8 surrogate", ascii, (v, b) => {
  v.setUint16(6, 0x800, true);
  v.setUint16(ac + 8, 0x800, true);
  b.set([0xed, 0xa0, 0x80], 30);
  b.set([0xed, 0xa0, 0x80], ac + 46);
});
mutate("non utf8 high bytes", ascii, (_, b) => {
  b[30] = 0xff;
  b[ac + 46] = 0xff;
});
const bom = writeDeterministicZip(new Map([["bomabc", new Uint8Array([1])]])),
  bc = locate(bom, 0x02014b50)[0];
mutate("leading utf8 bom", bom, (v, b) => {
  v.setUint16(6, 0x800, true);
  v.setUint16(bc + 8, 0x800, true);
  b.set([0xef, 0xbb, 0xbf], 30);
  b.set([0xef, 0xbb, 0xbf], bc + 46);
});

const paths = [];
for (const path of [
  "",
  ".",
  "..",
  "a/b",
  "a:b",
  "%2e%2e/x",
  "A:x",
  "0:x",
  "火/🔥",
  "\ufefftext",
  "a\ud800b",
  "a\udfffb",
  "a\u0080b",
  "a\u007fb",
  "a//b",
]) {
  let accepted = true;
  try {
    validatePackagePath(path);
  } catch {
    accepted = false;
  }
  paths.push({
    units: Array.from({ length: path.length }, (_, i) => path.charCodeAt(i)),
    accepted,
  });
}
const external = [
  "flowrate-test-pass1.3mf",
  "flowrate-test-pass2.3mf",
  "Orca-LinearFlow.3mf",
  "Orca-LinearFlow_fine.3mf",
].map((name) => {
  const path = `web/public/calibration/${name}`,
    bytes = readFileSync(new URL(path, root));
  return {
    path,
    sha256: sha(bytes),
    archiveHash: fnv1a64(bytes),
    entries: [...readSafeZip(bytes)].map(([path, value]) => ({
      path,
      bytes: value.length,
      sha256: sha(value),
    })),
  };
});
const result =
  JSON.stringify({ version: 1, cases, paths, external }, null, 2) + "\n";
for (const name of [
  "dishonest expansion prefix 0",
  "dishonest expansion prefix 1",
  "zip64 record size invalid",
  "zip64 record overlaps locator",
  "zip64 record disk invalid",
  "zip64 record central disk invalid",
  "zip64 classic count disagrees",
]) {
  assert.equal(
    cases.find((c) => c.name === name).entries,
    null,
    `ZIP64 regression: ${name}`,
  );
}
const target = new URL("testdata/cross-platform/archive-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, result);
else
  assert.equal(
    readFileSync(target, "utf8"),
    result,
    "Regenerate archive vectors",
  );
console.log(
  `Verified ${cases.length} browser ZIP cases (${cases.filter((v) => v.entries !== null).length} accepted), ${paths.length} path cases and ${external.length} shipped ZIP64 archives`,
);
