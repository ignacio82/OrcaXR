// Mesh simplification over a live session, from the production browser
// (`simplifyExchange.ts` over `simplify.ts`): a project of curved closed
// spheres, an open terrain, flat gridded boxes whose collapses all tie, the
// same box with exact slivers and a repeated corner, a minimal cube and a pair
// of bodies, decimated by count (including nothing, everything and past both
// ends) and by quadric error (including refused limits), with every refusal.
// Each reply is recorded with the SHA-256 of the result's mesh bytes and of
// one window of them; a host script then stages runs under its own asset IDs
// (applied, stale, refused when unnamed, unchanged or refused, and run
// against an asset ID already in use), with undo and redo, recording each
// outcome, revision, hash and undo label. Replayed by Rust, by WASM in Node
// and Chrome, and over JNI.
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
import {
  prepareVolumeSimplifyWire,
  stageVolumeSimplifyWire,
} from "../../web/src/project/objects/simplifyExchange.ts";
import {
  decodeProjectVolumeSimplifyRequest,
  decodeProjectVolumeSimplifyStage,
  encodeProjectSessionRequest,
  encodeProjectVolumeSimplifyReply,
  encodeProjectVolumeSimplifyRequest,
  encodeProjectVolumeSimplifyStage,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- Meshes -----------------------------------------------------------------
function icosphere(level, radius) {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices = [
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
  ];
  let triangles = [
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
  for (let l = 0; l < level; l++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!cache.has(key))
        cache.set(
          key,
          vertices.push(vertices[a].map((v, i) => (v + vertices[b][i]) / 2)) -
            1,
        );
      return cache.get(key);
    };
    triangles = triangles.flatMap(([a, b, c]) => {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  vertices = vertices.map((p) => p.map((v) => (v / Math.hypot(...p)) * radius));
  return { vertices, triangles };
}
function terrain(n, step) {
  const vertices = [],
    triangles = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++)
      vertices.push([
        x * step,
        y * step,
        2 + 1.5 * Math.sin(x * 0.8) * Math.cos(y * 0.6),
      ]);
  const at = (x, y) => y * (n + 1) + x;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      triangles.push(
        [at(x, y), at(x + 1, y), at(x + 1, y + 1)],
        [at(x, y), at(x + 1, y + 1), at(x, y + 1)],
      );
  return { vertices, triangles };
}
// A closed box of gridded faces at integer coordinates, welded.
function griddedBox(n) {
  const index = new Map(),
    vertices = [],
    triangles = [];
  const id = (p) => {
    const key = p.join(",");
    if (!index.has(key)) index.set(key, vertices.push(p) - 1);
    return index.get(key);
  };
  const faces = [
    [(u, v) => [u, v, 0], true],
    [(u, v) => [u, v, n], false],
    [(u, v) => [u, 0, v], false],
    [(u, v) => [u, n, v], true],
    [(u, v) => [0, u, v], true],
    [(u, v) => [n, u, v], false],
  ];
  for (const [face, flip] of faces)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = id(face(i, j)),
          b = id(face(i + 1, j)),
          c = id(face(i + 1, j + 1)),
          d = id(face(i, j + 1));
        for (const [x, y, z] of [
          [a, b, c],
          [a, c, d],
        ])
          triangles.push(flip ? [x, z, y] : [x, y, z]);
      }
  return { vertices, triangles, id };
}
function cube(at, size) {
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
  ];
  return { vertices, triangles };
}
const slivered = griddedBox(4);
for (const [p, q] of [
  [slivered.id([1, 1, 0]), slivered.id([2, 1, 0])],
  [slivered.id([2, 2, 4]), slivered.id([2, 3, 4])],
]) {
  const [a, b] = [slivered.vertices[p], slivered.vertices[q]];
  const m = slivered.vertices.push(a.map((c, k) => (c + b[k]) / 2)) - 1;
  slivered.triangles.push([p, m, q]);
}
slivered.triangles.push([
  slivered.id([3, 3, 0]),
  slivered.id([3, 3, 0]),
  slivered.id([2, 3, 0]),
]);
const first = cube([0, 0, 0], 6),
  second = cube([10.5, 2.25, 0], 3.5);
const pairMesh = {
  vertices: [...first.vertices, ...second.vertices],
  triangles: [
    ...first.triangles,
    ...second.triangles.map((t) => t.map((v) => v + 8)),
  ],
};
const asset = (name, mesh, sourceFilename) =>
  encodeIndexedMeshAsset({
    id: `import:asset:simplify-${name}`,
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
    ...(sourceFilename ? { sourceFilename } : {}),
    provenance: { source: "import", uri: `fixture:simplify-${name}` },
  });
const meshes = {
  sphere: asset("sphere", icosphere(2, 10), "sphere.stl"),
  fine: asset("fine", icosphere(3, 12.5)),
  terrain: asset("terrain", terrain(10, 1.5), "terrain.stl"),
  box: asset("box", griddedBox(4)),
  slivered: asset("slivered", slivered, "slivered.stl"),
  cube: asset("cube", cube([0, 0, 0], 10)),
  pair: asset("pair", pairMesh),
};
const payloads = Object.values(meshes);

// --- The project ------------------------------------------------------------
const fixture = createProjectFixture();
const state = structuredClone(fixture.state);
const template = state.plates[0].objects[0];
const volume = (name, source, extra = {}) => ({
  id: `import:volume:simplify-${name}`,
  name,
  role: "model",
  source: {
    assetId: source.descriptor.id,
    topologyRevision: 0,
    triangleCount: source.descriptor.mesh.triangleCount,
  },
  transform: {
    translationMm: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  },
  config: {},
  annotations: emptyFacetAnnotations(0),
  ...extra,
});
state.plates[0].objects = Object.entries(meshes).map(([name, source], i) => ({
  ...structuredClone(template),
  id: `import:object:simplify-${name}`,
  name,
  layerRanges: [],
  volumes: [
    volume(
      name,
      source,
      name === "sphere"
        ? {
            annotations: {
              ...emptyFacetAnnotations(0),
              color: [{ value: fixture.ids.physical1, triangles: [0, 3, 9] }],
            },
          }
        : {},
    ),
  ],
  instances: [
    {
      id: `import:instance:simplify-${name}`,
      transform: {
        translationMm: [30 * i + 20, 60, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      printable: true,
    },
  ],
}));
state.sourceAssets = payloads.map((a) => a.descriptor);
assertValidProjectState(state);
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
const runs = new Map();
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
function prepare(name, volume, useCount, decimateRatio, maxError) {
  const text = encodeProjectVolumeSimplifyRequest({
    volumeId: units(`import:volume:simplify-${volume}`),
    useCount,
    decimateRatio,
    maxError,
  });
  const guard = facade.captureGuard();
  const { reply, simplify } = prepareVolumeSimplifyWire(
    session.project.getSnapshot().state,
    session.assets,
    decodeProjectVolumeSimplifyRequest(text),
  );
  const step = {
    simplify: name,
    prepare: text,
    reply: encodeProjectVolumeSimplifyReply(reply),
  };
  if (simplify) {
    runs.set(name, { simplify, guard });
    const bytes = simplify.preview.bytes;
    step.mesh = sha256(bytes);
    if (bytes.length >= 80) step.window = sha256(bytes.subarray(16, 80));
  } else runs.set(name, { guard });
  steps.push(step);
}
const code = (e) =>
  e instanceof AsyncSessionError
    ? e.code === "invalid-request"
      ? "invalidRequest"
      : e.code
    : e instanceof StagedInputError && e.code === "limit"
      ? "resourceLimit"
      : "invalidRequest";
// Stage a prepared run under a host asset ID and execute it, as the bindings
// do: a run whose state changed refuses `stale` before its ID is read.
async function stage(name, assetId) {
  const text = encodeProjectVolumeSimplifyStage({ assetId: units(assetId) });
  const { simplify, guard } = runs.get(name);
  let outcome;
  try {
    if (!facade.isCurrent(guard)) throw new AsyncSessionError("stale");
    if (!simplify) throw new StagedInputError("invalid");
    const work = stageVolumeSimplifyWire(
      simplify,
      decodeProjectVolumeSimplifyStage(text),
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
  steps.push({ simplify: name, stage: text, outcome, ...observe() });
}
async function history(direction) {
  const result = await handle({
    [direction]: wireSessionGuard(facade.captureGuard()),
  });
  assert.ok("acknowledged" in result, direction);
  steps.push({ history: direction, ...observe() });
}

// Count and error runs over every mesh, then the refusals.
for (const name of Object.keys(meshes)) {
  for (const ratio of [10, 50, 90])
    prepare(`${name} ${ratio}%`, name, true, ratio, 1);
  for (const error of [1e-9, 0.01, 1])
    prepare(`${name} ≤${error}`, name, false, 50, error);
}
prepare("nothing", "cube", true, 0, 1);
prepare("below nothing", "sphere", true, -5, 1);
prepare("everything", "cube", true, 100, 1);
prepare("past everything", "pair", true, 150, 1);
prepare("all but one", "sphere", true, 99.9, 0);
prepare("huge error", "fine", false, 0, 1e300);
prepare("zero error", "sphere", false, 50, 0);
prepare("negative error", "sphere", false, 50, -1);
prepare("unknown", "missing", true, 50, 1);

// Stages: refused and unchanged runs name nothing; unstable IDs are refused;
// an ID already holding other bytes fails when it runs; a run applies once,
// then its state has moved on; undo and redo walk back over it.
await stage("everything", "import:host:simplify-everything");
await stage("nothing", "import:host:simplify-nothing");
await stage("sphere 50%", " import:host:padded");
await stage("sphere 50%", "import:asset:simplify-terrain");
prepare("sphere 50%", "sphere", true, 50, 1);
await stage("sphere 50%", "import:host:simplify-sphere");
await stage("sphere 50%", "import:host:simplify-sphere-again");
await stage("terrain 90%", "import:host:simplify-terrain");
prepare("slivered 90%", "slivered", true, 90, 1);
await stage("slivered 90%", "import:host:simplify-slivered");
await history("undo");
await history("undo");
await history("redo");
prepare("fine 50%", "fine", true, 50, 1);
await stage("fine 50%", "import:host:simplify-fine");
session.dispose();

const sources = [
  "tools/cross-platform/simplify-vectors.mjs",
  "web/src/project/objects/simplifyExchange.ts",
  "web/src/project/objects/simplify.ts",
  "web/src/project/objects/topologyCommands.ts",
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
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/simplify-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Simplify reference drift");
const count = (predicate) => steps.filter(predicate).length;
const replies = Object.groupBy(
  steps.filter((s) => "prepare" in s),
  (s) => Object.keys(JSON.parse(s.reply))[0],
);
const outcomes = Object.groupBy(
  steps.filter((s) => "outcome" in s),
  (s) => s.outcome,
);
console.log(
  `simplify: ${count((s) => "prepare" in s)} preparations (${Object.entries(
    replies,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}), stages ${Object.entries(outcomes)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}, ${count((s) => "history" in s)} history steps`,
);
