/**
 * Renderer packets for a mesh asset: the geometry the workspace draws, packed
 * for a platform renderer that cannot run three.js.
 *
 * `displayGeometry` is the very `BufferGeometry` `ThreeProjectSurface` uploads:
 * decoded float32 positions, the index, and three.js's smooth vertex normals
 * and bounds. `packMesh` splits it into chunks of at most a host's vertex
 * limit, in triangle order, each with its own vertices (in first-use order)
 * and local indices — 16-bit when a chunk can never exceed 65,536 vertices.
 * Normals are the whole mesh's, so a vertex shared across a chunk boundary
 * shades identically on both sides and the seams cannot show.
 *
 * Packets stay in the asset's own millimetres and axes; each platform adapter
 * converts once, as the rendering contract requires. Colour, selection and
 * transforms come from the render projection, and paint from overlay packets.
 * The Rust core answers the same requests (`orcaxr_project::mesh_packet`).
 */
import * as THREE from 'three';

import type {
  ProjectMeshPacketReplyWire,
  ProjectMeshPacketRequestWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetPayload } from '../assets';
import type { AssetId } from '../domain/ids';
import { decodeIndexedMeshAsset } from '../meshCodec';

/**
 * The geometry the workspace draws for a mesh asset. Throws the decoder's
 * error when the payload is not a valid indexed mesh.
 */
export function displayGeometry(payload: AssetPayload): THREE.BufferGeometry {
  const decoded = decodeIndexedMeshAsset(payload);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(decoded.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Bytes of one chunk-table entry: first triangle, triangles, vertices, byte offset. */
export const MESH_PACKET_TABLE_ENTRY_BYTES = 16;
/** Chunks of at most this many vertices index them in 16 bits. */
const SHORT_INDEX_VERTICES = 65_536;
/** The quiet NaN every NaN normal component is written as. */
const CANONICAL_NAN = 0x7fc0_0000;

export interface MeshPacketChunk {
  readonly firstTriangle: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly byteOffset: number;
}

export interface MeshPacket {
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Absent for a mesh with no vertices, whose three.js box is empty. */
  readonly bounds?: {
    readonly boxMin: readonly [number, number, number];
    readonly boxMax: readonly [number, number, number];
    readonly sphereCenter: readonly [number, number, number];
    readonly sphereRadius: number;
  };
  readonly indexBytes: 2 | 4;
  readonly chunks: readonly MeshPacketChunk[];
  /**
   * The chunk table, then each chunk at its 4-byte-aligned offset: float32
   * xyz positions, float32 xyz normals, then indices, all little-endian.
   */
  readonly bytes: Uint8Array;
}

/** Pack a display geometry into chunks of at most `maxChunkVertices` (≥ 3). */
export function packMesh(geometry: THREE.BufferGeometry, maxChunkVertices: number): MeshPacket {
  if (!Number.isSafeInteger(maxChunkVertices) || maxChunkVertices < 3) {
    throw new RangeError('A chunk must hold at least one triangle');
  }
  const positions = geometry.getAttribute('position').array as Float32Array;
  const normals = geometry.getAttribute('normal').array as Float32Array;
  const index = geometry.getIndex()!.array;
  const vertexCount = positions.length / 3;
  const triangleCount = index.length / 3;
  const indexBytes = maxChunkVertices <= SHORT_INDEX_VERTICES ? 2 : 4;

  // Chunk boundaries: a triangle starts a new chunk when its new vertices
  // would take the current one past the limit. `seen` stamps a vertex with
  // the chunk that last took it, so no map is rebuilt per chunk.
  const seen = new Int32Array(vertexCount).fill(-1);
  const bounds: { first: number; vertices: number }[] = [];
  let first = 0;
  let used = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const chunk = bounds.length;
    let fresh = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index[triangle * 3 + corner];
      if (seen[vertex] !== chunk) {
        // A degenerate triangle names a vertex twice; count it once.
        let repeated = false;
        for (let earlier = 0; earlier < corner; earlier += 1) repeated ||= index[triangle * 3 + earlier] === vertex;
        if (!repeated) fresh += 1;
      }
    }
    if (used + fresh > maxChunkVertices) {
      bounds.push({ first, vertices: used });
      first = triangle;
      used = 0;
    }
    const current = bounds.length;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index[triangle * 3 + corner];
      if (seen[vertex] !== current) {
        seen[vertex] = current;
        used += 1;
      }
    }
  }
  if (triangleCount > first) bounds.push({ first, vertices: used });

  const chunks: MeshPacketChunk[] = [];
  let offset = bounds.length * MESH_PACKET_TABLE_ENTRY_BYTES;
  for (const [position, chunk] of bounds.entries()) {
    const next = bounds[position + 1]?.first ?? triangleCount;
    chunks.push({
      firstTriangle: chunk.first,
      triangleCount: next - chunk.first,
      vertexCount: chunk.vertices,
      byteOffset: offset,
    });
    offset += align4(chunk.vertices * 24 + (next - chunk.first) * 3 * indexBytes);
  }

  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  const float = (at: number, value: number) => {
    if (Number.isNaN(value)) view.setUint32(at, CANONICAL_NAN, true);
    else view.setFloat32(at, value, true);
  };
  const local = new Int32Array(vertexCount);
  seen.fill(-1);
  for (const [position, chunk] of chunks.entries()) {
    const table = position * MESH_PACKET_TABLE_ENTRY_BYTES;
    view.setUint32(table, chunk.firstTriangle, true);
    view.setUint32(table + 4, chunk.triangleCount, true);
    view.setUint32(table + 8, chunk.vertexCount, true);
    view.setUint32(table + 12, chunk.byteOffset, true);
    const normalsAt = chunk.byteOffset + chunk.vertexCount * 12;
    const indicesAt = chunk.byteOffset + chunk.vertexCount * 24;
    let next = 0;
    for (let triangle = 0; triangle < chunk.triangleCount; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index[(chunk.firstTriangle + triangle) * 3 + corner];
        if (seen[vertex] !== position) {
          seen[vertex] = position;
          local[vertex] = next;
          for (let axis = 0; axis < 3; axis += 1) {
            float(chunk.byteOffset + next * 12 + axis * 4, positions[vertex * 3 + axis]);
            float(normalsAt + next * 12 + axis * 4, normals[vertex * 3 + axis]);
          }
          next += 1;
        }
        const at = indicesAt + (triangle * 3 + corner) * indexBytes;
        if (indexBytes === 2) view.setUint16(at, local[vertex], true);
        else view.setUint32(at, local[vertex], true);
      }
    }
  }

  const box = geometry.boundingBox!;
  const sphere = geometry.boundingSphere!;
  return {
    vertexCount,
    triangleCount,
    ...(vertexCount === 0
      ? {}
      : {
          bounds: {
            boxMin: [box.min.x, box.min.y, box.min.z],
            boxMax: [box.max.x, box.max.y, box.max.z],
            sphereCenter: [sphere.center.x, sphere.center.y, sphere.center.z],
            sphereRadius: sphere.radius,
          },
        }),
    indexBytes,
    chunks,
    bytes,
  };
}

function align4(bytes: number): number {
  return Math.ceil(bytes / 4) * 4;
}

/** The largest packet a reply describes; offsets in its table are 32-bit. */
const MAX_PACKET_BYTES = 0xffff_ffff;

/** `MeshPacketRequest` → `MeshPacketReply`, with the packet's bytes. */
export function meshPacketWire(
  request: ProjectMeshPacketRequestWire,
  assets: { peek(id: AssetId): AssetPayload | undefined },
): { reply: ProjectMeshPacketReplyWire; bytes?: Uint8Array } {
  const assetId = wireText(request.assetId) as AssetId;
  const payload = assets.peek(assetId);
  if (!payload) {
    return {
      reply: { refused: { code: 'unknownAsset', message: wireUnits(`Asset bytes are missing for ${assetId}`) } },
    };
  }
  let geometry: THREE.BufferGeometry;
  try {
    geometry = displayGeometry(payload);
  } catch (error) {
    return { reply: { refused: { code: 'invalidMesh', message: wireUnits((error as Error).message) } } };
  }
  try {
    const packet = packMesh(geometry, request.maxChunkVertices);
    if (packet.bytes.byteLength > MAX_PACKET_BYTES) {
      return { reply: { refused: { code: 'tooLarge', message: wireUnits('The mesh is too large for one packet') } } };
    }
    return {
      reply: {
        prepared: {
          assetId: request.assetId,
          digest: wireUnits(payload.descriptor.digest),
          vertexCount: packet.vertexCount,
          triangleCount: packet.triangleCount,
          bounds: packet.bounds
            ? {
                value: {
                  boxMin: [...packet.bounds.boxMin],
                  boxMax: [...packet.bounds.boxMax],
                  sphereCenter: [...packet.bounds.sphereCenter],
                  sphereRadius: packet.bounds.sphereRadius,
                },
              }
            : { absent: {} },
          indexBytes: packet.indexBytes,
          chunkCount: packet.chunks.length,
          byteLength: packet.bytes.byteLength,
        },
      },
      bytes: packet.bytes,
    };
  } finally {
    geometry.dispose();
  }
}
