// Remembered credentials references from the production browser
// (`RememberedCredentialsExchange.ts` over `RememberedCredentials.ts`): how
// stored records of every shape load (corrupt, hostile, oversized secrets,
// many per-printer keys in any order, ids past their length, the remember
// switch) and the text each record is stored as, or that nothing is. Replayed
// by Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerCredentialsLoad,
  answerCredentialsSave,
} from "../../web/src/settings/RememberedCredentialsExchange.ts";
import { encodeProjectRememberedCredentials } from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));

// Seeded, so the corpus is the same every run.
let seed = 0xc4ed;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

const secrets = [
  "",
  "   ",
  "abc123",
  "  padded-key  ",
  "x".repeat(4096),
  "y".repeat(4097),
  ` ${"z".repeat(4096)} `,
  "ü😀 unicode",
  "x\uD800lone",
  "line\nbreak",
  'quote"and\\slash',
];
const keys = [
  "printer-1",
  "printer-2",
  "2f0c6c2e-1b55-4b3a-9e8c-0a1d2b3c4d5e",
  "10",
  "9",
  "0",
  "01",
  "__proto__",
  "constructor",
  "k".repeat(70),
  `${"k".repeat(64)}tail`,
  "😀".repeat(40),
  "",
];

const records = [];
for (let i = 0; i < 60; i++) {
  const count = pick([0, 0, 1, 2, 5, 40]);
  records.push({
    printerApiKey: units(pick(secrets)),
    printerApiKeys: Array.from({ length: count }, (_, j) => ({
      key: units(
        count > 10 ? `printer-${String(j).padStart(2, "0")}` : pick(keys),
      ),
      // Many keys stay short, so the corpus stays small.
      secret: units(count > 10 ? `secret-${j}` : pick(secrets.slice(1))),
    })),
    slicerToken: units(pick(secrets)),
    remember: random() < 0.85,
  });
}
records.push(
  { printerApiKey: [], printerApiKeys: [], slicerToken: [], remember: true },
  { printerApiKey: [], printerApiKeys: [], slicerToken: [], remember: false },
  {
    printerApiKey: [],
    printerApiKeys: [
      { key: units("printer-1"), secret: units("first") },
      { key: units("printer-1"), secret: units("last wins") },
    ],
    slicerToken: [],
    remember: true,
  },
);
const saves = records.map((record) => ({
  requestJson: encodeProjectRememberedCredentials(record),
  stored: answerCredentialsSave(record),
}));

const storedTexts = [
  null,
  "",
  "not json",
  "null",
  "[]",
  '"text"',
  "{}",
  '{"remember":false}',
  '{"remember":"false"}',
  '{"printerApiKey":42,"slicerToken":null}',
  '{"printerApiKeys":"no"}',
  '{"printerApiKeys":[1,2]}',
  '{"printerApiKeys":{"a":42,"b":"  ok  ","c":""}}',
  '{"printerApiKeys":{"__proto__":"proto","constructor":"ctor"}}',
  '{"printerApiKeys":{"10":"ten","9":"nine","b":"bee","a":"ay"}}',
  '{"printerApiKeys":{"a":"first","a":"last"}}',
  JSON.stringify({
    printerApiKeys: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `printer-${String(39 - i).padStart(2, "0")}`,
        `key-${i}`,
      ]),
    ),
  }),
  JSON.stringify({
    printerApiKeys: {
      [`${"k".repeat(64)}a`]: "first",
      [`${"k".repeat(64)}b`]: "second",
    },
  }),
  ...saves.map((save) => save.stored).filter((stored) => stored !== null),
];
const loads = storedTexts.map((stored) => ({
  stored,
  replyJson: encodeProjectRememberedCredentials(answerCredentialsLoad(stored)),
}));

const sources = [
  "tools/cross-platform/printer-credentials-vectors.mjs",
  "web/src/settings/RememberedCredentialsExchange.ts",
  "web/src/settings/RememberedCredentials.ts",
  "web/src/printer/PrinterWire.ts",
];
const corpus = { loads, saves };
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    ...corpus,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-credentials-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Remembered credentials reference drift",
  );
console.log(
  `Remembered credentials references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
