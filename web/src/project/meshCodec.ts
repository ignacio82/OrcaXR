import { contentDigest, type AssetPayload } from './assets';
import { isStableEntityId, type AssetId } from './domain/ids';
import type { SourceAssetDescriptor } from './domain/model';

/**
 * A decoded mesh, packed first and only expanded on demand.
 *
 * `vertices`/`triangles` are the ergonomic view, but they cost one JS array
 * per vertex and per triangle: on a two-million-triangle model that is nearly
 * three million short-lived objects and several hundred megabytes, paid by
 * every consumer that only wanted to read coordinates. The flat typed arrays
 * are the real representation; the tuple views are built lazily and cached, so
 * a caller that never touches them never pays for them.
 */
export interface DecodedIndexedMesh {
  /** Flat xyz triples, `vertexCount * 3` long. */
  readonly positions: Float32Array;
  /** Flat vertex indices, `triangleCount * 3` long. */
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly vertices: ReadonlyArray<readonly [number, number, number]>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
}

class PackedIndexedMesh implements DecodedIndexedMesh {
  private vertexTuples: ReadonlyArray<readonly [number, number, number]> | undefined;
  private triangleTuples: ReadonlyArray<readonly [number, number, number]> | undefined;

  constructor(
    readonly positions: Float32Array,
    readonly indices: Uint32Array,
  ) {}

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  get vertices(): ReadonlyArray<readonly [number, number, number]> {
    if (!this.vertexTuples) {
      const count = this.vertexCount;
      const tuples: Array<readonly [number, number, number]> = new Array(count);
      for (let index = 0; index < count; index += 1) {
        const offset = index * 3;
        tuples[index] = [this.positions[offset], this.positions[offset + 1], this.positions[offset + 2]];
      }
      this.vertexTuples = tuples;
    }
    return this.vertexTuples;
  }

  get triangles(): ReadonlyArray<readonly [number, number, number]> {
    if (!this.triangleTuples) {
      const count = this.triangleCount;
      const tuples: Array<readonly [number, number, number]> = new Array(count);
      for (let index = 0; index < count; index += 1) {
        const offset = index * 3;
        tuples[index] = [this.indices[offset], this.indices[offset + 1], this.indices[offset + 2]];
      }
      this.triangleTuples = tuples;
    }
    return this.triangleTuples;
  }
}

/** Wrap already-packed buffers as a mesh, without copying or re-validating them. */
export function packIndexedMesh(positions: Float32Array, indices: Uint32Array): DecodedIndexedMesh {
  return new PackedIndexedMesh(positions, indices);
}

export interface EncodeIndexedMeshOptions {
  readonly id: AssetId;
  readonly positions: ArrayLike<number>;
  readonly indices?: ArrayLike<number>;
  readonly sourceFilename?: string;
  readonly provenance?: SourceAssetDescriptor['provenance'];
}

/** Decode the canonical immutable mesh wire format without any rendering dependency. */
export function decodeIndexedMeshAsset(payload: AssetPayload): DecodedIndexedMesh {
  const { descriptor, bytes } = payload;
  const mesh = descriptor.mesh;
  if (descriptor.kind !== 'mesh' || !mesh) throw new Error('Asset is not an indexed mesh');
  if (descriptor.byteLength !== bytes.byteLength)
    throw new Error('Mesh payload byte length differs from its descriptor');
  if (descriptor.digest.startsWith('fnv1a64:') && descriptor.digest !== contentDigest(bytes)) {
    throw new Error('Mesh payload content differs from its descriptor digest');
  }
  if (mesh.positions.componentType !== 'float32' || mesh.positions.componentCount < 3) {
    throw new Error('Mesh positions must be float32 vectors with at least three components');
  }
  validateBufferView(mesh.positions, bytes.byteLength, 4, 'position');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positionStride = mesh.positions.byteStride ?? mesh.positions.componentCount * 4;
  const vertexCount = mesh.positions.count;
  const positions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) {
    const offset = mesh.positions.byteOffset + index * positionStride;
    const x = view.getFloat32(offset, true);
    const y = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('Mesh contains a non-finite vertex');
    }
    const target = index * 3;
    positions[target] = x;
    positions[target + 1] = y;
    positions[target + 2] = z;
  }

  let indices: Uint32Array;
  if (mesh.indices) {
    if (mesh.indices.componentType !== 'uint16' && mesh.indices.componentType !== 'uint32') {
      throw new Error('Mesh indices must be uint16 or uint32 scalars');
    }
    if (mesh.indices.componentCount !== 1) throw new Error('Mesh indices must be scalar values');
    const componentBytes = mesh.indices.componentType === 'uint16' ? 2 : 4;
    validateBufferView(mesh.indices, bytes.byteLength, componentBytes, 'index');
    const stride = mesh.indices.byteStride ?? componentBytes;
    indices = new Uint32Array(mesh.indices.count);
    for (let index = 0; index < mesh.indices.count; index += 1) {
      const offset = mesh.indices.byteOffset + index * stride;
      indices[index] = componentBytes === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
    }
  } else {
    indices = new Uint32Array(vertexCount);
    for (let index = 0; index < vertexCount; index += 1) indices[index] = index;
  }

  if (!Number.isInteger(mesh.triangleCount) || mesh.triangleCount < 0) {
    throw new Error('Mesh triangle count must be a non-negative integer');
  }
  if (indices.length % 3 !== 0 || indices.length / 3 !== mesh.triangleCount) {
    throw new Error('Mesh index count does not match the declared triangle count');
  }
  for (let index = 0; index < indices.length; index += 1) {
    // Unsigned by construction, so one bound is enough.
    if (indices[index] >= vertexCount) throw new Error('Mesh index is outside the vertex buffer');
  }
  return new PackedIndexedMesh(positions, indices);
}

/** Encode tightly-packed float32 vertices plus optional uint32 indices deterministically. */
export function encodeIndexedMeshAsset(options: EncodeIndexedMeshOptions): AssetPayload {
  if (!isStableEntityId(options.id)) throw new Error(`Asset ID ${options.id} is not stable`);
  if (!Number.isSafeInteger(options.positions.length) || options.positions.length % 3 !== 0) {
    throw new Error('Mesh positions must contain complete xyz vectors');
  }
  const vertexCount = options.positions.length / 3;
  const indices = options.indices
    ? Array.from(options.indices)
    : Array.from({ length: vertexCount }, (_, index) => index);
  if (indices.length % 3 !== 0) throw new Error('Mesh indices must contain complete triangles');
  if (!options.indices && vertexCount % 3 !== 0) {
    throw new Error('A non-indexed mesh must contain three vertices per triangle');
  }

  const positionBytes = options.positions.length * 4;
  const indexBytes = options.indices ? indices.length * 4 : 0;
  const totalBytes = positionBytes + indexBytes;
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Mesh payload is too large');
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < options.positions.length; index += 1) {
    const coordinate = Number(options.positions[index]);
    if (!Number.isFinite(coordinate)) throw new Error('Mesh positions must be finite');
    view.setFloat32(index * 4, coordinate, true);
  }
  for (let index = 0; index < indices.length; index += 1) {
    const vertex = indices[index];
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertexCount || vertex > 0xffff_ffff) {
      throw new Error(`Mesh index ${vertex} is outside the vertex buffer`);
    }
    if (options.indices) view.setUint32(positionBytes + index * 4, vertex, true);
  }

  const descriptor: SourceAssetDescriptor = {
    id: options.id,
    kind: 'mesh',
    digest: contentDigest(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/vnd.orcaxr.indexed-mesh',
    ...(options.sourceFilename ? { sourceFilename: options.sourceFilename } : {}),
    ...(options.provenance ? { provenance: { ...options.provenance } } : {}),
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: positionBytes,
        componentType: 'float32',
        componentCount: 3,
        count: vertexCount,
      },
      ...(options.indices
        ? {
            indices: {
              byteOffset: positionBytes,
              byteLength: indexBytes,
              componentType: 'uint32' as const,
              componentCount: 1 as const,
              count: indices.length,
            },
          }
        : {}),
      triangleCount: indices.length / 3,
    },
  };
  return { descriptor, bytes };
}

/** Expand an indexed mesh into Three/STL-friendly xyz triples without sharing source bytes. */
export function expandIndexedMeshPositions(mesh: DecodedIndexedMesh): Float32Array {
  const source = mesh.positions;
  const indices = mesh.indices;
  const positions = new Float32Array(indices.length * 3);
  for (let index = 0; index < indices.length; index += 1) {
    const from = indices[index] * 3;
    const to = index * 3;
    positions[to] = source[from];
    positions[to + 1] = source[from + 1];
    positions[to + 2] = source[from + 2];
  }
  return positions;
}

function validateBufferView(
  descriptor: {
    byteOffset: number;
    byteLength: number;
    componentCount: number;
    count: number;
    byteStride?: number;
  },
  payloadByteLength: number,
  componentBytes: number,
  label: string,
): void {
  for (const [name, value] of [
    ['byteOffset', descriptor.byteOffset],
    ['byteLength', descriptor.byteLength],
    ['componentCount', descriptor.componentCount],
    ['count', descriptor.count],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Mesh ${label} ${name} is invalid`);
  }
  if (descriptor.componentCount < 1) throw new Error(`Mesh ${label} component count is invalid`);
  const packedBytes = descriptor.componentCount * componentBytes;
  const stride = descriptor.byteStride ?? packedBytes;
  if (!Number.isSafeInteger(stride) || stride < packedBytes) throw new Error(`Mesh ${label} stride is invalid`);
  const segmentEnd = descriptor.byteOffset + descriptor.byteLength;
  const lastEnd =
    descriptor.count === 0
      ? descriptor.byteOffset
      : descriptor.byteOffset + (descriptor.count - 1) * stride + packedBytes;
  if (
    !Number.isSafeInteger(segmentEnd) ||
    !Number.isSafeInteger(lastEnd) ||
    segmentEnd > payloadByteLength ||
    lastEnd > segmentEnd
  ) {
    throw new Error(`Mesh ${label} buffer view is outside the payload`);
  }
}
