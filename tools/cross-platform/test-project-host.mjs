import assert from "node:assert/strict";
import {
  encodeProjectHostOptions,
  PROJECT_HOST,
} from "../../contracts/generated/project-host.ts";
const fields = Object.fromEntries(PROJECT_HOST.options.map((k) => [k, 1]));
assert.deepEqual(
  Array.from(encodeProjectHostOptions(fields)),
  Array(10).fill(1),
);
for (const key of PROJECT_HOST.options)
  for (const value of [
    -1,
    0.5,
    NaN,
    Infinity,
    4294967296,
    "1",
    null,
    undefined,
  ])
    assert.throws(() => encodeProjectHostOptions({ ...fields, [key]: value }));
for (const key of PROJECT_HOST.options) {
  const missing = { ...fields };
  delete missing[key];
  assert.throws(() => encodeProjectHostOptions(missing));
}
assert.throws(() => encodeProjectHostOptions({ ...fields, unknown: 1 }));
assert.throws(() =>
  encodeProjectHostOptions({ ...fields, [Symbol("unknown")]: 1 }),
);
assert.throws(() => encodeProjectHostOptions({ ...fields, depth: 129 }));
assert.throws(() => encodeProjectHostOptions({ ...fields, numberBytes: 0 }));
let invoked = 0;
const getter = { ...fields };
Object.defineProperty(getter, "assets", {
  enumerable: true,
  get() {
    invoked++;
    return 1;
  },
});
assert.throws(() => encodeProjectHostOptions(getter));
assert.equal(invoked, 0);
const boundary = { ...fields, documentBytes: 4294967295 };
const encoded = encodeProjectHostOptions(boundary);
boundary.documentBytes = 0;
assert.equal(encoded[0], 4294967295);
console.log(
  "Project host option bounds and immutable data-property capture pass",
);
