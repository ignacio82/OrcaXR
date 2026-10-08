// Brim-ear detection references from the production browser
// (`brimEarExchange.ts` over `brimEarDetection.ts` and `brimEarPreview.ts`):
// objects whose model parts are recentred split parts, a pyramid whose sides
// are single triangles, a plus with inward corners, a smooth prism, a part
// turned, scaled and mirrored by its own transform, a part with a modifier
// beside it, a flat sheet and a notch whose
// corners collide — detected under default and explicit angles, thinning
// radii, ear radii and cut heights; then placed ears checked for the ones
// stranded (touching, chained through other ears, and islands), with every
// refusal. Replayed by Rust, by WASM in Node and Chrome, and over JNI.
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
  detectObjectBrimEarsWire,
  strandedObjectBrimEarsWire,
} from "../../web/src/project/objects/brimEarExchange.ts";
import {
  decodeProjectBrimEarDetectRequest,
  decodeProjectBrimEarStrandedRequest,
  encodeProjectBrimEarDetectReply,
  encodeProjectBrimEarDetectRequest,
  encodeProjectBrimEarStrandedReply,
  encodeProjectBrimEarStrandedRequest,
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
for (const object of [...Object.keys(objects), "missing"]) {
  detect(object);
  stranded(object);
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

const sources = [
  "tools/cross-platform/brim-ear-vectors.mjs",
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
  `brim ears: ${steps.filter((s) => "detect" in s).length} detections (${earCount} ears, ${replies.filter((r) => r.detected && "value" in r.detected.reason).length} with reasons), ${steps.filter((s) => "stranded" in s).length} stranded checks (${replies.reduce((sum, r) => sum + (r.stranded?.indices.length ?? 0), 0)} stranded), ${replies.filter((r) => "refused" in r).length} refused`,
);
