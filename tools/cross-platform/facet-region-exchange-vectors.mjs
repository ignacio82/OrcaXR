// Facet region selection over a live session, from the production browser:
// a project with two mesh volumes (a painted icosphere and a support-painted
// terrain) opened as a real TypeScript session, and a host script of region
// requests — every tool, transforms, clipping, the overhang gate and paging
// windows — answered by `answerFacetRegion` in the shared contract's
// encoding, with the selector's issues for invalid tool input and refusals
// for an unknown volume and an oversized page. Replayed by Rust, by WASM in
// Node and Chrome, and over JNI.
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
  FacetRegionRefusal,
  answerFacetRegion,
} from "../../web/src/project/annotations/FacetRegionExchange.ts";
import {
  decodeProjectFacetRegionRequest,
  encodeProjectFacetRegionReply,
  encodeProjectFacetRegionRequest,
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
const sphere = asset("import:asset:region-sphere", sphereMesh);
const ground = asset("import:asset:region-terrain", terrainMesh);
const state = structuredClone(fixture.state);
const object = state.plates[0].objects[0];
const { physical0, physical1, mixed } = fixture.ids;
const every = (count, step, offset = 0) =>
  Array.from({ length: count }, (_, i) => i).filter((i) => i % step === offset);
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
    id: "import:volume:region-terrain",
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

const script = [];
const absent = { absent: {} };
const vector = (v) => [...v];
const ask = (request) => {
  const text = encodeProjectFacetRegionRequest({
    clippingPlane: absent,
    transform: absent,
    highlightByAngleDegrees: absent,
    start: 0,
    count: 4096,
    ...request,
  });
  try {
    const reply = answerFacetRegion(
      session.project.getSnapshot(),
      session.assets,
      decodeProjectFacetRegionRequest(text),
    );
    script.push({ request: text, reply: encodeProjectFacetRegionReply(reply) });
  } catch (error) {
    if (!(error instanceof FacetRegionRefusal)) throw error;
    script.push({ request: text, refusal: error.code.replace("-", "_") });
  }
};
const rotate = {
  linear: [
    [1, 0, 0],
    [0, Math.cos(0.5), -Math.sin(0.5)],
    [0, Math.sin(0.5), Math.cos(0.5)],
  ],
  translation: [0, 0, 4],
  scalingFactors: [1, 1, 1],
};
const stretch = {
  linear: [
    [1.5, 0, 0],
    [0, 1, 0],
    [0, 0, 0.75],
  ],
  translation: [1, 2, 3],
  scalingFactors: [1.5, 1, 0.75],
};
const volumes = [
  {
    id: object.volumes[0].id,
    mesh: sphereMesh,
    channel: "color",
    states: [physical0, physical1, mixed],
  },
  {
    id: "import:volume:region-terrain",
    mesh: terrainMesh,
    channel: "support",
    states: ["enforce", "block"],
  },
];
const centroid = (mesh, t) =>
  [0, 1, 2].map(
    (k) => mesh.triangles[t].reduce((s, v) => s + mesh.vertices[v][k], 0) / 3,
  );
for (const v of volumes) {
  const base = { volumeId: units(v.id), channel: v.channel };
  const count = v.mesh.triangles.length;
  for (const seed of [0, count >> 1, count - 3]) {
    ask({ ...base, seedTriangle: seed, tool: { triangle: { hit: absent } } });
    for (const angle of [absent, { value: 30 }, { value: 89.5 }]) {
      ask({
        ...base,
        seedTriangle: seed,
        tool: { fill: { hit: absent, maxAdjacentAngleDegrees: angle } },
      });
    }
    ask({
      ...base,
      seedTriangle: seed,
      tool: { fill: { hit: absent, maxAdjacentAngleDegrees: { value: 60 } } },
      clippingPlane: { value: { normal: [0, 0, 1], offset: 2.5 } },
    });
    const center = centroid(v.mesh, seed);
    const other = centroid(v.mesh, (seed + 5) % count);
    for (const kind of ["circle", "sphere"]) {
      for (const [radiusMm, previous] of [
        [2, absent],
        [6, { value: vector(other) }],
      ]) {
        for (const transform of [
          absent,
          { value: rotate },
          { value: stretch },
        ]) {
          ask({
            ...base,
            seedTriangle: seed,
            tool: {
              [kind]: {
                center: vector(center),
                previousCenter: previous,
                cameraPosition: [
                  center[0] + 20,
                  center[1] - 10,
                  center[2] + 50,
                ],
                radiusMm,
              },
            },
            transform,
          });
        }
      }
    }
  }
  for (const transform of [absent, { value: rotate }, { value: stretch }]) {
    for (const highlight of [absent, { value: 45 }]) {
      ask({
        ...base,
        seedTriangle: 0,
        tool: { heightRange: { startZMm: 2, heightMm: 1.5 } },
        transform,
        highlightByAngleDegrees: highlight,
      });
    }
  }
  for (const order of [v.states, [...v.states].reverse()]) {
    for (const maxAreaMm2 of [0.5, 2, 5]) {
      ask({
        ...base,
        seedTriangle: 0,
        tool: {
          gapFill: {
            maxAreaMm2,
            stateOrder: order.map((s) =>
              typeof s === "boolean" ? { flag: s } : { text: units(s) },
            ),
          },
        },
      });
    }
  }
  // Paging windows over one large fill.
  for (const [start, count] of [
    [0, 1],
    [1, 3],
    [2, 0],
    [100000, 5],
  ]) {
    ask({
      ...base,
      seedTriangle: 0,
      tool: { fill: { hit: absent, maxAdjacentAngleDegrees: absent } },
      start,
      count,
    });
  }
  // The selector's own issues, as data.
  ask({
    ...base,
    seedTriangle: count + 4,
    tool: {
      circle: {
        center: [0, 0, 0],
        previousCenter: absent,
        cameraPosition: [0, 0, 0],
        radiusMm: 0.2,
      },
    },
  });
}
// Refusals: an unknown volume and an oversized page.
ask({
  volumeId: units("import:volume:missing"),
  channel: "color",
  seedTriangle: 0,
  tool: { triangle: { hit: absent } },
});
ask({
  volumeId: units(volumes[0].id),
  channel: "color",
  seedTriangle: 0,
  tool: { triangle: { hit: absent } },
  count: 4097,
});
session.dispose();

const sources = [
  "tools/cross-platform/facet-region-exchange-vectors.mjs",
  "web/src/project/annotations/FacetRegionExchange.ts",
  "web/src/project/annotations/FacetRegionSelection.ts",
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
      script,
    },
    null,
    0,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/facet-region-exchange-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Facet region exchange reference drift",
  );
const count = (kind) =>
  script.filter((e) =>
    kind === "refusal" ? "refusal" in e : e.reply?.includes(`"${kind}"`),
  ).length;
console.log(
  `facet region exchange: ${script.length} requests (${count("page")} pages, ${count("invalid")} invalid, ${count("refusal")} refusals)`,
);
