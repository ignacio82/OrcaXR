// The browser's model tools — split to objects and to parts, simplify and
// measure — as the production workspace runs them, for the shared core and
// the Android app:
//
// - split sources: what each split would split (`SplitSource.ts` through
//   `SplitSourceExchange.ts`) for every instance of a project whose objects
//   cover each of the workspace's refusals (a modifier, a volume below three
//   facets, height ranges, object extension data, paint, opaque 3MF facet
//   metadata, a volume over the synchronous triangle limit, an object that
//   already has parts) and the provenance an import gives every object
//   (`orcaxr:importSource`, as a model import and a geometry merge write it,
//   alone and beside an unknown key), under both splits and several limits,
//   with malformed requests. Replayed by Rust, by WASM in Node and over JNI;
// - a journey: the production `CanonicalWorkspaceController` opens a
//   canonical 3MF (a U1 bed) and splits to parts and to objects — both
//   strategies, across an object's instances, imported models whose
//   provenance every resulting object keeps, and every refusal the
//   confirmation and the commit raise —, previews and applies simplifications
//   by count and by error, finds nothing to simplify, simplifies an object at
//   once, and measures features of a scaled, turned instance and of split
//   parts (`measureExchange.ts` in printer millimetres, the frame the
//   workspace reaches through its scene root), recording the semantic hash and
//   undo label after every step, then undoes them all; a native
//   `ProjectWorkspace` taking the same steps is compared after each.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { createEmptyProject, emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { captureMeasureVolumeWire, measureFeaturesWire } from "../../web/src/project/objects/measureExchange.ts";
import { getThreeProjectEntity } from "../../web/src/project/surfaces/ThreeProjectSurface.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { splitSourceExchange } from "../../web/src/workspace/SplitSourceExchange.ts";
import { runCanonicalSplitToObjectsFlow } from "../../web/src/workspace/CanonicalSplitToObjectsFlow.ts";
import {
  decodeProjectMeasureFeatureRequest,
  decodeProjectMeasureVolumeRequest,
  encodeProjectMeasureFeatureReply,
  encodeProjectMeasureReply,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";

const serializer = new Bbs3mfProjectSerializer();
const base64 = (bytes) => Buffer.from(bytes).toString("base64");
const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const NOW = "2026-10-10T00:00:00.000Z";
const IDENTITY = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

// --- Meshes (volume-local millimetres) ------------------------------------------------------

const BOX_TRIANGLES = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [3, 7, 6],
  [3, 6, 2],
  [0, 4, 7],
  [0, 7, 3],
  [1, 2, 6],
  [1, 6, 5],
];
/** An axis-aligned box of [size] from [origin], outward-wound: one connected body. */
function box(origin, size) {
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  return {
    vertices: corners.map((c) => c.map((v, k) => origin[k] + v * size[k])),
    triangles: BOX_TRIANGLES.map((t) => [...t]),
  };
}
/** Several meshes as one: separate bodies of a single volume. */
function merged(...parts) {
  const vertices = [];
  const triangles = [];
  for (const part of parts) {
    const offset = vertices.length;
    vertices.push(...part.vertices);
    triangles.push(...part.triangles.map((t) => t.map((v) => v + offset)));
  }
  return { vertices, triangles };
}
function sphere(radius, widthSegments, heightSegments) {
  const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const vertices = Array.from({ length: position.count }, (_, i) => [position.getX(i), position.getY(i), position.getZ(i)]);
  const triangles = [];
  for (let i = 0; i < index.count; i += 3) triangles.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)]);
  geometry.dispose();
  return { vertices, triangles };
}
const quad = {
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
const asset = (id, mesh, sourceFilename) =>
  encodeIndexedMeshAsset({
    id,
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
    ...(sourceFilename ? { sourceFilename } : {}),
  });

/** A project of [objects] (plate → list) built from records, its assets declared in first-use order. */
function project(seed, plates, config = {}) {
  const state = createEmptyProject({ idSource: new UuidIdSource(seededRandom(seed)), now: NOW });
  state.config = config;
  const first = state.plates[0];
  state.plates = plates.map((objects, index) => ({
    ...structuredClone(first),
    ...(index === 0 ? {} : { id: `import:plate:model-tools-${index + 1}`, name: `Plate ${index + 1}`, order: index }),
    objects: objects.map((o) => o.record),
  }));
  const payloads = [];
  for (const objects of plates)
    for (const object of objects)
      for (const payload of object.payloads)
        if (!payloads.some((p) => p.descriptor.id === payload.descriptor.id)) payloads.push(payload);
  state.sourceAssets = payloads.map((p) => p.descriptor);
  assertValidProjectState(state);
  return { state, payloads };
}
function volume(id, name, payload, extra = {}) {
  return {
    id,
    name,
    role: "model",
    source: { assetId: payload.descriptor.id, topologyRevision: 0, triangleCount: payload.descriptor.mesh.triangleCount },
    transform: structuredClone(IDENTITY),
    config: {},
    annotations: emptyFacetAnnotations(0),
    ...extra,
  };
}
function object(key, name, volumes, instances, extra = {}) {
  return {
    payloads: volumes.map((v) => v.payload),
    record: {
      id: `import:object:${key}`,
      name,
      config: {},
      volumes: volumes.map((v) => v.record),
      instances: instances.map((transform, i) => ({ id: `import:instance:${key}-${i + 1}`, transform, printable: true })),
      layerRanges: [],
      ...extra,
    },
  };
}
const part = (key, name, payload, extra) => ({ payload, record: volume(`import:volume:${key}`, name, payload, extra) });
const at = (x, y, z = 0, extra = {}) => ({ ...structuredClone(IDENTITY), translationMm: [x, y, z], ...extra });

// --- Split sources ----------------------------------------------------------------------------

const cube = asset("import:asset:model-tools-cube", box([0, 0, 0], [10, 10, 10]));
const pairMesh = asset("import:asset:model-tools-pair", merged(box([0, 0, 0], [10, 10, 10]), box([15, 0, 0], [10, 10, 10])));
const quadMesh = asset("import:asset:model-tools-quad", quad);
const big = asset("import:asset:model-tools-big", sphere(10, 48, 32));
const CORE_FACET_ATTRIBUTES_KEY = "https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes";
// The provenance `ModelImportParser` and `GeometryMergeParser` give every object they import.
const imported = (filename) => ({
  "orcaxr:importSource": { filename, format: "stl", unit: "mm", importedAt: NOW },
});
const merged3mf = (filename) => ({
  "orcaxr:importSource": { filename, format: "project-3mf", mode: "geometry-only", importedAt: NOW },
});
const sourceProject = project(
  0x5917,
  [
    [
      object("pair", "Pair", [part("pair", "Pair", pairMesh)], [at(40, 40), at(80, 40)]),
      object("duo", "Duo — zwei", [part("duo-a", "A", cube), part("duo-b", "B", cube, { transform: at(20, 0) })], [at(40, 90)]),
      object(
        "guarded",
        "Guarded",
        [part("guarded", "Body", cube), part("guarded-modifier", "Modifier", cube, { role: "parameter-modifier" })],
        [at(40, 140)],
      ),
      object("ranged", "Ranged", [part("ranged", "Ranged", cube)], [at(90, 140)], {
        layerRanges: [{ id: "import:range:ranged", minZMm: 0, maxZMm: 5, config: { layer_height: 0.1 } }],
      }),
      object("extended", "Extended", [part("extended", "Extended", cube)], [at(140, 140)], {
        extensionData: { "https://example.org/kept": { note: "kept" } },
      }),
      object(
        "painted",
        "Painted",
        [part("painted", "Painted", cube, { annotations: { ...emptyFacetAnnotations(0), support: [{ triangles: [0, 1], value: "enforce" }] } })],
        [at(190, 140)],
      ),
      object(
        "opaque",
        "Opaque",
        [part("opaque", "Opaque", cube, { extensionData: { [CORE_FACET_ATTRIBUTES_KEY]: { kept: true } } })],
        [at(40, 190)],
      ),
      object("tiny", "Tiny", [part("tiny", "Tiny", quadMesh)], [at(90, 190)]),
      object("big", "Big", [part("big", "Big", big)], [at(140, 190)]),
      object("wurfel", "Würfel ☃ 𝔘", [part("wurfel", "Würfel", cube)], [at(190, 190), at(220, 190), at(220, 220)]),
      object("imported", "pair.stl", [part("imported", "pair.stl", pairMesh)], [at(140, 40)], { extensionData: imported("pair.stl") }),
      object(
        "merged",
        "Merged",
        [part("merged-a", "A", cube), part("merged-b", "B", cube, { transform: at(20, 0) })],
        [at(190, 40)],
        { extensionData: merged3mf("parts.3mf") },
      ),
      object("unknown", "Unknown", [part("unknown", "Unknown", pairMesh)], [at(190, 90)], {
        extensionData: { ...imported("unknown.stl"), "https://example.org/kept": { note: "kept" } },
      }),
    ],
    [object("elsewhere", "Elsewhere", [part("elsewhere", "Elsewhere", cube)], [at(60, 60)])],
  ],
  { printable_area: ["0x0", "270x0", "270x270", "0x270"] },
);
const sourceCases = [];
const instanceIds = sourceProject.state.plates.flatMap((p) => p.objects.flatMap((o) => o.instances.map((i) => i.id)));
for (const instanceId of [...instanceIds, "import:instance:missing", "Würfel ☃"]) {
  for (const target of ["objects", "parts"]) {
    for (const triangleLimit of instanceId === "import:instance:big-1" ? [50000, 2976, 2975, 1000, 1] : [50000, 24, 23]) {
      const request = canonicalStringify({ instanceId, target, triangleLimit });
      sourceCases.push({ request, reply: splitSourceExchange(sourceProject.state, request) });
    }
  }
}
const sourceRefusals = [
  ["not JSON", "{"],
  ["an array", "[]"],
  ["missing limit", { instanceId: "import:instance:pair-1", target: "objects" }],
  ["extra field", { instanceId: "import:instance:pair-1", target: "objects", triangleLimit: 5, plateId: "x" }],
  ["numeric instance", { instanceId: 3, target: "objects", triangleLimit: 5 }],
  ["null instance", { instanceId: null, target: "parts", triangleLimit: 5 }],
  ["unknown target", { instanceId: "import:instance:pair-1", target: "volumes", triangleLimit: 5 }],
  ["zero limit", { instanceId: "import:instance:pair-1", target: "parts", triangleLimit: 0 }],
  ["fractional limit", { instanceId: "import:instance:pair-1", target: "parts", triangleLimit: 1.5 }],
  ["negative limit", { instanceId: "import:instance:pair-1", target: "parts", triangleLimit: -4 }],
  ["text limit", { instanceId: "import:instance:pair-1", target: "parts", triangleLimit: "5" }],
  ["unsafe limit", { instanceId: "import:instance:pair-1", target: "parts", triangleLimit: 9007199254740992 }],
].map(([name, request]) => ({ name, request: typeof request === "string" ? request : JSON.stringify(request) }));
for (const refusal of sourceRefusals) {
  assert.throws(() => splitSourceExchange(sourceProject.state, refusal.request), /invalid_request/, refusal.name);
}
const splitSources = {
  stateJson: canonicalStringify(sourceProject.state),
  assets: sourceProject.payloads.map((p) => ({ descriptorJson: canonicalStringify(p.descriptor), bytes: base64(p.bytes) })),
  cases: sourceCases,
  refusals: sourceRefusals,
};

// --- Journey ----------------------------------------------------------------------------------

const block = asset("import:asset:model-tools-block", box([0, 0, 0], [20, 20, 20]), "block.stl");
const ball = asset("import:asset:model-tools-ball", sphere(10, 24, 16), "ball.stl");
const start = project(
  0x70015,
  [
    [
      object("block", "Block", [part("block", "Block", block)], [
        at(60, 60, 0, { rotation: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)], scale: [1.5, 1.5, 1.5] }),
      ]),
      object("pair", "Pair", [part("pair", "Pair", pairMesh)], [at(120, 60), at(180, 60)]),
      object("duo", "Duo", [part("duo", "Duo", pairMesh)], [at(120, 140)]),
      object("guarded", "Guarded", [part("guarded", "Body", cube), part("guarded-modifier", "Modifier", cube, { role: "parameter-modifier" })], [at(60, 140)]),
      object("ball", "Ball", [part("ball", "Ball", ball)], [at(200, 200, 10)]),
      object("stl", "pair.stl", [part("stl", "pair.stl", pairMesh)], [at(60, 220)], { extensionData: imported("pair.stl") }),
      object("model", "twins.stl", [part("model", "twins.stl", pairMesh)], [at(120, 220)], { extensionData: imported("twins.stl") }),
      object("kept", "Kept", [part("kept", "Kept", pairMesh)], [at(200, 120)], {
        extensionData: { ...imported("kept.stl"), "https://example.org/kept": { note: "kept" } },
      }),
    ],
  ],
  { printable_area: ["0.5x1", "270.5x1", "270.5x271", "0.5x271"], printable_height: "250" },
);
const startAssets = new InMemoryAssetRepository();
for (const payload of start.payloads) startAssets.put(payload.descriptor, payload.bytes);
const source = new EditorSession({ initialState: start.state, assets: startAssets, serializer });
const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });

const JOURNEY_SEED = 0x5711;
const seeded = new UuidIdSource(seededRandom(JOURNEY_SEED));
const idSource = {
  drawn: 0,
  next(kind) {
    this.drawn += 1;
    return seeded.next(kind);
  },
};
const controller = CanonicalWorkspaceController.createEmpty({
  idSource,
  clock: () => NOW,
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [200, 200], worldUnitsPerMm: 0.00175 },
  projectSerializer: serializer,
});
assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
const opened = controller.captureProjectExportGuard();
assert.equal(opened.semanticHash, source.captureExportGuard().semanticHash);
const skippedIds = idSource.drawn;
const live = () => controller.session.project.getSnapshot().state;

const observe = () => {
  const { history } = controller.getSummary();
  return {
    semanticHash: controller.captureProjectExportGuard().semanticHash,
    undoCount: history.undoCount,
    undoLabel: history.undoLabel ?? null,
  };
};
const steps = [];
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
const choose = (kind, id) =>
  step({ kind: "select", entity: kind, id }, async () => {
    controller.setObjectsTreeSelection([{ kind, id }]);
  });

// Split to objects through the workspace's flow: the confirmation it shows,
// then the commit and the status the flow reports.
async function splitToObjects() {
  let confirmation = null;
  let status = null;
  return step({ kind: "splitToObjects" }, async () => {
    await runCanonicalSplitToObjectsFlow(
      controller,
      (shown) => {
        confirmation = {
          objectName: shown.objectName,
          strategy: shown.strategy,
          volumeCount: shown.volumeCount,
          triangleCount: shown.triangleCount,
          affectedInstanceIds: [...shown.affectedInstanceIds],
        };
        return true;
      },
      (message) => {
        status = message;
      },
    );
    return { confirmation, status };
  });
}
const splitToParts = () =>
  step({ kind: "splitToParts" }, async () => {
    const split = await controller.splitSelectedToParts();
    return { partCount: split.partCount, objectName: split.objectName };
  });

/** The volumes the workspace's simplify takes (`OrcaWorkspace.paintableSelectedVolumes`): the
 * active plate's model parts, in the order its scene lists them — the selected parts, the parts of
 * selected objects and of selected instances' objects, else all of them. */
function selectedVolumes() {
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
  return [...new Set(targets.filter((t) => all || volumes.has(t.volumeId) || objects.has(t.objectId)).map((t) => t.volumeId))];
}

/** `OrcaWorkspace.previewSimplify` then `applySimplifyPreview`. */
const simplify = (configuration, apply) =>
  step({ kind: "simplifyPreview", configuration, apply }, async () => {
    const volumes = selectedVolumes();
    const prepared = volumes.map((v) => controller.prepareSimplifyVolume(v, configuration)).filter((p) => p);
    const preview = {
      volumeIds: prepared.map((p) => p.volumeId),
      beforeTriangles: prepared.reduce((sum, p) => sum + p.beforeTriangles, 0),
      afterTriangles: prepared.reduce((sum, p) => sum + p.afterTriangles, 0),
      stoppedOnError: prepared.some((p) => p.stoppedOnError),
    };
    if (prepared.length > 0 && apply) for (const p of prepared) await controller.applyPreparedSimplify(p);
    return preview;
  });
/** `OrcaWorkspace.simplifySelected`: each selected part decimated by count and installed. */
const simplifyNow = (decimateRatio) =>
  step({ kind: "simplify", decimateRatio }, async () => {
    let before = 0;
    let after = 0;
    let changed = 0;
    for (const v of selectedVolumes()) {
      const result = await controller.simplifyVolume(v, { useCount: true, decimateRatio, maxError: 1 });
      before += result.beforeTriangles;
      after += result.afterTriangles;
      if (result.afterTriangles < result.beforeTriangles) changed += 1;
    }
    return { changed, beforeTriangles: before, afterTriangles: after };
  });

// Measure: a pick on facet [triangle] of a volume as one instance places it, at a
// volume-local point (the facet's centroid, or beside a corner), in printer
// millimetres as the workspace reaches them through its scene root.
const measured = [];
function measurePick(instanceId, volumeId, triangle, weights = [1 / 3, 1 / 3, 1 / 3]) {
  return step({ kind: "measurePick", instanceId, volumeId, triangle }, async () => {
    const state = live();
    const { reply, volume } = captureMeasureVolumeWire(
      state,
      controller.assets,
      decodeProjectMeasureVolumeRequest(JSON.stringify({ volumeId: units(volumeId) })),
    );
    assert.ok(volume, JSON.stringify(reply));
    const mesh = controller.getVolumeMesh(volumeId);
    const corners = mesh.triangles[triangle].map((v) => mesh.vertices[v]);
    const point = [0, 1, 2].map((k) => corners.reduce((sum, c, i) => sum + c[k] * weights[i], 0));
    const surface = controller.surface.root;
    surface.updateMatrixWorld(true);
    const display = surface.children
      .filter((group) => getThreeProjectEntity(group)?.instanceId === instanceId)
      .flatMap((group) => group.children)
      .find((child) => getThreeProjectEntity(child)?.volumeId === volumeId);
    const m = new THREE.Matrix4().copy(surface.matrixWorld).invert().multiply(display.matrixWorld).elements;
    const transform = [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
    const featureReply = volume.feature(
      decodeProjectMeasureFeatureRequest(
        JSON.stringify({ faceIndex: triangle, point, onlyPlane: false, transform: { value: transform } }),
      ),
    );
    if ("feature" in featureReply) measured.push(featureReply.feature.feature);
    return { point, transform, reply: encodeProjectMeasureFeatureReply(featureReply) };
  });
}
const measure = (first, second) =>
  step({ kind: "measure", first, second }, async () =>
    encodeProjectMeasureReply(measureFeaturesWire({ first: measured[first], second: measured[second] })),
  );

const objectOf = (key) => `import:object:${key}`;
const instanceOf = (key, n = 1) => `import:instance:${key}-${n}`;

// A single body neither splits to parts nor to objects; the confirmation is shown first.
await choose("instance", instanceOf("block"));
await splitToParts();
await splitToObjects();
// Measure the turned, scaled block: its top and bottom, a corner, an edge's side.
await measurePick(instanceOf("block"), "import:volume:block", 2);
await measurePick(instanceOf("block"), "import:volume:block", 0);
await measure(0, 1);
await measurePick(instanceOf("block"), "import:volume:block", 4, [0.98, 0.01, 0.01]);
await measurePick(instanceOf("block"), "import:volume:block", 10, [0.495, 0.495, 0.01]);
await measure(2, 3);
await measure(0, 3);
// A modifier the split would drop: refused before anything is shown.
await choose("instance", instanceOf("guarded"));
await splitToObjects();
await splitToParts();
// Two bodies across both of an object's instances, picked from the second instance.
await choose("instance", instanceOf("pair", 2));
await splitToObjects();
// Parts, then the parts measured (each part placed inside its object), then promoted.
await choose("instance", instanceOf("duo"));
await splitToParts();
await splitToParts();
const duo = live().plates[0].objects.find((o) => o.id === objectOf("duo"));
await measurePick(instanceOf("duo"), duo.volumes[0].id, 2);
await measurePick(instanceOf("duo"), duo.volumes[1].id, 8);
await measure(4, 5);
await splitToObjects();
// Imported models keep their provenance: two bodies as objects at once, each taking a
// copy; two as parts (the object keeps it), then promoted; an unknown key beside it
// refuses the promotion alone, while the parts split keeps everything.
await choose("instance", instanceOf("stl"));
await splitToObjects();
await choose("instance", instanceOf("model"));
await splitToParts();
await splitToObjects();
await choose("instance", instanceOf("kept"));
await splitToObjects();
await splitToParts();
// Simplify the ball: a preview applied by count, one by error, one with nothing to do,
// a preview cancelled, then at once by its object.
await choose("instance", instanceOf("ball"));
await simplify({ useCount: true, decimateRatio: 50, maxError: 1 }, true);
await simplify({ useCount: false, decimateRatio: 50, maxError: 0.05 }, true);
await simplify({ useCount: true, decimateRatio: 0, maxError: 1 }, true);
await simplify({ useCount: true, decimateRatio: 90, maxError: 1 }, false);
await choose("object", objectOf("ball"));
await simplifyNow(50);
await choose("plate", live().activePlateId);
await simplify({ useCount: true, decimateRatio: 40, maxError: 1 }, false);

const undo = [];
for (let count = controller.getSummary().history.undoCount; count > 0; count -= 1) {
  assert.equal(await controller.undoAsync(), true);
  undo.push(observe());
}
assert.equal(undo.at(-1).semanticHash, opened.semanticHash);
const journey = {
  archive: base64(serialized.bytes),
  seed: JOURNEY_SEED,
  skippedIds,
  opened: { semanticHash: opened.semanticHash, assetFingerprint: opened.assetFingerprint },
  steps,
  undo,
};
controller.dispose();
source.dispose?.();

const sources = [
  "tools/cross-platform/model-tool-vectors.mjs",
  "web/src/workspace/SplitSource.ts",
  "web/src/workspace/SplitSourceExchange.ts",
  "web/src/workspace/CanonicalSplitToObjectsFlow.ts",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/project/objects/volumeSplitExchange.ts",
  "web/src/project/objects/splitPreparation.ts",
  "web/src/project/objects/splitToObjectsCommands.ts",
  "web/src/project/objects/splitCommands.ts",
  "web/src/project/objects/simplifyExchange.ts",
  "web/src/project/objects/simplify.ts",
  "web/src/project/objects/measureExchange.ts",
  "web/src/project/objects/measure.ts",
  "web/node_modules/three/package.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    splitSources,
    journey,
  }) + "\n";
const path = new URL("testdata/cross-platform/model-tool-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Model tool reference drift");
const refused = sourceCases.filter((c) => c.reply.startsWith('{"refusal"')).length;
console.log(
  `Model tool references: ${sourceCases.length} split sources (${refused} refused, ${sourceRefusals.length} malformed), ` +
    `journey of ${steps.length} steps (${steps.filter((s) => s.refusal !== null).length} refused) and ${undo.length} undo entries`,
);
