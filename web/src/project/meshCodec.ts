import { contentDigest, type AssetPayload } from './assets';
import { isStableEntityId, type AssetId } from './domain/ids';
import type { SourceAssetDescriptor } from './domain/model';

export interface DecodedIndexedMesh {
  readonly vertices: ReadonlyArray<readonly [number, number, number]>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
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
  const vertices: Array<readonly [number, number, number]> = [];
  for (let index = 0; index < mesh.positions.count; index += 1) {
    const offset = mesh.positions.byteOffset + index * positionStride;
    const vertex: readonly [number, number, number] = [
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
    ];
    if (vertex.some((coordinate) => !Number.isFinite(coordinate))) {
      throw new Error('Mesh contains a non-finite vertex');
    }
    vertices.push(vertex);
  }

  const indices: number[] = [];
  if (mesh.indices) {
    if (mesh.indices.componentType !== 'uint16' && mesh.indices.componentType !== 'uint32') {
      throw new Error('Mesh indices must be uint16 or uint32 scalars');
    }
    if (mesh.indices.componentCount !== 1) throw new Error('Mesh indices must be scalar values');
    const componentBytes = mesh.indices.componentType === 'uint16' ? 2 : 4;
    validateBufferView(mesh.indices, bytes.byteLength, componentBytes, 'index');
    const stride = mesh.indices.byteStride ?? componentBytes;
    for (let index = 0; index < mesh.indices.count; index += 1) {
      const offset = mesh.indices.byteOffset + index * stride;
      indices.push(componentBytes === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true));
    }
  } else {
    for (let index = 0; index < vertices.length; index += 1) indices.push(index);
  }

  if (!Number.isInteger(mesh.triangleCount) || mesh.triangleCount < 0) {
    throw new Error('Mesh triangle count must be a non-negative integer');
  }
  if (indices.length % 3 !== 0 || indices.length / 3 !== mesh.triangleCount) {
    throw new Error('Mesh index count does not match the declared triangle count');
  }
  const triangles: Array<readonly [number, number, number]> = [];
  for (let index = 0; index < indices.length; index += 3) {
    const triangle: readonly [number, number, number] = [indices[index], indices[index + 1], indices[index + 2]];
    if (triangle.some((vertex) => vertex < 0 || vertex >= vertices.length)) {
      throw new Error('Mesh index is outside the vertex buffer');
    }
    triangles.push(triangle);
  }
  return { vertices, triangles };
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
  const positions = new Float32Array(mesh.triangles.length * 9);
  let cursor = 0;
  for (const triangle of mesh.triangles) {
    for (const vertexIndex of triangle) {
      const vertex = mesh.vertices[vertexIndex];
      positions[cursor++] = vertex[0];
      positions[cursor++] = vertex[1];
      positions[cursor++] = vertex[2];
    }
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
