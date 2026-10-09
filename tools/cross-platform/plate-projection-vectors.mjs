// One-plate slice projection references from the production browser
// (`plateProjection.ts`: `projectPlateArchiveForSlice`, `platePrintOverrides`):
// every plate of the project model corpus's states and of variants built on
// them — another plate unprintable, print overrides of every JSON shape next
// to the plate's bookkeeping keys, thumbnails per plate and none, custom
// G-code for the plate, another plate and the project, a source asset nothing
// uses — projected with all payloads, without one, and for an unknown plate.
// Replayed by Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify, projectFingerprint } from "../../web/src/project/domain/canonical.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import { platePrintOverrides, projectPlateArchiveForSlice } from "../../web/src/project/slicing/plateProjection.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const model = JSON.parse(read("testdata/cross-platform/project-model-vectors.json"));
const named = new Map([
  ...model.factories.map((factory) => [`factory:${factory.seed}`, factory.stateJson]),
  ...model.cases.map((each) => [`case:${each.name}`, each.stateJson]),
]);
const valid = (state) => {
  const errors = validateProjectState(state).filter((issue) => issue.severity === "error");
  assert.deepEqual(errors, []);
  return state;
};
const json = (value) => JSON.stringify(value);

// Variants of the richest corpus state.
const rich = () => JSON.parse(named.get("case:complete-schema-with-unknowns"));
const unprintable = rich();
unprintable.plates[1].printable = false;
const overrides = rich();
Object.assign(overrides.plates[0].config, {
  plater_id: 7,
  plater_name: "Front",
  locked: true,
  printable: false,
  layer_height: 0.2,
  wall_loops: 3,
  spiral_mode: true,
  seam_position: "aligned",
  filament_colour: ["#ff0000", null, "#00ff00"],
  nested: [[1, null, [2, 3]], "x", true],
  nothing: null,
  shape: { a: 1 },
  tiny: 1.5e-7,
  huge: 1e21,
  sum: 0.1 + 0.2,
  negative_zero: -0,
  empty: [],
  unicode: "é\u{10000}",
});
const thumbnails = rich();
{
  const [template] = thumbnails.thumbnails;
  const [first, second] = thumbnails.plates.map((plate) => plate.id);
  const { plateId: _plate, ...unplated } = template;
  thumbnails.thumbnails = [
    { ...template, id: "import:thumbnail:first", plateId: first },
    { ...template, id: "import:thumbnail:second", plateId: second },
    { ...unplated, id: "import:thumbnail:project" },
  ];
  // A source asset nothing uses is not carried.
  thumbnails.sourceAssets.push({ ...thumbnails.sourceAssets.at(-1), id: "import:asset:unused" });
  // Custom G-code for each plate and the project.
  const code = thumbnails.customGcode.find((entry) => entry.scope === "plate");
  thumbnails.customGcode.push({ ...code, id: "import:gcode:second", plateId: second });
}
const embedded = new Map([
  ["variant:second-plate-unprintable", unprintable],
  ["variant:print-overrides", overrides],
  ["variant:thumbnails-gcode-unused-asset", thumbnails],
]);
for (const state of embedded.values()) valid(state);

const sources = [
  ...[
    "factory:0",
    "case:minimal",
    "case:large-integral-domain-numbers",
    "case:complete-schema-with-unknowns",
    "case:utf16-identities-and-references",
    "case:unassigned-filament-inheritance",
    'case:distribution-{"mode":"ratio"}',
  ].map((source) => ({ source, state: JSON.parse(named.get(source)), embed: false })),
  ...[...embedded].map(([source, state]) => ({ source, state, embed: true })),
];

/** The browser's snapshot: every source asset's payload, less the omitted ones. */
function snapshot(state, omitted = new Set()) {
  return {
    state,
    assets: state.sourceAssets
      .filter((descriptor) => !omitted.has(descriptor.id))
      .map((descriptor) => ({ descriptor, bytes: new Uint8Array([1, 2, 3]) })),
    sourceRevision: 7,
    sourceHash: projectFingerprint(state),
    sourceAssetHash: "fnv1a64:0000000000000000",
  };
}
function code(error) {
  const message = String(error.message);
  if (error.name === "ProjectValidationError") return "invalid";
  if (message.startsWith("Unknown plate ")) return "unknown-plate";
  if (message.endsWith(" is not printable")) return "plate-not-printable";
  if (message.startsWith("One-plate projection is missing source asset ")) return "missing-asset";
  throw error;
}
function project(state, plateId, omitted) {
  try {
    const projection = projectPlateArchiveForSlice(snapshot(state, omitted), plateId);
    assert.equal(projection.archive.sourceHash, projectFingerprint(projection.archive.state));
    return {
      stateJson: canonicalStringify(projection.archive.state),
      sourceHash: projection.archive.sourceHash,
      assetIdsJson: json(projection.archive.assets.map((asset) => asset.descriptor.id)),
    };
  } catch (error) {
    return { error: code(error), messageJson: json(String(error.message)) };
  }
}

const cases = [];
for (const { source, state, embed } of sources) {
  const base = { source, ...(embed ? { sourceJson: canonicalStringify(state) } : {}) };
  state.plates.forEach((plate, plateIndex) => {
    cases.push({
      ...base,
      plateIndex,
      result: project(state, plate.id),
      overridesJson: canonicalStringify(platePrintOverrides({ state }, plate.id)),
    });
  });
}
// A kept asset's payload missing from the capture; an unknown plate.
{
  const state = JSON.parse(named.get("case:complete-schema-with-unknowns"));
  const used = state.plates[0].objects[0].volumes[0].source.assetId;
  cases.push({
    source: "case:complete-schema-with-unknowns",
    plateIndex: 0,
    omittedJson: json([used]),
    result: project(state, state.plates[0].id, new Set([used])),
    overridesJson: canonicalStringify(platePrintOverrides({ state }, state.plates[0].id)),
  });
  cases.push({
    source: "case:complete-schema-with-unknowns",
    plateIdJson: json("import:plate:unknown"),
    result: project(state, "import:plate:unknown"),
    overridesJson: canonicalStringify(platePrintOverrides({ state }, "import:plate:unknown")),
  });
}
const outcomes = new Map();
for (const each of cases) {
  const key = each.result.error ?? "projected";
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}
for (const key of ["projected", "plate-not-printable", "missing-asset", "unknown-plate"]) {
  assert.ok(outcomes.get(key) > 0, `the corpus exercises ${key}`);
}
assert.ok(
  cases.some((each) => Object.keys(JSON.parse(each.overridesJson)).length > 8),
  "a plate with print overrides",
);

const hashed = [
  "web/src/project/slicing/plateProjection.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/validation.ts",
  "testdata/cross-platform/project-model-vectors.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: hashed.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    cases,
  }) + "\n";
const path = new URL("testdata/cross-platform/plate-projection-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Plate projection reference drift");
console.log(
  `Plate projection references: ${cases.length} cases (${[...outcomes].map(([k, v]) => `${v} ${k}`).join(", ")}).`,
);
