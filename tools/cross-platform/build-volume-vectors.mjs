// Placements against the slice preflight's build volume, as the browser
// workspace makes them on printers whose printable area does not start at the
// bed corner: the Snapmaker U1's bundled profile (its area starts at
// 0.5 × 1 mm; its printable height is 270.05 mm) and an area far from the bed
// corner, whose far corner's half lies outside it (with a plate tower). The
// production `CanonicalWorkspaceController` opens a canonical 3MF of an empty
// project on each bed, with seeded IDs, and makes every placement on the bed
// `WorkspaceBed.ts` reads, as `OrcaWorkspace` passes it: primitives centred on
// the placement area, an arrangement, a bed fill, centring and scaling to the
// build volume (the selection, then the plate's models), and last a model
// import. After each step it records the project's semantic hash, the undo
// label and count, what the workspace reports and the instances the live
// slice preflight (the project as authored) finds outside its build volume —
// none, asserted here — then undoes every entry. A native `ProjectWorkspace`
// replays each journey (`ProjectBuildVolumeChecks`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { primitiveFileName, primitiveGeometry } from "../../web/src/project/objects/primitives.ts";
import { authoredProjectPreflightTarget } from "../../web/src/workspace/AuthoredSlicingTarget.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { geometryBedPlacement } from "../../web/src/workspace/geometryPlacement.ts";
import {
  deriveLiveProfilePreflightConstraints,
  LiveProfileSlicePreflight,
} from "../../web/src/workspace/ProfilePreflightConstraints.ts";
import { wipeTowerKeepOut, workspaceBed } from "../../web/src/workspace/WorkspaceBed.ts";
import { workspaceBedExchange } from "../../web/src/workspace/WorkspaceBedExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";

const serializer = new Bbs3mfProjectSerializer();
const IMPORTED_AT = "2026-10-11T00:00:00.000Z";
const u1 = JSON.parse(read("web/public/profiles/Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json"));
const cubeStl = Buffer.from(
  JSON.parse(read("testdata/cross-platform/model-import-vectors.json")).cases.find((c) => c.name === "stl-binary/cube")
    .bytesBase64,
  "base64",
);

async function journey(name, seed, printer, tower) {
  // Counts the IDs the controller draws before the first step (its own empty project's).
  const seeded = new UuidIdSource(seededRandom(seed));
  const idSource = {
    drawn: 0,
    next(kind) {
      this.drawn += 1;
      return seeded.next(kind);
    },
  };
  const start = createEmptyProject({ idSource: new UuidIdSource(seededRandom(seed + 1)), now: IMPORTED_AT });
  start.config = { ...printer, prime_tower_width: "35" };
  if (tower) start.plates[0].wipeTower = { enabled: true, positionMm: tower, rotationDeg: 0 };
  assertValidProjectState(start);
  const source = new EditorSession({ initialState: start, assets: new InMemoryAssetRepository(), serializer });
  const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource,
    clock: () => IMPORTED_AT,
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [200, 200], worldUnitsPerMm: 0.00175 },
    projectSerializer: serializer,
  });
  assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
  const opened = controller.captureProjectExportGuard();
  const skippedIds = idSource.drawn;
  const plateId = controller.getSummary().activePlateId;
  const config = controller.getSlicingConfiguration().config;
  // The bed as `OrcaWorkspace.placementBed` reads it, and its tower's keep-out.
  const bed = workspaceBed(config);
  const plateTower = () => controller.getSummary().plates.find((plate) => plate.id === plateId)?.wipeTower;
  const keepOut = () => wipeTowerKeepOut(controller.getSlicingConfiguration().config, plateTower());
  const exclusions = () => (keepOut() ? { exclusions: [keepOut()] } : {});
  const bedReply = workspaceBedExchange(JSON.stringify({ config, wipeTower: plateTower() ?? null }));

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
  /** `OrcaWorkspace.selectedInstanceIdsForTransform`, else the active plate's models. */
  const selectedOrPlate = () => {
    const selected = controller.getSummary().selectedInstanceIds;
    if (selected.length > 0) return [...selected];
    const state = controller.createCanonicalSliceSource().capture().state;
    return state.plates
      .find((plate) => plate.id === plateId)
      .objects.flatMap((object) => object.instances.map((instance) => instance.id));
  };
  const steps = [];
  async function step(operation, run) {
    const result = (await run()) ?? null;
    const entry = { operation, result, ...observe() };
    assert.deepEqual(entry.outside, [], `${name}: ${operation.kind} left models outside the build volume`);
    steps.push(entry);
    return result;
  }
  const primitive = (kind) =>
    step({ kind: "primitive", primitive: kind }, async () => {
      const geometry = primitiveGeometry(kind);
      const file = primitiveFileName(kind);
      const added = await controller.importGeometry(geometry, {
        name: file,
        sourceFilename: file,
        transform: geometryBedPlacement(geometry, bed.areaMm),
      });
      return { objectId: added.objectId, instanceId: added.instanceId, reusedAsset: added.reusedAsset };
    });
  const select = (instanceId) =>
    step({ kind: "select", instanceId }, async () => {
      controller.selectInstance(instanceId);
    });
  const deselect = () =>
    step({ kind: "deselect" }, async () => {
      controller.setObjectsTreeSelection([]);
    });

  const cube = await primitive("cube");
  await primitive("sphere");
  await primitive("cylinder");
  await step({ kind: "arrange" }, async () => {
    const arranged = await controller.arrangePlate(plateId, { bedAreaMm: bed.areaMm, ...exclusions() });
    return { placed: arranged.placements.length, unplaced: arranged.unplacedInstanceIds.length };
  });
  await select(cube.instanceId);
  // `OrcaWorkspace.fillPlateWithSelection`: the last selected instance.
  await step({ kind: "fill" }, async () =>
    controller.fillPlateWithInstances(controller.getSummary().selectedInstanceIds.at(-1), {
      bedAreaMm: bed.areaMm,
      ...exclusions(),
    }),
  );
  await deselect();
  await step({ kind: "center" }, async () => {
    const ids = selectedOrPlate();
    await controller.centerInstancesOnPlate(ids, bed.areaMm);
    return { count: ids.length };
  });
  await select(cube.instanceId);
  await step({ kind: "scaleToFit" }, async () => ({
    changed: await controller.scaleInstancesToFitPrintVolume(selectedOrPlate(), bed.volumeMm),
  }));
  await deselect();
  await step({ kind: "scaleToFit" }, async () => ({
    changed: await controller.scaleInstancesToFitPrintVolume(selectedOrPlate(), bed.volumeMm),
  }));
  // Last, as its IDs are drawn where a native import draws its own.
  await step({ kind: "import" }, async () => {
    const prepared = await controller.prepareModelImport(
      cubeStl,
      { filename: "cube.stl" },
      { placement: { bedAreaMm: bed.areaMm, dropToBed: true } },
    );
    await controller.confirmImport(prepared, {
      confirmed: true,
      acknowledgedNoticeIds: [...prepared.preview.requiredAcknowledgementIds],
    });
    return null;
  });

  const undo = [];
  for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
    assert.equal(await controller.undoAsync(), true);
    undo.push(observe());
  }
  assert.equal(undo.at(-1).semanticHash, opened.semanticHash);
  controller.dispose();
  source.dispose?.();
  return {
    name,
    archive: Buffer.from(serialized.bytes).toString("base64"),
    seed,
    skippedIds,
    importedAt: IMPORTED_AT,
    opened: { semanticHash: opened.semanticHash, assetFingerprint: opened.assetFingerprint },
    plateId,
    bed: bedReply,
    steps,
    undo,
  };
}

const journeys = [
  await journey("U1", 0xb01, { printable_area: u1.printable_area, printable_height: u1.printable_height }, null),
  await journey(
    "far offset",
    0xb02,
    { printable_area: ["180x150", "300x150", "300x260", "180x260"], printable_height: "100" },
    [262, 222],
  ),
];

const sources = [
  "tools/cross-platform/build-volume-vectors.mjs",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/project/meshWeld.ts",
  "web/src/workspace/WorkspaceBed.ts",
  "web/src/workspace/WorkspaceBedExchange.ts",
  "web/src/workspace/ProfilePreflightConstraints.ts",
  "web/src/workspace/AuthoredSlicingTarget.ts",
  "web/src/workspace/geometryPlacement.ts",
  "web/src/project/objects/primitives.ts",
  "web/src/project/objects/transformOperations.ts",
  "web/src/project/objects/arrange.ts",
  "web/src/project/import/ModelImportParser.ts",
  "web/src/project/slicing/preflight.ts",
  "web/public/profiles/Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json",
  "testdata/cross-platform/model-import-vectors.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    journeys,
  }) + "\n";
const path = new URL("testdata/cross-platform/build-volume-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Build volume reference drift");
for (const { name, steps, undo } of journeys) {
  console.log(
    `Build volume on ${name}: ${steps.length} steps, none outside the preflight's volume, ${undo.length} undo entries`,
  );
}
