// Bit-exact references for the ECMAScript `Math` functions the native core
// reproduces (`orcaxr_project::js_math`): sin and cos (V8's vendored glibc),
// tan, exp, acos, asin, atan2, pow and cbrt (fdlibm), hypot (V8's scaled, compensated
// sum) and round. Inputs cover every range-reduction branch of the trig routines, their thresholds, signed zeros,
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

// acos: its |x| >= 1, 0.5 and 2**-57 thresholds and neighbours, both signs,
// out-of-domain and non-finite inputs, the tails near ±1 and seeded doubles.
const acos = new Set();
for (const value of [0, -0, 1, -1, 0.5, -0.5, 1 + Number.EPSILON, -1 - Number.EPSILON, 2, -2, Infinity, -Infinity, NaN])
  acos.add(bits(value));
for (const high of [0x3c600000, 0x3fe00000, 0x3fefffff]) {
  for (const low of [0, 1, 0x7fffffff, 0xffffffff]) {
    for (const sign of [0n, 1n << 63n]) {
      const value = fromBits(((sign | (BigInt(high) << 32n) | BigInt(low)) & 0xffffffffffffffffn).toString(16));
      acos.add(bits(value));
      acos.add(((BigInt(`0x${bits(value)}`) - 1n) & 0xffffffffffffffffn).toString(16).padStart(16, "0"));
    }
  }
}
for (let i = 0; i < 3000; i += 1) acos.add(bits(uniform(-1, 1)));
for (let i = 0; i < 500; i += 1) acos.add(bits((1 - Math.abs(logUniform(1e-16, 1e-2))) * (unit() < 0.5 ? -1 : 1)));
for (let i = 0; i < 300; i += 1) acos.add(bits(logUniform(1e-20, 1e-6)));
const acosRows = [...acos].sort().map((hex) => [hex, bits(Math.acos(fromBits(hex)))]);

// round: ties both ways, the largest double below one half, signed zeros,
// the integer-spacing edge at 2**52 and seeded values on and near halves.
const round = new Set();
for (const value of [0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, -0.49999999999999994, -0.4, 2 ** 52, 2 ** 52 + 1, -(2 ** 52) - 1, 2 ** 53, 1e300, -1e300, Infinity, -Infinity, NaN])
  round.add(bits(value));
for (let i = 0; i < 1000; i += 1) round.add(bits(uniform(-1e4, 1e4)));
for (let i = 0; i < 500; i += 1) round.add(bits(Math.trunc(uniform(-1e6, 1e6)) + 0.5));
for (let i = 0; i < 500; i += 1) round.add(bits(uniform(-4, 4) * 1e6));
const roundRows = [...round].sort().map((hex) => [hex, bits(Math.round(fromBits(hex)))]);

const hypotRows = [];
const hypotCases = [[], [0], [-0, 0], [3, 4], [NaN, Infinity], [NaN, 1], [1e308, 1e308], [1e-320, 1e-320, 1e-320], [-2, 0, 1e-300]];
for (let i = 0; i < 1500; i += 1) {
  const count = 2 + (i % 2);
  hypotCases.push(Array.from({ length: count }, () => (i % 3 === 0 ? logUniform(1e-200, 1e200) : uniform(-100, 100))));
}
for (const args of hypotCases) hypotRows.push([args.map(bits), bits(Math.hypot(...args))]);

// tan, drawn after the others so their seeded inputs stay as they were:
// __kernel_tan's 2**-28 and 0.6744 thresholds, pi/4 and the reduction
// threshold with neighbours, multiples of pi/4, the skew angles an SVG
// transform produces (degrees * pi / 180) and seeded doubles.
const tan = new Set();
for (const value of [0, -0, Infinity, -Infinity, NaN, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Math.PI / 2, -Math.PI / 2])
  tan.add(bits(value));
for (const high of [0x3e300000, 0x3fe59428, 0x3fe921fb, 0x400921fb, 0x413921fb, 0x7fefffff]) {
  for (const low of [0, 1, 0x54442d18, 0x7fffffff, 0xffffffff]) {
    for (const sign of [0n, 1n << 63n]) {
      const value = fromBits(((sign | (BigInt(high) << 32n) | BigInt(low)) & 0xffffffffffffffffn).toString(16));
      tan.add(bits(value));
      tan.add(((BigInt(`0x${bits(value)}`) - 1n) & 0xffffffffffffffffn).toString(16).padStart(16, "0"));
    }
  }
}
for (let k = -64; k <= 64; k += 1) tan.add(bits((k * Math.PI) / 4));
for (let degrees = -720; degrees <= 720; degrees += 0.25) tan.add(bits((degrees * Math.PI) / 180));
for (let i = 0; i < 2000; i += 1) tan.add(bits(uniform(-4, 4)));
for (let i = 0; i < 1000; i += 1) tan.add(bits(uniform(-1000, 1000)));
for (let i = 0; i < 500; i += 1) tan.add(bits(logUniform(1e-20, 1e-6)));
for (let i = 0; i < 500; i += 1) tan.add(bits(logUniform(1e3, 1e308)));
const tanRows = [...tan].sort().map((hex) => [hex, bits(Math.tan(fromBits(hex)))]);

// asin and atan2 (three's Euler.setFromRotationMatrix), drawn last so the
// inputs above stay as they were: asin's 2**-27, 0.5 and 0.975 thresholds
// with neighbours, ±1 and beyond, the tails near ±1 and seeded doubles;
// atan2's signed zeros, infinities and NaN in either place, x = 1 (plain
// atan), every argument-reduction band of atan, |y/x| beyond 2**60 both
// ways, rotation-matrix-sized pairs and seeded pairs across magnitudes.
const asin = new Set();
for (const value of [0, -0, 1, -1, 0.5, -0.5, 0.975, -0.975, 1 + Number.EPSILON, -1 - Number.EPSILON, 2, Infinity, -Infinity, NaN])
  asin.add(bits(value));
for (const high of [0x3e400000, 0x3fe00000, 0x3fef3333, 0x3fefffff]) {
  for (const low of [0, 1, 0x33333333, 0x7fffffff, 0xffffffff]) {
    for (const sign of [0n, 1n << 63n]) {
      const value = fromBits(((sign | (BigInt(high) << 32n) | BigInt(low)) & 0xffffffffffffffffn).toString(16));
      asin.add(bits(value));
      asin.add(((BigInt(`0x${bits(value)}`) - 1n) & 0xffffffffffffffffn).toString(16).padStart(16, "0"));
    }
  }
}
for (let i = 0; i < 3000; i += 1) asin.add(bits(uniform(-1, 1)));
for (let i = 0; i < 500; i += 1) asin.add(bits((1 - Math.abs(logUniform(1e-16, 1e-2))) * (unit() < 0.5 ? -1 : 1)));
for (let i = 0; i < 300; i += 1) asin.add(bits(logUniform(1e-20, 1e-6)));
const asinRows = [...asin].sort().map((hex) => [hex, bits(Math.asin(fromBits(hex)))]);

const atan2Rows = [];
const atan2Cases = [];
const specials = [0, -0, 1, -1, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MAX_VALUE, 0.5];
for (const y of specials) for (const x of specials) atan2Cases.push([y, x]);
// atan's reduction bands: |t| below 2**-29, 0.4375, 0.6875, 1.1875, 2.4375 and 2**66.
for (const t of [1e-10, 0.3, 0.4375, 0.5, 0.6875, 0.9, 1.1875, 2, 2.4375, 10, 2 ** 66, 1e30]) {
  atan2Cases.push([t, 1], [-t, 1], [t, -1], [-t, -1], [1, t], [-1, -t]);
}
for (const [y, x] of [[1e30, 1e-40], [-1e30, -1e-40], [1e-40, -1e30], [-1e-40, -1e30], [1e-40, 1e30], [2 ** 61, 1], [2 ** 61, -1], [1, -(2 ** 61)]])
  atan2Cases.push([y, x]);
for (let i = 0; i < 2000; i += 1) atan2Cases.push([uniform(-1, 1), uniform(-1, 1)]);
for (let i = 0; i < 1000; i += 1) atan2Cases.push([logUniform(1e-200, 1e200), logUniform(1e-200, 1e200)]);
for (let i = 0; i < 500; i += 1) atan2Cases.push([uniform(-1, 1), 1]);
for (const [y, x] of atan2Cases) atan2Rows.push([[bits(y), bits(x)], bits(Math.atan2(y, x))]);

// pow and cbrt (the ΔE2000 and sRGB→Lab of the Match search), drawn after
// the others: the exponents ΔE2000 and the sRGB gamma use (7, 2, 2.4) over
// their ranges, y = ±1, 0.5 and ±0, x near 1 (the |y| > 2³¹ path), signed
// zeros, infinities and NaN in either place, negative x with odd, even and
// fractional y, overflow and underflow edges and subnormal results, and
// seeded pairs across magnitudes; cbrt over its subnormal, zero and
// non-finite inputs and seeded doubles of both signs.
const powCases = [];
const powSpecials = [0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, Infinity, -Infinity, NaN, Number.MIN_VALUE, Number.MAX_VALUE, 1 + Number.EPSILON, 1 - Number.EPSILON / 2];
for (const x of powSpecials) for (const y of powSpecials) powCases.push([x, y]);
for (let i = 0; i < 1500; i += 1) powCases.push([uniform(0, 110), 7]);
for (let i = 0; i < 1500; i += 1) powCases.push([uniform(0.04, 1.06), 2.4]);
for (let i = 0; i < 500; i += 1) powCases.push([uniform(-200, 200), 2]);
for (let i = 0; i < 500; i += 1) powCases.push([logUniform(1e-300, 1e300), 0.5]);
for (let i = 0; i < 500; i += 1) powCases.push([uniform(-5, 5), Math.floor(uniform(-40, 40))]);
for (let i = 0; i < 300; i += 1) powCases.push([1 + uniform(-1e-7, 1e-7), logUniform(2 ** 31, 2 ** 70)]);
for (let i = 0; i < 300; i += 1) powCases.push([uniform(0.5, 2), uniform(-1100, 1100)]);
for (const [x, y] of [[2, 1023], [2, 1024], [2, -1074], [2, -1075], [2, -1022.5], [10, 308.25], [10, -323.5], [0.5, 1074.5], [-2, 1025], [-2, -1075]])
  powCases.push([x, y]);
for (let i = 0; i < 2000; i += 1) powCases.push([logUniform(1e-20, 1e20), uniform(-30, 30)]);
for (let i = 0; i < 300; i += 1) powCases.push([fromBits((next() & 0x000fffffffffffffn).toString(16).padStart(16, "0")), uniform(-2, 2)]);
const powRows = powCases.map(([x, y]) => [[bits(x), bits(y)], bits(Math.pow(x, y))]);
const cbrt = new Set();
for (const value of [0, -0, 1, -1, 8, -27, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, 2.2250738585072014e-308])
  cbrt.add(bits(value));
for (let i = 0; i < 2000; i += 1) cbrt.add(bits(uniform(-2, 2)));
for (let i = 0; i < 1500; i += 1) cbrt.add(bits(logUniform(1e-300, 1e300)));
for (let i = 0; i < 300; i += 1) cbrt.add(bits(logUniform(1e-320, 1e-308)));
const cbrtRows = [...cbrt].sort().map((hex) => [hex, bits(Math.cbrt(fromBits(hex)))]);

// Array.prototype.sort with the Match ranking's comparator, which a 1e-6
// tolerance makes intransitive, so only V8's own TimSort leaves the same
// order: lengths across the minimum-run and galloping thresholds, values
// crowded within the tolerance, ascending and descending runs, and the
// order each array is left in (original positions).
const sortRows = [];
for (let round = 0; round < 260; round += 1) {
  const length = round < 70 ? round : Math.floor(uniform(64, 700));
  const shape = round % 5;
  const values = Array.from({ length }, (_, index) => {
    if (shape === 0) return Math.floor(unit() * 20) * 5e-7 + unit() * 1e-7;
    if (shape === 1) return index * 4e-7 + unit() * 3e-7;
    if (shape === 2) return (length - index) * 4e-7 + unit() * 3e-7;
    if (shape === 3) return Math.floor(index / 9) * 2e-6 * (index % 2 ? 1 : -1) + unit() * 9e-7;
    return uniform(0, 50);
  });
  const entries = values.map((value, index) => ({ value, index }));
  entries.sort((left, right) => {
    if (left.value + 1e-6 < right.value) return -1;
    if (right.value + 1e-6 < left.value) return 1;
    return left.index - right.index;
  });
  sortRows.push([values.map(bits), entries.map((entry) => entry.index)]);
}

const source = "tools/cross-platform/js-math-vectors.mjs";
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: [{ path: source, sha256: createHash("sha256").update(readFileSync(new URL(source, root))).digest("hex") }],
      engine: { node: process.versions.node, v8: process.versions.v8 },
      trig: trigRows,
      exp: expRows,
      acos: acosRows,
      tan: tanRows,
      round: roundRows,
      hypot: hypotRows,
      asin: asinRows,
      atan2: atan2Rows,
      pow: powRows,
      cbrt: cbrtRows,
      sort: sortRows,
    },
    null,
    1,
  ) + "\n";
const path = new URL("testdata/cross-platform/js-math-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "JS Math reference drift");
console.log(`JS Math references: ${trigRows.length} sin/cos, ${expRows.length} exp, ${acosRows.length} acos, ${tanRows.length} tan, ${roundRows.length} round, ${hypotRows.length} hypot, ${asinRows.length} asin, ${atan2Rows.length} atan2, ${powRows.length} pow, ${cbrtRows.length} cbrt, ${sortRows.length} sorts (V8 ${process.versions.v8})`);
