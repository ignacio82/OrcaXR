// Placement edits as the browser workspace applies them: the production
// `CanonicalWorkspaceController` opens a canonical 3MF of the picking scene
// (a U1 printable area offset from the bed corner, its printable height and a
// wipe tower on the plate) and runs drop to bed, mirror, the three resets,
// centre on plate, scale to fit, lay flat by a normal and by a picked facet,
// and arrange — each on the bed `WorkspaceBed.ts` reads from the project, as
// `OrcaWorkspace` passes it — then undoes every history entry. Each step
// records the project's semantic hash, the undo label and count and what the
// workspace reports (drops, scaled count, arrangement), so a native session
// applying the same edits through `ProjectWorkspace` can be compared after
// every step: the transforms, the coalescing of repeated gestures, no-op
// edits that leave history alone, and undo restoring each earlier state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { EditorSession } from "../../web/src/project/session.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { layInstanceOnFacet } from "../../web/src/project/objects/transformOperations.ts";
import { createPickingFixture } from "../../web/src/project/__tests__/pickingFixture.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { workspaceBed, wipeTowerKeepOut } from "../../web/src/workspace/WorkspaceBed.ts";
import { workspaceBedExchange } from "../../web/src/workspace/WorkspaceBedExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";

const fixture = createPickingFixture();
const state = structuredClone(fixture.state);
state.config = {
  ...state.config,
  printable_area: ["0.5x1", "270.5x1", "270.5x271", "0.5x271"],
  printable_height: "250",
  prime_tower_width: "35",
};
state.plates[0].wipeTower = { enabled: true, positionMm: [200, 210], rotationDeg: 0 };
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const payload of fixture.assets) assets.put(payload.descriptor, payload.bytes);
const serializer = new Bbs3mfProjectSerializer();
const source = new EditorSession({ initialState: state, assets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
const archive = serialized.bytes;

const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0x51ace)),
  clock: () => "2026-10-10T00:00:00.000Z",
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [200, 200], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(archive), []);
const opened = controller.captureProjectExportGuard();
assert.equal(opened.semanticHash, source.captureExportGuard().semanticHash);

const objects = state.plates[0].objects;
const plateId = state.plates[0].id;
const [plainId, turnedId] = objects[0].instances.map((i) => i.id);
const mirroredId = objects[1].instances[0].id;
const terrainVolume = objects[1].volumes[0].id;
const sphereVolume = objects[0].volumes[0].id;

// The bed exactly as the workspace reads it from the opened project.
const config = controller.getSlicingConfiguration().config;
const bed = workspaceBed(config);
const plateTower = () => controller.getSummary().plates.find((plate) => plate.id === plateId)?.wipeTower;
const bedReply = workspaceBedExchange(JSON.stringify({ config, wipeTower: plateTower() ?? null }));

const observe = () => {
  const { history } = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: history.undoCount,
    undoLabel: history.undoLabel ?? null,
  };
};
const steps = [];
async function step(operation) {
  let result = null;
  let refusal = null;
  try {
    switch (operation.kind) {
      case "dropToBed": {
        const dropped = await controller.dropInstancesToBed(operation.instanceIds);
        result = { moved: dropped.instances.filter((d) => d.deltaZMm !== 0).length };
        break;
      }
      case "mirror":
        await controller.mirrorInstances(operation.instanceIds, operation.axis);
        break;
      case "reset":
        await controller.resetInstanceTransforms(operation.instanceIds, operation.target);
        break;
      case "center":
        await controller.centerInstancesOnPlate(operation.instanceIds, bed.sizeMm);
        break;
      case "scaleToFit":
        result = {
          changed: await controller.scaleInstancesToFitPrintVolume(operation.instanceIds, {
            x: bed.sizeMm[0],
            y: bed.sizeMm[1],
            z: bed.printableHeightMm,
          }),
        };
        break;
      case "layOnFace":
        await controller.layInstanceOnFace(operation.instanceId, operation.localNormal);
        break;
      case "layOnFacet":
        // `layInstanceOnFace` with the picked facet's normal: its own body
        // over the facet planner, under the same gesture.
        await controller.setInstanceTransforms(
          layInstanceOnFacet(controller.session.project.getSnapshot().state, controller.assets, operation),
          "lay-on-face",
        );
        break;
      case "arrange": {
        const keepOut = wipeTowerKeepOut(controller.getSlicingConfiguration().config, plateTower());
        const arranged = await controller.arrangePlate(operation.plateId, {
          bedSizeMm: bed.sizeMm,
          ...(keepOut ? { exclusions: [keepOut] } : {}),
        });
        result = { placed: arranged.placements.length, unplaced: arranged.unplacedInstanceIds.length };
        break;
      }
      default:
        throw Error(`unknown operation ${operation.kind}`);
    }
  } catch (error) {
    refusal = error.message;
  }
  steps.push({ operation, result, refusal, ...observe() });
}

await step({ kind: "dropToBed", instanceIds: [plainId, turnedId, mirroredId] });
await step({ kind: "mirror", instanceIds: [turnedId], axis: "x" });
await step({ kind: "mirror", instanceIds: [turnedId], axis: "x" });
await step({ kind: "mirror", instanceIds: [plainId, mirroredId], axis: "y" });
await step({ kind: "mirror", instanceIds: [mirroredId], axis: "z" });
await step({ kind: "reset", instanceIds: [turnedId], target: "rotation" });
await step({ kind: "reset", instanceIds: [turnedId, mirroredId], target: "scale" });
await step({ kind: "reset", instanceIds: [plainId, turnedId, mirroredId], target: "both" });
await step({ kind: "center", instanceIds: [plainId, turnedId, mirroredId] });
await step({ kind: "center", instanceIds: [plainId, turnedId, mirroredId] });
await step({ kind: "center", instanceIds: [mirroredId] });
await step({ kind: "scaleToFit", instanceIds: [plainId] });
await step({ kind: "scaleToFit", instanceIds: [plainId] });
await step({ kind: "layOnFace", instanceId: turnedId, localNormal: [0.3, -0.5, 0.8] });
await step({ kind: "layOnFacet", instanceId: mirroredId, volumeId: terrainVolume, triangle: 17 });
await step({ kind: "layOnFacet", instanceId: plainId, volumeId: sphereVolume, triangle: 100 });
await step({ kind: "arrange", plateId });
await step({ kind: "arrange", plateId });
await step({ kind: "dropToBed", instanceIds: [plainId, turnedId, mirroredId] });
await step({ kind: "dropToBed", instanceIds: [turnedId] });
// Refusals leave the project and its history as they were.
await step({ kind: "mirror", instanceIds: [], axis: "x" });
await step({ kind: "dropToBed", instanceIds: [plainId, plainId] });
await step({ kind: "layOnFacet", instanceId: plainId, volumeId: sphereVolume, triangle: 320 });
await step({ kind: "arrange", plateId: "import:plate:missing" });

const undo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  undo.push(observe());
}
assert.equal(undo.at(-1).semanticHash, opened.semanticHash);

const sources = [
  "tools/cross-platform/placement-edit-vectors.mjs",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/workspace/WorkspaceBed.ts",
  "web/src/workspace/WorkspaceBedExchange.ts",
  "web/src/project/objects/transformOperations.ts",
  "web/src/project/objects/transformCommands.ts",
  "web/src/project/objects/arrange.ts",
  "web/src/project/history/commandBus.ts",
  "web/src/project/__tests__/pickingFixture.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    archive: Buffer.from(archive).toString("base64"),
    opened: { semanticHash: opened.semanticHash, assetFingerprint: opened.assetFingerprint },
    plateId,
    bed: bedReply,
    steps,
    undo,
  }) + "\n";
const path = new URL("testdata/cross-platform/placement-edit-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Placement edit reference drift");
const changed = steps.filter((s, i) => s.semanticHash !== (i === 0 ? opened.semanticHash : steps[i - 1].semanticHash)).length;
const refused = steps.filter((s) => s.refusal !== null).length;
console.log(
  `Placement edits: ${steps.length} steps (${changed} changed the project, ${refused} refused), ${undo.length} undo entries`,
);
controller.dispose?.();
source.dispose?.();
