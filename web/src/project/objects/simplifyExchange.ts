/**
 * Mesh simplification over a live session, in the shared contract's
 * encoding: the workspace's Simplify prepared from an acknowledged state and
 * its assets, then staged under a host-drawn asset ID.
 *
 * A preparation decimates one volume's mesh (`simplify.ts`) and reports its
 * before and after counts, the largest error it accepted and the encoded
 * result's digest; the mesh it previews is the very payload staging installs.
 * A run that removes nothing is unchanged, not refused; a volume the workspace
 * cannot simplify refuses with a code and the browser's own message. The Rust
 * session prepares and stages the same decimations
 * (`orcaxr_project::simplify`).
 */
import type {
  ProjectVolumeSimplifyPreviewWire,
  ProjectVolumeSimplifyRefusalCodeWire,
  ProjectVolumeSimplifyReplyWire,
  ProjectVolumeSimplifyRequestWire,
  ProjectVolumeSimplifyStageWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetPayload, AssetRepository } from '../assets';
import { isStableEntityId, type AssetId, type VolumeId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { findVolume } from '../domain/selectors';
import { decodeIndexedMeshAsset, encodeIndexedMeshAsset } from '../meshCodec';
import {
  StagedInputError,
  captureReplaceVolumeMeshCommand,
  singleStagedWork,
  type StagedInputLimits,
  type StagedProjectWork,
} from '../StagedProjectCommands';
import {
  SimplifyError,
  simplifyMesh,
  type SimplifyConfiguration,
  type SimplifyOptions,
  type SimplifyResult,
} from './simplify';
import type { MeshTopologyReplacementGuard } from './topologyCommands';

/** Why a volume cannot be simplified; the message is the workspace's own. */
export class VolumeSimplifyRefusal extends Error {
  constructor(
    message: string,
    readonly code: ProjectVolumeSimplifyRefusalCodeWire,
  ) {
    super(message);
    this.name = 'VolumeSimplifyRefusal';
  }
}

/** One volume's decimation, encoded but not yet named. */
export class PreparedVolumeSimplify {
  constructor(
    readonly volumeId: VolumeId,
    /** The source mesh as the replacement will check it. */
    readonly guard: MeshTopologyReplacementGuard,
    readonly result: SimplifyResult,
    /** The result encoded under the source's asset ID. */
    readonly preview: AssetPayload,
  ) {}

  summary(): ProjectVolumeSimplifyPreviewWire {
    const { result, preview } = this;
    return {
      beforeTriangles: result.sourceTriangleCount,
      afterTriangles: result.triangles.length,
      vertexCount: result.vertices.length,
      maxError: Number.isFinite(result.maxAppliedError) ? { value: result.maxAppliedError } : { absent: {} },
      stoppedOnError: result.stoppedOnError,
      digest: wireUnits(preview.descriptor.digest),
      byteLength: preview.descriptor.byteLength,
    };
  }

  /** The previewed payload under its own asset ID. */
  asset(assetId: AssetId): AssetPayload {
    return { descriptor: { ...this.preview.descriptor, id: assetId }, bytes: this.preview.bytes.slice() };
  }

  /** The replacement as one staged work. */
  work(assetId: AssetId, limits: StagedInputLimits): StagedProjectWork {
    if (!isStableEntityId(assetId)) throw new StagedInputError('invalid');
    return singleStagedWork(captureReplaceVolumeMeshCommand(this.guard, this.asset(assetId), limits));
  }
}

export type VolumeSimplifyPreparation =
  | { readonly kind: 'unchanged'; readonly triangleCount: number }
  | { readonly kind: 'prepared'; readonly simplify: PreparedVolumeSimplify };

const KERNEL_CODES: Readonly<Record<SimplifyError['code'], ProjectVolumeSimplifyRefusalCodeWire | undefined>> = {
  'degenerate-mesh': 'degenerateMesh',
  'invalid-configuration': 'invalidConfiguration',
  // A cancelled run is the caller's, not a refusal.
  cancelled: undefined,
};

/**
 * Decimate one volume's mesh from a state and its assets, with the
 * workspace's checks in its order. Throws `VolumeSimplifyRefusal`; a
 * cancelled run throws its `SimplifyError`.
 */
export function prepareVolumeSimplify(
  state: ProjectState,
  assets: AssetRepository,
  volumeId: VolumeId,
  configuration: SimplifyConfiguration,
  options: SimplifyOptions = {},
): VolumeSimplifyPreparation {
  const found = findVolume(state, volumeId);
  if (!found) throw new VolumeSimplifyRefusal(`Unknown volume ${volumeId}`, 'unknownVolume');
  const payload = assets.get(found.volume.source.assetId);
  if (!payload) throw new VolumeSimplifyRefusal(`Volume ${volumeId} has no stored mesh asset`, 'missingAsset');
  const guard: MeshTopologyReplacementGuard = {
    volumeId,
    assetId: found.volume.source.assetId,
    assetDigest: payload.descriptor.digest,
    topologyRevision: found.volume.source.topologyRevision,
    triangleCount: found.volume.source.triangleCount,
  };
  let decoded;
  try {
    decoded = decodeIndexedMeshAsset(payload);
  } catch (error) {
    throw new VolumeSimplifyRefusal((error as Error).message, 'invalidMesh');
  }
  let result: SimplifyResult;
  try {
    result = simplifyMesh({ vertices: decoded.vertices, triangles: decoded.triangles }, configuration, options);
  } catch (error) {
    const code = error instanceof SimplifyError ? KERNEL_CODES[error.code] : undefined;
    if (code === undefined) throw error;
    throw new VolumeSimplifyRefusal((error as Error).message, code);
  }
  if (result.triangles.length >= result.sourceTriangleCount) {
    return { kind: 'unchanged', triangleCount: result.sourceTriangleCount };
  }
  const positions: number[] = [];
  for (const vertex of result.vertices) positions.push(vertex[0], vertex[1], vertex[2]);
  const indices: number[] = [];
  for (const triangle of result.triangles) indices.push(triangle[0], triangle[1], triangle[2]);
  let preview: AssetPayload;
  try {
    preview = encodeIndexedMeshAsset({
      id: payload.descriptor.id,
      positions,
      indices,
      ...(payload.descriptor.sourceFilename ? { sourceFilename: payload.descriptor.sourceFilename } : {}),
    });
  } catch (error) {
    // A collapse placed a vertex past float32 range.
    throw new VolumeSimplifyRefusal((error as Error).message, 'invalidMesh');
  }
  return { kind: 'prepared', simplify: new PreparedVolumeSimplify(volumeId, guard, result, preview) };
}

/** `VolumeSimplifyRequest` → `VolumeSimplifyReply`, with the prepared run. */
export function prepareVolumeSimplifyWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectVolumeSimplifyRequestWire,
): { reply: ProjectVolumeSimplifyReplyWire; simplify?: PreparedVolumeSimplify } {
  let prepared;
  try {
    prepared = prepareVolumeSimplify(state, assets, wireText(request.volumeId) as VolumeId, {
      useCount: request.useCount,
      decimateRatio: request.decimateRatio,
      maxError: request.maxError,
    });
  } catch (error) {
    if (!(error instanceof VolumeSimplifyRefusal)) throw error;
    return { reply: { refused: { code: error.code, message: wireUnits(error.message) } } };
  }
  if (prepared.kind === 'unchanged') return { reply: { unchanged: { triangleCount: prepared.triangleCount } } };
  return { reply: { prepared: prepared.simplify.summary() }, simplify: prepared.simplify };
}

/** A `VolumeSimplifyStage` as staged work. Throws `StagedInputError`. */
export function stageVolumeSimplifyWire(
  simplify: PreparedVolumeSimplify,
  request: ProjectVolumeSimplifyStageWire,
  limits: StagedInputLimits,
): StagedProjectWork {
  return simplify.work(wireText(request.assetId) as AssetId, limits);
}
