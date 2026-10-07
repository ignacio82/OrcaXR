// Complete production-browser package outcomes, with source fixtures referenced
// rather than copied. Native output may use different DEFLATE bytes, but every
// expanded member and canonical mapping must match these independent digests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Bbs3mfProjectSerializer,
  ORCAXR_EXTENSION_PATH,
} from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { readSafeZip } from "../../web/src/project/serialization/deterministicZip.ts";
import { projectFingerprint } from "../../web/src/project/domain/canonical.ts";
import { packageInputs } from "./package-inputs.mjs";
const root = new URL("../../", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const cases = [];
const inputs =
  JSON.stringify({ version: 1, cases: await packageInputs() }, null, 2) + "\n";
const inputPath = new URL(
  "testdata/cross-platform/package-input-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(inputPath, inputs);
else
  assert.equal(
    readFileSync(inputPath, "utf8"),
    inputs,
    "Package inputs are stale",
  );
const fixtures = ["bbs-model", "bbs-metadata", "bbs-settings", "package-input"];
for (const source of fixtures) {
  const corpus = JSON.parse(
    readFileSync(
      new URL(`testdata/cross-platform/${source}-vectors.json`, root),
      "utf8",
    ),
  );
  for (const [index, input] of corpus.cases.entries()) {
    const state = JSON.parse(input.stateJson);
    const assets = input.assets.map((p) => ({
      descriptor: JSON.parse(p.descriptorJson),
      bytes: new Uint8Array(p.bytes),
    }));
    const row = { source, index, name: input.name };
    try {
      const result = await new Bbs3mfProjectSerializer().serialize({
        state,
        assets,
        sourceRevision: 7,
        sourceHash: projectFingerprint(state),
      });
      const files = readSafeZip(result.bytes);
      row.members = [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, bytes]) => ({
          path,
          bytes: bytes.length,
          sha256: hash(bytes),
        }));
      row.mappings = JSON.parse(
        new TextDecoder().decode(files.get(ORCAXR_EXTENSION_PATH)),
      ).assetEntries.map(({ assetId, path }) => ({
        assetId: units(assetId),
        path,
      }));
      row.warnings = result.warnings.map(units);
    } catch (error) {
      row.error = units(error.message);
    }
    cases.push(row);
  }
}
const sourcePaths = [
  "tools/cross-platform/package-inputs.mjs",
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/CanonicalEnvelope.ts",
  "web/src/project/serialization/bbsCore.ts",
  "web/src/project/serialization/bbsNumbers.ts",
  "web/src/project/serialization/bbsXml.ts",
  "web/src/project/serialization/opcPackage.ts",
  "web/src/project/serialization/deterministicZip.ts",
  "web/src/project/domain/canonical.ts",
  ...fixtures.map((s) => `testdata/cross-platform/${s}-vectors.json`),
];
const value = {
  version: 1,
  sources: Object.fromEntries(
    sourcePaths.map((path) => [path, hash(readFileSync(new URL(path, root)))]),
  ),
  cases,
};
const output = new URL("testdata/cross-platform/package-vectors.json", root);
const text = JSON.stringify(value, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(output, text);
else
  assert.equal(
    readFileSync(output, "utf8"),
    text,
    "Package references are stale",
  );
console.log(
  JSON.stringify({
    cases: cases.length,
    accepted: cases.filter((r) => r.members).length,
    refused: cases.filter((r) => r.error).length,
  }),
);
