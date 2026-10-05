// Independent fixtures from the unchanged browser identifier authority.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  isStableEntityId,
  seededRandom,
  UuidIdSource,
} from "../../web/src/project/domain/ids.ts";

const root = new URL("../../", import.meta.url);
const reference = "web/src/project/domain/ids.ts";
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
};
const uuid = "12345678-9abc-4def-8123-456789abcdef";
const inputs = [
  "",
  uuid,
  uuid.toUpperCase(),
  "import:bbs:object-17",
  "IMPORT:BBS:OBJECT-17",
  "import:a.b_c-d:with:colons",
  "import:0:0",
  "import:a:🐳 café",
  "import:a:🐳漢字",
  "import:a:é",
  "import:a:e\u0301",
  "import:a:\ud800",
  "import:a:\udc00",
  "import:a:\udc00\ud800",
  "import:a:\u0000",
  "import:a:\u0085",
  "import:a:\u180e",
  "import:a:\u200b",
  "import:a:\ufeff",
  "import::x",
  "import:.a:x",
  "import:_a:x",
  "import:-a:x",
  "import:a:",
  "import:é:x",
  "import:K:x",
  "import:ſ:x",
  "import:a/b:x",
  " import:a:x",
  "import:a:x ",
  "import:a:x\n",
  "import:a:x\r\n",
  uuid + "\n",
  uuid + "\r",
  uuid + "\u2028",
  uuid + "\u2029",
  " " + uuid,
  uuid + " ",
  uuid.replaceAll("-", ""),
  "{" + uuid + "}",
  "urn:uuid:" + uuid,
];
for (const position of [0, 7, 8, 13, 14, 18, 19, 23, 35]) {
  for (const character of [
    "0",
    "1",
    "8",
    "9",
    "a",
    "b",
    "c",
    "f",
    "g",
    "-",
    ":",
    "\n",
    "\ud800",
  ])
    inputs.push(uuid.slice(0, position) + character + uuid.slice(position + 1));
}
const cases = [...new Set(inputs)].map((input, index) => ({
  id: `id-${index}`,
  inputUtf16: units(input),
  valid: isStableEntityId(input),
}));
// Exhaust every UTF-16 unit in each distinct imported-ID grammar position.
// Compact accepted/denied sets keep the oracle readable instead of persisting
// 196,608 nearly identical strings. They are derived from the real validator.
const whitespace = [],
  namespaceFirst = [],
  namespaceMiddle = [];
for (let code = 0; code <= 65535; code++) {
  const value = String.fromCharCode(code);
  if (!isStableEntityId(`import:a:x${value}y`)) whitespace.push(code);
  if (isStableEntityId(`import:${value}:x`)) namespaceFirst.push(code);
  if (isStableEntityId(`import:a${value}b:x`)) namespaceMiddle.push(code);
}
assert.equal(whitespace.includes(0x85), false);
assert.equal(whitespace.includes(0xfeff), true);
assert.equal(isStableEntityId("import:a:\ud800"), true);
assert.equal(isStableEntityId(uuid + "\n"), false);
const uuidUnits = units(uuid);
const uuidReplacements = uuidUnits.map((_, position) => {
  const accepted = [];
  for (let code = 0; code <= 65535; code++) {
    if (
      isStableEntityId(
        uuid.slice(0, position) +
          String.fromCharCode(code) +
          uuid.slice(position + 1),
      )
    )
      accepted.push(code);
  }
  return accepted;
});
const longId = {
  prefixUtf16: units("import:a:"),
  repeatedUnit: 120,
  repeatCount: 65536,
  valid: isStableEntityId("import:a:" + "x".repeat(65536)),
};
const seeds = [
  0,
  -0,
  1,
  42,
  0x9e3779b9,
  0xffffffff,
  0x100000000,
  0x100000001,
  -1,
  -1.5,
  1.5,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  9007199254740991,
  9007199254740992,
  NaN,
  Infinity,
  -Infinity,
];
const seeded = seeds.map((seed) => {
  const random = seededRandom(seed);
  const source = new UuidIdSource(seededRandom(seed));
  return {
    seedBits: bits(seed),
    wordBits: Array.from({ length: 64 }, () => bits(random())),
    uuids: Array.from({ length: 16 }, () => source.next("plate")),
  };
});
const injected = [
  Array(16).fill(0),
  Array(16).fill(1 - Number.EPSILON),
  [
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    1,
    -1,
    1.5,
    -1.5,
    2 ** 53,
    -(2 ** 53),
    Number.MAX_VALUE,
    1 / 256,
    -1 / 256,
  ],
  Array.from({ length: 16 }, (_, i) => (i - 8) / 17),
].map((words) => {
  let calls = 0;
  const source = new UuidIdSource(() => words[calls++]);
  const value = source.next("object");
  assert.equal(calls, 16);
  return { wordBits: words.map(bits), uuid: value };
});
assert.equal(injected[0].uuid, "00000000-0000-4000-8000-000000000000");
assert.equal(injected[1].uuid, "ffffffff-ffff-4fff-bfff-ffffffffffff");
assert.equal(
  seeded.find((row) => row.seedBits === bits(42)).uuids[0],
  "00a91cd9-e055-4d90-b93f-b2c9b6427440",
);
const orderedValidIds = cases
  .filter((row) => row.valid)
  .toSorted((left, right) => {
    const a = String.fromCharCode(...left.inputUtf16),
      b = String.fromCharCode(...right.inputUtf16);
    return a < b ? -1 : a > b ? 1 : 0;
  })
  .map((row) => row.id);
const output = {
  schemaVersion: 1,
  reference,
  referenceSha256: createHash("sha256")
    .update(readFileSync(new URL(reference, root)))
    .digest("hex"),
  provenance:
    "Synthetic identifiers and numeric sources; no user data. UTF-16 units preserve malformed surrogates.",
  cases,
  orderedValidIds,
  exhaustive: {
    whitespace,
    namespaceFirst,
    namespaceMiddle,
    uuidUnits,
    uuidReplacements,
  },
  longId,
  seeded,
  injected,
};
const target = new URL("testdata/cross-platform/project-id-vectors.json", root);
const content = JSON.stringify(output, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(target, content);
else
  assert.equal(
    readFileSync(target, "utf8"),
    content,
    "Project identifier reference vectors drifted",
  );
console.log(
  `Verified ${cases.length} IDs, 2555904 grammar probes, ${seeded.length} seeded streams and ${injected.length} injected UUID streams`,
);
