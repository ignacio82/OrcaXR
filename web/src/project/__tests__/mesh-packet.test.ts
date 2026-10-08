import assert from 'node:assert/strict';

import { encodeIndexedMeshAsset, type AssetId } from '..';
import { MESH_PACKET_TABLE_ENTRY_BYTES, displayGeometry, packMesh } from '../surfaces/meshPacket';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** xorshift32, seeded, so every run checks the same meshes. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** A mesh with shared, unreferenced and repeated vertices and degenerate triangles. */
function randomMesh(next: () => number, id: string) {
  const vertexCount = 3 + Math.floor(next() * 60);
  const positions = Array.from({ length: vertexCount * 3 }, () => Math.round((next() * 200 - 100) * 64) / 64);
  const triangleCount = Math.floor(next() * 120);
  // Mostly local neighbourhoods, so chunks share vertices; some corners
  // repeat the one before, making degenerate triangles.
  const indices: number[] = [];
  for (let i = 0; i < triangleCount * 3; i += 1) {
    if (i % 3 !== 0 && next() < 0.05) indices.push(indices[i - 1]);
    else indices.push(Math.min(vertexCount - 1, Math.floor((i / 3 / triangleCount) * vertexCount + next() * 6)));
  }
  return encodeIndexedMeshAsset({ id: id as AssetId, positions, indices });
}

test('every triangle reads back from its chunk exactly, and every chunk is full and aligned', () => {
  // The packer is the same in both cores, so the corpus alone cannot catch a
  // chunking bug they share; this checks it against the geometry directly.
  const next = random(0x5eed);
  for (let round = 0; round < 60; round += 1) {
    const geometry = displayGeometry(randomMesh(next, `import:asset:packet-${round}`));
    const positions = geometry.getAttribute('position').array as Float32Array;
    const normals = geometry.getAttribute('normal').array as Float32Array;
    const index = geometry.getIndex()!.array;
    const triangles = index.length / 3;
    for (const limit of [3, 4, 5, 8, 17, 64, 65_536, 65_537]) {
      const packet = packMesh(geometry, limit);
      const view = new DataView(packet.bytes.buffer, packet.bytes.byteOffset, packet.bytes.byteLength);
      assert.equal(packet.indexBytes, limit <= 65_536 ? 2 : 4);
      let expectedFirst = 0;
      for (const [position, chunk] of packet.chunks.entries()) {
        const entry = position * MESH_PACKET_TABLE_ENTRY_BYTES;
        assert.deepEqual(
          [0, 4, 8, 12].map((offset) => view.getUint32(entry + offset, true)),
          [chunk.firstTriangle, chunk.triangleCount, chunk.vertexCount, chunk.byteOffset],
        );
        assert.equal(chunk.firstTriangle, expectedFirst, 'chunks cover the triangles in order');
        assert.ok(chunk.triangleCount > 0 && chunk.vertexCount <= limit);
        assert.equal(chunk.byteOffset % 4, 0);
        expectedFirst += chunk.triangleCount;
        const referenced = new Set<number>();
        for (let triangle = 0; triangle < chunk.triangleCount; triangle += 1) {
          for (let corner = 0; corner < 3; corner += 1) {
            const at = chunk.byteOffset + chunk.vertexCount * 24 + (triangle * 3 + corner) * packet.indexBytes;
            const local = packet.indexBytes === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
            assert.ok(local < chunk.vertexCount);
            referenced.add(local);
            const vertex = index[(chunk.firstTriangle + triangle) * 3 + corner];
            for (let axis = 0; axis < 3; axis += 1) {
              assert.equal(
                view.getFloat32(chunk.byteOffset + local * 12 + axis * 4, true),
                positions[vertex * 3 + axis],
              );
              assert.equal(
                view.getFloat32(chunk.byteOffset + chunk.vertexCount * 12 + local * 12 + axis * 4, true),
                normals[vertex * 3 + axis],
              );
            }
          }
        }
        assert.equal(referenced.size, chunk.vertexCount, 'a chunk carries only the vertices it uses');
        // Greedy: the next chunk's first triangle did not fit in this one.
        const following = packet.chunks[position + 1];
        if (following) {
          const used = new Set(
            Array.from({ length: chunk.triangleCount * 3 }, (_, i) => index[chunk.firstTriangle * 3 + i]),
          );
          for (let corner = 0; corner < 3; corner += 1) used.add(index[following.firstTriangle * 3 + corner]);
          assert.ok(used.size > limit, 'a chunk closes only when the next triangle overflows it');
        }
      }
      assert.equal(expectedFirst, triangles);
      assert.equal(packet.chunks.length === 0, triangles === 0);
    }
    geometry.dispose();
  }
});

test('packets keep three.js normals and bounds, and a vertexless mesh has no bounds', () => {
  const geometry = displayGeometry(
    encodeIndexedMeshAsset({
      id: 'import:asset:packet-tent' as AssetId,
      positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 5, -20, 3, 1],
      indices: [0, 1, 2, 1, 3, 2],
    }),
  );
  const packet = packMesh(geometry, 64);
  assert.deepEqual(packet.bounds?.boxMin, [-20, 0, 0]);
  assert.deepEqual(packet.bounds?.boxMax, [10, 10, 5]);
  assert.equal(packet.bounds?.sphereRadius, geometry.boundingSphere!.radius);
  assert.equal(packet.chunks[0].vertexCount, 4, 'the unreferenced vertex is bounded but not drawn');
  const empty = packMesh(
    displayGeometry(encodeIndexedMeshAsset({ id: 'import:asset:packet-none' as AssetId, positions: [], indices: [] })),
    64,
  );
  assert.equal(empty.bounds, undefined);
  assert.equal(empty.bytes.byteLength, 0);
  assert.throws(() => packMesh(geometry, 2), RangeError);
});

console.log(`\nMesh packets: ${passed} tests passed.`);
