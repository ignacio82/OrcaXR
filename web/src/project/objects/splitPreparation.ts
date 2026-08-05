import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneJson } from '../domain/canonical';
import { isStableEntityId, type AssetId, type VolumeId } from '../domain/ids';
import type { Transform, Vec3 } from '../domain/model';
import { decodeIndexedMeshAsset, encodeIndexedMeshAsset, type DecodedIndexedMesh } from '../meshCodec';
import type { PreparedVolumeSplitPart } from './splitCommands';

export type VolumeSplitPreparationStage = 'decode' | 'connectivity' | 'components' | 'encode';

export interface VolumeSplitPreparationProgress {
  readonly stage: VolumeSplitPreparationStage;
  readonly completed: number;
  readonly total: number;
}

export interface VolumeSplitPartIdentityRequest {
  /** Zero-based component index in the pinned source-face order. */
  readonly partIndex: number;
  readonly partCount: number;
  readonly sourceTriangleIndices: readonly number[];
  /** Digest of the exact recentered canonical mesh bytes. */
  readonly geometryDigest: string;
}

export interface VolumeSplitPartIdentity {
  readonly volumeId: VolumeId;
  readonly assetId: AssetId;
}

export interface PrepareVolumeSplitPartsRequest {
  readonly sourceAsset: AssetPayload;
  readonly sourceTransform: Transform;
  /**
   * Inject stable IDs only after topology and deterministic bytes are known.
   * Identical geometry digests must resolve to the same immutable asset ID.
   */
  readonly idsForPart: (request: VolumeSplitPartIdentityRequest) => VolumeSplitPartIdentity;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VolumeSplitPreparationProgress) => void;
}

interface ComponentGeometry {
  readonly sourceTriangleIndices: readonly number[];
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly center: Vec3;
}

/**
 * Deterministically stage canonical split-to-parts payloads without mutating
 * project state or the asset repository.
 *
 * Connectivity and output ordering mirror the pinned TriangleMesh splitter:
 * faces connect only through oppositely directed shared index edges, components
 * are seeded by the first unvisited source face, and faces/vertices retain the
 * pinned discovery order. The pinned TBB neighbor builder has no stable winner
 * when an edge is shared by more than two competing faces; this implementation
 * deliberately serializes that scan in ascending source-face order.
 */
export function prepareVolumeSplitParts(request: PrepareVolumeSplitPartsRequest): PreparedVolumeSplitPart[] {
  const progress = new PreparationProgress(request.signal, request.onProgress);
  progress.check();
  const sourceAsset: AssetPayload = {
    descriptor: cloneJson(request.sourceAsset.descriptor),
    bytes: request.sourceAsset.bytes.slice(),
  };
  const sourceTransform: Transform = {
    translationMm: [...request.sourceTransform.translationMm],
    rotation: [...request.sourceTransform.rotation],
    scale: [...request.sourceTransform.scale],
  };
  const idsForPart = request.idsForPart;
  assertSourceTransform(sourceTransform);
  if (!isStableEntityId(sourceAsset.descriptor.id)) {
    throw new Error(`Source split asset ID ${sourceAsset.descriptor.id} is not stable`);
  }

  progress.report('decode', 0, 1);
  const mesh = decodeIndexedMeshAsset(sourceAsset);
  if (mesh.triangles.length === 0 || mesh.vertices.length === 0) {
    throw new Error('Split preparation requires a non-empty indexed mesh');
  }
  progress.report('decode', 1, 1);

  const neighbors = buildPinnedFaceNeighbors(mesh, progress);
  const components = discoverPinnedComponents(neighbors, progress);
  if (components.length < 2) {
    throw new Error('Source mesh has one shared-edge component and is not splittable');
  }

  const results: PreparedVolumeSplitPart[] = [];
  const volumeIds = new Set<VolumeId>();
  const assetIdByDigest = new Map<string, AssetId>();
  const assetById = new Map<AssetId, AssetPayload>();
  const encodeTotal = mesh.triangles.length + components.length;
  let encodedTriangles = 0;
  progress.report('encode', 0, encodeTotal);

  for (const [partIndex, sourceTriangles] of components.entries()) {
    const component = buildComponentGeometry(mesh, sourceTriangles, () => {
      encodedTriangles += 1;
      progress.report('encode', encodedTriangles + partIndex, encodeTotal);
    });
    const preview = encodeIndexedMeshAsset({
      id: sourceAsset.descriptor.id,
      positions: component.positions,
      indices: component.indices,
      provenance: {
        source: 'generated',
        uri: `orcaxr:split-to-parts:${sourceAsset.descriptor.digest}`,
      },
    });
    const sourceTriangleIndices = [...component.sourceTriangleIndices];
    const identity = idsForPart({
      partIndex,
      partCount: components.length,
      sourceTriangleIndices: [...sourceTriangleIndices],
      geometryDigest: preview.descriptor.digest,
    });
    progress.check();
    assertPreparedIdentity(identity, sourceAsset.descriptor.id, partIndex);
    if (volumeIds.has(identity.volumeId)) {
      throw new Error(`Prepared split volume ID ${identity.volumeId} is duplicated`);
    }
    volumeIds.add(identity.volumeId);

    const digestAssetId = assetIdByDigest.get(preview.descriptor.digest);
    if (digestAssetId && digestAssetId !== identity.assetId) {
      throw new Error(
        `Identical split geometry ${preview.descriptor.digest} resolved to both ${digestAssetId} and ${identity.assetId}`,
      );
    }
    const asset: AssetPayload = {
      descriptor: { ...preview.descriptor, id: identity.assetId },
      bytes: preview.bytes.slice(),
    };
    const existingAsset = assetById.get(identity.assetId);
    if (existingAsset && !sameAssetPayload(existingAsset, asset)) {
      throw new Error(`Prepared split asset ID ${identity.assetId} resolved to different immutable geometry`);
    }
    assetIdByDigest.set(preview.descriptor.digest, identity.assetId);
    const canonicalAsset = existingAsset ?? asset;
    assetById.set(identity.assetId, canonicalAsset);

    results.push({
      volumeId: identity.volumeId,
      asset: cloneAssetPayload(canonicalAsset),
      transform: recenteredTransform(sourceTransform, component.center),
      sourceTriangleIndices,
    });
    progress.report('encode', encodedTriangles + partIndex + 1, encodeTotal);
  }

  for (const assetId of assetById.keys()) {
    if (volumeIds.has(assetId as unknown as VolumeId)) {
      throw new Error(`Injected stable ID ${assetId} is reused by a prepared split volume and asset`);
    }
  }
  return results;
}

class PreparationProgress {
  constructor(
    private readonly signal: AbortSignal | undefined,
    private readonly callback: ((progress: VolumeSplitPreparationProgress) => void) | undefined,
  ) {}

  check(): void {
    if (!this.signal?.aborted) return;
    const error = new Error('Volume split preparation was cancelled');
    error.name = 'AbortError';
    throw error;
  }

  report(stage: VolumeSplitPreparationStage, completed: number, total: number): void {
    this.check();
    this.callback?.({ stage, completed, total });
    this.check();
  }
}

function buildPinnedFaceNeighbors(mesh: DecodedIndexedMesh, progress: PreparationProgress): number[][] {
  const faceCount = mesh.triangles.length;
  const vertexFaces = Array.from({ length: mesh.vertices.length }, () => [] as number[]);
  const neighbors = Array.from({ length: faceCount }, () => [-1, -1, -1]);
  progress.report('connectivity', 0, faceCount * 2);

  for (const [faceIndex, triangle] of mesh.triangles.entries()) {
    if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[2] === triangle[0]) {
      throw new Error(`Source triangle ${faceIndex} repeats a vertex index`);
    }
    vertexFaces[triangle[0]].push(faceIndex);
    vertexFaces[triangle[1]].push(faceIndex);
    vertexFaces[triangle[2]].push(faceIndex);
    progress.report('connectivity', faceIndex + 1, faceCount * 2);
  }

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const triangle = mesh.triangles[faceIndex];
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      if (neighbors[faceIndex][edgeIndex] !== -1) continue;
      const edgeStart = triangle[edgeIndex];
      const edgeEnd = triangle[(edgeIndex + 1) % 3];
      for (const otherFaceIndex of vertexFaces[edgeStart]) {
        if (otherFaceIndex <= faceIndex) continue;
        const otherTriangle = mesh.triangles[otherFaceIndex];
        const otherEdgeIndex = triangleVertexIndex(otherTriangle, edgeEnd);
        if (otherEdgeIndex < 0 || otherTriangle[(otherEdgeIndex + 1) % 3] !== edgeStart) continue;
        if (neighbors[otherFaceIndex][otherEdgeIndex] !== -1) continue;
        neighbors[faceIndex][edgeIndex] = otherFaceIndex;
        neighbors[otherFaceIndex][otherEdgeIndex] = faceIndex;
        break;
      }
    }
    progress.report('connectivity', faceCount + faceIndex + 1, faceCount * 2);
  }
  return neighbors;
}

function discoverPinnedComponents(
  neighbors: readonly (readonly number[])[],
  progress: PreparationProgress,
): number[][] {
  const visited = new Uint8Array(neighbors.length);
  const components: number[][] = [];
  let visitedCount = 0;
  progress.report('components', 0, neighbors.length);

  for (let seed = 0; seed < neighbors.length; seed += 1) {
    if (visited[seed]) continue;
    const component: number[] = [seed];
    const stack: number[] = [seed];
    visited[seed] = 1;
    visitedCount += 1;
    progress.report('components', visitedCount, neighbors.length);

    while (stack.length > 0) {
      const faceIndex = stack.pop()!;
      for (const neighbor of neighbors[faceIndex]) {
        if (neighbor < 0 || visited[neighbor]) continue;
        component.push(neighbor);
        stack.push(neighbor);
        visited[neighbor] = 1;
        visitedCount += 1;
        progress.report('components', visitedCount, neighbors.length);
      }
    }
    components.push(component);
  }
  return components;
}

function buildComponentGeometry(
  mesh: DecodedIndexedMesh,
  sourceTriangleIndices: readonly number[],
  onTriangle: () => void,
): ComponentGeometry {
  const sourceToPartVertex = new Map<number, number>();
  const vertices: Vec3[] = [];
  const indices: number[] = [];
  for (const sourceTriangleIndex of sourceTriangleIndices) {
    for (const sourceVertexIndex of mesh.triangles[sourceTriangleIndex]) {
      let partVertexIndex = sourceToPartVertex.get(sourceVertexIndex);
      if (partVertexIndex === undefined) {
        partVertexIndex = vertices.length;
        sourceToPartVertex.set(sourceVertexIndex, partVertexIndex);
        vertices.push([...mesh.vertices[sourceVertexIndex]] as Vec3);
      }
      indices.push(partVertexIndex);
    }
    onTriangle();
  }

  if (pinnedSignedVolume(vertices, indices) < 0) {
    for (let index = 0; index < indices.length; index += 3) {
      [indices[index + 1], indices[index + 2]] = [indices[index + 2], indices[index + 1]];
    }
  }

  const center = boundingBoxCenter(vertices);
  const shift: Vec3 = [Math.fround(center[0]), Math.fround(center[1]), Math.fround(center[2])];
  const positions: number[] = [];
  for (const vertex of vertices) {
    positions.push(
      Math.fround(vertex[0] - shift[0]),
      Math.fround(vertex[1] - shift[1]),
      Math.fround(vertex[2] - shift[2]),
    );
  }
  return {
    sourceTriangleIndices: [...sourceTriangleIndices],
    positions,
    indices,
    center,
  };
}

function pinnedSignedVolume(vertices: readonly Vec3[], indices: readonly number[]): number {
  const reference = vertices[0];
  let volume = Math.fround(0);
  for (let index = 0; index < indices.length; index += 3) {
    const first = vertices[indices[index]];
    const second = vertices[indices[index + 1]];
    const third = vertices[indices[index + 2]];
    const ux = Math.fround(second[0] - first[0]);
    const uy = Math.fround(second[1] - first[1]);
    const uz = Math.fround(second[2] - first[2]);
    const vx = Math.fround(third[0] - first[0]);
    const vy = Math.fround(third[1] - first[1]);
    const vz = Math.fround(third[2] - first[2]);
    const cx = Math.fround(Math.fround(uy * vz) - Math.fround(uz * vy));
    const cy = Math.fround(Math.fround(uz * vx) - Math.fround(ux * vz));
    const cz = Math.fround(Math.fround(ux * vy) - Math.fround(uy * vx));
    const norm = Math.fround(Math.hypot(cx, cy, cz));
    if (norm === 0) return Number.NaN;
    const nx = Math.fround(cx / norm);
    const ny = Math.fround(cy / norm);
    const nz = Math.fround(cz / norm);
    const area = Math.fround(0.5 * norm);
    const height = Math.fround(
      Math.fround(nx * Math.fround(first[0] - reference[0])) +
        Math.fround(ny * Math.fround(first[1] - reference[1])) +
        Math.fround(nz * Math.fround(first[2] - reference[2])),
    );
    volume = Math.fround(volume + Math.fround(Math.fround(area * height) / 3));
  }
  return volume;
}

function boundingBoxCenter(vertices: readonly Vec3[]): Vec3 {
  const min: [number, number, number] = [...vertices[0]];
  const max: [number, number, number] = [...vertices[0]];
  for (let index = 1; index < vertices.length; index += 1) {
    const vertex = vertices[index];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function recenteredTransform(source: Transform, center: Vec3): Transform {
  const translationMm: Vec3 = [
    source.translationMm[0] + center[0],
    source.translationMm[1] + center[1],
    source.translationMm[2] + center[2],
  ];
  if (translationMm.some((value) => !Number.isFinite(value))) {
    throw new Error('Recentered split transform is not finite');
  }
  return {
    translationMm,
    rotation: [...source.rotation],
    scale: [...source.scale],
  };
}

function assertSourceTransform(transform: Transform): void {
  if (transform.translationMm.length !== 3 || transform.rotation.length !== 4 || transform.scale.length !== 3) {
    throw new Error('Source split transform has invalid dimensions');
  }
  if (
    [...transform.translationMm, ...transform.rotation, ...transform.scale].some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Source split transform must be finite');
  }
  if (transform.scale.some((value) => Math.abs(value) < 1e-12)) {
    throw new Error('Source split transform scale cannot contain zero');
  }
  const rotationNorm = Math.hypot(...transform.rotation);
  if (!Number.isFinite(rotationNorm) || rotationNorm < 1e-12) {
    throw new Error('Source split transform rotation cannot be zero');
  }
}

function assertPreparedIdentity(identity: VolumeSplitPartIdentity, sourceAssetId: AssetId, partIndex: number): void {
  if (!isStableEntityId(identity.volumeId)) {
    throw new Error(`Prepared split part ${partIndex + 1} volume ID ${identity.volumeId} is not stable`);
  }
  if (!isStableEntityId(identity.assetId)) {
    throw new Error(`Prepared split part ${partIndex + 1} asset ID ${identity.assetId} is not stable`);
  }
  if (identity.assetId === sourceAssetId) {
    throw new Error(`Prepared split part ${partIndex + 1} reuses the immutable source asset ID`);
  }
}

function triangleVertexIndex(triangle: readonly number[], vertex: number): number {
  return triangle[0] === vertex ? 0 : triangle[1] === vertex ? 1 : triangle[2] === vertex ? 2 : -1;
}

function cloneAssetPayload(payload: AssetPayload): AssetPayload {
  return {
    descriptor: cloneJson(payload.descriptor),
    bytes: payload.bytes.slice(),
  };
}

function sameAssetPayload(left: AssetPayload, right: AssetPayload): boolean {
  return (
    canonicalStringify(left.descriptor) === canonicalStringify(right.descriptor) &&
    left.descriptor.digest === right.descriptor.digest &&
    left.bytes.byteLength === right.bytes.byteLength &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}
