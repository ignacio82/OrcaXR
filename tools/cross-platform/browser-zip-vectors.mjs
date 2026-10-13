// The browser's compressor as references: fflate 0.8.3's `deflateSync` and
// the deterministic ZIP the production writer (`writeDeterministicZip` in
// deterministicZip.ts) builds with its `zipSync`. The exports that must be the
// browser's file byte for byte (all objects as STLs, the plated 3MF) are
// written by the shared core's port (`orcaxr_archive::fflate`), which replays
// every case. Inputs are recipes both sides expand the same way (a xorshift32
// stream as random, low-entropy, run, periodic, G-code-like text and zero
// bytes), at the lengths where fflate's choices change: its hash width,
// `ceil(1.5 ln n)` bits, steps at e^(2p/3) bytes, a block ends at 7,000 matches or 24,576 symbols unless
// fewer than 424 bytes remain, stored blocks hold 65,535 bytes and matches
// reach 32,767 bytes back. ZIP cases cover the browser's member order
// (UTF-16, array-index names first as a JavaScript object enumerates them),
// stored suffixes in any case, non-ASCII names (fflate's UTF-8 flag),
// `__proto__` and empty members. Each records the output's SHA-256 and length.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "../../web/node_modules/fflate/esm/index.mjs";
import { writeDeterministicZip } from "../../web/src/project/serialization/deterministicZip.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

/** The recipe's bytes; `orcaxr-archive/tests/fflate.rs` expands them identically. */
export function expand({ kind, seed, length, period = 0 }) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  const out = new Uint8Array(length);
  if (kind === "random") for (let i = 0; i < length; i++) out[i] = next() & 255;
  else if (kind === "low") for (let i = 0; i < length; i++) out[i] = next() % 5;
  else if (kind === "runs") {
    let i = 0;
    while (i < length) {
      const value = next() & 255;
      const run = 1 + (next() % 600);
      for (let j = 0; j < run && i < length; j++) out[i++] = value;
    }
  } else if (kind === "periodic") {
    const block = new Uint8Array(period);
    for (let i = 0; i < period; i++) block[i] = next() & 255;
    for (let i = 0; i < length; i++) out[i] = block[i % period];
  } else if (kind === "text") {
    let i = 0;
    while (i < length) {
      const line = `G1 X${next() % 25000} Y${next() % 25000} E${next() % 900}\n`;
      for (let j = 0; j < line.length && i < length; j++) out[i++] = line.charCodeAt(j);
    }
  } else assert.equal(kind, "zeros");
  return out;
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- Deflate --------------------------------------------------------------------------------

// Around every hash-width step (n = e^(2p/3) for p = 12 … 19), stored-block,
// window and block-size boundaries.
const lengths = [
  0, 1, 2, 3, 4, 5, 10, 100, 258, 259, 423, 424, 425, 1000, 2980, 2981, 5806, 5807, 7000, 11308,
  11309, 22026, 22027, 32767, 32768, 32769, 42901, 42902, 65535, 65536, 65537, 83561, 83562, 162754,
  162755, 317003, 317004, 442413, 442414,
];
const deflates = [];
let seed = 0x5eed;
const add = (recipe, level = 6) => {
  const input = expand(recipe);
  const output = deflateSync(input, { level });
  deflates.push({ ...recipe, level, sha256: digest(output), bytes: output.length });
};
for (const kind of ["random", "low", "runs", "text", "zeros"])
  for (const length of lengths) add({ kind, seed: seed++, length });
for (const period of [1, 2, 3, 7, 258, 259, 4096, 32766, 32767, 32768, 32769, 40000])
  add({ kind: "periodic", seed: seed++, length: 120000, period });
for (const kind of ["low", "text", "runs"]) add({ kind, seed: seed++, length: 1_500_000 });
for (const level of [0, 1, 2, 3, 4, 5, 7, 8, 9])
  for (const kind of ["low", "text", "random"]) add({ kind, seed: seed++, length: 70000 }, level);
add({ kind: "zeros", seed: 1, length: 2_000_000 });

// --- Deterministic ZIP ----------------------------------------------------------------------

const zip = (members) => {
  const files = new Map(members.map((m) => [m.path, expand(m)]));
  const output = writeDeterministicZip(files);
  return { members, sha256: digest(output), bytes: output.length };
};
const member = (path, kind, length, extra = {}) => ({ path, kind, seed: seed++, length, ...extra });
const zips = [
  zip([member("model.stl", "low", 5000)]),
  zip([member("only-empty.stl", "zeros", 0)]),
  zip([
    member("b.stl", "text", 30000),
    member("a.stl", "low", 20000),
    member("A.stl", "random", 300),
    member("a_2.stl", "runs", 70000),
  ]),
  zip([
    member("10", "text", 100),
    member("9", "text", 100),
    member("0", "zeros", 10),
    member("01", "low", 50),
    member("4294967294", "low", 10),
    member("4294967295", "low", 10),
    member("+1", "low", 10),
    member("a", "low", 10),
  ]),
  zip([
    member("__proto__", "text", 2000),
    member("_orcx0000", "low", 100),
    member("Metadata/plate_1.png", "random", 4000),
    member("Metadata/plate_1.PNG.txt", "text", 400),
    member("x.PNG", "random", 1000),
    member("y.Zip", "random", 1000),
    member("z.jpeg", "low", 3000),
    member("w.JPG", "low", 3000),
    member("v.webp", "low", 300),
    member("u.mp4", "low", 300),
    member("t.3mf", "text", 300),
    member("png", "text", 300),
  ]),
  zip([
    member("Pièce.stl", "text", 4000),
    member("日本.stl", "low", 4000),
    member("😀.stl", "runs", 4000),
    member("dir/sub/Ünïcode.txt", "text", 100),
    member("Z.stl", "low", 10),
  ]),
  zip([member("big.stl", "low", 600_000), member("periodic.bin", "periodic", 200_000, { period: 32769 })]),
  zip(Array.from({ length: 40 }, (_, i) => member(`part_${i}.stl`, i % 2 ? "low" : "text", 1000 + i * 37))),
];

const sources = [
  "tools/cross-platform/browser-zip-vectors.mjs",
  "web/src/project/serialization/deterministicZip.ts",
  "web/node_modules/fflate/esm/index.mjs",
  "web/node_modules/fflate/package.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: digest(read(path)) })),
      deflates,
      zips,
    },
    null,
    2,
  ) + "\n";
const path = new URL("testdata/cross-platform/browser-zip-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Browser ZIP reference drift");
console.log(`browser zip: ${deflates.length} deflate streams, ${zips.length} archives`);
