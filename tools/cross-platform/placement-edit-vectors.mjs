// Placement edits as the browser workspace applies them: the production
// `CanonicalWorkspaceController` opens a canonical 3MF of the picking scene
// and runs drop to bed, mirror, the three resets, centre on plate, scale to
// fit, lay flat by a normal and by a picked facet, and arrange — each on the
// bed `WorkspaceBed.ts` reads from the project, as `OrcaWorkspace` passes it
// (centring and arranging on its placement area, scaling into its build
// volume) — then undoes every history entry. Two scenes: the U1's printable
// area (offset 0.5 × 1 mm from the bed corner, its printable height, a plate
// tower), and one far from the bed corner, whose far corner's half lies
// outside it, where every model starts outside the area. Each step records
// the project's semantic hash, the undo label and count, what the workspace
// reports (drops, scaled count, arrangement) and the instances the live slice
// preflight (the project as authored) finds outside its build volume, so a
// native session applying the same edits through `ProjectWorkspace` can be
// compared after every step: the transforms, the coalescing of repeated
// gestures, no-op edits that leave history alone, the preflight's verdict,
// and undo restoring each earlier state.
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
import { authoredProjectPreflightTarget } from "../../web/src/workspace/AuthoredSlicingTarget.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import {
  deriveLiveProfilePreflightConstraints,
  LiveProfileSlicePreflight,
} from "../../web/src/workspace/ProfilePreflightConstraints.ts";
import { workspaceBed, wipeTowerKeepOut } from "../../web/src/workspace/WorkspaceBed.ts";
import { workspaceBedExchange } from "../../web/src/workspace/WorkspaceBedExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";

const serializer = new Bbs3mfProjectSerializer();
const fixture = createPickingFixture();
const objects = fixture.state.plates[0].objects;
const plateId = fixture.state.plates[0].id;
const [plainId, turnedId] = objects[0].instances.map((i) => i.id);
const mirroredId = objects[1].instances[0].id;
const all = [plainId, turnedId, mirroredId];
const terrainVolume = objects[1].volumes[0].id;
const sphereVolume = objects[0].volumes[0].id;

/** One scene: the picking scene on [printer]'s area and height, with a plate tower at [towerAt]. */
async function scene(name, printer, towerAt) {
  const state = structuredClone(fixture.state);
  state.config = { ...state.config, ...printer, prime_tower_width: "35" };
  state.plates[0].wipeTower = { enabled: true, positionMm: towerAt, rotationDeg: 0 };
  assertValidProjectState(state);
  const assets = new InMemoryAssetRepository();
  for (const payload of fixture.assets) assets.put(payload.descriptor, payload.bytes);
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

  // The bed exactly as the workspace reads it from the opened project.
  const config = controller.getSlicingConfiguration().config;
  const bed = workspaceBed(config);
  const plateTower = () => controller.getSummary().plates.find((plate) => plate.id === plateId)?.wipeTower;
  const bedReply = workspaceBedExchange(JSON.stringify({ config, wipeTower: plateTower() ?? null }));

  /** The instances the live preflight of the project as authored finds outside its build volume. */
  const outside = () => {
    const preflight = new LiveProfileSlicePreflight(
      deriveLiveProfilePreflightConstraints(authoredProjectPreflightTarget(controller.getSlicingConfiguration())),
    );
    const result = preflight.evaluate(controller.createCanonicalSliceSource().capture(), plateId);
    return result.issues
      .filter((issue) => issue.code === "instance-outside-build-volume")
      .flatMap((issue) => issue.entities.filter((entity) => entity.kind === "instance").map((entity) => entity.id))
      .sort();
  };
  const observe = () => {
    const { history } = controller.getSummary();
    return {
      semanticHash: controller.captureProjectExportGuard().semanticHash,
      undoCount: history.undoCount,
      undoLabel: history.undoLabel ?? null,
      outside: outside(),
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
          await controller.centerInstancesOnPlate(operation.instanceIds, bed.areaMm);
          break;
        case "scaleToFit":
          result = { changed: await controller.scaleInstancesToFitPrintVolume(operation.instanceIds, bed.volumeMm) };
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
            bedAreaMm: bed.areaMm,
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
    return steps.at(-1);
  }
  const inside = (entry, ids) =>
    assert.ok(!ids.some((id) => entry.outside.includes(id)), `${name}: ${entry.operation.kind} left ${entry.outside}`);

  await step({ kind: "dropToBed", instanceIds: all });
  await step({ kind: "mirror", instanceIds: [turnedId], axis: "x" });
  await step({ kind: "mirror", instanceIds: [turnedId], axis: "x" });
  await step({ kind: "mirror", instanceIds: [plainId, mirroredId], axis: "y" });
  await step({ kind: "mirror", instanceIds: [mirroredId], axis: "z" });
  await step({ kind: "reset", instanceIds: [turnedId], target: "rotation" });
  await step({ kind: "reset", instanceIds: [turnedId, mirroredId], target: "scale" });
  await step({ kind: "reset", instanceIds: all, target: "both" });
  // Placements must land inside the volume the preflight checks.
  inside(await step({ kind: "center", instanceIds: all }), all);
  inside(await step({ kind: "center", instanceIds: all }), all);
  inside(await step({ kind: "center", instanceIds: [mirroredId] }), [mirroredId]);
  inside(await step({ kind: "scaleToFit", instanceIds: [plainId] }), [plainId]);
  inside(await step({ kind: "scaleToFit", instanceIds: [plainId] }), [plainId]);
  await step({ kind: "layOnFace", instanceId: turnedId, localNormal: [0.3, -0.5, 0.8] });
  await step({ kind: "layOnFacet", instanceId: mirroredId, volumeId: terrainVolume, triangle: 17 });
  await step({ kind: "layOnFacet", instanceId: plainId, volumeId: sphereVolume, triangle: 100 });
  await step({ kind: "arrange", plateId });
  await step({ kind: "arrange", plateId });
  await step({ kind: "dropToBed", instanceIds: all });
  await step({ kind: "dropToBed", instanceIds: [turnedId] });
  inside(await step({ kind: "scaleToFit", instanceIds: all }), all);
  inside(await step({ kind: "center", instanceIds: [turnedId, mirroredId] }), [turnedId, mirroredId]);
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
  controller.dispose?.();
  source.dispose?.();
  return {
    name,
    archive: Buffer.from(archive).toString("base64"),
    opened: { semanticHash: opened.semanticHash, assetFingerprint: opened.assetFingerprint },
    plateId,
    bed: bedReply,
    steps,
    undo,
  };
}

const scenes = [
  await scene("U1", { printable_area: ["0.5x1", "270.5x1", "270.5x271", "0.5x271"], printable_height: "250" }, [200, 210]),
  await scene("far offset", { printable_area: ["180x150", "300x150", "300x260", "180x260"], printable_height: "100" }, [262, 222]),
];

const sources = [
  "tools/cross-platform/placement-edit-vectors.mjs",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/workspace/WorkspaceBed.ts",
  "web/src/workspace/WorkspaceBedExchange.ts",
  "web/src/workspace/ProfilePreflightConstraints.ts",
  "web/src/workspace/AuthoredSlicingTarget.ts",
  "web/src/project/objects/transformOperations.ts",
  "web/src/project/objects/transformCommands.ts",
  "web/src/project/objects/arrange.ts",
  "web/src/project/slicing/preflight.ts",
  "web/src/project/history/commandBus.ts",
  "web/src/project/__tests__/pickingFixture.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    scenes,
  }) + "\n";
const path = new URL("testdata/cross-platform/placement-edit-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Placement edit reference drift");
for (const { name, opened, steps, undo } of scenes) {
  const changed = steps.filter((s, i) => s.semanticHash !== (steps[i - 1] ?? opened).semanticHash).length;
  const refused = steps.filter((s) => s.refusal !== null).length;
  const flagged = steps.filter((s) => s.outside.length > 0).length;
  console.log(
    `Placement edits on ${name}: ${steps.length} steps (${changed} changed the project, ${refused} refused, ` +
      `${flagged} with a model outside the build volume), ${undo.length} undo entries`,
  );
}
