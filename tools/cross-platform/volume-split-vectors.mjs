// Volume splits over a live session, from the production browser
// (`volumeSplitExchange.ts` over `splitPreparation.ts`): a project of
// compound meshes — closed cubes interleaved face by face, one wound inside
// out and one repeating another's geometry; open sheets, a collinear sliver
// and a three-way fan; a connected ball; a mesh that repeats a vertex; a
// painted pair — under rotated, scaled and offset volume transforms, plus a
// spare asset that already holds one component's exact bytes, and an
// imported pair whose provenance (`orcaxr:importSource`) every object split
// from it keeps, alone or beside an unknown key that refuses the promotion. A host script
// prepares splits (with every reachable refusal), stages them under its own
// IDs as parts or as objects (with every naming refusal and a stale stage),
// executes them through the session endpoint and walks undo and redo,
// recording each reply, outcome, revision, hash and undo label. Replayed by
// Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession } from "../../web/src/project/session.ts";
import {
  AsyncEditorSession,
  AsyncSessionError,
} from "../../web/src/project/AsyncEditorSession.ts";
import {
  ProjectSessionEndpoint,
  wireSessionGuard,
} from "../../web/src/project/ProjectSessionEndpoint.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { StagedInputError } from "../../web/src/project/StagedProjectCommands.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { prepareVolumeSplitComponents } from "../../web/src/project/objects/splitPreparation.ts";
import {
  prepareVolumeSplitWire,
  stageVolumeSplitWire,
} from "../../web/src/project/objects/volumeSplitExchange.ts";
import {
  decodeProjectVolumeSplitRequest,
  decodeProjectVolumeSplitStage,
  encodeProjectSessionRequest,
  encodeProjectVolumeSplitReply,
  encodeProjectVolumeSplitRequest,
  encodeProjectVolumeSplitStage,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// --- Meshes -----------------------------------------------------------------
// A closed cube of edge `size` at `at`, wound outward (or inside out).
function cube(at, size, inverted = false) {
  const vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map((v) => v.map((c, i) => at[i] + c * size));
  const triangles = [
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
  ].map(([a, b, c]) => (inverted ? [a, c, b] : [a, b, c]));
  return { vertices, triangles };
}
// Several bodies in one mesh, their faces interleaved round-robin so the
// pinned seed and discovery order matter.
function interleave(...bodies) {
  const vertices = [],
    triangles = [],
    offsets = [];
  for (const body of bodies) {
    offsets.push(vertices.length);
    vertices.push(...body.vertices);
  }
  const longest = Math.max(...bodies.map((b) => b.triangles.length));
  for (let t = 0; t < longest; t++)
    bodies.forEach((body, i) => {
      if (t < body.triangles.length)
        triangles.push(body.triangles[t].map((v) => v + offsets[i]));
    });
  return { vertices, triangles };
}
const sheet = (vertices, triangles) => ({ vertices, triangles });
function icosahedron(radius) {
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => p.map((v) => (v / Math.hypot(...p)) * radius));
  const triangles = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return { vertices, triangles };
}
const asset = (id, mesh) =>
  encodeIndexedMeshAsset({
    id,
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
    sourceFilename: `${id.slice(id.lastIndexOf(":") + 1)}.stl`,
    provenance: { source: "import", uri: `fixture:${id}` },
  });

// Three cubes: A, B inside out at fractional coordinates, and C repeating A.
const trioMesh = interleave(
  cube([0, 0, 0], 6),
  cube([20.3, -4.7, 1.15], 5.5, true),
  cube([0, 30, 0], 6),
);
// Two open quads (one wound against the other across a shared-direction
// edge), a collinear sliver and a fan of three faces on one edge.
const sheetsMesh = sheet(
  [
    [0, 0, 0],
    [4, 0, 0],
    [4, 4, 0],
    [0, 4, 0],
    [8, 0, 0],
    [8, 4, 0],
    [10, 0, 0],
    [11, 0, 0],
    [12.5, 0, 0],
    [20, 0, 0],
    [21, 0, 0],
    [20.5, 1, 0],
    [20.5, -1, 0.25],
    [20.5, 0.5, 1],
  ],
  [
    [0, 1, 2],
    [0, 2, 3],
    [1, 2, 4],
    [4, 2, 5],
    [6, 7, 8],
    [9, 10, 11],
    [10, 9, 12],
    [10, 9, 13],
  ],
);
const pairMesh = interleave(
  cube([-3.25, 0.5, 0], 2.5),
  cube([4.125, -1.75, 0.5], 3.75),
);
const ballMesh = icosahedron(5);
const brokenMesh = {
  vertices: [...cube([0, 0, 0], 2).vertices, [9, 9, 9]],
  triangles: [...cube([0, 0, 0], 2).triangles, [8, 8, 0]],
};
const trio = asset("import:asset:split-trio", trioMesh);
const sheets = asset("import:asset:split-sheets", sheetsMesh);
const pair = asset("import:asset:split-pair", pairMesh);
const ball = asset("import:asset:split-ball", ballMesh);
const broken = asset("import:asset:split-broken", brokenMesh);
// The first cube's own recentred component bytes, held under another ID.
const [firstCube] = prepareVolumeSplitComponents({
  sourceAsset: trio,
  sourceTransform: {
    translationMm: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  },
});
const spare = {
  descriptor: {
    ...firstCube.preview.descriptor,
    id: "import:asset:split-spare",
    provenance: { source: "import", uri: "fixture:spare" },
  },
  bytes: firstCube.preview.bytes,
};

// --- The project ------------------------------------------------------------
const fixture = createProjectFixture();
const state = structuredClone(fixture.state);
const template = state.plates[0].objects[0];
const transform = (
  translationMm,
  rotation = [0, 0, 0, 1],
  scale = [1, 1, 1],
) => ({
  translationMm,
  rotation,
  scale,
});
const volume = (name, source, extra = {}) => ({
  id: `import:volume:split-${name}`,
  name,
  role: "model",
  source: {
    assetId: source.descriptor.id,
    topologyRevision: 0,
    triangleCount: source.descriptor.mesh.triangleCount,
  },
  transform: transform([0, 0, 0]),
  config: {},
  annotations: emptyFacetAnnotations(0),
  ...extra,
});
const object = (name, volumes, instances = 1, extra = {}) => ({
  ...structuredClone(template),
  id: `import:object:split-${name}`,
  name,
  layerRanges: [],
  volumes,
  instances: Array.from({ length: instances }, (_, i) => ({
    id: `import:instance:split-${name}-${i}`,
    transform: transform([40 * i + 20, 60, 0]),
    printable: true,
  })),
  ...extra,
});
const { physical1, mixed } = fixture.ids;
// What `ModelImportParser` gives an imported object.
const provenance = {
  "orcaxr:importSource": {
    filename: "pair.stl",
    format: "stl",
    unit: "mm",
    importedAt: "2026-10-10T00:00:00.000Z",
  },
};
state.plates[0].objects = [
  object("compound", [
    volume("trio", trio, {
      transform: transform(
        [5, -3, 2],
        [0, 0, 0.3826834323650898, 0.9238795325112867],
        [1, 2, 0.5],
      ),
      config: { wall_loops: 4 },
    }),
    volume("modifier", ball, {
      role: "parameter-modifier",
      transform: transform([0, 0, 4]),
    }),
  ]),
  object(
    "pair",
    [volume("pair", pair, { transform: transform([1, 2, 3]) })],
    2,
  ),
  object("sheets", [volume("sheets", sheets)]),
  object("ball", [volume("ball", ball)]),
  object("broken", [volume("broken", broken)]),
  object("painted", [
    volume("painted", pair, {
      annotations: {
        ...emptyFacetAnnotations(0),
        color: [
          { value: physical1, triangles: [0, 2, 5] },
          { value: mixed, triangles: [1, 7] },
        ],
      },
    }),
  ]),
  object("spare", [volume("spare", spare)]),
  object("imported", [volume("imported", pair)], 1, { extensionData: provenance }),
  object("unknown", [volume("unknown", pair)], 1, {
    extensionData: { ...provenance, "orcaxr:owner": "host" },
  }),
];
state.sourceAssets = [trio, sheets, pair, ball, broken, spare].map(
  (a) => a.descriptor,
);
assertValidProjectState(state);
const payloads = [trio, sheets, pair, ball, broken, spare];
const assets = new InMemoryAssetRepository();
for (const a of payloads) assets.put(a.descriptor, a.bytes);

// --- The session ------------------------------------------------------------
const session = new EditorSession({
  initialState: state,
  assets,
  serializer: {
    serialize: () => Promise.reject(new Error("unused")),
    deserialize: () => Promise.reject(new Error("unused")),
  },
});
const nonce = [0, 1, 2147483648, 4294967295];
const facade = new AsyncEditorSession(session);
const endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
// The bindings' staging budget, and generous input limits under it.
endpoint.configureStaging({
  maxResources: 4,
  maxCommands: 16,
  maxUnits: 64_000_000,
  maxAssetBytes: 16_000_000,
});
const input = {
  maxUnits: 64_000_000,
  maxNodes: 64_000_000,
  maxDepth: 128,
  maxAssets: 64,
  maxAssetBytes: 16_000_000,
};
let sequence = 0;
const handle = async (operation) =>
  JSON.parse(
    await endpoint.handle(
      encodeProjectSessionRequest({
        protocolVersion: 1,
        generation: nonce,
        requestId: ++sequence,
        operation,
      }),
    ),
  ).result;
assert.ok(
  (
    await handle({
      hello: {
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
        projectSchemaVersion: 1,
        intentVersion: 1,
      },
    })
  ).welcome,
);

// --- The host script ----------------------------------------------------------
const steps = [];
const splits = new Map();
const observe = () => {
  const snapshot = session.project.getSnapshot();
  const history = session.commands.getHistorySnapshot();
  return {
    revision: snapshot.revision,
    hash: snapshot.hash,
    undoLabel:
      history.undoLabel === undefined ? null : units(history.undoLabel),
  };
};
function prepare(name, volumeId) {
  const text = encodeProjectVolumeSplitRequest({ volumeId: units(volumeId) });
  const guard = facade.captureGuard();
  const { reply, split } = prepareVolumeSplitWire(
    session.project.getSnapshot().state,
    session.assets,
    decodeProjectVolumeSplitRequest(text),
  );
  if (split) splits.set(name, { split, guard });
  steps.push({
    split: name,
    prepare: text,
    reply: encodeProjectVolumeSplitReply(reply),
  });
  return split;
}
const code = (e) =>
  e instanceof AsyncSessionError
    ? e.code === "invalid-request"
      ? "invalidRequest"
      : e.code
    : e instanceof StagedInputError && e.code === "limit"
      ? "resourceLimit"
      : "invalidRequest";
// Stage a prepared split under host IDs and run it, as the bindings do: a
// split whose state changed refuses `stale` before its names are read.
async function stage(name, ids, objects) {
  const text = encodeProjectVolumeSplitStage({
    volumeIds: ids.volumeIds.map(units),
    assetIds: ids.assetIds.map(units),
    objects:
      objects === undefined
        ? { absent: {} }
        : {
            value: objects.map((o) => ({
              sourceVolumeId: units(o.sourceVolumeId),
              objectId: units(o.objectId),
              instanceIds: o.instanceIds.map(units),
            })),
          },
  });
  const { split, guard } = splits.get(name);
  let outcome;
  try {
    if (!facade.isCurrent(guard)) throw new AsyncSessionError("stale");
    const work = stageVolumeSplitWire(
      split,
      session.project.getSnapshot().state,
      session.assets,
      decodeProjectVolumeSplitStage(text),
      input,
    );
    const stagedId = endpoint.stage(work, guard);
    const result = await handle({ executeStaged: { stagedId } });
    outcome =
      "acknowledged" in result
        ? result.acknowledged.changed
          ? "applied"
          : "unchanged"
        : result.error;
  } catch (e) {
    outcome = code(e);
  }
  steps.push({ split: name, stage: text, outcome, ...observe() });
}
async function history(direction) {
  const result = await handle({
    [direction]: wireSessionGuard(facade.captureGuard()),
  });
  assert.ok("acknowledged" in result, direction);
  steps.push({ history: direction, ...observe() });
}
async function rename(objectId, name) {
  const intent = {
    version: 1,
    command: { renameObject: { objectId: units(objectId), name: units(name) } },
  };
  const result = await handle({
    execute: { guard: wireSessionGuard(facade.captureGuard()), intent },
  });
  assert.ok("acknowledged" in result, "rename");
  steps.push({ edit: JSON.stringify(intent), ...observe() });
}
// Host IDs: one volume per part, one asset per distinct geometry.
const named = (split, stem) => {
  const volumeIds = [],
    assetIds = [];
  for (const geometry of split.partGeometries) {
    if (geometry === assetIds.length)
      assetIds.push(`import:host:asset-${stem}-${assetIds.length}`);
    volumeIds.push(`import:host:volume-${stem}-${volumeIds.length}`);
  }
  return { volumeIds, assetIds };
};
const separated = (ids, stem, instances) =>
  ids.volumeIds.map((sourceVolumeId, i) => ({
    sourceVolumeId,
    objectId: `import:host:object-${stem}-${i}`,
    instanceIds: Array.from(
      { length: instances },
      (_, k) => `import:host:instance-${stem}-${i}-${k}`,
    ),
  }));

// Refusals the session can reach: an unknown volume, one connected body and
// a mesh that repeats a vertex.
prepare("unknown", "import:volume:split-missing");
prepare("ball", "import:volume:split-ball");
prepare("broken", "import:volume:split-broken");
prepare("modifier", "import:volume:split-modifier");

// The trio as parts of its two-volume object: naming refusals first.
const trioSplit = prepare("trio", "import:volume:split-trio");
const trioIds = named(trioSplit, "trio");
await stage("trio", {
  volumeIds: trioIds.volumeIds.slice(1),
  assetIds: trioIds.assetIds,
});
await stage("trio", {
  volumeIds: trioIds.volumeIds,
  assetIds: [...trioIds.assetIds, "import:host:asset-extra"],
});
await stage("trio", {
  volumeIds: [trioIds.volumeIds[0], trioIds.volumeIds[0], trioIds.volumeIds[2]],
  assetIds: trioIds.assetIds,
});
await stage("trio", {
  volumeIds: trioIds.volumeIds,
  assetIds: ["import:asset:split-trio", trioIds.assetIds[1]],
});
await stage("trio", {
  volumeIds: trioIds.volumeIds,
  assetIds: [trioIds.assetIds[0], trioIds.assetIds[0]],
});
await stage("trio", {
  volumeIds: [trioIds.assetIds[0], ...trioIds.volumeIds.slice(1)],
  assetIds: trioIds.assetIds,
});
await stage("trio", {
  volumeIds: [" import:host:padded", ...trioIds.volumeIds.slice(1)],
  assetIds: trioIds.assetIds,
});
// As objects, a two-volume object's split is refused when it runs.
await stage("trio", trioIds, separated(trioIds, "trio", 1));
// Then as parts: the first and third cube take the spare asset's bytes.
await stage("trio", trioIds);
await stage("trio", trioIds);
await history("undo");
await history("redo");

// The pair as objects of its two instances: a split prepared before an edit
// is stale; objects that do not name the parts, or name too few instances,
// are refused; then the split, undone with the edit and redone.
prepare("stale pair", "import:volume:split-pair");
await rename("import:object:split-ball", "Renamed ball");
await stage("stale pair", named(splits.get("stale pair").split, "stale"));
// Each refused run rolls back but moves the revision, so each attempt
// prepares afresh.
const pairIds = named(prepare("pair", "import:volume:split-pair"), "pair");
for (const objects of [
  separated(pairIds, "pair", 1),
  separated(pairIds, "pair", 2).reverse(),
  separated(pairIds, "pair", 2).slice(1),
  separated(named(splits.get("pair").split, "other"), "pair", 2),
  separated(pairIds, "pair", 2),
]) {
  await stage("pair", pairIds, objects);
  prepare("pair", "import:volume:split-pair");
}
await history("undo");
await history("undo");
await history("redo");

// Open sheets, a sliver and a fan; then a painted pair, whose parts reset
// their annotations (undone) and whose objects keep them.
const sheetsSplit = prepare("sheets", "import:volume:split-sheets");
await stage("sheets", named(sheetsSplit, "sheets"));
const paintedParts = prepare("painted parts", "import:volume:split-painted");
await stage("painted parts", named(paintedParts, "painted-parts"));
await history("undo");
const paintedSplit = prepare("painted", "import:volume:split-painted");
const paintedIds = named(paintedSplit, "painted");
await stage("painted", paintedIds, separated(paintedIds, "painted", 1));
// A split part of an earlier split splits no further.
prepare("part", "import:host:volume-sheets-0");

// An imported pair as objects: each takes a copy of its provenance. An
// unknown key beside it refuses the promotion when it runs; the same pair
// still splits to parts, its object keeping everything.
const importedIds = named(prepare("imported", "import:volume:split-imported"), "imported");
await stage("imported", importedIds, separated(importedIds, "imported", 1));
for (const objectId of ["import:host:object-imported-0", "import:host:object-imported-1"]) {
  const promoted = session.project
    .getSnapshot()
    .state.plates[0].objects.find((o) => o.id === objectId);
  assert.deepEqual(promoted.extensionData, provenance, objectId);
}
const unknownIds = named(prepare("unknown", "import:volume:split-unknown"), "unknown");
await stage("unknown", unknownIds, separated(unknownIds, "unknown", 1));
const unknownParts = named(prepare("unknown parts", "import:volume:split-unknown"), "unknown-parts");
await stage("unknown parts", unknownParts);
session.dispose();

// Sources no valid session holds, prepared directly from a state and its
// assets: a missing or redescribed payload, a doubled declaration, a zero
// scale or rotation, an empty mesh and a malformed layout.
const direct = [];
function prepareDirect(name, mutate) {
  const next = structuredClone(state);
  const held = new Map(payloads.map((a) => [a.descriptor.id, a]));
  const volumeId = mutate(next, held) ?? "import:volume:split-trio";
  const repository = new InMemoryAssetRepository();
  for (const a of held.values()) repository.put(a.descriptor, a.bytes);
  const request = encodeProjectVolumeSplitRequest({
    volumeId: units(volumeId),
  });
  const { reply } = prepareVolumeSplitWire(
    next,
    repository,
    decodeProjectVolumeSplitRequest(request),
  );
  // Base payloads by index, others in full; the state only when it changed.
  const stateJson = canonicalStringify(next);
  direct.push({
    name,
    ...(stateJson === canonicalStringify(state) ? {} : { stateJson }),
    assets: [...held.values()].map((a) =>
      payloads.includes(a)
        ? payloads.indexOf(a)
        : {
            descriptorJson: canonicalStringify(a.descriptor),
            bytes: [...a.bytes],
          },
    ),
    request,
    reply: encodeProjectVolumeSplitReply(reply),
  });
}
const trioVolume = (next) => next.plates[0].objects[0].volumes[0];
prepareDirect("missing payload", (_, held) => {
  held.delete(trio.descriptor.id);
});
prepareDirect("redescribed payload", (_, held) => {
  held.set(trio.descriptor.id, {
    descriptor: { ...trio.descriptor, sourceFilename: "renamed.stl" },
    bytes: trio.bytes,
  });
});
prepareDirect("doubled declaration", (next) => {
  next.sourceAssets.push(structuredClone(trio.descriptor));
});
prepareDirect("zero scale", (next) => {
  trioVolume(next).transform.scale = [1, 0, 1];
});
prepareDirect("zero rotation", (next) => {
  trioVolume(next).transform.rotation = [0, 0, 0, 0];
});
prepareDirect("tiny scale", (next) => {
  trioVolume(next).transform.scale = [1, 1, -9e-13];
});
const empty = encodeIndexedMeshAsset({
  id: "import:asset:split-empty",
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [],
});
prepareDirect("empty mesh", (next, held) => {
  held.set(empty.descriptor.id, empty);
  next.sourceAssets.push(empty.descriptor);
  trioVolume(next).source = {
    assetId: empty.descriptor.id,
    topologyRevision: 0,
    triangleCount: 0,
  };
});
const malformed = {
  descriptor: {
    ...structuredClone(pair.descriptor),
    id: "import:asset:split-malformed",
    mesh: {
      ...structuredClone(pair.descriptor.mesh),
      positions: {
        ...pair.descriptor.mesh.positions,
        byteStride: 8,
      },
    },
  },
  bytes: pair.bytes,
};
prepareDirect("malformed layout", (next, held) => {
  held.set(malformed.descriptor.id, malformed);
  next.sourceAssets.push(malformed.descriptor);
  trioVolume(next).source = {
    assetId: malformed.descriptor.id,
    topologyRevision: 0,
    triangleCount: 24,
  };
});
// A modifier splits like any other volume.
prepareDirect("pair as a modifier", (next) => {
  const volume = next.plates[0].objects[1].volumes[0];
  volume.role = "negative-volume";
  return volume.id;
});

const sources = [
  "tools/cross-platform/volume-split-vectors.mjs",
  "web/src/project/objects/volumeSplitExchange.ts",
  "web/src/project/objects/splitPreparation.ts",
  "web/src/project/objects/splitCommands.ts",
  "web/src/project/objects/splitToObjectsCommands.ts",
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
      assets: payloads.map((a) => ({
        descriptorJson: canonicalStringify(a.descriptor),
        bytes: [...a.bytes],
      })),
      steps,
      direct,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/volume-split-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Volume split reference drift",
  );
const count = (predicate) => steps.filter(predicate).length;
const outcomes = Object.groupBy(
  steps.filter((s) => "outcome" in s),
  (s) => s.outcome,
);
console.log(
  `volume splits: ${count((s) => "prepare" in s)} preparations (${count((s) => s.reply?.startsWith('{"refused"'))} refused), stages ${Object.entries(
    outcomes,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(
      ", ",
    )}, ${count((s) => "history" in s)} history steps, ${direct.length} direct preparations`,
);
