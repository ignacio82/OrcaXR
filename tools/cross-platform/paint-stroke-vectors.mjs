// Paint strokes over a live session, from the production browser: a project
// with a painted icosphere, a support-painted terrain and a modifier, opened
// as a real TypeScript session, and a host script of strokes answered by
// `PaintStrokeExchange` in the shared contract's encoding. Strokes open on a
// volume, channel and target (with every open refusal), stream samples —
// brushes dragged with and without triangle splitting, Fill, Triangle,
// Height Range, Gap Fill, invalid tool input — page their overlays, and
// commit through the browser's own facet commands: ranges, refined trees
// over a persisted refinement, a stroke that touched nothing, one that
// changes nothing, and one that went stale. Every sample's live preview and
// every commit's canonical overlay are recorded as paint overlay packets
// (`PaintOverlay.ts`), compared by SHA-256. Replayed by Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession } from "../../web/src/project/session.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  commitFacetAnnotationStroke,
  commitFacetRefinement,
} from "../../web/src/project/annotations/FacetAnnotationStrokeCommand.ts";
import { StaleFacetAnnotationResultError } from "../../web/src/project/annotations/types.ts";
import {
  PaintStrokeExchange,
  PaintStrokeRefusal,
} from "../../web/src/project/painting/PaintStrokeExchange.ts";
import {
  PaintOverlayRefusal,
  capturePaintOverlay,
} from "../../web/src/project/painting/PaintOverlay.ts";
import {
  decodeProjectPaintOverlayRequest,
  encodeProjectPaintOverlayRequest,
  encodeProjectPaintOverlaySummary,
  decodeProjectPaintStrokeOpen,
  decodeProjectPaintStrokeOverlayRequest,
  decodeProjectPaintStrokeSample,
  encodeProjectPaintStrokeOpen,
  encodeProjectPaintStrokeOverlay,
  encodeProjectPaintStrokeOverlayRequest,
  encodeProjectPaintStrokeSample,
  encodeProjectPaintStrokeSampleReply,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// Two meshes: an icosphere and an open terrain.
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
const asset = (id, mesh) =>
  encodeIndexedMeshAsset({
    id,
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
  });

const fixture = createProjectFixture();
const sphereMesh = icosphere(2, 8),
  terrainMesh = terrain(8, 1.25);
const sphere = asset("import:asset:stroke-sphere", sphereMesh);
const ground = asset("import:asset:stroke-terrain", terrainMesh);
const state = structuredClone(fixture.state);
const object = state.plates[0].objects[0];
const { physical0, physical1, mixed } = fixture.ids;
// A disabled copy of the mixed recipe: a palette entry that cannot be painted.
const disabled = "5d4f0b8e-2c1a-4b7e-9f3d-6a2e8c1b0f47";
state.filaments.mixed.push({
  ...structuredClone(state.filaments.mixed[0]),
  id: disabled,
  name: "Disabled mix",
  enabled: false,
});
const every = (count, step, offset = 0) =>
  Array.from({ length: count }, (_, i) => i).filter((i) => i % step === offset);
const sphereId = object.volumes[0].id;
const terrainId = "import:volume:stroke-terrain";
const modifierId = "import:volume:stroke-modifier";
object.volumes = [
  {
    ...object.volumes[0],
    source: {
      assetId: sphere.descriptor.id,
      topologyRevision: 0,
      triangleCount: 320,
    },
    annotations: {
      ...emptyFacetAnnotations(0),
      color: [
        { value: physical1, triangles: every(320, 7) },
        {
          value: mixed,
          triangles: every(320, 11, 3).filter((t) => t % 7 !== 0),
        },
      ],
    },
  },
  {
    id: terrainId,
    name: "Terrain",
    role: "model",
    source: {
      assetId: ground.descriptor.id,
      topologyRevision: 0,
      triangleCount: 128,
    },
    transform: {
      translationMm: [0, 0, 1],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    config: {},
    annotations: {
      ...emptyFacetAnnotations(0),
      support: [
        { value: "enforce", triangles: every(128, 9) },
        {
          value: "block",
          triangles: every(128, 13, 5).filter((t) => t % 9 !== 0),
        },
      ],
    },
  },
  {
    id: modifierId,
    name: "Modifier",
    role: "parameter-modifier",
    source: {
      assetId: ground.descriptor.id,
      topologyRevision: 0,
      triangleCount: 128,
    },
    transform: {
      translationMm: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    config: {},
    annotations: emptyFacetAnnotations(0),
  },
];
state.sourceAssets = [sphere.descriptor, ground.descriptor];
const assets = new InMemoryAssetRepository();
assets.put(sphere.descriptor, sphere.bytes);
assets.put(ground.descriptor, ground.bytes);
const session = new EditorSession({
  initialState: state,
  assets,
  serializer: {
    serialize: () => Promise.reject(new Error("unused")),
    deserialize: () => Promise.reject(new Error("unused")),
  },
});

// --- The host script ---------------------------------------------------------
const steps = [];
const strokes = new Map();
const absent = { absent: {} };
const assigned = (value) =>
  typeof value === "boolean"
    ? { assigned: { flag: value } }
    : { assigned: { text: units(value) } };
const unpainted = { unpainted: {} };
function open(name, volumeId, channel, target) {
  const text = encodeProjectPaintStrokeOpen({
    volumeId: units(volumeId),
    channel,
    target,
  });
  try {
    strokes.set(
      name,
      PaintStrokeExchange.open(
        session.project.getSnapshot(),
        session.assets,
        decodeProjectPaintStrokeOpen(text),
      ),
    );
    steps.push({ stroke: name, open: text });
    opened.set(name, { volumeId, channel });
  } catch (error) {
    if (!(error instanceof PaintStrokeRefusal)) throw error;
    steps.push({ stroke: name, open: text, refusal: code(error) });
  }
}
const code = (error) => error.code.replaceAll("-", "_");
const opened = new Map();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// One overlay capture: its summary and its whole packet, or the refusal.
function packets(capture, step) {
  const facets = capture.facets.stateIndices.length;
  steps.push({
    ...step,
    summary: encodeProjectPaintOverlaySummary(capture.summary()),
    packet: sha256(capture.packet(0, 16384)),
    ...(facets > 2 ? { window: sha256(capture.packet(1, 2)) } : {}),
  });
}
// The stroke's live preview, as the workspace draws it after a sample.
function preview(name) {
  packets(strokes.get(name).preview(), { stroke: name, preview: true });
}
// The canonical overlay of one volume's channel, as the workspace draws it.
function canonical(volumeId, channel) {
  const text = encodeProjectPaintOverlayRequest({
    volumeId: units(volumeId),
    channel,
  });
  try {
    packets(
      capturePaintOverlay(
        session.project.getSnapshot(),
        session.assets,
        decodeProjectPaintOverlayRequest(text),
      ),
      { canonical: text },
    );
  } catch (error) {
    if (!(error instanceof PaintOverlayRefusal)) throw error;
    steps.push({ canonical: text, refusal: code(error) });
  }
}
function sample(name, request) {
  const text = encodeProjectPaintStrokeSample({
    triangleSplitting: false,
    clippingPlane: absent,
    transform: absent,
    highlightByAngleDegrees: absent,
    ...request,
  });
  const reply = strokes.get(name).sample(decodeProjectPaintStrokeSample(text));
  steps.push({
    stroke: name,
    sample: text,
    reply: encodeProjectPaintStrokeSampleReply(reply),
  });
  preview(name);
}
function overlay(name, start = 0, count = 4096) {
  const text = encodeProjectPaintStrokeOverlayRequest({ start, count });
  try {
    const reply = strokes
      .get(name)
      .overlay(decodeProjectPaintStrokeOverlayRequest(text));
    steps.push({
      stroke: name,
      overlay: text,
      reply: encodeProjectPaintStrokeOverlay(reply),
    });
  } catch (error) {
    if (!(error instanceof PaintStrokeRefusal)) throw error;
    steps.push({ stroke: name, overlay: text, refusal: code(error) });
  }
}
// Commit through the browser's own facet commands, as the workspace does.
function commit(name, label) {
  const work = strokes.get(name).commit(label);
  strokes.delete(name);
  let outcome;
  if (!work) outcome = "noop";
  else {
    try {
      const result =
        work.kind === "refinement"
          ? commitFacetRefinement(session.commands, work.request)
          : commitFacetAnnotationStroke(session.commands, work.request);
      outcome = result.status === "applied" ? "applied" : "unchanged";
    } catch (error) {
      if (!(error instanceof StaleFacetAnnotationResultError)) throw error;
      outcome = "stale";
    }
  }
  const snapshot = session.project.getSnapshot();
  const history = session.commands.getHistorySnapshot();
  steps.push({
    stroke: name,
    commit: label === undefined ? null : units(label),
    outcome,
    revision: snapshot.revision,
    hash: snapshot.hash,
    undoLabel:
      history.undoLabel === undefined ? null : units(history.undoLabel),
  });
  const { volumeId, channel } = opened.get(name);
  canonical(volumeId, channel);
}

const centroid = (mesh, t) =>
  [0, 1, 2].map(
    (k) => mesh.triangles[t].reduce((s, v) => s + mesh.vertices[v][k], 0) / 3,
  );
const brush = (kind, mesh, t, previous, radiusMm, camera) => {
  const center = centroid(mesh, t);
  return {
    [kind]: {
      center,
      previousCenter:
        previous === undefined ? absent : { value: centroid(mesh, previous) },
      cameraPosition: camera ?? center.map((v) => v * 4 + 1),
      radiusMm,
    },
  };
};

// Open refusals, in the browser's order: channel, volume, role, target, mesh.
open("brim", sphereId, "brim", assigned(true));
open("missing", "import:volume:missing", "color", assigned(physical0));
open("modifier", modifierId, "color", assigned(physical0));
open("support state", terrainId, "support", assigned("prefer"));
open("fuzzy off", sphereId, "fuzzySkin", assigned(false));
open("unknown filament", sphereId, "color", assigned("filament:unknown"));
open("flag colour", sphereId, "color", assigned(true));
open("disabled mix", sphereId, "color", assigned(disabled));

// A dragged Circle over the sphere, then its overlay pages and a commit.
open("drag", sphereId, "color", assigned(physical0));
sample("drag", {
  seedTriangle: 40,
  tool: brush("circle", sphereMesh, 40, undefined, 1.5),
});
sample("drag", {
  seedTriangle: 41,
  tool: brush("circle", sphereMesh, 41, 40, 1.5),
});
sample("drag", {
  seedTriangle: 44,
  tool: brush("circle", sphereMesh, 44, 41, 1.5),
});
// Invalid tool input reports the selector's issues and changes nothing.
sample("drag", {
  seedTriangle: 999,
  tool: brush("circle", sphereMesh, 44, 41, 1.5),
});
sample("drag", {
  seedTriangle: 44,
  tool: brush("circle", sphereMesh, 44, 41, 0.1),
});
overlay("drag");
overlay("drag", 1, 2);
overlay("drag", 100, 5);
overlay("drag", 0, 4097);
commit("drag");

// Splitting Sphere strokes leave a refined tree; the commit persists it.
open("split", sphereId, "color", assigned(physical1));
sample("split", {
  seedTriangle: 100,
  tool: brush("sphere", sphereMesh, 100, undefined, 0.6),
  triangleSplitting: true,
});
sample("split", {
  seedTriangle: 101,
  tool: brush("sphere", sphereMesh, 101, 100, 0.6),
  triangleSplitting: true,
});
overlay("split");
commit("split", "Paint the seam detail");

// Over the persisted refinement: Fill and Triangle select leaves, and a
// clipped Fill under a transform.
open("leaves", sphereId, "color", assigned(mixed));
sample("leaves", {
  seedTriangle: 100,
  tool: {
    fill: {
      hit: { value: centroid(sphereMesh, 100) },
      maxAdjacentAngleDegrees: { value: 30 },
    },
  },
});
sample("leaves", {
  seedTriangle: 101,
  tool: { triangle: { hit: { value: centroid(sphereMesh, 101) } } },
});
sample("leaves", {
  seedTriangle: 7,
  tool: { fill: { hit: absent, maxAdjacentAngleDegrees: absent } },
  clippingPlane: { value: { normal: [0, 0, 1], offset: 2 } },
  transform: {
    value: {
      linear: [
        [1, 0, 0],
        [0, Math.cos(0.5), -Math.sin(0.5)],
        [0, Math.sin(0.5), Math.cos(0.5)],
      ],
      translation: [0, 0, 4],
      scalingFactors: [1, 1, 1],
    },
  },
});
overlay("leaves");
commit("leaves");

// Erasing with a splitting brush over that tree, then erasing it again
// changes nothing.
open("erase", sphereId, "color", unpainted);
sample("erase", {
  seedTriangle: 100,
  tool: brush("circle", sphereMesh, 100, undefined, 0.8),
  triangleSplitting: true,
});
commit("erase");
open("erase again", sphereId, "color", unpainted);
sample("erase again", {
  seedTriangle: 100,
  tool: brush("circle", sphereMesh, 100, undefined, 0.8),
  triangleSplitting: true,
});
commit("erase again");

// Gap Fill over unrefined support facets commits the dense tree.
open("gaps", terrainId, "support", assigned("enforce"));
sample("gaps", {
  seedTriangle: 0,
  tool: {
    gapFill: {
      maxAreaMm2: 2,
      stateOrder: [{ text: units("enforce") }, { text: units("block") }],
    },
  },
});
commit("gaps");

// Height Range with and without splitting, on the seam and fuzzy-skin channels.
open("band", terrainId, "seam", assigned("avoid"));
sample("band", {
  seedTriangle: 0,
  tool: { heightRange: { startZMm: 2.5, heightMm: 0.5 } },
});
commit("band");
open("fuzzy", terrainId, "fuzzySkin", assigned(true));
sample("fuzzy", {
  seedTriangle: 0,
  tool: { heightRange: { startZMm: 1.2, heightMm: 0.4 } },
  triangleSplitting: true,
  transform: {
    value: {
      linear: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      translation: [0, 0, 1],
      scalingFactors: [1, 1, 1],
    },
  },
});
commit("fuzzy", "Fuzz the low band");

// A stroke that touches nothing commits nothing; two strokes opened on the
// same state race, and the later commit is stale.
open("empty", terrainId, "support", assigned("block"));
sample("empty", { seedTriangle: 999, tool: { triangle: { hit: absent } } });
commit("empty");
open("first", terrainId, "support", assigned("block"));
open("second", sphereId, "color", assigned(physical1));
sample("first", { seedTriangle: 3, tool: { triangle: { hit: absent } } });
sample("second", { seedTriangle: 3, tool: { triangle: { hit: absent } } });
commit("first");
commit("second");
// Every channel of every volume as the strokes left them, an unknown volume
// and an oversized packet.
for (const volumeId of [sphereId, terrainId, modifierId])
  for (const channel of ["color", "support", "seam", "fuzzySkin", "brim"])
    canonical(volumeId, channel);
canonical("import:volume:missing", "color");
{
  const text = encodeProjectPaintOverlayRequest({
    volumeId: units(sphereId),
    channel: "color",
  });
  const capture = capturePaintOverlay(
    session.project.getSnapshot(),
    session.assets,
    decodeProjectPaintOverlayRequest(text),
  );
  assert.throws(() => capture.packet(0, 16385), PaintOverlayRefusal);
  steps.push({ canonical: text, count: 16385, refusal: "invalid_request" });
}
session.dispose();

const sources = [
  "tools/cross-platform/paint-stroke-vectors.mjs",
  "web/src/project/painting/PaintStrokeExchange.ts",
  "web/src/project/painting/PaintStrokeService.ts",
  "web/src/project/painting/PaintOverlay.ts",
  "web/src/project/annotations/FacetRegionExchange.ts",
  "web/src/project/annotations/FacetRegionSelection.ts",
  "web/src/project/annotations/FacetAnnotationStrokeCommand.ts",
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
      assets: [sphere, ground].map((a) => ({
        descriptorJson: canonicalStringify(a.descriptor),
        bytes: [...a.bytes],
      })),
      steps,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/paint-stroke-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Paint stroke reference drift",
  );
const count = (predicate) => steps.filter(predicate).length;
const outcomes = Object.groupBy(
  steps.filter((s) => "outcome" in s),
  (s) => s.outcome,
);
console.log(
  `paint strokes: ${count((s) => "open" in s)} opens (${count((s) => "open" in s && "refusal" in s)} refused), ${count((s) => "sample" in s)} samples, ${count((s) => "overlay" in s)} overlays, commits ${Object.entries(
    outcomes,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}`,
);
