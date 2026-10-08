// Facet region selection references from the production browser
// (`selectFacetRegion`, `buildOrcaFaceNeighbors`): Triangle, state-aware Fill
// with smart-fill angles and clipping, Height Range under transforms and the
// overhang gate, and Gap Fill over every channel, plus each validation
// refusal and a stale topology. Meshes include a closed cube, an icosphere, an
// open terrain, a patchwork grid and a non-manifold fan with a degenerate
// facet. Replayed by Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildOrcaFaceNeighbors,
  selectFacetRegion,
} from "../../web/src/project/annotations/FacetRegionSelection.ts";
import {
  FacetAnnotationValidationError,
  StaleFacetAnnotationResultError,
} from "../../web/src/project/annotations/types.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

function random(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

// --- Meshes ------------------------------------------------------------------
function cube(size) {
  const h = size / 2;
  const vertices = [
    [-h, -h, 0],
    [h, -h, 0],
    [h, h, 0],
    [-h, h, 0],
    [-h, -h, size],
    [h, -h, size],
    [h, h, size],
    [-h, h, size],
  ];
  const triangles = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return { name: "cube", vertices, triangles };
}
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
      if (!cache.has(key)) {
        const p = vertices[a].map((v, i) => (v + vertices[b][i]) / 2);
        cache.set(key, vertices.push(p) - 1);
      }
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
  vertices = vertices.map((p) => {
    const length = Math.hypot(...p);
    return p.map((v) =>
      Math.fround((v / length) * radius + (v === p[2] ? radius : 0)),
    );
  });
  return { name: "icosphere", vertices, triangles };
}
function grid(name, n, step, height) {
  const vertices = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++)
      vertices.push([x * step, y * step, height(x, y)]);
  const triangles = [];
  const at = (x, y) => y * (n + 1) + x;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      triangles.push([at(x, y), at(x + 1, y), at(x + 1, y + 1)]);
      triangles.push([at(x, y), at(x + 1, y + 1), at(x, y + 1)]);
    }
  return { name, vertices, triangles };
}
const terrain = grid(
  "terrain",
  8,
  1.5,
  (x, y) => 2.5 + 2 * Math.sin(x * 0.7) * Math.cos(y * 0.5) + 0.1,
);
const patchwork = grid("patchwork", 10, 0.4, () => 0);
const fan = {
  name: "non-manifold fan",
  vertices: [
    [0, 0, 0],
    [4, 0, 0],
    [2, 3, 0],
    [2, -3, 0.5],
    [2, -2, -1],
    [2, 0.5, 3],
    [1, 1, 1],
  ],
  // Three faces on edge 0-1 against [0,1,2]; one shares its winding; a
  // degenerate facet repeats a vertex.
  triangles: [
    [0, 1, 2],
    [1, 0, 3],
    [1, 0, 4],
    [0, 1, 5],
    [2, 2, 6],
    [1, 2, 6],
  ],
};
const meshes = [cube(10), icosphere(2, 6), terrain, patchwork, fan];

// --- Annotations ---------------------------------------------------------------
const CHANNEL_VALUES = {
  color: ["filament:red", "filament:green", "filament:blue"],
  support: ["enforce", "block"],
  seam: ["prefer", "avoid"],
  fuzzySkin: [true],
  brim: [true, false],
};
function paint(rng, channel, count, density = 0.5) {
  const values = CHANNEL_VALUES[channel];
  const byValue = new Map();
  for (let t = 0; t < count; t++) {
    if (rng.next() > density) continue;
    const value = rng.pick(values);
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(t);
  }
  return [...byValue].map(([value, triangles]) => ({ value, triangles }));
}
const emptyAnnotations = (topologyRevision) => ({
  topologyRevision,
  color: [],
  support: [],
  seam: [],
  fuzzySkin: [],
  brim: [],
});

// --- Transforms ----------------------------------------------------------------
const deg = (d) => (d * Math.PI) / 180;
const TRANSFORMS = [
  undefined,
  {
    linear: [
      [1, 0, 0],
      [0, Math.cos(deg(30)), -Math.sin(deg(30))],
      [0, Math.sin(deg(30)), Math.cos(deg(30))],
    ],
    translation: [0, 0, 5],
    scalingFactors: [1, 1, 1],
  },
  {
    linear: [
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 0.5],
    ],
    translation: [3, -2, 1.25],
    scalingFactors: [1, 2, 0.5],
  },
  {
    linear: [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
    scalingFactors: [1, 1, 1],
  },
];

// --- Cases -------------------------------------------------------------------
const cases = [];
function run(name, meshIndex, channel, annotations, request) {
  const mesh = meshes[meshIndex];
  const full = {
    mesh: { vertices: mesh.vertices, triangles: mesh.triangles },
    annotations,
    channel,
    ...request,
  };
  let result;
  try {
    const selection = selectFacetRegion(full);
    result = {
      triangleIndices: [...selection.triangleIndices],
      ranges: selection.ranges.map((r) => [r.start, r.endExclusive]),
      ...(selection.gapFillReplacements
        ? {
            gapFillReplacements: selection.gapFillReplacements.map((r) => ({
              areaMm2: r.areaMm2,
              source: r.source,
              target: r.target,
              triangleIndices: [...r.triangleIndices],
              ranges: r.ranges.map((x) => [x.start, x.endExclusive]),
            })),
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof FacetAnnotationValidationError)
      result = { issues: error.issues.map((i) => ({ ...i })) };
    else if (error instanceof StaleFacetAnnotationResultError)
      result = { stale: error.reason };
    else throw error;
  }
  cases.push({
    name,
    mesh: meshIndex,
    channel,
    topologyRevision: annotations.topologyRevision,
    assignments: annotations[channel],
    request,
    result,
  });
}

const rng = random(0xfacade);
const CHANNELS = Object.keys(CHANNEL_VALUES);
meshes.forEach((mesh, m) => {
  const count = mesh.triangles.length;
  for (const channel of CHANNELS) {
    const annotations = {
      ...emptyAnnotations(3),
      [channel]: paint(rng, channel, count),
    };
    const guard = { topologyRevision: 3, triangleCount: count };
    const seeds = [...new Set([0, count >> 1, count - 1, rng.int(count)])];
    for (const seed of seeds) {
      run(`${mesh.name} ${channel} triangle ${seed}`, m, channel, annotations, {
        guard,
        seedTriangle: seed,
        tool: { kind: "triangle" },
      });
      for (const angle of [undefined, 0, 10, 30, 45, 89.99, 90]) {
        run(
          `${mesh.name} ${channel} fill ${seed} ${angle}`,
          m,
          channel,
          annotations,
          {
            guard,
            seedTriangle: seed,
            tool: {
              kind: "fill",
              edgeDetection:
                angle === undefined
                  ? false
                  : { maxAdjacentAngleDegrees: angle },
            },
          },
        );
      }
      // A clipping plane rejects neighbours above it, never the seed.
      const zs = mesh.vertices.map((v) => v[2]);
      const middle = (Math.min(...zs) + Math.max(...zs)) / 2;
      for (const plane of [
        { normal: [0, 0, 1], offset: middle },
        { normal: [0.3, -0.2, 0.9], offset: middle * 0.8 },
      ]) {
        run(
          `${mesh.name} ${channel} clipped fill ${seed}`,
          m,
          channel,
          annotations,
          {
            guard,
            seedTriangle: seed,
            tool: {
              kind: "fill",
              edgeDetection: { maxAdjacentAngleDegrees: 60 },
            },
            clippingPlane: plane,
          },
        );
      }
    }
    // Height ranges under transforms and the overhang gate.
    const zs = mesh.vertices.map((v) => v[2]);
    const low = Math.min(...zs),
      high = Math.max(...zs);
    TRANSFORMS.forEach((transform, t) => {
      for (const [startZ, height] of [
        [low - 1, 0.1],
        [low, 0.5],
        [(low + high) / 2, 1.3],
        [high - 0.2, 8],
        [high + 5, 2],
      ]) {
        for (const highlight of [undefined, 0, 30, 60, 90]) {
          run(
            `${mesh.name} ${channel} height ${t} ${startZ} ${height} ${highlight}`,
            m,
            channel,
            annotations,
            {
              guard,
              seedTriangle: 0,
              tool: { kind: "heightRange", startZMm: startZ, heightMm: height },
              ...(transform ? { transform } : {}),
              ...(highlight === undefined
                ? {}
                : { highlightByAngleDegrees: highlight }),
            },
          );
        }
      }
    });
    // Gap Fill over sparse fragments.
    const fragments = {
      ...emptyAnnotations(3),
      [channel]: paint(rng, channel, count, 0.15),
    };
    const order = [...CHANNEL_VALUES[channel]];
    for (const stateOrder of [order, [...order].reverse()]) {
      for (const maxAreaMm2 of [0, 0.2, 1, 2.5, 5]) {
        run(
          `${mesh.name} ${channel} gap ${maxAreaMm2} ${stateOrder.join("/")}`,
          m,
          channel,
          fragments,
          {
            guard,
            seedTriangle: 0,
            tool: { kind: "gapFill", maxAreaMm2, stateOrder },
          },
        );
      }
    }
  }
});

// Refusals, each with the browser's issues; then a stale topology.
const base = {
  ...emptyAnnotations(1),
  color: [{ value: "filament:red", triangles: [0, 1] }],
};
const guard = { topologyRevision: 1, triangleCount: 12 };
const refuse = (
  name,
  request,
  annotations = base,
  channel = "color",
  mesh = 0,
) => run(`refusal: ${name}`, mesh, channel, annotations, request);
refuse("guard", {
  guard: { topologyRevision: -1, triangleCount: 12.5 },
  seedTriangle: 0,
  tool: { kind: "triangle" },
});
refuse("seed", { guard, seedTriangle: 12, tool: { kind: "triangle" } });
refuse("fractional seed", {
  guard,
  seedTriangle: 1.5,
  tool: { kind: "fill", edgeDetection: false },
});
refuse("highlight", {
  guard,
  seedTriangle: 0,
  tool: { kind: "triangle" },
  highlightByAngleDegrees: 91,
});
refuse("hit", {
  guard,
  seedTriangle: 0,
  tool: { kind: "triangle", hit: [0, 1e39, 0] },
});
refuse("fill angle", {
  guard,
  seedTriangle: 0,
  tool: {
    kind: "fill",
    hit: [1e39, 0, 0],
    edgeDetection: { maxAdjacentAngleDegrees: 95 },
  },
});
refuse("height", {
  guard,
  seedTriangle: 0,
  tool: { kind: "heightRange", startZMm: 1e39, heightMm: 0.05 },
});
refuse("tall", {
  guard,
  seedTriangle: 0,
  tool: { kind: "heightRange", startZMm: 1, heightMm: 8.5 },
});
refuse("gap area and states", {
  guard,
  seedTriangle: 99,
  tool: {
    kind: "gapFill",
    maxAreaMm2: 6,
    stateOrder: ["filament:green", true, "filament:green"],
  },
});
refuse(
  "support gap states",
  {
    guard,
    seedTriangle: 0,
    tool: { kind: "gapFill", maxAreaMm2: 1, stateOrder: ["block", "prefer"] },
  },
  {
    ...emptyAnnotations(1),
    support: [
      { value: "enforce", triangles: [3] },
      { value: "block", triangles: [4] },
    ],
  },
  "support",
);
refuse("clipping plane", {
  guard,
  seedTriangle: 0,
  tool: { kind: "triangle" },
  clippingPlane: { normal: [0, 0, 0], offset: 1 },
});
refuse("float clipping plane", {
  guard,
  seedTriangle: 0,
  tool: { kind: "triangle" },
  clippingPlane: { normal: [1e-46, 0, 0], offset: 1e39 },
});
refuse("singular transform", {
  guard,
  seedTriangle: 0,
  tool: { kind: "triangle" },
  transform: {
    linear: [
      [1, 0, 0],
      [2, 0, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
    scalingFactors: [1, 1, 1],
  },
});
refuse("scaling factor", {
  guard,
  seedTriangle: 0,
  tool: { kind: "triangle" },
  transform: {
    linear: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
    scalingFactors: [1, 0, 1],
  },
});
refuse("everything at once", {
  guard: { topologyRevision: 1.5, triangleCount: 12 },
  seedTriangle: -1,
  tool: { kind: "fill", edgeDetection: { maxAdjacentAngleDegrees: -1 } },
  clippingPlane: { normal: [0, 0, 0], offset: 0 },
  highlightByAngleDegrees: -5,
});
refuse(
  "annotations",
  { guard, seedTriangle: 0, tool: { kind: "fill", edgeDetection: false } },
  {
    ...emptyAnnotations(1),
    color: [
      { value: "filament:red", triangles: [0, 12, 2] },
      { value: true, triangles: [2, 3.5] },
    ],
  },
);
refuse("stale revision", {
  guard: { topologyRevision: 2, triangleCount: 12 },
  seedTriangle: 0,
  tool: { kind: "triangle" },
});
refuse("stale count", {
  guard: { topologyRevision: 1, triangleCount: 11 },
  seedTriangle: 0,
  tool: { kind: "triangle" },
});
meshes.push({
  name: "bad mesh",
  vertices: [
    [0, 0, 0],
    [1, 1e39, 0],
    [0, 1, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 1, 3],
    [0, 1.5, 2],
  ],
});
refuse(
  "mesh",
  {
    guard: { topologyRevision: 1, triangleCount: 3 },
    seedTriangle: 0,
    tool: { kind: "triangle" },
  },
  { ...emptyAnnotations(1) },
  "color",
  meshes.length - 1,
);

const neighbors = meshes
  .slice(0, -1)
  .map((mesh) => buildOrcaFaceNeighbors(mesh).map((n) => [...n]));

const sources = [
  "tools/cross-platform/facet-region-vectors.mjs",
  "web/src/project/annotations/FacetRegionSelection.ts",
  "web/src/project/annotations/sparse.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      meshes,
      neighbors,
      cases,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/facet-region-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Facet region reference drift",
  );
const count = (key) => cases.filter((c) => key in c.result).length;
console.log(
  `facet regions: ${meshes.length} meshes, ${cases.length} cases (${count("triangleIndices")} selections, ${count("issues")} refusals, ${count("stale")} stale)`,
);
