// Assembly alignment references from the production browser
// (`assemblyExchange.ts` over `assembly.ts`, the pinned `GLGizmoAssembly`
// alignments): which actions plane pairs allow — skewed, parallel,
// anti-parallel, each side of the 1e-4 parallel test, already aligned within
// the 1e-3 guard, with non-unit and zero normals, and with points, edges and
// circles in either position — then every alignment kind with and without its
// parameter and reversing either feature, under identity, rotated, scaled and
// overflowing moving transforms; and view-only explosions at factor 1, above
// it, below it and past float range. Seeded random pairs join the curated
// ones. Replayed by Rust, by WASM in Node and Chrome, and over JNI.
//
// Then a journey: the production `CanonicalWorkspaceController` opens a
// canonical 3MF (a block, a tilted lid, a two-instance twin and a pin) and
// the workspace's assembly flow (`AssemblyAlignment.ts`, as `OrcaWorkspace`
// runs it over the Measure tool's picks, each picked as its scene root
// places the part) aligns the lid onto the block — parallel, centre
// coincidence, a gap, a turn about the face centre, a flip — with the pairs
// already aligned or already parallel, a missing parameter, two faces on one
// model, one pick and a circle second, then one twin onto the other, and
// explodes the view. After every step it records the pick's feature, the
// panel's snapshot, the alignment's outcome, status and transform, the
// semantic hash and the undo label, then undoes every entry; the journey's
// availability, alignment and explosion requests join the script above, and
// the Android `ProjectWorkspace` takes the same steps.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import {
  assemblyAlignmentWire,
  assemblyAvailabilityWire,
  explosionWire,
} from "../../web/src/project/objects/assemblyExchange.ts";
import { captureMeasureVolumeWire, featureFromWire } from "../../web/src/project/objects/measureExchange.ts";
import { createEmptyProject, emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { getThreeProjectEntity } from "../../web/src/project/surfaces/ThreeProjectSurface.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { assemblySnapshot, planAssemblyStep } from "../../web/src/workspace/AssemblyAlignment.ts";
import {
  decodeProjectMeasureFeatureRequest,
  decodeProjectMeasureVolumeRequest,
  encodeProjectMeasureFeatureReply,
  decodeProjectAssemblyAlignmentRequest,
  decodeProjectAssemblyPair,
  decodeProjectExplosionRequest,
  encodeProjectAssemblyAlignmentReply,
  encodeProjectAssemblyAlignmentRequest,
  encodeProjectAssemblyAvailabilityReply,
  encodeProjectAssemblyPair,
  encodeProjectExplosionReply,
  encodeProjectExplosionRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// xorshift64*, seeded.
let state = 0x2545f4914f6cdd1dn;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const unit = () => Number(next() >> 11n) / 2 ** 53;
const uniform = (low, high) => low + (high - low) * unit();
const vector = (scale = 50) => [
  uniform(-scale, scale),
  uniform(-scale, scale),
  uniform(-scale, scale),
];
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((c) => c / length);
};

const plane = (normal, origin = [0, 0, 0], index = 0) => ({
  plane: { index, normal, origin },
});
const point = (p) => ({ point: { point: p } });
const edge = (from, to) => ({ edge: { from, to, extraPoint: { absent: {} } } });
const circle = (center, normal, radius) => ({
  circle: { center, normal, radius },
});
const quaternion = () => {
  const q = [uniform(-1, 1), uniform(-1, 1), uniform(-1, 1), uniform(-1, 1)];
  return normalize(q);
};
const transforms = [
  { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  {
    translationMm: [12.5, -40, 3],
    rotation: [0, 0, 0.7071067811865476, 0.7071067811865476],
    scale: [1, 1, 1],
  },
  { translationMm: vector(), rotation: quaternion(), scale: [2, 0.5, 1.25] },
  {
    translationMm: [1e308, -1e308, 0],
    rotation: quaternion(),
    scale: [1, 1, 1],
  },
];

// --- Pairs ---------------------------------------------------------------------------
const pairs = [];
const z = [0, 0, 1];
const tilt = (epsilon) => normalize([epsilon, 0, 1]);
pairs.push(
  [plane(z, [0, 0, 10]), plane([0, 0, -1], [3, 4, 0])],
  [plane(z, [0, 0, 10]), plane(z, [3, 4, 2])],
  [plane([0, 0, 7], [0, 0, 10]), plane([0, 0, -0.25], [5, 5, 30])],
  [plane(z), plane(tilt(0.0139))],
  [plane(z), plane(tilt(0.0145))],
  [plane(z), plane([0, 0, -1].map((c, i) => (i === 0 ? 0.03 : c)))],
  [plane(z), plane(normalize([0.04, 0, -1]))],
  [plane([1, 0, 0], [0, 0, 0]), plane([0, 1, 0], [10, 10, 10])],
  [plane([1, 0, 0]), plane([-1, 0, 0], [20, 1, 2])],
  [plane([0.9999, 0.01, 0]), plane([0, 0, 1])],
  [plane([0, 0, 0]), plane(z)],
  [plane(z), plane([0, 0, 0])],
  [point([1, 2, 3]), plane(z)],
  [plane(z), point([1, 2, 3])],
  [plane(z), edge([0, 0, 0], [5, 0, 0])],
  [circle([0, 0, 0], z, 3), plane(z)],
  [plane(z), circle([1, 1, 1], z, 2)],
  [plane(z, [1e308, 0, 0]), plane([0, 0, -1], [-1e308, 0, 0])],
  [plane(z, [0, 0, -1e308]), plane(z, [0, 0, 1e308])],
);
for (let i = 0; i < 24; i += 1)
  pairs.push([plane(vector(2), vector()), plane(vector(2), vector())]);
for (let i = 0; i < 12; i += 1) {
  const n = normalize(vector());
  pairs.push([
    plane(n, vector()),
    plane(
      n.map((c) => -c * uniform(0.5, 3)),
      vector(),
    ),
  ]);
}

const steps = [];
for (const [first, second] of pairs) {
  const request = encodeProjectAssemblyPair({ first, second });
  steps.push({
    availability: request,
    reply: encodeProjectAssemblyAvailabilityReply(
      assemblyAvailabilityWire(decodeProjectAssemblyPair(request)),
    ),
  });
}
const kinds = [
  "parallel",
  "centerCoincidence",
  "parallelDistance",
  "reverseRotation",
  "aroundFaceCenter",
];
for (const [index, [first, second]] of pairs.entries()) {
  // A skewed pair refuses every parallel-only kind alike; two variants say so.
  const available = assemblyAvailabilityWire({ first, second });
  const parallel =
    "available" in available && available.available.hasParallelDistance;
  for (const kind of kinds) {
    const variants =
      kind === "parallelDistance"
        ? [
            { absent: {} },
            { value: 4.5 },
            { value: -2 },
            { value: 0 },
            { value: 1e308 },
          ]
        : kind === "aroundFaceCenter"
          ? [
              { absent: {} },
              { value: 90 },
              { value: -30 },
              { value: 0.05 },
              { value: 720 },
            ]
          : kind === "reverseRotation"
            ? [{ absent: {} }, { value: "first" }, { value: "second" }]
            : [{ absent: {} }];
    const parallelOnly =
      kind === "parallelDistance" || kind === "aroundFaceCenter";
    for (const variant of parallelOnly && !parallel
      ? variants.slice(0, 2)
      : variants) {
      const request = encodeProjectAssemblyAlignmentRequest({
        kind,
        first,
        second,
        movingTransform:
          transforms[(index + variants.indexOf(variant)) % transforms.length],
        parameter:
          kind === "reverseRotation" || !("value" in variant)
            ? { absent: {} }
            : variant,
        reverseFeature: kind === "reverseRotation" ? variant : { absent: {} },
      });
      steps.push({
        alignment: request,
        reply: encodeProjectAssemblyAlignmentReply(
          assemblyAlignmentWire(decodeProjectAssemblyAlignmentRequest(request)),
        ),
      });
    }
  }
}
const explosions = [
  { parts: [], factor: 2 },
  {
    parts: [{ id: units("import:instance:a"), centerMm: [10, -20, 5] }],
    factor: 3,
  },
  {
    parts: [
      { id: units("import:instance:a"), centerMm: [10, -20, 5] },
      { id: units("import:instance:b"), centerMm: [-4, 7, 1] },
      { id: units("lone \ud800"), centerMm: [0, 0, -9] },
    ],
    factor: 1,
  },
  {
    parts: Array.from({ length: 9 }, (_, i) => ({
      id: units(`import:instance:p${i}`),
      centerMm: vector(80),
    })),
    factor: 2.75,
  },
  {
    parts: [{ id: units("import:instance:a"), centerMm: [1, 2, 3] }],
    factor: 0.5,
  },
  {
    parts: [
      { id: units("import:instance:a"), centerMm: [1e308, 0, 0] },
      { id: units("import:instance:b"), centerMm: [-1e308, 0, 0] },
    ],
    factor: 4,
  },
  {
    parts: [
      { id: units("import:instance:a"), centerMm: [1e300, 0, 0] },
      { id: units("import:instance:b"), centerMm: [-1e300, 0, 0] },
    ],
    factor: 1e10,
  },
];
for (const explosion of explosions) {
  const request = encodeProjectExplosionRequest(explosion);
  steps.push({
    explosion: request,
    reply: encodeProjectExplosionReply(
      explosionWire(decodeProjectExplosionRequest(request)),
    ),
  });
}

// --- The journey --------------------------------------------------------------------
process.env.TZ = "UTC";
const NOW = "2026-10-12T00:00:00.000Z";
const IDENTITY = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const serializer = new Bbs3mfProjectSerializer();
// An axis-aligned box from the origin: facets 0-1 its bottom, 2-3 its top, 4-5 its front (y = 0),
// 6-7 its back, 8-9 its left (x = 0), 10-11 its right.
const BOX = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
];
const block = (id, [x, y, z]) => {
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  return encodeIndexedMeshAsset({
    id,
    positions: corners.flatMap(([a, b, c]) => [a * x, b * y, c * z]),
    indices: BOX.flat(),
  });
};
/** A [sides]-sided prism of [radius] and [height] about the Z axis: its top fan first, then its bottom fan, then its sides. */
const prism = (id, radius, height, sides) => {
  const positions = [0, 0, height, 0, 0, 0];
  for (let i = 0; i < sides; i += 1) {
    const angle = (2 * Math.PI * i) / sides;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), height);
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), 0);
  }
  const top = (i) => 2 + 2 * (i % sides);
  const bottom = (i) => 3 + 2 * (i % sides);
  const indices = [];
  for (let i = 0; i < sides; i += 1) indices.push(0, top(i), top(i + 1));
  for (let i = 0; i < sides; i += 1) indices.push(1, bottom(i + 1), bottom(i));
  for (let i = 0; i < sides; i += 1) indices.push(top(i), bottom(i), bottom(i + 1), top(i), bottom(i + 1), top(i + 1));
  return encodeIndexedMeshAsset({ id, positions, indices });
};
const lidTilt = Math.PI / 9;
const base = block("import:asset:assembly-base", [20, 20, 20]);
const lid = block("import:asset:assembly-lid", [20, 20, 6]);
const cube = block("import:asset:assembly-twin", [10, 10, 10]);
const pin = prism("import:asset:assembly-pin", 5, 10, 24);
const journeyState = createEmptyProject({ idSource: new UuidIdSource(seededRandom(0xa55e)), now: NOW });
journeyState.config = { printable_area: ["0x0", "270x0", "270x270", "0x270"] };
const object = (key, payload, transforms) => ({
  id: `import:object:${key}`,
  name: key,
  config: {},
  volumes: [
    {
      id: `import:volume:${key}`,
      name: key,
      role: "model",
      source: { assetId: payload.descriptor.id, topologyRevision: 0, triangleCount: payload.descriptor.mesh.triangleCount },
      transform: structuredClone(IDENTITY),
      config: {},
      annotations: emptyFacetAnnotations(0),
    },
  ],
  instances: transforms.map((transform, i) => ({ id: `import:instance:${key}-${i + 1}`, transform, printable: true })),
  layerRanges: [],
});
const at = (x, y, z = 0, rotation = [0, 0, 0, 1]) => ({ translationMm: [x, y, z], rotation, scale: [1, 1, 1] });
journeyState.plates[0].objects = [
  object("base", base, [at(60, 60)]),
  object("lid", lid, [at(120, 60, 15, [Math.sin(lidTilt / 2), 0, 0, Math.cos(lidTilt / 2)])]),
  object("twin", cube, [at(60, 140), at(110, 150, 5, [0, 0, Math.SQRT1_2, Math.SQRT1_2])]),
  object("pin", pin, [at(180, 140)]),
];
journeyState.sourceAssets = [base.descriptor, lid.descriptor, cube.descriptor, pin.descriptor];
assertValidProjectState(journeyState);
const journeyAssets = new InMemoryAssetRepository();
for (const payload of [base, lid, cube, pin]) journeyAssets.put(payload.descriptor, payload.bytes);
const source = new EditorSession({ initialState: journeyState, assets: journeyAssets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0xa55f)),
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
const journeySteps = [];
/** The Measure tool's picks, as `OrcaWorkspace.measurePicks` holds them: a third starts a new pair. */
let picks = [];
const record = (operation, result) => journeySteps.push({ operation, result, ...observe() });
/**
 * `pickMeasureFeature`: facet [triangle] of instance [n] of [key], at a volume-local point
 * ([weights] of its corners), in printer millimetres as the scene root places the part.
 */
function pick(key, n, triangle, weights = [1 / 3, 1 / 3, 1 / 3]) {
  const instanceId = `import:instance:${key}-${n}`;
  const volumeId = `import:volume:${key}`;
  const { reply, volume } = captureMeasureVolumeWire(
    live(),
    controller.assets,
    decodeProjectMeasureVolumeRequest(JSON.stringify({ volumeId: units(volumeId) })),
  );
  assert.ok(volume, JSON.stringify(reply));
  const mesh = controller.getVolumeMesh(volumeId);
  const corners = mesh.triangles[triangle].map((v) => mesh.vertices[v]);
  const point = [0, 1, 2].map((k) => corners.reduce((sum, c, i) => sum + c[k] * weights[i], 0));
  const root = controller.surface.root;
  root.updateMatrixWorld(true);
  const display = root.children
    .filter((group) => getThreeProjectEntity(group)?.instanceId === instanceId)
    .flatMap((group) => group.children)
    .find((child) => getThreeProjectEntity(child)?.volumeId === volumeId);
  const m = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(display.matrixWorld).elements;
  const transform = [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
  const featureReply = volume.feature(
    decodeProjectMeasureFeatureRequest(
      JSON.stringify({ faceIndex: triangle, point, onlyPlane: false, transform: { value: transform } }),
    ),
  );
  assert.ok("feature" in featureReply, JSON.stringify(featureReply));
  if (picks.length >= 2) picks = [];
  picks.push({ feature: featureFromWire(featureReply.feature.feature), instanceId, wire: featureReply.feature.feature });
  record(
    { kind: "pick", instanceId, volumeId, triangle, point },
    { transform, reply: encodeProjectMeasureFeatureReply(featureReply) },
  );
}
/** `getAssemblySnapshot`, and its availability request among the script's when there are two picks. */
function snapshot() {
  const view = assemblySnapshot(picks);
  if (picks.length >= 2) {
    const request = encodeProjectAssemblyPair({ first: picks[0].wire, second: picks[1].wire });
    steps.push({
      availability: request,
      reply: encodeProjectAssemblyAvailabilityReply(assemblyAvailabilityWire(decodeProjectAssemblyPair(request))),
    });
  }
  record({ kind: "snapshot" }, { available: { ...view.available }, movable: view.movable, hint: view.hint });
}
const WIRE_KINDS = {
  parallel: "parallel",
  "center-coincidence": "centerCoincidence",
  "parallel-distance": "parallelDistance",
  "reverse-rotation": "reverseRotation",
  "around-face-center": "aroundFaceCenter",
};
/** `applyAssemblyAlignment`: the flow's step, a move committed as one `setInstanceTransform`, then the picks cleared. */
async function align(kind, parameter) {
  const current = picks;
  const step = planAssemblyStep(current, kind, parameter, (id) => controller.getInstanceTransform(id));
  if (current.length >= 2) {
    const moving = controller.getInstanceTransform(current[1].instanceId);
    if (moving && current[1].instanceId !== current[0].instanceId) {
      const request = encodeProjectAssemblyAlignmentRequest({
        kind: WIRE_KINDS[kind],
        first: current[0].wire,
        second: current[1].wire,
        movingTransform: moving,
        parameter: parameter === undefined ? { absent: {} } : { value: parameter },
        reverseFeature: { absent: {} },
      });
      steps.push({
        alignment: request,
        reply: encodeProjectAssemblyAlignmentReply(assemblyAlignmentWire(decodeProjectAssemblyAlignmentRequest(request))),
      });
    }
  }
  if (step.outcome === "move") {
    await controller.setInstanceTransform(step.instanceId, step.transform);
    picks = [];
  }
  record(
    { kind: "align", alignment: kind, ...(parameter === undefined ? {} : { parameter }) },
    {
      outcome: step.outcome,
      status: step.status,
      ...(step.outcome === "move" ? { instanceId: step.instanceId, transform: step.transform } : {}),
    },
  );
}
/** `setExplosionFactor`: the active plate's drawn instances, by their canonical translations, moved apart in view only. */
function explode(factor) {
  const plateId = live().activePlateId;
  const parts = controller.surface.root.children
    .map((group) => getThreeProjectEntity(group))
    .filter((entity) => entity?.kind === "instance" && entity.plateId === plateId)
    .map((entity) => ({ id: units(entity.instanceId), centerMm: [...controller.getInstanceTransform(entity.instanceId).translationMm] }));
  const request = encodeProjectExplosionRequest({ parts, factor });
  const reply = encodeProjectExplosionReply(explosionWire(decodeProjectExplosionRequest(request)));
  steps.push({ explosion: request, reply });
  record({ kind: "explode", factor }, { request, reply });
}

// The lid, tilted, onto the block's top: parallel first.
pick("base", 1, 2);
snapshot();
pick("lid", 1, 0);
snapshot();
await align("parallel");
// Facing now: centre coincidence closes the gap; again, nothing moves; parallel is refused.
pick("base", 1, 2);
pick("lid", 1, 0);
snapshot();
await align("center-coincidence");
pick("base", 1, 2);
pick("lid", 1, 0);
await align("center-coincidence");
await align("parallel");
// A gap, then a gap without its distance; a turn about the face centre; a flip.
await align("parallel-distance", 4.5);
pick("base", 1, 2);
pick("lid", 1, 0);
snapshot();
await align("parallel-distance");
await align("around-face-center", 90);
pick("base", 1, 2);
pick("lid", 1, 1);
await align("reverse-rotation");
// Two faces of one model offer nothing to move.
pick("base", 1, 10);
pick("base", 1, 2);
snapshot();
await align("center-coincidence");
// One twin onto the other: two instances of one object are two models.
pick("twin", 1, 2);
pick("twin", 2, 4);
snapshot();
await align("center-coincidence");
// One pick is not a pair; a circle second offers no plane to turn about.
pick("base", 1, 2);
await align("parallel");
pick("pin", 1, 0, [0.02, 0.49, 0.49]);
snapshot();
await align("reverse-rotation");
// The exploded view moves nothing.
explode(2);
explode(1);
const journeyUndo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  journeyUndo.push(observe());
}
assert.equal(journeyUndo.at(-1).semanticHash, opened.semanticHash);
const outcomes = journeySteps.filter((s) => s.operation.kind === "align").map((s) => s.result.outcome);
assert.deepEqual(
  Object.fromEntries(["move", "aligned", "failed", "refused"].map((o) => [o, outcomes.filter((x) => x === o).length])),
  { move: 6, aligned: 1, failed: 3, refused: 2 },
  outcomes.join(" "),
);
const journey = {
  archive: Buffer.from(serialized.bytes).toString("base64"),
  opened: { semanticHash: opened.semanticHash },
  steps: journeySteps,
  undo: journeyUndo,
};
controller.dispose();

const sources = [
  "tools/cross-platform/assembly-vectors.mjs",
  "web/src/workspace/AssemblyAlignment.ts",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/node_modules/three/package.json",
  "web/src/project/objects/assemblyExchange.ts",
  "web/src/project/objects/assembly.ts",
  "web/src/project/objects/transformOperations.ts",
  "web/src/project/objects/measureExchange.ts",
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
      steps,
      journey,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/assembly-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Assembly reference drift");
const outcome = (s) => Object.keys(JSON.parse(s.reply))[0];
const tally = Object.groupBy(
  steps,
  (s) => `${Object.keys(s)[0]}:${outcome(s)}`,
);
console.log(`assembly journey: ${journeySteps.length} steps, ${journeyUndo.length} undo entries`);
console.log(
  `assembly: ${steps.length} requests (${Object.entries(tally)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")})`,
);
