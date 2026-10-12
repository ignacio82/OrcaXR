// Primitives and helper volumes as the production browser creates them, for
// the shared core (`orcaxr_project::primitives`) and its hosts:
//
// - meshes: the six `add_primitive_*` shapes (`primitives.ts`, three's
//   generators, `toNonIndexed`, welded into one closed surface by
//   `meshWeld.ts` as the controller stores them) and the helper-volume cube
//   (`addHelperVolume`'s `createPrimitiveCubeGeometry`) at several sizes, as
//   the canonical mesh payload `CanonicalWorkspaceController` stores — read
//   back from a real controller's repository;
// - plans: what a primitive or a helper volume becomes in a project — the
//   object (`importGeometry` through `prepareGeometryObject`, centred on the
//   printable area — from the bed corner, the U1's offset 0.5 × 1 mm or one
//   far from the corner — by `geometryBedPlacement` as
//   `OrcaWorkspace.addPrimitive` places it,
//   its mesh shared with an asset the project already holds) or the volume
//   added to the selected object, with the IDs drawn in the browser's order —
//   each run on a real controller in a recorded state, then undone;
// - a journey: the production controller opens a canonical 3MF (a U1 bed and
//   a plate tower) and adds every primitive, helper volumes, an instance, a
//   bed fill, copies, cuts and pastes, recording the project's semantic hash
//   and undo label after every step and then undoing them all, so a native
//   `ProjectWorkspace` applying the same steps can be compared after each.
//
// Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { weldTriangleMesh } from "../../web/src/project/meshWeld.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { PRIMITIVE_KINDS, primitiveFileName, primitiveGeometry } from "../../web/src/project/objects/primitives.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { geometryBedPlacement } from "../../web/src/workspace/geometryPlacement.ts";
import { workspaceBed, wipeTowerKeepOut } from "../../web/src/workspace/WorkspaceBed.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";

const serializer = new Bbs3mfProjectSerializer();
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/** The controller's ID source: queued IDs first (a request's), then seeded UUIDs; counts each draw. */
class QueuedIds {
  constructor(seed) {
    this.base = new UuidIdSource(seededRandom(seed));
    this.queue = [];
    this.drawn = 0;
  }
  next(kind) {
    this.drawn += 1;
    return this.queue.length > 0 ? this.queue.shift() : this.base.next(kind);
  }
  /** [count] fresh IDs from the seeded source, queued for the next draws. */
  prepare(count) {
    this.queue = Array.from({ length: count }, () => this.base.next("entity"));
    this.drawn = 0;
    return [...this.queue];
  }
}

let clockValue = "2026-10-10T00:00:00.000Z";
function controllerFor(ids) {
  return CanonicalWorkspaceController.createEmpty({
    idSource: ids,
    clock: () => clockValue,
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [200, 200], worldUnitsPerMm: 0.00175 },
    projectSerializer: serializer,
  });
}
const state = (controller) => controller.session.project.getSnapshot().state;
const hash = (controller) => controller.captureProjectExportGuard().semanticHash;

function findObject(project, objectId) {
  for (const plate of project.plates) for (const object of plate.objects) if (object.id === objectId) return object;
  return undefined;
}
function findVolume(project, volumeId) {
  for (const plate of project.plates)
    for (const object of plate.objects) for (const volume of object.volumes) if (volume.id === volumeId) return volume;
  return undefined;
}
const descriptorOf = (project, assetId) => project.sourceAssets.find((asset) => asset.id === assetId);

/** A printable area: `WorkspaceBed.areaMm`. */
const area = (xMin, yMin, xMax, yMax) => ({ xMin, yMin, xMax, yMax });
const BED = area(0, 0, 200, 200);
const U1 = area(0.5, 1, 270.5, 271);
const FAR = area(180, 150, 300, 260);

/** `OrcaWorkspace.addPrimitive` on [area]: the shape, named after its file, centred on the printable area and resting on the bed. */
async function addPrimitive(controller, kind, sizeMm, area, plateId) {
  const geometry = primitiveGeometry(kind, sizeMm);
  const name = primitiveFileName(kind);
  return controller.importGeometry(geometry, {
    name,
    sourceFilename: name,
    transform: geometryBedPlacement(geometry, area),
    ...(plateId ? { plateId } : {}),
  });
}

/** Sets the controller's selection to [primary] alone (`{kind, id}`), or clears it. */
function select(controller, primary) {
  controller.setObjectsTreeSelection(primary ? [{ kind: primary.kind, id: primary.id }] : [], primary ?? undefined);
}

// --- Meshes ---------------------------------------------------------------------------------

const meshes = [];
const meshRefusals = [];
const SIZES = [20, 1, 7.25, 0.2, 123.456, 1e-3, 6.4e5];
const HELPER_SIZES = [10, 1, 0.5, 33.3, 6.4, 1e4];
async function meshCase(kind, sizeMm) {
  const ids = new QueuedIds(0x9e5 + meshes.length);
  const controller = controllerFor(ids);
  try {
    let assetId;
    if (kind === "helper-cube") {
      const block = await addPrimitive(controller, "cube", 20, BED);
      controller.selectInstance(block.instanceId);
      const added = await controller.addHelperVolume("parameter-modifier", sizeMm);
      assetId = findVolume(state(controller), added.volumeId).source.assetId;
    } else {
      assetId = (await addPrimitive(controller, kind, sizeMm, BED)).assetId;
    }
    const payload = controller.assets.get(assetId);
    const isDefault = kind === "helper-cube" ? sizeMm === 10 : sizeMm === 20;
    meshes.push({
      request: canonicalStringify({ kind, sizeMm }),
      byteLength: payload.bytes.byteLength,
      digest: payload.descriptor.digest,
      triangleCount: payload.descriptor.mesh.triangleCount,
      ...(isDefault ? { payload: base64(payload.bytes) } : {}),
    });
  } finally {
    controller.dispose();
  }
}
for (const kind of PRIMITIVE_KINDS) for (const size of SIZES) await meshCase(kind, size);
for (const size of HELPER_SIZES) await meshCase("helper-cube", size);
for (const [name, request] of [
  ["not JSON", "{"],
  ["not an object", "[]"],
  ["unknown kind", canonicalStringify({ kind: "pyramid", sizeMm: 20 })],
  ["kind case", canonicalStringify({ kind: "Cube", sizeMm: 20 })],
  ["missing size", canonicalStringify({ kind: "cube" })],
  ["missing kind", canonicalStringify({ sizeMm: 20 })],
  ["zero size", canonicalStringify({ kind: "cube", sizeMm: 0 })],
  ["negative size", canonicalStringify({ kind: "sphere", sizeMm: -20 })],
  ["text size", canonicalStringify({ kind: "cube", sizeMm: "20" })],
  ["size beyond float32", canonicalStringify({ kind: "torus", sizeMm: 1e39 })],
  ["extra field", canonicalStringify({ kind: "cube", sizeMm: 20, segments: 4 })],
]) {
  meshRefusals.push({ name, request });
}

// --- Plans over recorded states ------------------------------------------------------------

const states = [];

/** A recorded state the core opens from its document and assets, with the plans answered in it. */
function record(name, controller) {
  const project = state(controller);
  assertValidProjectState(project);
  const entry = {
    name,
    stateJson: canonicalStringify(project),
    assets: controller.assets.list().map((payload) => ({
      descriptorJson: canonicalStringify(payload.descriptor),
      bytes: base64(payload.bytes),
    })),
    plans: [],
  };
  states.push(entry);
  return entry;
}

/** Runs one request on [controller] with its IDs, records the reply, then undoes it. */
async function plan(entry, controller, ids, kind, fields, run) {
  const before = hash(controller);
  const undoCount = controller.getSummary().history.undoCount;
  const request = { ...fields, ids: ids.prepare(fields.idCount ?? (kind === "primitive" ? 4 : 2)) };
  delete request.idCount;
  let reply;
  try {
    reply = await run(request);
    reply.idsUsed = ids.drawn;
  } catch (error) {
    reply = { refusal: error.message };
  }
  ids.queue = [];
  if (controller.getSummary().history.undoCount > undoCount) assert.equal(await controller.undoAsync(), true);
  assert.equal(hash(controller), before, `${entry.name}: ${JSON.stringify(fields)} undoes`);
  entry.plans.push({ kind, request: canonicalStringify(request), reply: canonicalStringify(reply) });
}

async function primitivePlan(entry, controller, ids, fields) {
  await plan(entry, controller, ids, "primitive", fields, async (request) => {
    clockValue = request.importedAt;
    const result = await addPrimitive(controller, request.kind, request.sizeMm, request.areaMm, request.plateId ?? undefined);
    const project = state(controller);
    return {
      assetJson: canonicalStringify(descriptorOf(project, result.assetId)),
      objectJson: canonicalStringify(findObject(project, result.objectId)),
      plateId: result.plateId,
      reusedAsset: result.reusedAsset,
    };
  });
}

async function helperPlan(entry, controller, ids, fields) {
  await plan(entry, controller, ids, "helper", fields, async (request) => {
    select(controller, request.primary);
    const added = await controller.addHelperVolume(request.role, request.sizeMm);
    const project = state(controller);
    const volume = findVolume(project, added.volumeId);
    return {
      assetJson: canonicalStringify(descriptorOf(project, volume.source.assetId)),
      objectId: added.objectId,
      volumeJson: canonicalStringify(volume),
    };
  });
}

const ROLES = ["parameter-modifier", "support-enforcer", "support-blocker", "negative-volume"];

// An empty project: every shape on a default bed, the U1's area and a far one, an unknown plate, no target.
{
  const ids = new QueuedIds(0xe0);
  const controller = controllerFor(ids);
  const entry = record("empty", controller);
  const plateId = state(controller).activePlateId;
  for (const kind of PRIMITIVE_KINDS)
    await primitivePlan(entry, controller, ids, { kind, sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, { kind: "cube", sizeMm: 20, areaMm: U1, plateId, importedAt: "2026-10-10T08:30:15.250Z" });
  await primitivePlan(entry, controller, ids, { kind: "disc", sizeMm: 7.25, areaMm: area(0, 0, 0.5, 1e6), plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, { kind: "torus", sizeMm: 123.456, areaMm: area(0, 0, -40, 33.3), plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, {
    kind: "cube",
    sizeMm: 20,
    areaMm: BED,
    plateId: "import:plate:missing",
    importedAt: clockValue,
  });
  await helperPlan(entry, controller, ids, { role: "parameter-modifier", sizeMm: 10, primary: null });
  await helperPlan(entry, controller, ids, { role: "support-blocker", sizeMm: 10, primary: { kind: "plate", id: plateId } });
  // Areas offset from the bed corner: centred on the midpoint of their corners.
  await primitivePlan(entry, controller, ids, { kind: "cone", sizeMm: 20, areaMm: FAR, plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, { kind: "sphere", sizeMm: 9.5, areaMm: area(-120.25, -80.5, 99.75, 120.5), plateId: null, importedAt: clockValue });
  controller.dispose();
}

// Primitives already in the project, on two plates, with helper volumes and a height range.
{
  const ids = new QueuedIds(0xe1);
  const controller = controllerFor(ids);
  const plateOne = state(controller).activePlateId;
  const cube = await addPrimitive(controller, "cube", 20, BED);
  const torus = await addPrimitive(controller, "torus", 20, U1);
  await controller.addPlate(undefined, { activate: false });
  const plates = state(controller).plates;
  controller.selectInstance(torus.instanceId);
  const modifier = await controller.addHelperVolume("parameter-modifier");
  controller.selectInstance(torus.instanceId);
  await controller.addHelperVolume("parameter-modifier");
  controller.selectInstance(cube.instanceId);
  const range = await controller.addHeightRange(0, 4);
  assert.equal(state(controller).activePlateId, plateOne);
  const entry = record("primitives", controller);
  for (const kind of PRIMITIVE_KINDS)
    await primitivePlan(entry, controller, ids, { kind, sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, { kind: "torus", sizeMm: 20, areaMm: U1, plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, { kind: "cube", sizeMm: 19.999, areaMm: U1, plateId: null, importedAt: clockValue });
  if (plates.length > 1)
    await primitivePlan(entry, controller, ids, { kind: "cube", sizeMm: 20, areaMm: U1, plateId: plates[1].id, importedAt: clockValue });
  // Fewer IDs than a new asset needs are enough when the mesh is shared.
  await primitivePlan(entry, controller, ids, { kind: "cube", sizeMm: 20, areaMm: U1, plateId: null, importedAt: clockValue, idCount: 3 });
  for (const role of ROLES) {
    await helperPlan(entry, controller, ids, { role, sizeMm: 10, primary: { kind: "instance", id: cube.instanceId } });
  }
  await helperPlan(entry, controller, ids, { role: "parameter-modifier", sizeMm: 10, primary: { kind: "object", id: torus.objectId } });
  await helperPlan(entry, controller, ids, { role: "parameter-modifier", sizeMm: 25, primary: { kind: "volume", id: modifier.volumeId } });
  await helperPlan(entry, controller, ids, { role: "support-enforcer", sizeMm: 0.5, primary: { kind: "instance", id: torus.instanceId } });
  await helperPlan(entry, controller, ids, { role: "support-blocker", sizeMm: 10, primary: { kind: "layer-range", id: range.layerRangeId } });
  await helperPlan(entry, controller, ids, { role: "support-blocker", sizeMm: 10, primary: { kind: "plate", id: plateOne } });
  controller.dispose();
}

/** A state authored directly — assets under chosen IDs — opened through the canonical 3MF as the browser opens it. */
async function authored(name, seed, build) {
  const ids = new QueuedIds(seed);
  const project = createEmptyProject({ idSource: new UuidIdSource(seededRandom(seed)), now: "2026-10-10T00:00:00.000Z" });
  const assets = new InMemoryAssetRepository();
  build(project, assets);
  assertValidProjectState(project);
  const source = new EditorSession({ initialState: project, assets, serializer });
  const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
  const controller = controllerFor(ids);
  assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
  assert.equal(hash(controller), source.captureExportGuard().semanticHash, `${name} opens as authored`);
  return { controller, ids, entry: record(name, controller) };
}

/** The cube primitive's payload under [id], as a project would hold it. */
/** The cube's mesh as the controller stores it: its triangle list welded. */
function cubePayload(id, extra = {}) {
  const geometry = primitiveGeometry("cube");
  const soup = Float32Array.from(geometry.getAttribute("position").array);
  const corners = Uint32Array.from({ length: soup.length / 3 }, (_, i) => i);
  const { positions, indices } = weldTriangleMesh(soup, corners);
  return encodeIndexedMeshAsset({ id, positions, indices, ...extra });
}
function objectFor(project, objectId, assetPayload, triangleCount) {
  project.plates[0].objects.push({
    id: objectId,
    name: objectId,
    config: {},
    volumes: [
      {
        id: `${objectId}:volume`.replace("object", "volume"),
        name: "Part",
        role: "model",
        source: { assetId: assetPayload.descriptor.id, topologyRevision: 0, triangleCount },
        transform: { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        config: {},
        annotations: { topologyRevision: 0, color: [], support: [], seam: [], fuzzySkin: [], brim: [] },
      },
    ],
    instances: [
      {
        id: `${objectId}:instance`.replace("object", "instance"),
        transform: { translationMm: [50, 50, 10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        printable: true,
      },
    ],
    layerRanges: [],
  });
}

// Two assets carry the cube's mesh: the one first in code-unit order is shared,
// whatever the runtime's locale would sort first (`B` before `a`).
{
  const { controller, ids, entry } = await authored("shared twins", 0xe2, (project, assets) => {
    for (const [objectId, assetId] of [
      ["import:object:a", "import:asset:a"],
      ["import:object:B", "import:asset:B"],
    ]) {
      const payload = cubePayload(assetId, { sourceFilename: "twin.stl" });
      assets.put(payload.descriptor, payload.bytes);
      project.sourceAssets.push(payload.descriptor);
      objectFor(project, objectId, payload, 12);
    }
  });
  await primitivePlan(entry, controller, ids, { kind: "cube", sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue });
  await primitivePlan(entry, controller, ids, { kind: "cone", sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue });
  controller.dispose();
}

// An asset with the cube's bytes but another layout is no mesh to share: refused,
// unless a compatible one follows it.
for (const [name, seed, compatible] of [
  ["foreign layout", 0xe3, false],
  ["foreign layout and twin", 0xe4, true],
]) {
  const { controller, ids, entry } = await authored(name, seed, (project, assets) => {
    const indexed = cubePayload("import:asset:indexed");
    // The same bytes read as 12 vertices and 8 triangles (the cube's 8 corners,
    // then its first 12 indices as coordinates): one digest, another topology.
    const bytes = indexed.bytes.slice().buffer;
    const unindexed = encodeIndexedMeshAsset({
      id: "import:asset:a-unindexed",
      positions: new Float32Array(bytes, 0, 36),
      indices: new Uint32Array(bytes, 144, 24),
    });
    assert.equal(unindexed.descriptor.digest, indexed.descriptor.digest);
    assets.put(unindexed.descriptor, unindexed.bytes);
    project.sourceAssets.push(unindexed.descriptor);
    objectFor(project, "import:object:unindexed", unindexed, 8);
    if (compatible) {
      assets.put(indexed.descriptor, indexed.bytes);
      project.sourceAssets.push(indexed.descriptor);
      objectFor(project, "import:object:indexed", indexed, 12);
    }
  });
  await primitivePlan(entry, controller, ids, { kind: "cube", sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue });
  controller.dispose();
}

// Requests the exchange itself refuses (shape, IDs, kinds), whatever the state.
const planRefusals = [
  ["primitive", "not JSON", "{"],
  ["primitive", "helper kind", { kind: "helper-cube", sizeMm: 10, areaMm: BED, plateId: null, importedAt: clockValue, ids: [] }],
  ["primitive", "too few IDs", { kind: "sphere", sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue, ids: ["import:id:1"] }],
  ["primitive", "unstable ID", { kind: "sphere", sizeMm: 20, areaMm: BED, plateId: null, importedAt: clockValue, ids: ["a", "b", "c", "d"] }],
  ["primitive", "area without a corner", { kind: "cube", sizeMm: 20, areaMm: { xMin: 0, yMin: 0, xMax: 200 }, plateId: null, importedAt: clockValue, ids: [] }],
  ["primitive", "infinite area", { kind: "cube", sizeMm: 20, areaMm: { ...BED, yMax: null }, plateId: null, importedAt: clockValue, ids: [] }],
  ["primitive", "area as a list", { kind: "cube", sizeMm: 20, areaMm: [0, 0, 200, 200], plateId: null, importedAt: clockValue, ids: [] }],
  ["primitive", "area with an extra corner", { kind: "cube", sizeMm: 20, areaMm: { ...BED, zMin: 0 }, plateId: null, importedAt: clockValue, ids: [] }],
  ["primitive", "bed size", { kind: "cube", sizeMm: 20, bedMm: [200, 200], plateId: null, importedAt: clockValue, ids: [] }],
  ["primitive", "missing time", { kind: "cube", sizeMm: 20, areaMm: BED, plateId: null, ids: [] }],
  ["primitive", "numeric plate", { kind: "cube", sizeMm: 20, areaMm: BED, plateId: 1, importedAt: clockValue, ids: [] }],
  ["helper", "unknown role", { role: "model", sizeMm: 10, primary: null, ids: [] }],
  ["helper", "zero size", { role: "support-blocker", sizeMm: 0, primary: null, ids: [] }],
  ["helper", "unknown kind", { role: "support-blocker", sizeMm: 10, primary: { kind: "thing", id: "x" }, ids: [] }],
  ["helper", "extra field", { role: "support-blocker", sizeMm: 10, primary: null, ids: [], name: "x" }],
].map(([kind, name, request]) => ({ kind, name, request: typeof request === "string" ? request : canonicalStringify(request) }));
// Too few IDs for a helper volume refuses only once a target is found.
planRefusals.push({
  kind: "helper",
  name: "too few IDs",
  state: "primitives",
  request: canonicalStringify({
    role: "parameter-modifier",
    sizeMm: 10,
    primary: { kind: "object", id: JSON.parse(states[1].stateJson).plates[0].objects[0].id },
    ids: ["import:asset:only"],
  }),
});

// --- Journey ----------------------------------------------------------------------------

const JOURNEY_SEED = 0xc4ea7e;
const journey = await (async () => {
  // Counts the IDs the controller draws before the first step (its own empty project's).
  const seeded = new UuidIdSource(seededRandom(JOURNEY_SEED));
  const idSource = {
    drawn: 0,
    next(kind) {
      this.drawn += 1;
      return seeded.next(kind);
    },
  };
  const start = createEmptyProject({ idSource: new UuidIdSource(seededRandom(7)), now: "2026-10-10T00:00:00.000Z" });
  start.config = {
    printable_area: ["0.5x1", "270.5x1", "270.5x271", "0.5x271"],
    printable_height: "250",
    prime_tower_width: "35",
  };
  start.plates[0].wipeTower = { enabled: true, positionMm: [200, 210], rotationDeg: 0 };
  assertValidProjectState(start);
  const source = new EditorSession({ initialState: start, assets: new InMemoryAssetRepository(), serializer });
  const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
  clockValue = "2026-10-10T00:00:00.000Z";
  const controller = controllerFor(idSource);
  assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
  const opened = controller.captureProjectExportGuard();
  const config = controller.getSlicingConfiguration().config;
  // The bed the workspace draws, and the area it places and fills on (`OrcaWorkspace.placementBed`).
  const bed = workspaceBed(config).sizeMm;
  const { areaMm } = workspaceBed(config);
  const plateId = state(controller).activePlateId;

  const observe = () => {
    const { history } = controller.getSummary();
    return { semanticHash: hash(controller), undoCount: history.undoCount, undoLabel: history.undoLabel ?? null };
  };
  const skippedIds = idSource.drawn;
  const steps = [];
  const made = {};
  async function step(operation, run) {
    let result = null;
    let refusal = null;
    try {
      result = (await run()) ?? null;
    } catch (error) {
      refusal = error.message;
    }
    steps.push({ operation, result, refusal, ...observe() });
    return result;
  }
  const primitive = (kind) =>
    step({ kind: "primitive", primitive: kind }, async () => {
      const added = await addPrimitive(controller, kind, 20, areaMm);
      return { objectId: added.objectId, instanceId: added.instanceId, reusedAsset: added.reusedAsset };
    });
  const choose = (instanceId) =>
    step({ kind: "select", instanceId }, async () => {
      controller.selectInstance(instanceId);
    });
  const helper = (role) =>
    step({ kind: "helper", role }, async () => {
      const added = await controller.addHelperVolume(role);
      return { objectId: added.objectId, volumeId: added.volumeId };
    });

  for (const kind of PRIMITIVE_KINDS) made[kind] = await primitive(kind);
  made.cubeAgain = await primitive("cube");
  await choose(made.cube.instanceId);
  await helper("parameter-modifier");
  // The modifier is selected now; a helper volume goes to its object all the same.
  await helper("support-enforcer");
  await choose(made.cube.instanceId);
  await helper("support-blocker");
  await helper("parameter-modifier");
  await choose(made.cone.instanceId);
  made.coneCopy = await step({ kind: "addInstance" }, async () => {
    const copy = await controller.duplicateSelectedInstance();
    return copy ? { instanceId: copy.instanceId } : null;
  });
  // Fill as `OrcaWorkspace.fillPlateWithSelection`: the last selected instance, the bed, the active plate's tower.
  const fill = () =>
    step({ kind: "fill" }, async () => {
      const primary = controller.getSummary().selectedInstanceIds.at(-1);
      if (!primary) return null;
      const plate = controller.getSummary().plates.find((candidate) => candidate.id === plateId);
      const keepOut = wipeTowerKeepOut(controller.getSlicingConfiguration().config, plate?.wipeTower);
      return controller.fillPlateWithInstances(primary, { bedAreaMm: areaMm, ...(keepOut ? { exclusions: [keepOut] } : {}) });
    });
  await choose(made.disc.instanceId);
  await fill();
  await choose(made.sphere.instanceId);
  await step({ kind: "copy" }, async () => controller.copySelectedObject() ?? null);
  made.sphereCopy = await step({ kind: "paste" }, async () => (await controller.pasteClipboard()) ?? null);
  made.sphereCopy2 = await step({ kind: "paste" }, async () => (await controller.pasteClipboard()) ?? null);
  await choose(made.cubeAgain.instanceId);
  await step({ kind: "cut" }, async () => (await controller.cutSelectedObject()) ?? null);
  await step({ kind: "paste" }, async () => (await controller.pasteClipboard()) ?? null);
  await choose(made.coneCopy.instanceId);
  await step({ kind: "cut" }, async () => (await controller.cutSelectedObject()) ?? null);
  await step({ kind: "paste" }, async () => (await controller.pasteClipboard()) ?? null);
  // Nothing selected: no helper target, no instance to copy or fill with.
  await step({ kind: "deselect" }, async () => {
    controller.setObjectsTreeSelection([]);
  });
  await helper("support-blocker");
  await step({ kind: "addInstance" }, async () => {
    const copy = await controller.duplicateSelectedInstance();
    return copy ? { instanceId: copy.instanceId } : null;
  });
  await fill();
  await step({ kind: "copy" }, async () => controller.copySelectedObject() ?? null);

  const undo = [];
  for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
    assert.equal(await controller.undoAsync(), true);
    undo.push(observe());
  }
  assert.equal(undo.at(-1).semanticHash, opened.semanticHash);
  controller.dispose();
  return {
    archive: base64(serialized.bytes),
    seed: JOURNEY_SEED,
    skippedIds,
    importedAt: clockValue,
    opened: { semanticHash: opened.semanticHash, assetFingerprint: opened.assetFingerprint },
    bed,
    steps,
    undo,
  };
})();

const sources = [
  "tools/cross-platform/primitive-vectors.mjs",
  "web/src/project/objects/primitives.ts",
  "web/src/workspace/geometryPlacement.ts",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/project/meshWeld.ts",
  "web/src/workspace/WorkspaceBed.ts",
  "web/src/workspace/ProfilePreflightConstraints.ts",
  "web/src/project/meshCodec.ts",
  "web/src/project/commands.ts",
  "web/src/project/objects/commands.ts",
  "web/src/project/objects/semanticVolumeCommands.ts",
  "web/src/project/objects/arrange.ts",
  "web/src/project/StagedProjectCommands.ts",
  "web/node_modules/three/package.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    meshes,
    meshRefusals,
    states,
    planRefusals,
    journey,
  }) + "\n";
const path = new URL("testdata/cross-platform/primitive-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Primitive reference drift");
const plans = states.flatMap((s) => s.plans);
console.log(
  `Primitive references: ${meshes.length} meshes (${meshRefusals.length} refusals), ` +
    `${plans.length} plans over ${states.length} states (${plans.filter((p) => p.reply.startsWith('{"refusal"')).length} refused, ` +
    `${planRefusals.length} malformed), journey of ${journey.steps.length} steps and ${journey.undo.length} undo entries`,
);
