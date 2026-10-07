// The generated TypeScript archive-policy encoder: exact field capture, refusal
// of every malformed budget, and agreement with the replayed binding policy.
import assert from "node:assert/strict";
import {
  encodeProjectArchiveOptions,
  PROJECT_ARCHIVE,
} from "../../contracts/generated/project-archive.ts";
import { BROWSER_EQUIVALENT_POLICY } from "./archive-wasm-replay.mjs";
const browser = Object.fromEntries(
  PROJECT_ARCHIVE.options.map((k, i) => [k, BROWSER_EQUIVALENT_POLICY[i]]),
);
assert.deepEqual(
  Array.from(encodeProjectArchiveOptions(browser)),
  BROWSER_EQUIVALENT_POLICY,
);
const fields = Object.fromEntries(PROJECT_ARCHIVE.options.map((k) => [k, 1]));
assert.deepEqual(
  Array.from(encodeProjectArchiveOptions(fields)),
  Array(PROJECT_ARCHIVE.options.length).fill(1),
);
for (const key of PROJECT_ARCHIVE.options)
  for (const value of [0, -1, 0.5, NaN, Infinity, 4294967296, "1", null, undefined])
    assert.throws(() => encodeProjectArchiveOptions({ ...fields, [key]: value }));
for (const key of PROJECT_ARCHIVE.options) {
  const missing = { ...fields };
  delete missing[key];
  assert.throws(() => encodeProjectArchiveOptions(missing));
}
assert.throws(() => encodeProjectArchiveOptions({ ...fields, unknown: 1 }));
assert.throws(() => encodeProjectArchiveOptions({ ...fields, [Symbol("unknown")]: 1 }));
// Per-item caps never exceed their totals.
assert.throws(() => encodeProjectArchiveOptions({ ...fields, entryBytes: 2 }));
assert.throws(() => encodeProjectArchiveOptions({ ...fields, assetBytes: 2 }));
let invoked = 0;
const getter = { ...fields };
Object.defineProperty(getter, "records", {
  enumerable: true,
  get() {
    invoked++;
    return 1;
  },
});
assert.throws(() => encodeProjectArchiveOptions(getter));
assert.equal(invoked, 0);
const boundary = { ...fields, archiveBytes: 4294967295 };
const encoded = encodeProjectArchiveOptions(boundary);
boundary.archiveBytes = 0;
assert.equal(encoded[0], 4294967295);
console.log("Project archive option bounds and browser-equivalent policy pass");
