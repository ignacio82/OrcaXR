import assert from 'node:assert/strict';
import {
  contentDigest,
  decodeIndexedMeshAsset,
  encodeIndexedMeshAsset,
  entityId,
  expandIndexedMeshPositions,
  type AssetPayload,
  type SourceAssetDescriptor,
} from '..';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('round-trips deterministic indexed mesh bytes and expands triangle order', () => {
  const asset = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:mesh-codec-square'),
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
    indices: [0, 1, 2, 0, 2, 3],
    sourceFilename: 'square.stl',
    provenance: { source: 'import', uri: 'fixture:square' },
  });
  const again = encodeIndexedMeshAsset({
    id: asset.descriptor.id,
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
    indices: [0, 1, 2, 0, 2, 3],
    sourceFilename: 'square.stl',
    provenance: { source: 'import', uri: 'fixture:square' },
  });
  assert.deepEqual(again, asset);
  const decoded = decodeIndexedMeshAsset(asset);
  assert.deepEqual(decoded.vertices, [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ]);
  assert.deepEqual(decoded.triangles, [
    [0, 1, 2],
    [0, 2, 3],
  ]);
  assert.deepEqual(
    Array.from(expandIndexedMeshPositions(decoded)),
    [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0],
  );
});

test('decodes bounded interleaved positions and strided uint16 indices', () => {
  const bytes = new Uint8Array(68);
  const view = new DataView(bytes.buffer);
  const vertices = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ];
  vertices.forEach((vertex, index) => {
    const offset = 4 + index * 16;
    vertex.forEach((value, component) => view.setFloat32(offset + component * 4, value, true));
  });
  [2, 0, 1].forEach((value, index) => view.setUint16(52 + index * 4, value, true));
  const descriptor: SourceAssetDescriptor = {
    id: entityId<'asset'>('import:test:mesh-codec-strided'),
    kind: 'mesh',
    digest: contentDigest(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/vnd.orcaxr.indexed-mesh',
    mesh: {
      positions: {
        byteOffset: 4,
        byteLength: 44,
        componentType: 'float32',
        componentCount: 3,
        count: 3,
        byteStride: 16,
      },
      indices: {
        byteOffset: 52,
        byteLength: 10,
        componentType: 'uint16',
        componentCount: 1,
        count: 3,
        byteStride: 4,
      },
      triangleCount: 1,
    },
  };
  const strided = decodeIndexedMeshAsset({ descriptor, bytes });
  assert.deepEqual(strided.vertices, vertices);
  assert.deepEqual(strided.triangles, [[2, 0, 1]]);
  // The packed buffers are the real representation; the tuple views above are
  // derived from them, so both have to agree.
  assert.deepEqual(Array.from(strided.positions), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(strided.indices), [2, 0, 1]);
  assert.equal(strided.vertexCount, 3);
  assert.equal(strided.triangleCount, 1);
});

test('exposes packed buffers and tuple views that stay in agreement', () => {
  const asset = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:mesh-codec-packed'),
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0],
    indices: [0, 1, 2],
  });
  const decoded = decodeIndexedMeshAsset(asset);
  assert.equal(decoded.vertexCount, 3);
  assert.equal(decoded.triangleCount, 1);
  assert.ok(decoded.positions instanceof Float32Array);
  assert.ok(decoded.indices instanceof Uint32Array);
  assert.deepEqual(Array.from(decoded.positions), [0, 0, 0, 10, 0, 0, 10, 10, 0]);
  assert.deepEqual(Array.from(decoded.indices), [0, 1, 2]);
  assert.deepEqual(decoded.vertices, [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ]);
  assert.deepEqual(decoded.triangles, [[0, 1, 2]]);
  // Materialized once and reused, so callers that read them repeatedly on a
  // large mesh do not rebuild millions of tuples every time.
  assert.equal(decoded.vertices, decoded.vertices);
  assert.equal(decoded.triangles, decoded.triangles);
});

test('rejects malformed views, non-finite coordinates, bad indices, and digest drift', () => {
  const valid = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:mesh-codec-invalid'),
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  });
  const mutate = (change: (payload: AssetPayload) => void): AssetPayload => {
    const payload: AssetPayload = {
      descriptor: structuredClone(valid.descriptor),
      bytes: valid.bytes.slice(),
    };
    change(payload);
    return payload;
  };
  assert.throws(
    () =>
      decodeIndexedMeshAsset(
        mutate((payload) => {
          payload.descriptor.mesh!.positions.byteLength = 4;
        }),
      ),
    /outside the payload/,
  );
  assert.throws(
    () =>
      encodeIndexedMeshAsset({
        id: valid.descriptor.id,
        positions: [0, 0, 0, Number.NaN, 0, 0, 0, 1, 0],
      }),
    /finite/,
  );
  assert.throws(
    () =>
      encodeIndexedMeshAsset({
        id: valid.descriptor.id,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 9],
      }),
    /outside/,
  );
  assert.throws(
    () =>
      decodeIndexedMeshAsset(
        mutate((payload) => {
          payload.bytes[0] ^= 0xff;
        }),
      ),
    /digest/,
  );
});

console.log(`\nCanonical mesh codec: ${passed} tests passed.`);
