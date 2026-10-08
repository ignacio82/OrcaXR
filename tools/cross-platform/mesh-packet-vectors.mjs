// Mesh renderer packet references from the production browser
// (`meshPacket.ts`: the `displayGeometry` `ThreeProjectSurface` uploads,
// packed by `packMesh`). Meshes: the project fixture, a smooth sphere and a
// shared-corner cube (normals averaged across faces), mirrored windings,
// unreferenced vertices (in the bounds, in no chunk), degenerate and
// repeated triangles, a non-indexed mesh, a strided payload with 16-bit
// indices, coordinates whose normals overflow float32, a terrain of 4,608
// triangles and an empty mesh — each packed at chunk limits from one
// triangle to unbounded, across the 16-bit index boundary — plus a missing
// asset, an unstable ID and an asset that is not a mesh. Each packet is
// recorded with the SHA-256 of its bytes and of three.js's own normal
// attribute, so the Rust normals are pinned apart from the packer. Replayed
// by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { contentDigest } from "../../web/src/project/assets.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  displayGeometry,
  meshPacketWire,
} from "../../web/src/project/surfaces/meshPacket.ts";
import {
  decodeProjectMeshPacketRequest,
  encodeProjectMeshPacketReply,
  encodeProjectMeshPacketRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- Meshes ----------------------------------------------------------------------
function sphere(radius, segments, rings) {
  const vertices = [];
  const triangles = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const v = ring / rings;
    for (let segment = 0; segment <= segments; segment += 1) {
      const u = segment / segments;
      vertices.push([
        -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI),
        radius * Math.cos(v * Math.PI),
        radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI),
      ]);
    }
  }
  const at = (ring, segment) => ring * (segments + 1) + segment;
  for (let ring = 0; ring < rings; ring += 1)
    for (let segment = 0; segment < segments; segment += 1) {
      const [a, b, c, d] = [
        at(ring, segment + 1),
        at(ring, segment),
        at(ring + 1, segment),
        at(ring + 1, segment + 1),
      ];
      if (ring !== 0) triangles.push([a, b, d]);
      if (ring !== rings - 1) triangles.push([b, c, d]);
    }
  return { vertices, triangles };
}
function cube(size) {
  const vertices = [];
  for (const z of [0, size])
    for (const y of [0, size]) for (const x of [0, size]) vertices.push([x, y, z]);
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  return {
    vertices,
    triangles: quads.flatMap(([a, b, c, d]) => [
      [a, b, c],
      [a, c, d],
    ]),
  };
}
function terrain(cells, spacing) {
  const vertices = [];
  const triangles = [];
  for (let y = 0; y <= cells; y += 1)
    for (let x = 0; x <= cells; x += 1)
      vertices.push([
        x * spacing,
        y * spacing,
        3 * Math.sin(x * 0.31) * Math.cos(y * 0.23) + 0.01 * x * y,
      ]);
  const at = (x, y) => y * (cells + 1) + x;
  for (let y = 0; y < cells; y += 1)
    for (let x = 0; x < cells; x += 1)
      triangles.push(
        [at(x, y), at(x + 1, y), at(x + 1, y + 1)],
        [at(x, y), at(x + 1, y + 1), at(x, y + 1)],
      );
  return { vertices, triangles };
}
const indexed = (id, mesh) =>
  encodeIndexedMeshAsset({
    id,
    positions: mesh.vertices.flat(),
    indices: mesh.triangles.flat(),
  });
const flipped = cube(10);
flipped.triangles = flipped.triangles.map((t, i) =>
  i % 3 === 0 ? [t[0], t[2], t[1]] : t,
);
const loose = cube(8);
loose.vertices.push([-50, 2, 3], [40, -60, 70]);
const degenerate = {
  vertices: [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
    [20, 0, 0],
    [5, 5, 5],
  ],
  triangles: [
    [0, 1, 2],
    [0, 0, 1],
    [1, 2, 2],
    [0, 1, 3],
    [0, 1, 2],
    [2, 1, 0],
    [4, 4, 4],
    [3, 4, 0],
  ],
};
const overflow = {
  vertices: [
    [0, 0, 0],
    [3e19, 0, 0],
    [0, 3e19, 0],
    [0, 0, 1e-30],
    [1e-30, 0, 0],
    [0, 1e-30, 0],
  ],
  triangles: [
    [0, 1, 2],
    [3, 4, 5],
    [0, 4, 5],
  ],
};
/** Strided float32 positions with a padding component, 16-bit indices. */
function strided(id) {
  const vertices = sphere(6, 9, 5).vertices;
  const triangles = sphere(6, 9, 5).triangles.flat();
  const positionBytes = vertices.length * 20;
  const indexBytes = triangles.length * 2;
  const bytes = new Uint8Array(positionBytes + indexBytes + (indexBytes % 4));
  const view = new DataView(bytes.buffer);
  vertices.forEach((v, i) => {
    v.forEach((c, axis) => view.setFloat32(i * 20 + axis * 4, c, true));
    view.setFloat32(i * 20 + 12, 1, true);
    view.setFloat32(i * 20 + 16, -1, true);
  });
  triangles.forEach((t, i) =>
    view.setUint16(positionBytes + i * 2, t, true),
  );
  return {
    descriptor: {
      id,
      kind: "mesh",
      digest: contentDigest(bytes),
      byteLength: bytes.byteLength,
      mediaType: "application/vnd.orcaxr.indexed-mesh",
      mesh: {
        positions: {
          byteOffset: 0,
          byteLength: positionBytes,
          componentType: "float32",
          componentCount: 4,
          count: vertices.length,
          byteStride: 20,
        },
        indices: {
          byteOffset: positionBytes,
          byteLength: indexBytes,
          componentType: "uint16",
          componentCount: 1,
          count: triangles.length,
        },
        triangleCount: triangles.length / 3,
      },
    },
    bytes,
  };
}
const drawingBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
);
const fixture = createProjectFixture();
const payloads = [
  fixture.asset,
  indexed("import:asset:packet-sphere", sphere(20, 32, 18)),
  indexed("import:asset:packet-cube", cube(20)),
  indexed("import:asset:packet-flipped", flipped),
  indexed("import:asset:packet-loose", loose),
  indexed("import:asset:packet-degenerate", degenerate),
  indexed("import:asset:packet-overflow", overflow),
  encodeIndexedMeshAsset({
    id: "import:asset:packet-soup",
    positions: cube(5).triangles.flatMap((t) =>
      t.flatMap((v) => cube(5).vertices[v]),
    ),
  }),
  strided("import:asset:packet-strided"),
  indexed("import:asset:packet-terrain", terrain(48, 1.5)),
  indexed("import:asset:packet-empty", { vertices: [], triangles: [] }),
  {
    descriptor: {
      id: "import:asset:packet-drawing",
      kind: "extension",
      digest: contentDigest(drawingBytes),
      byteLength: drawingBytes.byteLength,
      mediaType: "image/svg+xml",
      sourceFilename: "drawing.svg",
    },
    bytes: drawingBytes,
  },
];

// --- The project -------------------------------------------------------------
const state = structuredClone(fixture.state);
state.sourceAssets = payloads.map((a) => structuredClone(a.descriptor));
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
for (const a of payloads) assets.put(a.descriptor, a.bytes);

// --- Packets -------------------------------------------------------------------
const steps = [];
function packet(assetId, maxChunkVertices) {
  const request = encodeProjectMeshPacketRequest({
    assetId: units(assetId),
    maxChunkVertices,
  });
  const { reply, bytes } = meshPacketWire(
    decodeProjectMeshPacketRequest(request),
    assets,
  );
  const step = { request, reply: encodeProjectMeshPacketReply(reply) };
  if (bytes) {
    step.bytes = sha256(bytes);
    if (bytes.length >= 80) step.window = sha256(bytes.subarray(16, 80));
    const geometry = displayGeometry(assets.peek(assetId));
    step.normals = sha256(
      new Uint8Array(geometry.getAttribute("normal").array.buffer),
    );
    geometry.dispose();
  }
  steps.push(step);
}
const limits = [3, 4, 7, 64, 1000, 65536, 65537, 4294967295];
for (const { descriptor } of payloads.slice(0, -1))
  for (const limit of descriptor.id === fixture.asset.descriptor.id
    ? limits
    : [3, 64, 65536, 65537])
    packet(descriptor.id, limit);
for (const limit of [5, 100, 4096, 16384, 65535]) packet("import:asset:packet-terrain", limit);
packet("import:asset:packet-drawing", 64);
packet("import:asset:packet-missing", 64);
packet(" import:asset:packet-sphere", 64);

const sources = [
  "tools/cross-platform/mesh-packet-vectors.mjs",
  "web/src/project/surfaces/meshPacket.ts",
  "web/src/project/meshCodec.ts",
  "web/node_modules/three/src/core/BufferGeometry.js",
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
const path = new URL("testdata/cross-platform/mesh-packet-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Mesh packet reference drift");
const prepared = steps
  .filter((s) => s.reply.startsWith('{"prepared"'))
  .map((s) => JSON.parse(s.reply).prepared);
console.log(
  `mesh packets: ${steps.length} requests (${prepared.length} packed into ${prepared.reduce((n, p) => n + p.chunkCount, 0)} chunks of ${prepared.reduce((n, p) => n + p.byteLength, 0)} bytes, ${steps.length - prepared.length} refused)`,
);
