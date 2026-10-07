// The generated TypeScript model-import limits encoder: exact field capture and
// refusal of every malformed limit; the contract defaults are the browser's.
import assert from "node:assert/strict";
import {
  encodeProjectModelImportOptions,
  PROJECT_MODEL_IMPORT,
} from "../../contracts/generated/project-model-import.ts";
import { DEFAULT_MODEL_IMPORT_LIMITS } from "../../web/src/project/import/formats/types.ts";
assert.deepEqual(Array.from(encodeProjectModelImportOptions({ ...DEFAULT_MODEL_IMPORT_LIMITS })), PROJECT_MODEL_IMPORT.defaults);
const fields = Object.fromEntries(PROJECT_MODEL_IMPORT.options.map((k) => [k, 1]));
for (const key of PROJECT_MODEL_IMPORT.options)
  for (const value of [0, -1, 0.5, NaN, Infinity, 4294967296, "1", null, undefined])
    assert.throws(() => encodeProjectModelImportOptions({ ...fields, [key]: value }));
for (const key of PROJECT_MODEL_IMPORT.options) {
  const missing = { ...fields };
  delete missing[key];
  assert.throws(() => encodeProjectModelImportOptions(missing));
}
assert.throws(() => encodeProjectModelImportOptions({ ...fields, unknown: 1 }));
let invoked = 0;
const getter = { ...fields };
Object.defineProperty(getter, "maxBytes", { enumerable: true, get() { invoked++; return 1; } });
assert.throws(() => encodeProjectModelImportOptions(getter));
assert.equal(invoked, 0);
console.log("Project model import limits and browser defaults pass");
