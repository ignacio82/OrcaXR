// Filament assignment references from the production browser
// (`FilamentAssignment.ts` through `FilamentAssignmentExchange.ts`, and the
// production `CanonicalWorkspaceController` that the inspector's selector, the
// selection's filament bar and the headset's swatches drive): the assignable
// scopes, unsupported refs and offered filaments of selections — objects,
// parts, height ranges, instances standing for their objects, plates, refs
// the project lacks — and the assignments a choice makes, with the
// controller's refusals in its words. States derive from the browser fixture
// (whose mesh the bindings upload): physical heads out of order and outside
// the printer's head range, disabled heads and recipes, recipe names whose
// order differs between code units and any locale, mixed materials, every
// distribution mode, inherited and local assignments, non-ASCII and
// lone-surrogate names, fractional and huge heights. A journey runs the
// controller over the state's canonical 3MF — select, read the snapshot,
// assign — recording the hash and undo label after each step, then undoes
// every entry. Replayed by Rust, WASM and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { createEmptyProject, emptyFacetAnnotations, identityTransform } from "../../web/src/project/domain/model.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import {
  filamentAssignmentChangesExchange,
  filamentAssignmentExchange,
} from "../../web/src/workspace/FilamentAssignmentExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";
const json = (value) => canonicalStringify(value);

// --- States ------------------------------------------------------------------------------------

const fixture = createProjectFixture();
const ids = new UuidIdSource(seededRandom(0xf11a));
const rich = structuredClone(fixture.state);
const [physical0, physical1] = rich.filaments.physical;
physical0.presetId = "preset:Snapmaker:filament:Snapmaker%20PLA%20%40U1";
const physical = (name, toolId, extra = {}) => ({
  id: ids.next("physical-filament"),
  name,
  toolId,
  material: "PLA",
  color: "#808080",
  config: {},
  enabled: true,
  ...extra,
});
const petg = physical("Tool 4 PETG", 3, { material: "PETG", color: "#00ff00" });
const spare = physical("Spare", 2, { enabled: false, color: "#ffffff", presetId: "preset:Snapmaker:filament:Snapmaker%20PLA" });
// Out of tool order.
rich.printer.toolCount = 4;
rich.config.printable_area = ["0x0", "270x0", "270x270", "0x270"];
rich.filaments.physical = [petg, physical1, spare, physical0];
const mixed = (name, components, distribution, extra = {}) => ({
  id: ids.next("mixed-filament"),
  name,
  displayColor: "#777777",
  components: components.map(([filament, weight]) => ({ filamentId: filament.id, weight })),
  distribution,
  config: {},
  enabled: true,
  ...extra,
});
const blend = mixed("b blend", [[physical0, 3], [petg, 1]], { mode: "cycle", cycleLengthMm: 2 });
const disabledBlend = mixed("B blend", [[physical0, 1], [physical1, 1]], { mode: "ratio" }, { enabled: false });
const withSpare = mixed("a blend", [[physical1, 1], [spare, 2]], { mode: "match", targetColor: "#123456" });
const accented = mixed("ä blend", [[physical0, 0.1], [physical1, 0.2]], { mode: "gradient", startWeights: [1, 0], endWeights: [0, 1] });
const lone = mixed("\ud800 lone", [[petg, 1], [physical1, 1]], { mode: "ratio" }, { displayColor: "#\udc00" });
const twinA = mixed("Twin", [[physical0, 1], [physical1, 1]], { mode: "ratio" });
const twinB = mixed("Twin", [[physical0, 2], [physical1, 1]], { mode: "ratio" });
rich.filaments.mixed.push(blend, disabledBlend, withSpare, accented, lone, twinA, twinB);
const objectA = rich.plates[0].objects[0];
const [body] = objectA.volumes;
const [range1] = objectA.layerRanges;
const asset = fixture.asset.descriptor.id;
const volume = (name, extra = {}) => ({
  id: ids.next("volume"),
  name,
  role: "model",
  source: { assetId: asset, topologyRevision: 0, triangleCount: 1 },
  transform: identityTransform(),
  config: {},
  annotations: emptyFacetAnnotations(0),
  ...extra,
});
const instance = () => ({ id: ids.next("instance"), transform: identityTransform(), printable: true });
const range = (minZMm, maxZMm, extra = {}) => ({ id: ids.next("layer-range"), minZMm, maxZMm, config: {}, ...extra });
const lid = volume("Lid ñ", { filamentId: blend.id });
const modifier = volume("Modifier", { role: "parameter-modifier", filamentId: physical1.id });
objectA.volumes.push(lid, modifier);
const instanceA2 = instance();
objectA.instances.push(instanceA2);
const range2 = range((0.1 + 0.2) * 20, 7.123456, { filamentId: physical1.id });
objectA.layerRanges.push(range2);
const objectB = {
  id: ids.next("object"),
  name: "\ud83d Sphere  ",
  config: {},
  volumes: [volume("Shell")],
  instances: [instance()],
  layerRanges: [range(1e21, 2e21)],
};
rich.plates[0].objects.push(objectB);
const plate2 = { id: ids.next("plate"), name: "Plate 2", order: 1, printable: true, config: {}, objects: [] };
const objectC = {
  id: ids.next("object"),
  name: "On plate 2",
  config: {},
  filamentId: fixture.ids.mixed,
  volumes: [volume("Part", { filamentId: withSpare.id })],
  instances: [instance()],
  layerRanges: [],
};
plate2.objects.push(objectC);
rich.plates.push(plate2);
assertValidProjectState(rich);
// The journey's 3MF carries only what XML 1.0 can: whole characters for the lone units.
const journeyState = structuredClone(rich);
journeyState.plates[0].objects[1].name = "🌐 Sphere  ";
for (const recipe of journeyState.filaments.mixed) {
  recipe.name = recipe.name.replace("\ud800", "⛔");
  recipe.displayColor = recipe.displayColor.replace("\udc00", "dc00dc");
}
assertValidProjectState(journeyState);

const empty =createEmptyProject({ idSource: new UuidIdSource(seededRandom(0xf11b)), now: "2026-10-10T00:00:00.000Z" });
assertValidProjectState(empty);
const states = { rich, fixture: fixture.state, empty };

// --- Exchanges ---------------------------------------------------------------------------------

const ref = (kind, id) => ({ id, kind });
const refs = {
  objectA: ref("object", objectA.id),
  objectB: ref("object", objectB.id),
  objectC: ref("object", objectC.id),
  body: ref("volume", body.id),
  lid: ref("volume", lid.id),
  modifier: ref("volume", modifier.id),
  shell: ref("volume", objectB.volumes[0].id),
  part: ref("volume", objectC.volumes[0].id),
  range1: ref("layer-range", range1.id),
  range2: ref("layer-range", range2.id),
  rangeB: ref("layer-range", objectB.layerRanges[0].id),
  instanceA1: ref("instance", objectA.instances[0].id),
  instanceA2: ref("instance", instanceA2.id),
  instanceB: ref("instance", objectB.instances[0].id),
  instanceC: ref("instance", objectC.instances[0].id),
  plate1: ref("plate", rich.plates[0].id),
  plate2: ref("plate", plate2.id),
  missingInstance: ref("instance", "import:instance:missing"),
  missingObject: ref("object", "import:object:missing"),
  missingVolume: ref("volume", "import:volume:missing"),
  missingRange: ref("layer-range", "import:layer-range:missing"),
};
const resolutions = [];
function resolve(stateName, list) {
  const requestJson = json({ refs: list });
  resolutions.push({ state: stateName, requestJson, replyJson: filamentAssignmentExchange(states[stateName], requestJson) });
}
const r = refs;
for (const list of [
  [],
  [r.objectA],
  [r.body],
  [r.lid],
  [r.modifier],
  [r.range1],
  [r.range2],
  [r.rangeB],
  [r.objectB],
  [r.shell],
  [r.part],
  [r.objectC],
  [r.instanceA1],
  [r.instanceA1, r.instanceA2],
  [r.objectA, r.instanceA1, r.instanceA2],
  [r.instanceA2, r.objectA],
  [r.instanceB, r.instanceC],
  [r.plate1],
  [r.plate1, r.objectB],
  [r.plate2, r.plate2],
  [r.missingInstance],
  [r.missingInstance, r.objectA, r.missingInstance],
  [r.objectB, r.objectB],
  [r.objectA, r.body, r.range1, r.instanceC, r.plate2, r.objectB, r.lid],
  [r.missingObject],
  [r.missingVolume],
  [r.objectA, r.missingRange],
  [r.plate1, r.missingObject],
])
  resolve("rich", list);
const fixtureRefs = {
  object: ref("object", fixture.ids.object),
  volume: ref("volume", fixture.ids.volume),
  range: ref("layer-range", fixture.ids.range),
  instance: ref("instance", fixture.ids.instance),
  plate: ref("plate", fixture.ids.plate),
};
for (const list of [[], [fixtureRefs.object], [fixtureRefs.volume, fixtureRefs.range], [fixtureRefs.instance], [fixtureRefs.plate]])
  resolve("fixture", list);
resolve("empty", []);
resolve("empty", [ref("plate", empty.plates[0].id)]);
resolve("empty", [r.missingObject]);
// The mixed names in code-unit order: upper case before lower, then accents and lone units.
{
  const names = JSON.parse(resolutions[0].replyJson)
    .options.filter((option) => option.kind === "mixed")
    .map((option) => option.name);
  assert.deepEqual(names, ["B blend", "Purple mix", "Twin", "Twin", "a blend", "b blend", "ä blend", "\ud800 lone"]);
}

const changes = [];
function change(stateName, entities, filamentId) {
  const requestJson = json({ entities, filamentId });
  changes.push({ state: stateName, requestJson, replyJson: filamentAssignmentChangesExchange(states[stateName], requestJson) });
}
change("rich", [r.objectA], physical1.id);
change("rich", [r.objectA, r.body, r.range1], blend.id);
change("rich", [r.lid], null);
change("rich", [r.lid, r.range2, r.modifier, r.objectB], null);
change("rich", [r.part], petg.id);
change("rich", [r.objectA, r.objectA], physical0.id);
change("rich", [], physical0.id);
change("rich", [], null);
change("rich", [r.objectA], "import:filament:missing");
change("rich", [r.objectA], spare.id);
change("rich", [r.objectA], disabledBlend.id);
change("rich", [r.missingObject], physical0.id);
change("rich", [r.missingObject], spare.id);
change("rich", [r.missingVolume], null);
change("rich", [r.objectA, r.missingRange], null);
change("rich", [r.objectA], "");
change("fixture", [fixtureRefs.object, fixtureRefs.volume], fixture.ids.mixed);
change("empty", [r.missingObject], null);
const errors = (list) => list.filter((each) => JSON.parse(each.replyJson).error).length;
assert.ok(errors(resolutions) >= 4 && errors(changes) >= 8);

const refusals = [
  { exchange: "resolve", requestJson: "{" },
  { exchange: "resolve", requestJson: "[]" },
  { exchange: "resolve", requestJson: json({}) },
  { exchange: "resolve", requestJson: json({ refs: {} }) },
  { exchange: "resolve", requestJson: json({ refs: [ref("project", "x")] }) },
  { exchange: "resolve", requestJson: json({ refs: [ref("filament", "x")] }) },
  { exchange: "resolve", requestJson: json({ refs: [{ kind: "object" }] }) },
  { exchange: "resolve", requestJson: json({ refs: [{ id: 3, kind: "object" }] }) },
  { exchange: "resolve", requestJson: json({ refs: [{ id: "x", kind: "object", name: "y" }] }) },
  { exchange: "resolve", requestJson: json({ refs: [], extra: true }) },
  { exchange: "changes", requestJson: json({ entities: [] }) },
  { exchange: "changes", requestJson: json({ entities: [r.instanceA1], filamentId: null }) },
  { exchange: "changes", requestJson: json({ entities: [r.plate1], filamentId: null }) },
  { exchange: "changes", requestJson: json({ entities: [r.objectA], filamentId: 7 }) },
  { exchange: "changes", requestJson: json({ entities: null, filamentId: null }) },
  { exchange: "changes", requestJson: json({ entities: [r.objectA], filamentId: null, label: "x" }) },
];
const exchanges = { resolve: filamentAssignmentExchange, changes: filamentAssignmentChangesExchange };
for (const refusal of refusals) assert.throws(() => exchanges[refusal.exchange](rich, refusal.requestJson), /invalid_request/);

// --- Journey -----------------------------------------------------------------------------------

const assets = new InMemoryAssetRepository();
assets.put(fixture.asset.descriptor, fixture.asset.bytes);
const serializer = new Bbs3mfProjectSerializer();
const source = new EditorSession({ initialState: journeyState, assets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
const archive = serialized.bytes;
const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0xf11c)),
  clock: () => "2026-10-10T00:00:00.000Z",
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(archive), []);
const observe = () => {
  const summary = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: summary.history.undoCount,
    undoLabel: summary.history.undoLabel ?? null,
  };
};
const opened = observe();
assert.equal(opened.undoCount, 0);
const steps = [];
/** Select `list`, read the snapshot a filament bar shows, and choose `filamentId` for its scopes (`undefined` chooses nothing). */
async function step(list, filamentId) {
  controller.setObjectsTreeSelection(list);
  const snapshot = controller.getFilamentAssignmentSnapshot();
  const state = controller.session.project.getSnapshot().state;
  const resolution = filamentAssignmentExchange(state, json({ refs: list }));
  // The controller's snapshot is the exchange's answer for the state it reads.
  assert.equal(
    json({ options: snapshot.options, scopes: snapshot.scopes, unsupportedSelection: snapshot.unsupportedSelection }),
    resolution,
  );
  let refusal = null;
  if (filamentId !== undefined) {
    try {
      await controller.setFilamentAssignments(
        snapshot.scopes.map((scope) => scope.entity),
        filamentId,
        { sourceRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
      );
    } catch (error) {
      refusal = error.message;
    }
  }
  steps.push({ refs: list, resolutionJson: resolution, filamentId: filamentId ?? null, assign: filamentId !== undefined, refusal, ...observe() });
}
await step([r.objectA], physical1.id);
await step([r.instanceA2], blend.id);
await step([r.objectA, r.body, r.range1], petg.id);
await step([r.lid], null);
await step([r.objectA], petg.id);
await step([r.objectB, r.plate2]);
await step([r.objectA], spare.id);
await step([r.instanceC, r.part], null);
await step([r.range2, r.modifier, r.shell], fixture.ids.mixed);
await step([r.instanceB], twinB.id);
const assigned = steps.filter((each) => each.assign && each.refusal === null);
assert.ok(steps.some((each) => each.undoLabel === "Assign filament") && steps.some((each) => /^Assign \d+ scopes$/.test(each.undoLabel)));
assert.ok(steps.some((each) => each.refusal !== null));
const undo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  undo.push(observe());
}
assert.equal(undo.at(-1).semanticHash, opened.semanticHash);

// --- Output ------------------------------------------------------------------------------------

const sources = [
  "tools/cross-platform/filament-assignment-vectors.mjs",
  "web/src/workspace/FilamentAssignment.ts",
  "web/src/workspace/FilamentAssignmentExchange.ts",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/project/filaments/commands.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/__tests__/fixtures.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    states: Object.fromEntries(Object.entries(states).map(([name, state]) => [name, json(state)])),
    assets: [{ descriptorJson: json(fixture.asset.descriptor), bytes: [...fixture.asset.bytes] }],
    resolutions,
    changes,
    refusals,
    journey: {
      archive: Buffer.from(archive).toString("base64"),
      opened,
      steps,
      undo,
    },
  }) + "\n";
const path = new URL("testdata/cross-platform/filament-assignment-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Filament assignment reference drift");
console.log(
  `Filament assignment references: ${resolutions.length} resolutions (${errors(resolutions)} refused), ` +
    `${changes.length} assignments (${errors(changes)} refused), ${refusals.length} malformed, ` +
    `a ${steps.length}-step journey (${assigned.length} assigned) and ${undo.length} undo entries.`,
);
controller.dispose?.();
source.dispose?.();
