// Independent packed-mesh and canonical-bounds references from production TS.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  encodeIndexedMeshAsset,
  decodeIndexedMeshAsset,
  expandIndexedMeshPositions,
} from "../../web/src/project/meshCodec.ts";
import {
  contentDigest,
  InMemoryAssetRepository,
} from "../../web/src/project/assets.ts";
import {
  canonicalStringify,
  cloneProjectState,
} from "../../web/src/project/domain/canonical.ts";
import { computeCanonicalInstanceBounds } from "../../web/src/project/objects/bounds.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
const root = new URL("../../", import.meta.url);
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const bits64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b.readBigUInt64LE().toString(16).padStart(16, "0");
};
const bits32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b.readUInt32LE();
};
const wire = (p) => ({
  descriptorJson: canonicalStringify(p.descriptor),
  bytes: Array.from(p.bytes),
});
let seed = 0xabcdbad;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
}
const encoding = [];
function encodeCase(positions, indices, options = {}) {
  const input = { id: "import:mesh:reference", ...options };
  const c = {
    optionsJson: canonicalStringify(input),
    positionsBits: positions.map(bits64),
    indices: indices ?? null,
  };
  try {
    c.expected = wire(
      encodeIndexedMeshAsset({
        ...input,
        positions,
        ...(indices === undefined ? {} : { indices }),
      }),
    );
  } catch {
    c.error = true;
  }
  encoding.push(c);
}
for (const n of [
  0,
  -0,
  1,
  -1,
  1 / 3,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  1 + 2 ** -24,
  1 + 3 * 2 ** -24,
  -(1 + 2 ** -24),
  2 ** -149,
  2 ** -150,
  3 * 2 ** -150,
  (2 - 2 ** -23) * 2 ** 127,
  (2 - 2 ** -24) * 2 ** 127,
  1e40,
  -1e40,
  Infinity,
  -Infinity,
  NaN,
]) {
  for (const indices of [undefined, [2, 0, 1], []])
    encodeCase([n, 0, -0, 0, 1, 0, 1, 0, 0], indices);
}
encodeCase([], []);
encodeCase([]);
encodeCase([1, 2]);
encodeCase([1, 2, 3]);
encodeCase([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 3]);
encodeCase([0, 0, 0], [0, 0, 0]);
encodeCase([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], {
  id: "import:mesh:\ud800\0",
  sourceFilename: "odd\udfff\0.stl",
  provenance: {
    source: "recovered",
    uri: "x:💫",
    extra: JSON.parse('{"__proto__":42}'),
  },
});
encodeCase([0, 0, 0], [], { sourceFilename: "" });
for (let i = 0; i < 128; i++) {
  const positions = Array.from(
    { length: 9 * (1 + (i % 5)) },
    () => (random() - 0.5) * 2 ** Math.floor(random() * 250 - 125),
  );
  encodeCase(
    positions,
    i % 2
      ? undefined
      : Array.from({ length: 3 * (i % 7) }, () =>
          Math.floor((random() * positions.length) / 3),
        ),
  );
}
const decoding = [];
function decodeCase(payload, name) {
  const c = { name, ...wire(payload) };
  try {
    const mesh = decodeIndexedMeshAsset(payload);
    c.expected = {
      positionsBits: Array.from(mesh.positions, bits32),
      indices: Array.from(mesh.indices),
      expandedBits: Array.from(expandIndexedMeshPositions(mesh), bits32),
    };
  } catch {
    c.error = true;
  }
  decoding.push(c);
}
for (const [i, c] of encoding.entries())
  if (c.expected)
    decodeCase(
      {
        descriptor: JSON.parse(c.expected.descriptorJson),
        bytes: Uint8Array.from(c.expected.bytes),
      },
      `encoded-${i}`,
    );
const base = encodeIndexedMeshAsset({
  id: "import:mesh:mutated",
  positions: [-1, -0, 2, 3, 4, 5, 6, 7, 8],
  indices: [2, 0, 1],
});
function mutated(name, change, redigest = false) {
  const p = {
    descriptor: structuredClone(base.descriptor),
    bytes: base.bytes.slice(),
  };
  change(p);
  if (redigest) p.descriptor.digest = contentDigest(p.bytes);
  decodeCase(p, name);
}
for (const part of ["positions", "indices"]) {
  for (const key of [
    "byteOffset",
    "byteLength",
    "count",
    "componentCount",
    "byteStride",
  ]) {
    for (const value of [
      -1,
      0,
      1,
      2,
      3,
      4,
      5,
      11,
      12,
      36,
      48,
      49,
      0.5,
      Number.MAX_SAFE_INTEGER,
      2 ** 53,
    ])
      mutated(
        `${part}-${key}-${value}`,
        (p) => (p.descriptor.mesh[part][key] = value),
      );
    mutated(
      `${part}-${key}-absent`,
      (p) => delete p.descriptor.mesh[part][key],
    );
  }
  for (const type of ["float32", "uint16", "uint32", "bad"])
    mutated(
      `${part}-type-${type}`,
      (p) => (p.descriptor.mesh[part].componentType = type),
    );
}
for (const value of [-1, 0, 0.5, 1, 2, Number.MAX_SAFE_INTEGER])
  mutated(
    `triangles-${value}`,
    (p) => (p.descriptor.mesh.triangleCount = value),
  );
mutated("missing-mesh", (p) => delete p.descriptor.mesh);
mutated("wrong-kind", (p) => (p.descriptor.kind = "archive"));
mutated("unknown-digest", (p) => (p.descriptor.digest = "opaque:retained"));
mutated("bad-length", (p) => p.descriptor.byteLength--);
mutated("bad-digest", (p) => (p.bytes[0] ^= 255));
for (const n of [0x7f800000, 0xff800000, 0x7fc00001])
  mutated(
    `nonfinite-${n}`,
    (p) => new DataView(p.bytes.buffer).setUint32(0, n, true),
    true,
  );
mutated(
  "index-outside",
  (p) => new DataView(p.bytes.buffer).setUint32(36, 3, true),
  true,
);
for (let offset = 0; offset < base.bytes.length; offset++) {
  for (let bit = 0; bit < 8; bit++)
    mutated(
      `payload-bit-${offset}-${bit}`,
      (p) => {
        p.bytes[offset] ^= 1 << bit;
      },
      true,
    );
}
for (const positions of [[], [1, 2, 3]]) {
  const p = encodeIndexedMeshAsset({
    id: "import:mesh:unused-stride",
    positions,
    indices: [],
  });
  p.descriptor.mesh.positions.byteStride = Number.MAX_SAFE_INTEGER;
  p.descriptor.mesh.indices.byteStride = Number.MAX_SAFE_INTEGER;
  decodeCase(p, `unused-safe-integer-stride-${positions.length}`);
}
for (const width of [2, 4])
  for (const offset of [0, 1, 2, 3])
    for (const components of [3, 4, 5]) {
      const stride = components * 4 + 3,
        start = offset + stride * 3 + 5,
        bytes = new Uint8Array(start + 3 * (width + 1) + 8),
        v = new DataView(bytes.buffer);
      [
        [1, -0, 3],
        [4, 5, 6],
        [-7, 8, 9],
      ].forEach((p, i) =>
        p.forEach((n, a) => v.setFloat32(offset + i * stride + a * 4, n, true)),
      );
      if (components > 3)
        for (let i = 0; i < 3; i++)
          v.setUint32(offset + i * stride + 12, 0x7fc00001, true);
      [2, 0, 1].forEach((n, i) =>
        width === 2
          ? v.setUint16(start + i * (width + 1), n, true)
          : v.setUint32(start + i * (width + 1), n, true),
      );
      const descriptor = structuredClone(base.descriptor);
      descriptor.byteLength = bytes.length;
      descriptor.digest = contentDigest(bytes);
      descriptor.mesh.positions = {
        byteOffset: offset,
        byteLength: 2 * stride + components * 4,
        componentType: "float32",
        componentCount: components,
        count: 3,
        byteStride: stride,
      };
      descriptor.mesh.indices = {
        byteOffset: start,
        byteLength: 2 * (width + 1) + width,
        componentType: width === 2 ? "uint16" : "uint32",
        componentCount: 1,
        count: 3,
        byteStride: width + 1,
      };
      decodeCase(
        { descriptor, bytes },
        `strided-${width}-${offset}-${components}`,
      );
    }
const fixture = createProjectFixture();
const mesh = encodeIndexedMeshAsset({
  id: fixture.ids.asset,
  positions: [0, 0, -1, 2, 0, 3, 0, 4, 1, 100, -200, 30],
  indices: [0, 1, 2],
});
const state = cloneProjectState(fixture.state);
state.sourceAssets = [mesh.descriptor];
state.plates[0].objects[0].volumes[0].source.triangleCount = 1;
const bounds = [];
function boundsCase(
  name,
  change = () => {},
  ids = [fixture.ids.instance],
  roles,
) {
  const s = cloneProjectState(state);
  const payloads = [
    { descriptor: structuredClone(mesh.descriptor), bytes: mesh.bytes.slice() },
  ];
  change(s, payloads);
  const c = {
    name,
    stateJson: canonicalStringify(s),
    assets: payloads.map(wire),
    ids: ids.map((v) =>
      Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)),
    ),
    ...(roles === undefined ? {} : { roles }),
  };
  try {
    const repo = new InMemoryAssetRepository();
    for (const p of payloads) repo.put(p.descriptor, p.bytes);
    const b = computeCanonicalInstanceBounds(s, repo, ids, {
      ...(roles === undefined ? {} : { volumeRoles: roles }),
    });
    c.expectedBits = [...b.min, ...b.max].map(bits64);
  } catch {
    c.error = true;
  }
  bounds.push(c);
}
boundsCase("identity-includes-unused-vertex");
for (let i = 0; i < 128; i++)
  boundsCase(`transform-${i}`, (s) => {
    for (const transform of [
      s.plates[0].objects[0].volumes[0].transform,
      s.plates[0].objects[0].instances[0].transform,
    ]) {
      transform.translationMm = Array.from(
        { length: 3 },
        () => (random() - 0.5) * 1e5,
      );
      transform.scale = Array.from({ length: 3 }, () => (random() - 0.5) * 100);
      const magnitude = 2 ** Math.floor(random() * 1900 - 950);
      transform.rotation = Array.from(
        { length: 4 },
        () => (random() - 0.5) * magnitude,
      );
    }
  });
for (const q of [
  [0, 0, 0, 0],
  [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  [1e308, 1e308, 1e308, 1e308],
  [1e-320, 2e-320, 3e-320, 4e-320],
  [0, 0, 0, -1],
])
  boundsCase(
    `quaternion-${q}`,
    (s) => (s.plates[0].objects[0].volumes[0].transform.rotation = q),
  );
boundsCase(
  "overflowed-vertex",
  (s) => (s.plates[0].objects[0].volumes[0].transform.scale = [1e308, 1, 1]),
);
boundsCase("empty-selection", () => {}, []);
boundsCase("duplicate-selection", () => {}, [
  fixture.ids.instance,
  fixture.ids.instance,
]);
boundsCase("missing-instance", () => {}, ["import:instance:missing"]);
boundsCase("missing-asset", (s, p) => p.splice(0));
boundsCase("missing-descriptor", (s) => (s.sourceAssets = []));
boundsCase(
  "metadata-mismatch",
  (s) => (s.sourceAssets[0].sourceFilename = "changed.stl"),
);
boundsCase("empty-roles", () => {}, [fixture.ids.instance], []);
boundsCase(
  "excluded-role",
  (s) => (s.plates[0].objects[0].volumes[0].role = "negative-volume"),
  [fixture.ids.instance],
  ["model"],
);
boundsCase(
  "included-role",
  (s) => (s.plates[0].objects[0].volumes[0].role = "negative-volume"),
  [fixture.ids.instance],
  ["negative-volume"],
);
const second = "import:instance:second";
boundsCase(
  "two-instances",
  (s) => {
    const instance = structuredClone(s.plates[0].objects[0].instances[0]);
    instance.id = second;
    instance.transform.translationMm = [20, -10, 300];
    s.plates[0].objects[0].instances.push(instance);
  },
  [fixture.ids.instance, second],
);
boundsCase("second-volume", (s) => {
  const volume = structuredClone(s.plates[0].objects[0].volumes[0]);
  volume.id = "import:volume:second";
  volume.transform.translationMm = [1000, 0, -50];
  s.plates[0].objects[0].volumes.push(volume);
});
const sources = [
  "tools/cross-platform/mesh-vectors.mjs",
  "web/src/project/meshCodec.ts",
  "web/src/project/objects/bounds.ts",
  "web/src/project/assets.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/selectors.ts",
  "web/src/project/__tests__/fixtures.ts",
];
const result = {
  schemaVersion: 1,
  sources: Object.fromEntries(
    sources.map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(new URL(p, root)))
        .digest("hex"),
    ]),
  ),
  encoding,
  decoding,
  bounds,
};
const destination = new URL("testdata/cross-platform/mesh-vectors.json", root),
  text = JSON.stringify(result, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(destination, text);
else
  assert.equal(
    readFileSync(destination, "utf8"),
    text,
    "Mesh reference drift; regenerate explicitly",
  );
console.log(
  `Mesh references: ${encoding.length} encoding, ${decoding.length} decoding, ${bounds.length} bounds cases`,
);
