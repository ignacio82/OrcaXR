// Bit-exact references for the ECMAScript `Math` functions the native core
// reproduces (`orcaxr_project::js_math`): sin and cos (V8's vendored glibc),
// exp (fdlibm) and hypot (V8's scaled, compensated sum). Inputs cover every
// range-reduction branch of the trig routines, their thresholds, signed zeros,
// non-finite values and seeded random doubles across magnitudes. Values are
// IEEE-754 bit patterns in hex, so no decimal parsing sits between V8 and Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const scratch = new Float64Array(1);
const words = new BigUint64Array(scratch.buffer);
const bits = (value) => {
  scratch[0] = value;
  return words[0].toString(16).padStart(16, "0");
};
const fromBits = (hex) => {
  words[0] = BigInt(`0x${hex}`);
  return scratch[0];
};

// xorshift64*, seeded: the corpus is reproducible on any engine.
let state = 0x9e3779b97f4a7c15n;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const unit = () => Number(next() >> 11n) / 2 ** 53;
const uniform = (low, high) => low + (high - low) * unit();
const logUniform = (low, high) => Math.exp(uniform(Math.log(low), Math.log(high))) * (unit() < 0.5 ? -1 : 1);

const trig = new Set();
const add = (value) => trig.add(bits(value));
for (const value of [0, -0, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE])
  add(value);
// Branch thresholds of glibc_sin/glibc_cos (high words 0x3e400000, 0x3e500000,
// 0x3feb6000, 0x400368fd, 0x419921fb, 0x7ff00000) and their neighbours.
for (const high of [0x3e400000, 0x3e500000, 0x3feb6000, 0x400368fd, 0x419921fb, 0x7fefffff]) {
  for (const low of [0, 1, 0x7fffffff, 0xffffffff]) {
    for (const sign of [0n, 1n << 63n]) {
      const value = fromBits(((sign | (BigInt(high) << 32n) | BigInt(low)) & 0xffffffffffffffffn).toString(16));
      add(value);
      add(fromBits(((BigInt(`0x${bits(value)}`) - 1n) & 0xffffffffffffffffn).toString(16)));
    }
  }
}
// Multiples of pi/2 and of the layer-height cosine band, where reduction is hardest.
for (let k = -64; k <= 64; k += 1) add((k * Math.PI) / 2);
for (let k = 0; k < 400; k += 1) add((2 * Math.PI * (k * 0.1 - 8)) / 3);
for (let i = 0; i < 2500; i += 1) add(uniform(-4, 4));
for (let i = 0; i < 2500; i += 1) add(uniform(-1000, 1000));
for (let i = 0; i < 1500; i += 1) add(uniform(-105414350, 105414350));
for (let i = 0; i < 1500; i += 1) add(logUniform(105414350, 1e308));
for (let i = 0; i < 500; i += 1) add(logUniform(1e-12, 1e-6));
for (let i = 0; i < 1000; i += 1) {
  const value = fromBits(next().toString(16).padStart(16, "0"));
  if (Number.isFinite(value)) add(value);
}
const trigRows = [...trig].sort().map((hex) => {
  const value = fromBits(hex);
  return [hex, bits(Math.sin(value)), bits(Math.cos(value))];
});

const exp = new Set();
for (const value of [0, -0, 1, -1, 709.782712893384, 709.79, -745.13321910194122, -745.2, Infinity, -Infinity, NaN, 1e-300])
  exp.add(bits(value));
for (let i = 0; i < 2000; i += 1) exp.add(bits(uniform(-40, 40)));
for (let i = 0; i < 500; i += 1) exp.add(bits(uniform(-745, 710)));
const expRows = [...exp].sort().map((hex) => [hex, bits(Math.exp(fromBits(hex)))]);

const hypotRows = [];
const hypotCases = [[], [0], [-0, 0], [3, 4], [NaN, Infinity], [NaN, 1], [1e308, 1e308], [1e-320, 1e-320, 1e-320], [-2, 0, 1e-300]];
for (let i = 0; i < 1500; i += 1) {
  const count = 2 + (i % 2);
  hypotCases.push(Array.from({ length: count }, () => (i % 3 === 0 ? logUniform(1e-200, 1e200) : uniform(-100, 100))));
}
for (const args of hypotCases) hypotRows.push([args.map(bits), bits(Math.hypot(...args))]);

const source = "tools/cross-platform/js-math-vectors.mjs";
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: [{ path: source, sha256: createHash("sha256").update(readFileSync(new URL(source, root))).digest("hex") }],
      engine: { node: process.versions.node, v8: process.versions.v8 },
      trig: trigRows,
      exp: expRows,
      hypot: hypotRows,
    },
    null,
    1,
  ) + "\n";
const path = new URL("testdata/cross-platform/js-math-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "JS Math reference drift");
console.log(`JS Math references: ${trigRows.length} sin/cos, ${expRows.length} exp, ${hypotRows.length} hypot (V8 ${process.versions.v8})`);
