// Independent BBS numeric references from the production browser helpers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  formatNumber,
  formatMeshCoordinate,
  transformMatrix,
  transform3mf,
  matrix4,
} from "../../web/src/project/serialization/bbsNumbers.ts";
const root = new URL("../../", import.meta.url);
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const scratch = new DataView(new ArrayBuffer(8));
const f32 = (bits) => {
  scratch.setUint32(0, bits, true);
  return scratch.getFloat32(0, true);
};
const bits64 = (n) => {
  scratch.setFloat64(0, n, true);
  return scratch.getBigUint64(0, true).toString(16).padStart(16, "0");
};
const f64 = (bits) => {
  scratch.setBigUint64(0, BigInt(`0x${bits}`), true);
  return scratch.getFloat64(0, true);
};
let seed = 0xabbadaba;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
function result(f) {
  try {
    return { text: f() };
  } catch {
    return { error: true };
  }
}
const meshBits = new Set([
  0, 0x80000000, 1, 0x007fffff, 0x00800000, 0x7f7fffff, 0x7f800000, 0xff800000,
  0x7fc00000, 260046848, 1795162112, 1820327936,
]);
for (let exponent = 0; exponent < 255; exponent++)
  for (const fraction of [0, 1, 2, 0x3fffff, 0x400000, 0x7ffffe, 0x7fffff]) {
    const bits = (exponent << 23) | fraction;
    meshBits.add(bits);
    meshBits.add((bits | 0x80000000) >>> 0);
  }
for (let n = 1; n <= 100; n++)
  for (const v of [
    n / 2,
    n / 4,
    n / 8,
    n / 16,
    n / 32,
    n / 64,
    n / 128,
    n / 256,
  ]) {
    scratch.setFloat32(0, v, true);
    meshBits.add(scratch.getUint32(0, true));
    meshBits.add((scratch.getUint32(0, true) | 0x80000000) >>> 0);
  }
const mesh = [...meshBits].map((bits) => ({
  bits,
  ...result(() => formatMeshCoordinate(f32(bits))),
}));
// Fixed enumeration and digest keep broad rounding coverage out of giant JSON.
const digest = createHash("sha256");
let count = 0;
const sample = (bits) => {
  const n = f32(bits);
  if (!Number.isFinite(n)) return;
  digest.update(`${bits} ${formatMeshCoordinate(n)}\n`);
  count++;
};
for (let exponent = 0; exponent < 255; exponent++)
  for (let fraction = 0; fraction < 32768; fraction++)
    sample((exponent << 23) | (fraction << 8));
for (let i = 0; i < 1_000_000; i++) sample(random());
const scan = {
  latticeExponents: 255,
  latticeFractions: 32768,
  latticeShift: 8,
  seed: 0xabbadaba,
  randomCount: 1_000_000,
  count,
  sha256: digest.digest("hex"),
};
const doubles = [
  0,
  -0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Infinity,
  -Infinity,
  NaN,
];
for (let e = -308; e <= 308; e++)
  for (const v of [10 ** e, -(10 ** e), 1.234567890123456 * 10 ** e])
    doubles.push(v);
for (let i = 0; i < 1024; i++)
  doubles.push(
    f64(
      random().toString(16).padStart(8, "0") +
        random().toString(16).padStart(8, "0"),
    ),
  );
const numbers = doubles.map((n) => ({
  bits: bits64(n),
  ...result(() => formatNumber(n)),
}));
const transforms = [];
const make = (
  rotation = [0, 0, 0, 1],
  scale = [1, 1, 1],
  translationMm = [0, 0, 0],
  offset = [0, 0],
) => {
  const t = { rotation, scale, translationMm };
  const v = {
    rotation: rotation.map(bits64),
    scale: scale.map(bits64),
    translation: translationMm.map(bits64),
    offset: offset.map(bits64),
  };
  try {
    v.matrix = transformMatrix(t, { x: offset[0], y: offset[1] }).map(bits64);
    v.three = transform3mf(t, { x: offset[0], y: offset[1] });
    v.four = matrix4(t);
  } catch {
    delete v.matrix;
    v.error = true;
  }
  const norm = Math.hypot(...rotation);
  if (!Number.isFinite(norm) || norm === 0) v.nativeRotationRefusal = true;
  transforms.push(v);
};
make();
make([0, 0, 0, -1], [-1, 2, -3], [-0, -0, -0], [-0, -0]);
for (const q of [
  [0, 0, 0, 0],
  [1e-300, 2e-300, 3e-300, 4e-300],
  [1e300, 2e300, 3e300, 4e300],
  [1e308, 1e308, 1e308, 1e308],
  [Number.MIN_VALUE, 0, 0, 0],
])
  make(q);
for (const q of [
  [1, 1, 1, 1],
  [1, 2, 3, 4],
  [0.1, 0.2, 0.3, 0.4],
  [0, 1, 0, 1],
  [1, 0, 1, 0],
])
  for (const scale of [
    [1, 1, 1],
    [-1, 2, 3],
    [1e308, 1e308, 1e308],
  ])
    make(q, scale, [1e308, 1, 2], [1e308, 0]);
for (let i = 0; i < 2048; i++) {
  const v = () => (random() / 2 ** 32 - 0.5) * 2 ** ((random() % 200) - 100);
  make([v(), v(), v(), v()], [v(), v(), v()], [v(), v(), v()], [v(), v()]);
}
const patternBits = [
  0, 0x80000000, 0x3eaaaaab, 0xc1ce3475, 260046848, 1795162112, 1820327936,
  0x007fffff, 0x7f7fffff, 0x3f800000, 0x00800000,
];
const vertexHash = createHash("sha256");
let vertexBytes = 0;
const vertexCount = 2_000_000;
for (let i = 0; i < vertexCount; i++) {
  const xyz = [0, 1, 2].map((axis) =>
    formatMeshCoordinate(f32(patternBits[(i * 3 + axis) % patternBits.length])),
  );
  const row = `     <vertex x="${xyz[0]}" y="${xyz[1]}" z="${xyz[2]}"/>\n`;
  vertexHash.update(row);
  vertexBytes += Buffer.byteLength(row);
}
const vertices = {
  count: vertexCount,
  patternBits,
  bytes: vertexBytes,
  sha256: vertexHash.digest("hex"),
};
const sources = [
  "web/src/project/serialization/bbsNumbers.ts",
  "web/src/project/domain/model.ts",
];
const value = {
  version: 1,
  sources: Object.fromEntries(
    sources.map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(new URL(p, root)))
        .digest("hex"),
    ]),
  ),
  mesh,
  scan,
  numbers,
  transforms,
  vertices,
};
const output = JSON.stringify(value, null, 2) + "\n";
const path = new URL("testdata/cross-platform/bbs-number-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "BBS number references are stale",
  );
console.log(
  `BBS numbers: ${mesh.length} coordinates, ${count} scanned, ${numbers.length} doubles, ${transforms.length} transforms`,
);
