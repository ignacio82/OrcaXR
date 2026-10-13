import type { AssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { InstanceId, VolumeId } from '../domain/ids';
import type { ProjectState, Transform, Vec3 } from '../domain/model';
import { findInstance, findPlate, findVolume } from '../domain/selectors';
import { decodeIndexedMeshAsset, type DecodedIndexedMesh } from '../meshCodec';
import { writeDeterministicZip } from '../serialization/deterministicZip';

export interface CanonicalBinaryStlExport {
  readonly bytes: Uint8Array;
  readonly triangleCount: number;
  readonly instanceCount: number;
  readonly volumeIds: readonly VolumeId[];
}

interface PreparedVolume {
  readonly volumeId: VolumeId;
  readonly mesh: DecodedIndexedMesh;
  readonly volumeTransform: Transform;
  readonly instanceTransform: Transform;
  readonly reverseWinding: boolean;
}

/** An exported model file: its bytes and what the File menu reports of it. */
export interface CanonicalStlFile {
  readonly bytes: Uint8Array;
  readonly mediaType: 'model/stl' | 'application/zip';
  readonly suggestedFilename: string;
  readonly triangleCount: number;
  readonly instanceCount: number;
}

/**
 * The selected instances on the active plate, in selection order: what both
 * File → Export as one STL… and Export all objects as STLs… take before
 * falling back to the whole plate.
 */
export function selectedActivePlateInstanceIds(
  state: ProjectState,
  selectedInstanceIds: readonly InstanceId[],
): InstanceId[] {
  return selectedInstanceIds.filter((id) => findInstance(state, id)?.plate.id === state.activePlateId);
}

/** Every instance on the active plate, in plate order (the workspace's model order). */
export function activePlateInstanceIds(state: ProjectState): InstanceId[] {
  return findPlate(state, state.activePlateId)?.objects.flatMap((object) => object.instances.map((i) => i.id)) ?? [];
}

/** File → Export as one STL…: the selected instances on the active plate, else every one on it. */
export function stlExportInstanceIds(state: ProjectState, selectedInstanceIds: readonly InstanceId[]): InstanceId[] {
  const selected = selectedActivePlateInstanceIds(state, selectedInstanceIds);
  return selected.length > 0 ? selected : activePlateInstanceIds(state);
}

/** The file name a merged STL is offered under: the instance's (or object's) name for one, else the project's. */
export function suggestedStlFilename(name: string): string {
  const withoutControls = [...name].map((character) => (character.codePointAt(0)! <= 0x1f ? '-' : character)).join('');
  const stem = withoutControls
    .normalize('NFKC')
    .replace(/\.stl$/i, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return `${stem || 'OrcaXR-model'}.stl`;
}

/** File → Export as one STL…: [instanceIds] merged into one binary STL. */
export function exportCanonicalStlFile(
  state: ProjectState,
  assets: AssetRepository,
  instanceIds: readonly InstanceId[],
): CanonicalStlFile {
  const exported = exportCanonicalInstancesAsBinaryStl(state, assets, instanceIds);
  const single = instanceIds.length === 1 ? findInstance(state, instanceIds[0]) : undefined;
  return Object.freeze({
    bytes: exported.bytes,
    mediaType: 'model/stl',
    suggestedFilename: suggestedStlFilename(single?.instance.name ?? single?.object.name ?? state.name),
    triangleCount: exported.triangleCount,
    instanceCount: exported.instanceCount,
  });
}

/** A ZIP member's stem for an instance or project name: runs of other characters become `_`, none at either end. */
function archiveStem(name: string, fallback: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

/**
 * File → Export all objects as STLs…: one binary STL per instance — [instanceIds],
 * or every instance on the active plate — in a deterministic ZIP whose member
 * names are the instances' (or objects') names, a repeated one numbered from 2;
 * a single instance is its own STL instead.
 */
export function exportCanonicalStlArchive(
  state: ProjectState,
  assets: AssetRepository,
  instanceIds?: readonly InstanceId[],
): CanonicalStlFile {
  const ids = instanceIds && instanceIds.length > 0 ? instanceIds : activePlateInstanceIds(state);
  if (ids.length === 0) throw new Error('No models to export');
  if (ids.length === 1) return exportCanonicalStlFile(state, assets, ids);
  const files = new Map<string, Uint8Array>();
  const usedNames = new Set<string>();
  let totalTriangles = 0;
  for (const id of ids) {
    const found = findInstance(state, id);
    if (!found) continue;
    const baseName = archiveStem(found.instance.name || found.object.name || 'model', 'model');
    let filename = `${baseName}.stl`;
    let counter = 2;
    while (usedNames.has(filename.toLowerCase())) {
      filename = `${baseName}_${counter}.stl`;
      counter += 1;
    }
    usedNames.add(filename.toLowerCase());
    const exported = exportCanonicalInstancesAsBinaryStl(state, assets, [id]);
    totalTriangles += exported.triangleCount;
    files.set(filename, exported.bytes);
  }
  return Object.freeze({
    bytes: writeDeterministicZip(files),
    mediaType: 'application/zip',
    suggestedFilename: `${archiveStem(state.name || 'models', 'models')}_stls.zip`,
    triangleCount: totalTriangles,
    instanceCount: ids.length,
  });
}

/** What the status line says after Export as one STL… (`toLocaleString` grouping, the runtime's locale). */
export function stlExportedStatus(instanceCount: number, triangleCount: number): string {
  return `Exported ${instanceCount} model${instanceCount === 1 ? '' : 's'} as ${triangleCount.toLocaleString()} STL triangle${triangleCount === 1 ? '' : 's'}.`;
}

/**
 * Merge an exact stable-ID instance set into one binary STL.
 *
 * Only positive model parts are emitted. Parameter/support modifiers do not
 * describe printable surface geometry, while negative volumes require the
 * pinned CSG operation and therefore fail closed instead of exporting a
 * plausible but semantically wrong positive-only mesh.
 */
export function exportCanonicalInstancesAsBinaryStl(
  state: ProjectState,
  assets: AssetRepository,
  instanceIds: readonly InstanceId[],
): CanonicalBinaryStlExport {
  if (instanceIds.length === 0) throw new Error('STL export requires at least one instance');
  const seenInstances = new Set<InstanceId>();
  const descriptors = new Map(state.sourceAssets.map((descriptor) => [descriptor.id, descriptor]));
  const decodedByAsset = new Map<string, DecodedIndexedMesh>();
  const prepared: PreparedVolume[] = [];
  let triangleCount = 0;

  for (const instanceId of instanceIds) {
    if (seenInstances.has(instanceId)) throw new Error(`STL export contains duplicate instance ${instanceId}`);
    seenInstances.add(instanceId);
    const found = findInstance(state, instanceId);
    if (!found) throw new Error(`Unknown instance ${instanceId}`);

    for (const volume of found.object.volumes) {
      if (volume.role === 'negative-volume') {
        throw new Error(`Volume ${volume.id} requires canonical CSG before STL export`);
      }
      if (volume.role !== 'model') continue;
      const descriptor = descriptors.get(volume.source.assetId);
      const payload = assets.get(volume.source.assetId);
      if (!descriptor || !payload) {
        throw new Error(`Volume ${volume.id} references missing asset ${volume.source.assetId}`);
      }
      if (canonicalStringify(descriptor) !== canonicalStringify(payload.descriptor)) {
        throw new Error(`Asset repository metadata differs for ${volume.source.assetId}`);
      }
      let mesh = decodedByAsset.get(volume.source.assetId);
      if (!mesh) {
        mesh = decodeIndexedMeshAsset(payload);
        decodedByAsset.set(volume.source.assetId, mesh);
      }
      if (mesh.triangles.length !== volume.source.triangleCount) {
        throw new Error(`Volume ${volume.id} triangle count differs from its canonical mesh`);
      }
      triangleCount += mesh.triangles.length;
      if (!Number.isSafeInteger(triangleCount) || triangleCount > 0xffff_ffff) {
        throw new Error('Binary STL triangle count exceeds the format limit');
      }
      prepared.push({
        volumeId: volume.id,
        mesh,
        volumeTransform: volume.transform,
        instanceTransform: found.instance.transform,
        reverseWinding: transformHandedness(volume.transform) * transformHandedness(found.instance.transform) < 0,
      });
    }
  }

  if (triangleCount === 0) throw new Error('Selected instances contain no positive model triangles');
  const byteLength = 84 + triangleCount * 50;
  if (!Number.isSafeInteger(byteLength)) throw new Error('Binary STL output is too large');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(byteLength);
  } catch {
    throw new Error('Binary STL output cannot fit in browser memory');
  }
  const header = new TextEncoder().encode('OrcaXR canonical binary STL');
  bytes.set(header.subarray(0, 80));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(80, triangleCount, true);

  let offset = 84;
  for (const volume of prepared) {
    for (const triangle of volume.mesh.triangles) {
      const first = transformedVertex(volume.mesh.vertices[triangle[0]], volume);
      const secondIndex = volume.reverseWinding ? triangle[2] : triangle[1];
      const thirdIndex = volume.reverseWinding ? triangle[1] : triangle[2];
      const second = transformedVertex(volume.mesh.vertices[secondIndex], volume);
      const third = transformedVertex(volume.mesh.vertices[thirdIndex], volume);
      const normal = triangleNormal(first, second, third);
      offset = writeVector(view, offset, normal);
      offset = writeVector(view, offset, first);
      offset = writeVector(view, offset, second);
      offset = writeVector(view, offset, third);
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }

  return Object.freeze({
    bytes,
    triangleCount,
    instanceCount: instanceIds.length,
    volumeIds: Object.freeze(prepared.map((volume) => volume.volumeId)),
  });
}

function transformedVertex(vertex: Vec3, volume: PreparedVolume): Vec3 {
  return applyTransform(applyTransform(vertex, volume.volumeTransform), volume.instanceTransform);
}

function applyTransform(point: Vec3, transform: Transform): Vec3 {
  const scaled: Vec3 = [point[0] * transform.scale[0], point[1] * transform.scale[1], point[2] * transform.scale[2]];
  const rotated = rotateVector(transform.rotation, scaled);
  return [
    rotated[0] + transform.translationMm[0],
    rotated[1] + transform.translationMm[1],
    rotated[2] + transform.translationMm[2],
  ];
}

function transformHandedness(transform: Transform): -1 | 1 {
  return transform.scale[0] * transform.scale[1] * transform.scale[2] < 0 ? -1 : 1;
}

function rotateVector(quaternion: readonly [number, number, number, number], vector: Vec3): Vec3 {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (!Number.isFinite(length) || length === 0) throw new Error('A canonical transform quaternion must be non-zero');
  const x = quaternion[0] / length;
  const y = quaternion[1] / length;
  const z = quaternion[2] / length;
  const w = quaternion[3] / length;
  const uv: Vec3 = [y * vector[2] - z * vector[1], z * vector[0] - x * vector[2], x * vector[1] - y * vector[0]];
  const uuv: Vec3 = [y * uv[2] - z * uv[1], z * uv[0] - x * uv[2], x * uv[1] - y * uv[0]];
  return [
    vector[0] + 2 * (w * uv[0] + uuv[0]),
    vector[1] + 2 * (w * uv[1] + uuv[1]),
    vector[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}

function triangleNormal(first: Vec3, second: Vec3, third: Vec3): Vec3 {
  const left: Vec3 = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const right: Vec3 = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
  const normal: Vec3 = [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const length = Math.hypot(...normal);
  if (length === 0) return [0, 0, 0];
  const x = normal[0] / length;
  const y = normal[1] / length;
  const z = normal[2] / length;
  return [x === 0 ? 0 : x, y === 0 ? 0 : y, z === 0 ? 0 : z];
}

function writeVector(view: DataView, offset: number, vector: Vec3): number {
  view.setFloat32(offset, vector[0], true);
  view.setFloat32(offset + 4, vector[1], true);
  view.setFloat32(offset + 8, vector[2], true);
  return offset + 12;
}

/**
 * Export a single canonical volume's mesh as a binary STL byte array in its local space.
 */
export function exportCanonicalVolumeAsBinaryStl(
  state: ProjectState,
  assets: AssetRepository,
  volumeId: VolumeId,
): Uint8Array {
  const found = findVolume(state, volumeId);
  if (!found) throw new Error(`Unknown volume ${volumeId}`);
  const payload = assets.get(found.volume.source.assetId);
  if (!payload) throw new Error(`Volume ${volumeId} references missing asset ${found.volume.source.assetId}`);
  const mesh = decodeIndexedMeshAsset(payload);
  const triangleCount = mesh.triangles.length;
  if (triangleCount === 0) throw new Error('Volume contains no triangles');
  const byteLength = 84 + triangleCount * 50;
  const bytes = new Uint8Array(byteLength);
  const header = new TextEncoder().encode('OrcaXR canonical binary STL');
  bytes.set(header.subarray(0, 80));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(80, triangleCount, true);
  let offset = 84;
  for (const triangle of mesh.triangles) {
    const first = mesh.vertices[triangle[0]];
    const second = mesh.vertices[triangle[1]];
    const third = mesh.vertices[triangle[2]];
    const normal = triangleNormal(first, second, third);
    offset = writeVector(view, offset, normal);
    offset = writeVector(view, offset, first);
    offset = writeVector(view, offset, second);
    offset = writeVector(view, offset, third);
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return bytes;
}
