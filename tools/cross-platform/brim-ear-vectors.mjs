// Brim-ear detection references from the production browser
// (`brimEarExchange.ts` over `brimEarDetection.ts` and `brimEarPreview.ts`):
// objects whose model parts are recentred split parts, a pyramid whose sides
// are single triangles, a plus with inward corners, a smooth prism, a part
// turned, scaled and mirrored by its own transform, a part with a modifier
// beside it, a flat sheet and a notch whose
// corners collide — detected under default and explicit angles, thinning
// radii, ear radii and cut heights; then placed ears checked for the ones
// stranded (touching, chained through other ears, and islands), with every
// refusal; and each object's view (`brimEarViewWire`: its ears, the stranded
// ones and the base a placed ear sits on). Replayed by Rust, by WASM in Node
// and Chrome, and over JNI.
//
// Then a journey: the production `CanonicalWorkspaceController` opens a
// canonical 3MF and runs the workspace's brim-ear tool as `OrcaWorkspace`
// does — the one object the selection's model parts belong to
// (`brimEarTargetObject`), taps on its parts placed in the object's frame
// through three.js (`worldToLocal`) at its base, automatic placement by the
// detector, removal, clearing and the cases that place nothing — recording
// the semantic hash, undo label and the target's view after every step, then
// undoing them all; the Android `ProjectWorkspace` takes the same steps.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { getThreeProjectEntity } from "../../web/src/project/surfaces/ThreeProjectSurface.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { DEFAULT_BRIM_EAR_DETECTION, detectBrimEars } from "../../web/src/project/objects/brimEarDetection.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  brimEarViewWire,
  detectObjectBrimEarsWire,
  strandedObjectBrimEarsWire,
} from "../../web/src/project/objects/brimEarExchange.ts";
import {
  decodeProjectBrimEarDetectRequest,
  decodeProjectBrimEarStrandedRequest,
  decodeProjectBrimEarViewRequest,
  encodeProjectBrimEarDetectReply,
  encodeProjectBrimEarDetectRequest,
  encodeProjectBrimEarStrandedReply,
  encodeProjectBrimEarStrandedRequest,
  encodeProjectBrimEarViewReply,
  encodeProjectBrimEarViewRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// --- Meshes ---------------------------------------------------------------------
// A prism over a 2-D outline (counter-clockwise): fan caps about the first
// point and quad walls of two triangles each.
function prism(outline, height, base = 0) {
  const n = outline.length;
  const vertices = [
    ...outline.map(([x, y]) => [x, y, base]),
    ...outline.map(([x, y]) => [x, y, base + height]),
  ];
  const triangles = [];
  for (let i = 1; i + 1 < n; i++)
    triangles.push([0, i + 1, i], [n, n + i, n + i + 1]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return { vertices, triangles };
}
const square = (x, y, size) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
// Recentred, as split parts are: each centred on its own box.
const recentred = (mesh) => {
  const lo = [0, 1, 2].map((k) => Math.min(...mesh.vertices.map((v) => v[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...mesh.vertices.map((v) => v[k])));
  const centre = lo.map((v, k) => (v + hi[k]) / 2);
  return {
    mesh: {
      ...mesh,
      vertices: mesh.vertices.map((v) => v.map((c, k) => c - centre[k])),
    },
    centre,
  };
};
const pyramid = {
  vertices: [
    [0, 0, 0],
    [20, 0, 0],
    [20, 20, 0],
    [0, 20, 0],
    [10, 10, 15],
  ],
  triangles: [
    [0, 2, 1],
    [0, 3, 2],
    [0, 1, 4],
    [1, 2, 4],
    [2, 3, 4],
    [3, 0, 4],
  ],
};
const plus = prism(
  [
    [5, 0],
    [10, 0],
    [10, 5],
    [15, 5],
    [15, 10],
    [10, 10],
    [10, 15],
    [5, 15],
    [5, 10],
    [0, 10],
    [0, 5],
    [5, 5],
  ],
  8,
);
const smooth = prism(
  Array.from({ length: 48 }, (_, i) => [
    10 * Math.cos((2 * Math.PI * i) / 48),
    10 * Math.sin((2 * Math.PI * i) / 48),
  ]),
  6,
);
const notch = prism(
  [
    [0, 0],
    [12, 0],
    [12, 5],
    [12.6, 5],
    [12.6, 5.5],
    [12, 5.5],
    [12, 12],
    [0, 12],
  ],
  5,
);
const sheet = {
  vertices: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
  ],
};
const big = recentred(prism(square(0, 0, 10), 10));
const small = recentred(prism(square(20, 2, 6), 6));
const meshes = {
  big: big.mesh,
  small: small.mesh,
  pyramid,
  plus,
  smooth,
  notch,
  sheet,
  cube: prism(square(0, 0, 8), 8),
};
const payloads = Object.fromEntries(
  Object.entries(meshes).map(([name, mesh]) => [
    name,
    encodeIndexedMeshAsset({
      id: `import:asset:brim-${name}`,
      positions: mesh.vertices.flat(),
      indices: mesh.triangles.flat(),
    }),
  ]),
);

// --- The project -------------------------------------------------------------
const fixture = createProjectFixture();
const state = structuredClone(fixture.state);
const template = state.plates[0].objects[0];
const identity = {
  translationMm: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};
const volume = (name, mesh, extra = {}) => ({
  id: `import:volume:brim-${name}`,
  name,
  role: "model",
  source: {
    assetId: payloads[mesh].descriptor.id,
    topologyRevision: 0,
    triangleCount: payloads[mesh].descriptor.mesh.triangleCount,
  },
  transform: identity,
  config: {},
  annotations: emptyFacetAnnotations(0),
  ...extra,
});
const turn = Math.PI / 12;
const objects = {
  split: [
    volume("big", "big", {
      transform: { ...identity, translationMm: big.centre },
    }),
    volume("small", "small", {
      transform: { ...identity, translationMm: small.centre },
    }),
  ],
  pyramid: [volume("pyramid", "pyramid")],
  plus: [volume("plus", "plus")],
  smooth: [volume("smooth", "smooth")],
  turned: [
    volume("turned", "cube", {
      transform: {
        translationMm: [3, -2, 1],
        rotation: [0, 0, Math.sin(turn), Math.cos(turn)],
        scale: [-1.5, 1, 0.5],
      },
    }),
  ],
  modified: [
    volume("modified", "cube"),
    volume("modifier", "big", {
      role: "parameter-modifier",
      transform: { ...identity, translationMm: [30, 0, 5] },
    }),
  ],
  sheet: [volume("sheet", "sheet")],
  notch: [volume("notch", "notch")],
};
const ears = {
  split: [
    { positionMm: [0, 0, 0], headFrontRadiusMm: 3 },
    { positionMm: [-6, 5, 0], headFrontRadiusMm: 2 },
    { positionMm: [-9.5, 5, 0], headFrontRadiusMm: 2 },
    { positionMm: [40, 40, 0], headFrontRadiusMm: 4 },
    { positionMm: [23, 5, 0], headFrontRadiusMm: 1 },
  ],
  plus: [
    { positionMm: [7.5, 7.5, 0], headFrontRadiusMm: 1 },
    { positionMm: [20, 7.5, 0], headFrontRadiusMm: 4.9 },
    { positionMm: [20, 7.5, 0], headFrontRadiusMm: 5.1 },
  ],
  pyramid: [{ positionMm: [-5, -5, 0], headFrontRadiusMm: 5 }],
};
state.plates[0].objects = Object.entries(objects).map(([name, volumes], i) => ({
  ...structuredClone(template),
  id: `import:object:brim-${name}`,
  name,
  layerRanges: [],
  volumes,
  instances: [
    {
      id: `import:instance:brim-${name}`,
      transform: { ...identity, translationMm: [30 * i + 15, 40, 0] },
      printable: true,
    },
  ],
  ...(ears[name] ? { brimEars: ears[name] } : {}),
}));
state.sourceAssets = Object.values(payloads).map((a) => a.descriptor);
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const a of Object.values(payloads)) assets.put(a.descriptor, a.bytes);

// --- Requests -------------------------------------------------------------------
const steps = [];
const absent = { absent: {} };
function detect(object, extra = {}) {
  const text = encodeProjectBrimEarDetectRequest({
    objectId: units(`import:object:brim-${object}`),
    maxAngleDeg: 125,
    detectionRadiusMm: 1,
    headFrontRadiusMm: 5,
    sampleHeightMm: absent,
    ...extra,
  });
  steps.push({
    detect: text,
    reply: encodeProjectBrimEarDetectReply(
      detectObjectBrimEarsWire(
        state,
        assets,
        decodeProjectBrimEarDetectRequest(text),
      ),
    ),
  });
}
function stranded(object) {
  const text = encodeProjectBrimEarStrandedRequest({
    objectId: units(`import:object:brim-${object}`),
  });
  steps.push({
    stranded: text,
    reply: encodeProjectBrimEarStrandedReply(
      strandedObjectBrimEarsWire(
        state,
        assets,
        decodeProjectBrimEarStrandedRequest(text),
      ),
    ),
  });
}
function view(object) {
  const text = encodeProjectBrimEarViewRequest({
    objectId: units(`import:object:brim-${object}`),
  });
  steps.push({
    view: text,
    reply: encodeProjectBrimEarViewReply(
      brimEarViewWire(state, assets, decodeProjectBrimEarViewRequest(text)),
    ),
  });
}
for (const object of [...Object.keys(objects), "missing"]) {
  detect(object);
  stranded(object);
  view(object);
}
for (const object of ["split", "plus", "notch", "turned", "smooth"]) {
  detect(object, { maxAngleDeg: 90 });
  detect(object, { maxAngleDeg: 170, headFrontRadiusMm: 3 });
  detect(object, { detectionRadiusMm: 5 });
  detect(object, { sampleHeightMm: { value: 1 } });
  detect(object, { sampleHeightMm: { value: 50 } });
}
detect("pyramid", { sampleHeightMm: { value: 7.5 } });
detect("plus", { maxAngleDeg: 0 });
detect("split", { maxAngleDeg: 89.9 });
detect("notch", { detectionRadiusMm: 13 });
detect("plus", { detectionRadiusMm: 8 });
detect("turned", { detectionRadiusMm: 9, headFrontRadiusMm: 2.5 });

// --- The journey ----------------------------------------------------------------
process.env.TZ = "UTC";
const NOW = "2026-10-12T00:00:00.000Z";
const serializer = new Bbs3mfProjectSerializer();
const at = (x, y, z = 0, extra = {}) => ({ ...identity, translationMm: [x, y, z], ...extra });
const turnedBy = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
// The fixture's object without its filament: the journey's project has its own.
const { filamentId: _filament, ...journeyTemplate } = template;
const journeyObject = (key, volumes, instances) => ({
  ...structuredClone(journeyTemplate),
  id: `import:object:journey-${key}`,
  name: key,
  layerRanges: [],
  volumes: volumes.map(([name, mesh, extra]) => ({
    ...volume(name, mesh, extra),
    id: `import:volume:journey-${name}`,
  })),
  instances: instances.map((transform, i) => ({
    id: `import:instance:journey-${key}-${i + 1}`,
    transform,
    printable: true,
  })),
});
const journeyState = createEmptyProject({ idSource: new UuidIdSource(seededRandom(0xb41e)), now: NOW });
journeyState.config = { printable_area: ["0.5x1", "270.5x1", "270.5x271", "0.5x271"], printable_height: "270" };
journeyState.plates[0].objects = [
  journeyObject(
    "split",
    [
      ["big", "big", { transform: { ...identity, translationMm: big.centre } }],
      // Lifted 3 mm off the bed: an ear tapped onto it sits at the base, reaching nothing.
      ["small", "small", { transform: { ...identity, translationMm: [small.centre[0], small.centre[1], small.centre[2] + 3] } }],
    ],
    [at(60, 60)],
  ),
  journeyObject(
    "turned",
    [["turned", "cube", { transform: at(2, -3, 1.5, { rotation: turnedBy(Math.PI / 12) }) }]],
    [at(130, 60), at(190, 110, 0, { rotation: turnedBy(Math.PI / 6), scale: [1.5, 1.5, 1.5] })],
  ),
  journeyObject("smooth", [["smooth", "smooth"]], [at(60, 160)]),
  journeyObject("sheet", [["sheet", "sheet"]], [at(160, 200)]),
];
journeyState.sourceAssets = ["big", "small", "cube", "smooth", "sheet"].map((name) => payloads[name].descriptor);
assertValidProjectState(journeyState);
const journeyAssets = new InMemoryAssetRepository();
for (const name of ["big", "small", "cube", "smooth", "sheet"]) journeyAssets.put(payloads[name].descriptor, payloads[name].bytes);
const source = new EditorSession({ initialState: journeyState, assets: journeyAssets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0xb42e)),
  clock: () => NOW,
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
const opened = controller.captureProjectExportGuard();
const live = () => controller.session.project.getSnapshot().state;
const observe = () => {
  const { history } = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: history.undoCount,
    undoLabel: history.undoLabel ?? null,
  };
};
/** `OrcaWorkspace.brimEarTargetObject` over `paintableSelectedVolumes`: the one object owning the
 * active plate's model parts the selection takes (all of them when nothing is), or none. */
function target() {
  const state = live();
  const refs = controller.session.selection.getSnapshot().refs;
  const volumes = new Set(refs.filter((r) => r.kind === "volume").map((r) => r.id));
  const instances = new Set(refs.filter((r) => r.kind === "instance").map((r) => r.id));
  const plate = state.plates.find((p) => p.id === state.activePlateId);
  const targets = [];
  for (const o of plate.objects)
    for (const instance of o.instances)
      for (const v of o.volumes) if (v.role === "model") targets.push({ volumeId: v.id, objectId: o.id, instanceId: instance.id });
  const objects = new Set([
    ...refs.filter((r) => r.kind === "object").map((r) => r.id),
    ...targets.filter((t) => instances.has(t.instanceId)).map((t) => t.objectId),
  ]);
  const all = volumes.size === 0 && objects.size === 0;
  const chosen = new Set(targets.filter((t) => all || volumes.has(t.volumeId) || objects.has(t.objectId)).map((t) => t.objectId));
  return chosen.size === 1 ? [...chosen][0] : null;
}
const viewOf = (objectId) =>
  objectId === null
    ? null
    : encodeProjectBrimEarViewReply(brimEarViewWire(live(), controller.assets, { objectId: units(objectId) }));
const journeySteps = [];
async function step(operation, run) {
  const result = (await run()) ?? null;
  const objectId = target();
  journeySteps.push({ operation, result, target: objectId, view: viewOf(objectId), ...observe() });
}
const choose = (entity, id) =>
  step({ kind: "select", entity, id }, async () => {
    controller.setObjectsTreeSelection(entity === null ? [] : [{ kind: entity, id }]);
  });
/** `OrcaWorkspace.placeBrimEar`: a tap on [volumeId] of [instanceId] at a point in the part's own millimetres, read
 * in the instance's frame (`worldToLocal`) and placed at the object's base. */
const tap = (instanceId, volumeId, point, radiusMm) =>
  step({ kind: "tap", instanceId, volumeId, point, radiusMm }, async () => {
    const objectId = target();
    const root = controller.surface.root;
    root.updateMatrixWorld(true);
    const instance = root.children.find((group) => getThreeProjectEntity(group)?.instanceId === instanceId);
    const display = instance.children.find((child) => getThreeProjectEntity(child)?.volumeId === volumeId);
    const local = instance.worldToLocal(display.localToWorld(new THREE.Vector3(...point)));
    const baseZ = controller.getBrimEarView(objectId)?.baseZMm ?? local.z;
    await controller.addBrimEar(objectId, { positionMm: [local.x, local.y, baseZ], headFrontRadiusMm: radiusMm });
    return { objectId, objectPoint: [local.x, local.y, local.z] };
  });
/** `OrcaWorkspace.autoPlaceBrimEars`. */
const auto = (radiusMm) =>
  step({ kind: "auto", radiusMm }, async () => {
    const objectId = target();
    if (!objectId) return { outcome: "noTarget" };
    const mesh = controller.getObjectModelMesh(objectId);
    if (!mesh || mesh.indices.length === 0) return { outcome: "noGeometry" };
    const detected = detectBrimEars(mesh.positions, mesh.indices, { ...DEFAULT_BRIM_EAR_DETECTION, headFrontRadiusMm: radiusMm });
    if (detected.ears.length === 0) return { outcome: "noEars", reason: detected.reason ?? null };
    await controller.addBrimEars(objectId, detected.ears.map((ear) => ear.point));
    return { outcome: "placed", count: detected.ears.length };
  });
/** `OrcaWorkspace.clearBrimEars`. */
const clear = () =>
  step({ kind: "clear" }, async () => {
    const objectId = target();
    if (!objectId) return { outcome: "noTarget" };
    if (controller.getBrimEars(objectId).length === 0) return { outcome: "noEars" };
    await controller.clearBrimEars(objectId);
    return { outcome: "cleared" };
  });
/** `OrcaWorkspace.removeBrimEar`. */
const remove = (index) =>
  step({ kind: "remove", index }, async () => {
    const objectId = target();
    if (!objectId) return { removed: false };
    await controller.removeBrimEar(objectId, index);
    return { removed: true };
  });
const journeyId = (kind, key) => `import:${kind}:journey-${key}`;

// The split parts: a tap on the lifted small part's top (its ear reaches nothing: stranded), one on the big part's
// side half-way up (it still sits at the base), corners found by the detector, one removed, all cleared, and a
// clear with nothing to clear.
await choose("instance", journeyId("instance", "split-1"));
await tap(journeyId("instance", "split-1"), journeyId("volume", "small"), [0, 0, 3], 5);
await tap(journeyId("instance", "split-1"), journeyId("volume", "big"), [5, 1.5, 0], 2.5);
await auto(3);
await remove(1);
await clear();
await clear();
// The turned part, tapped on its scaled, rotated second instance; then its corners.
await choose("instance", journeyId("instance", "turned-2"));
await tap(journeyId("instance", "turned-2"), journeyId("volume", "turned"), [4, 4, 8], 4);
await auto(5);
// Corners that would not lift: a smooth prism, and a flat sheet.
await choose("instance", journeyId("instance", "smooth-1"));
await auto(5);
await choose("instance", journeyId("instance", "sheet-1"));
await auto(5);
// Nothing selected: every part on the plate, of four objects, so no one object to place on.
await choose(null, null);
await auto(5);
await clear();
await remove(0);
// An object chosen in the tree, and a removal of its first ear.
await choose("object", journeyId("object", "turned"));
await remove(0);

const journeyUndo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  journeyUndo.push(observe());
}
assert.equal(journeyUndo.at(-1).semanticHash, opened.semanticHash);
const journey = {
  archive: Buffer.from(serialized.bytes).toString("base64"),
  opened: { semanticHash: opened.semanticHash },
  steps: journeySteps,
  undo: journeyUndo,
};
controller.dispose();

const sources = [
  "tools/cross-platform/brim-ear-vectors.mjs",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/project/objects/brimEarCommands.ts",
  "web/node_modules/three/package.json",
  "web/src/project/objects/brimEarExchange.ts",
  "web/src/project/objects/brimEarDetection.ts",
  "web/src/project/objects/brimEarPreview.ts",
  "web/src/project/picking.ts",
  "contracts/project-intents.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      stateJson: canonicalStringify(state),
      assets: Object.values(payloads).map((a) => ({
        descriptorJson: canonicalStringify(a.descriptor),
        bytes: [...a.bytes],
      })),
      steps,
      journey,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/brim-ear-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Brim ear reference drift");
const replies = steps.map((s) => JSON.parse(s.reply));
const earCount = replies.reduce(
  (sum, r) => sum + (r.detected?.ears.length ?? 0),
  0,
);
console.log(
  `brim-ear journey: ${journeySteps.length} steps, ${journeyUndo.length} undo entries`,
);
console.log(
  `brim ears: ${steps.filter((s) => "detect" in s).length} detections (${earCount} ears, ${replies.filter((r) => r.detected && "value" in r.detected.reason).length} with reasons), ${steps.filter((s) => "stranded" in s).length} stranded checks (${replies.reduce((sum, r) => sum + (r.stranded?.indices.length ?? 0), 0)} stranded), ${steps.filter((s) => "view" in s).length} views (${replies.reduce((sum, r) => sum + (r.view?.ears.length ?? 0), 0)} ears, ${replies.reduce((sum, r) => sum + (r.view?.stranded.length ?? 0), 0)} stranded), ${replies.filter((r) => "refused" in r).length} refused`,
);
