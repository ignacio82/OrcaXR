// Surface measurement references from the production browser
// (`measureExchange.ts` over `measure.ts`): volumes captured from a project —
// a cube, a washer whose rims and hole are circles, a hexagonal prism whose
// caps are polygon edges about a centre, a twelve-sided prism, a wedge and an
// open terrain — picked at every facet's centroid and beside each of its
// edges and corners, as planes only and not, under no transform, a rigid one,
// a uniform scale and a non-uniform one (whose circles refuse); then every
// ordered pair of a spread of the picked features measured, with the
// unsupported non-parallel circle pair and a pair too large to be finite.
// Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  captureMeasureVolumeWire,
  measureFeaturesWire,
} from "../../web/src/project/objects/measureExchange.ts";
import {
  decodeProjectMeasureFeatureReply,
  decodeProjectMeasureFeatureRequest,
  decodeProjectMeasureRequest,
  decodeProjectMeasureVolumeRequest,
  encodeProjectMeasureFeatureReply,
  encodeProjectMeasureFeatureRequest,
  encodeProjectMeasureReply,
  encodeProjectMeasureRequest,
  encodeProjectMeasureVolumeReply,
  encodeProjectMeasureVolumeRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

// --- Meshes (volume-local millimetres) ----------------------------------------
function cube(size) {
  const vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map((v) => v.map((c) => c * size));
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
// A closed prism over a regular n-gon: two fan-triangulated caps about a
// centre vertex and quad side walls.
function prism(n, radius, height) {
  const vertices = [];
  for (let z of [0, height])
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      vertices.push([radius * Math.cos(a), radius * Math.sin(a), z]);
    }
  const bottom = vertices.push([0, 0, 0]) - 1;
  const top = vertices.push([0, 0, height]) - 1;
  const triangles = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push(
      [bottom, j, i],
      [top, n + i, n + j],
      [i, j, n + j],
      [i, n + j, n + i],
    );
  }
  return { vertices, triangles };
}
// A washer: outer and inner rings of n segments, annular caps and both walls.
function washer(n, outer, inner, height) {
  const vertices = [];
  const ring = (r, z) => {
    const start = vertices.length;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      vertices.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    return start;
  };
  const [ob, ib, ot, it] = [
    ring(outer, 0),
    ring(inner, 0),
    ring(outer, height),
    ring(inner, height),
  ];
  const triangles = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push(
      [ob + i, ib + j, ob + j],
      [ob + i, ib + i, ib + j],
      [ot + i, ot + j, it + j],
      [ot + i, it + j, it + i],
      [ob + i, ob + j, ot + j],
      [ob + i, ot + j, ot + i],
      [ib + i, it + j, ib + j],
      [ib + i, it + i, it + j],
    );
  }
  return { vertices, triangles };
}
function wedge(width, depth, height) {
  const vertices = [
    [0, 0, 0],
    [width, 0, 0],
    [width, depth, 0],
    [0, depth, 0],
    [0, depth, height],
    [width, depth, height],
  ];
  const triangles = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 1, 5],
    [0, 5, 4],
    [3, 4, 5],
    [3, 5, 2],
    [0, 4, 3],
    [1, 2, 5],
  ];
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
        x < n / 2 ? 0 : 1.5 * Math.sin(y * 0.7),
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
const meshes = {
  cube: cube(20),
  washer: washer(32, 15, 6.5, 4),
  hexagon: prism(6, 8, 10),
  dodecagon: prism(12, 9, 6),
  wedge: wedge(16, 12, 9),
  terrain: terrain(6, 2.5),
};
const assetOf = (name, mesh) =>
  encodeIndexedMeshAsset({
    id: `import:asset:measure-${name}`,
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
  });
const payloads = Object.entries(meshes).map(([name, mesh]) =>
  assetOf(name, mesh),
);

// --- The project -------------------------------------------------------------
const fixture = createProjectFixture();
const state = structuredClone(fixture.state);
const template = state.plates[0].objects[0];
state.plates[0].objects = Object.keys(meshes).map((name, i) => ({
  ...structuredClone(template),
  id: `import:object:measure-${name}`,
  name,
  layerRanges: [],
  volumes: [
    {
      id: `import:volume:measure-${name}`,
      name,
      role: "model",
      source: {
        assetId: payloads[i].descriptor.id,
        topologyRevision: 0,
        triangleCount: payloads[i].descriptor.mesh.triangleCount,
      },
      transform: {
        translationMm: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      config: {},
      annotations: emptyFacetAnnotations(0),
    },
  ],
  instances: [
    {
      id: `import:instance:measure-${name}`,
      transform: {
        translationMm: [40 * i + 20, 60, 0],
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

// --- Captures and picks --------------------------------------------------------
const steps = [];
const volumes = new Map();
function capture(name, volumeId) {
  const text = encodeProjectMeasureVolumeRequest({ volumeId: units(volumeId) });
  const { reply, volume } = captureMeasureVolumeWire(
    state,
    assets,
    decodeProjectMeasureVolumeRequest(text),
  );
  if (volume) volumes.set(name, volume);
  steps.push({
    volume: name,
    capture: text,
    reply: encodeProjectMeasureVolumeReply(reply),
  });
}
const picked = [];
function pick(name, faceIndex, point, onlyPlane, transform) {
  const text = encodeProjectMeasureFeatureRequest({
    faceIndex,
    point,
    onlyPlane,
    transform: transform ? { value: transform } : { absent: {} },
  });
  const reply = volumes
    .get(name)
    .feature(decodeProjectMeasureFeatureRequest(text));
  const encoded = encodeProjectMeasureFeatureReply(reply);
  steps.push({ volume: name, feature: text, reply: encoded });
  if ("feature" in reply)
    picked.push(decodeProjectMeasureFeatureReply(encoded).feature.feature);
}
const lerp = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
// Row-major 4x4 transforms: a rigid turn about Z with an offset, a uniform
// scale with a turn about X, and a non-uniform scale.
const turn = Math.PI / 6;
const transforms = {
  none: undefined,
  rigid: [
    Math.cos(turn),
    -Math.sin(turn),
    0,
    120,
    Math.sin(turn),
    Math.cos(turn),
    0,
    80,
    0,
    0,
    1,
    2.5,
    0,
    0,
    0,
    1,
  ],
  uniform: [
    2,
    0,
    0,
    -10,
    0,
    2 * Math.cos(turn),
    -2 * Math.sin(turn),
    5,
    0,
    2 * Math.sin(turn),
    2 * Math.cos(turn),
    1,
    0,
    0,
    0,
    1,
  ],
  uneven: [1, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 1],
};
for (const [name, mesh] of Object.entries(meshes)) {
  capture(name, `import:volume:measure-${name}`);
  const step = mesh.triangles.length > 64 ? 7 : 1;
  for (let face = 0; face < mesh.triangles.length; face += step) {
    const corners = mesh.triangles[face].map((v) => mesh.vertices[v]);
    const centroid = [0, 1, 2].map(
      (k) => (corners[0][k] + corners[1][k] + corners[2][k]) / 3,
    );
    // Beside one edge's midpoint and beside one corner, turning with the face.
    const k = face % 3;
    const mid = lerp(corners[k], corners[(k + 1) % 3], 0.5);
    const near = [lerp(mid, centroid, 0.02), lerp(corners[k], centroid, 0.01)];
    for (const [label, transform] of Object.entries(transforms)) {
      if ((label === "uniform" || label === "uneven") && face % 3 !== 0)
        continue;
      pick(name, face, centroid, false, transform);
      if (label === "none") pick(name, face, centroid, true, transform);
      for (const point of near) pick(name, face, point, false, transform);
    }
  }
}
// Refusals: an unknown volume and a facet past the mesh.
capture("missing", "import:volume:measure-missing");
pick("cube", 12, [1, 1, 1], false);
pick("washer", 9_007_199_254_740_991, [0, 0, 0], true);

// --- Pairs ----------------------------------------------------------------------
// A spread of the picked features: every kind, from several volumes and
// frames; then every ordered pair, so each swap is exercised.
const kinds = new Map();
for (const feature of picked) {
  const kind = Object.keys(feature)[0];
  if (!kinds.has(kind)) kinds.set(kind, []);
  kinds.get(kind).push(feature);
}
const spread = [];
for (const list of kinds.values()) {
  const stride = Math.max(1, Math.floor(list.length / 6));
  for (let i = 0; i < list.length && spread.length < 36; i += stride)
    spread.push(list[i]);
}
function measure(first, second) {
  const text = encodeProjectMeasureRequest({ first, second });
  steps.push({
    measure: text,
    reply: encodeProjectMeasureReply(
      measureFeaturesWire(decodeProjectMeasureRequest(text)),
    ),
  });
}
for (const first of spread) for (const second of spread) measure(first, second);
// Circles in turned planes, and features too large to measure finitely.
measure(
  { circle: { center: [0, 0, 0], normal: [0, 0, 1], radius: 3 } },
  { circle: { center: [5, 0, 2], normal: [1, 0, 0], radius: 2 } },
);
measure(
  { circle: { center: [0, 0, 0], normal: [0, 0, 1], radius: 3 } },
  { circle: { center: [0, 0, 7], normal: [0, 0, -1], radius: 5 } },
);
measure(
  { point: { point: [-1e308, 0, 0] } },
  { point: { point: [1e308, 0, 0] } },
);
measure(
  { edge: { from: [0, 0, 0], to: [0, 0, 0], extraPoint: { absent: {} } } },
  { plane: { index: 0, normal: [0, 0, 0], origin: [1, 2, 3] } },
);

const sources = [
  "tools/cross-platform/measure-vectors.mjs",
  "web/src/project/objects/measureExchange.ts",
  "web/src/project/objects/measure.ts",
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
const path = new URL("testdata/cross-platform/measure-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Measure reference drift");
const count = (key, refused) =>
  steps.filter((s) => key in s && s.reply.startsWith('{"refused"') === refused)
    .length;
const featureKinds = Object.groupBy(
  steps.filter((s) => "feature" in s && s.reply.startsWith('{"feature"')),
  (s) => Object.keys(JSON.parse(s.reply).feature.feature)[0],
);
console.log(
  `measure: ${count("capture", false)} captures (${count("capture", true)} refused), ${count("feature", false)} picks (${Object.entries(
    featureKinds,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(
      ", ",
    )}; ${count("feature", true)} refused), ${count("measure", false)} pairs (${count("measure", true)} refused), ${steps.filter((s) => s.reply?.includes('"unsupported":true')).length} unsupported`,
);
