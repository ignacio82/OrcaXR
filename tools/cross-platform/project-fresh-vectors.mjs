// New-project references from the production browser (`model.ts`): the
// project a session starts with (`createEmptyProject` with the browser's
// defaults) and the one "New project" replaces it with (`freshProjectState`,
// which keeps the printer, base profile and physical tools), from every state
// in the project model corpus. Identifiers come from the browser's UUID source
// over recorded random words, so a host replays them by passing the same
// words. Replayed by Rust and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { createEmptyProject, freshProjectState } from "../../web/src/project/domain/model.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const model = JSON.parse(read("testdata/cross-platform/project-model-vectors.json"));

/** The browser's UUID source over a seeded word stream, recording each word drawn. */
function recorded(seed) {
  const words = [];
  const next = seededRandom(seed);
  return {
    words,
    ids: new UuidIdSource(() => {
      const word = next();
      words.push(word);
      return word;
    }),
  };
}
const valid = (state) => {
  assert.deepEqual(validateProjectState(state), []);
  return state;
};
const times = ["2026-10-09T12:34:56.789Z", "1970-01-01T00:00:00.000Z", "2099-12-31T23:59:59.999Z"];

const empty = times.map((now, n) => {
  const { words, ids } = recorded(0x5eed + n);
  const state = valid(createEmptyProject({ idSource: ids, now }));
  return { words, now, stateJson: canonicalStringify(state) };
});
/** A corpus state without its objects and asset references, so a host can
 * open it as a session from its document alone; its printer, profile and
 * filaments stay as they were. */
function assetFree(stateJson) {
  const state = JSON.parse(stateJson);
  for (const plate of state.plates) plate.objects = [];
  state.sourceAssets = [];
  state.thumbnails = [];
  state.extensionBlobs = [];
  return canonicalStringify(valid(state));
}
const rich = model.cases.filter(({ stateJson }) => JSON.parse(stateJson).sourceAssets.length > 0);
const fresh = [
  ...model.factories.map((factory) => ({ source: `factory:${factory.seed}`, stateJson: factory.stateJson })),
  ...model.cases.map((each) => ({ source: `case:${each.name}`, stateJson: each.stateJson })),
  ...rich.slice(0, 2).map((each) => ({ source: `asset-free:${each.name}`, stateJson: assetFree(each.stateJson), embed: true })),
].map(({ source, stateJson, embed }, n) => {
  const { words, ids } = recorded(0xf4e5 + n);
  const now = times[n % times.length];
  const state = valid(freshProjectState(JSON.parse(stateJson), ids, now));
  return { source, ...(embed ? { sourceJson: stateJson } : {}), words, now, stateJson: canonicalStringify(state) };
});
// The corpus exercises what "New project" keeps and drops, and a host can
// open rich sources without their assets.
assert.ok(
  fresh.some(({ sourceJson }) => sourceJson && JSON.parse(sourceJson).filaments.mixed.length > 0),
  "an asset-free source with mixed filaments",
);
assert.ok(fresh.some(({ stateJson }) => JSON.parse(stateJson).filaments.physical.length > 0), "physical tools kept");
assert.ok(
  model.cases.some(({ stateJson }) => JSON.parse(stateJson).filaments.mixed.length > 0),
  "a source with mixed filaments",
);
assert.ok(
  model.cases.some(({ stateJson }) => JSON.parse(stateJson).settingsBaseConfig !== undefined),
  "a source with a base profile",
);

const sources = [
  "web/src/project/domain/model.ts",
  "web/src/project/domain/ids.ts",
  "web/src/project/domain/canonical.ts",
  "testdata/cross-platform/project-model-vectors.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    empty,
    fresh,
  }) + "\n";
const path = new URL("testdata/cross-platform/project-fresh-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "New-project reference drift");
console.log(`New-project references: ${empty.length} empty, ${fresh.length} fresh.`);
