/**
 * Split preparation over a live session, in the shared contract's encoding:
 * the workspace's "Split to Parts" and "Split to Objects" prepared from an
 * acknowledged state and its assets, then staged under host-drawn IDs.
 *
 * A preparation reports each connected component in the pinned order (its
 * counts, its distinct geometry and its recentred transform) and each
 * distinct geometry's digest; a source the workspace cannot split reports a
 * code and the browser's own message. Staging names the parts (one asset ID
 * per distinct geometry, drawn as it first appears), reuses any project asset
 * that already holds a part's exact bytes, and captures the split as one
 * staged work: parts of the same object or, with object identities, separate
 * objects. The Rust session prepares and stages the same splits
 * (`orcaxr_project::split`).
 */
import type {
  ProjectVolumeSplitPreviewWire,
  ProjectVolumeSplitRefusalCodeWire,
  ProjectVolumeSplitReplyWire,
  ProjectVolumeSplitRequestWire,
  ProjectVolumeSplitStageWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetPayload, AssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { AssetId, InstanceId, ObjectId, VolumeId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { findVolume } from '../domain/selectors';
import {
  StagedInputError,
  captureSplitVolumeToPartsCommand,
  singleStagedWork,
  splitToObjectsStagedWork,
  type StagedInputLimits,
  type StagedProjectWork,
} from '../StagedProjectCommands';
import { captureVolumeSplitGuard, type PreparedVolumeSplitPart, type VolumeSplitGuard } from './splitCommands';
import {
  VolumeSplitPreparationError,
  assignVolumeSplitIdentities,
  prepareVolumeSplitComponents,
  type PreparedVolumeSplitComponent,
  type VolumeSplitPreparationErrorCode,
} from './splitPreparation';
import type { SeparatedObjectIdentity } from './splitToObjectsCommands';

/** Why a volume cannot be split; the message is the workspace's own. */
export class VolumeSplitRefusal extends Error {
  constructor(
    message: string,
    readonly code: ProjectVolumeSplitRefusalCodeWire,
  ) {
    super(message);
    this.name = 'VolumeSplitRefusal';
  }
}

const KERNEL_CODES: Readonly<Record<VolumeSplitPreparationErrorCode, ProjectVolumeSplitRefusalCodeWire | undefined>> = {
  'invalid-source': 'invalidSource',
  'invalid-mesh': 'invalidMesh',
  'invalid-transform': 'invalidTransform',
  'not-splittable': 'notSplittable',
  // Preparation draws no ID; naming errors surface only when staging.
  'invalid-identity': undefined,
};

/** One volume's split, prepared but not yet named. */
export class PreparedVolumeSplit {
  /** The distinct geometry each part is, numbered as each first appears. */
  readonly partGeometries: readonly number[];
  /** Each distinct geometry's first part. */
  private readonly firstParts: readonly number[];

  constructor(
    /** The source volume as the commit will check it. */
    readonly guard: VolumeSplitGuard,
    private readonly components: readonly PreparedVolumeSplitComponent[],
  ) {
    const byDigest = new Map<string, number>();
    const firstParts: number[] = [];
    this.partGeometries = components.map((component, index) => {
      const digest = component.preview.descriptor.digest;
      let geometry = byDigest.get(digest);
      if (geometry === undefined) {
        geometry = firstParts.length;
        byDigest.set(digest, geometry);
        firstParts.push(index);
      }
      return geometry;
    });
    this.firstParts = firstParts;
  }

  get partCount(): number {
    return this.components.length;
  }

  get geometryCount(): number {
    return this.firstParts.length;
  }

  preview(): ProjectVolumeSplitPreviewWire {
    return {
      parts: this.components.map((component, index) => ({
        triangleCount: component.sourceTriangleIndices.length,
        vertexCount: component.preview.descriptor.mesh!.positions.count,
        geometry: this.partGeometries[index],
        transform: {
          translationMm: [...component.transform.translationMm],
          rotation: [...component.transform.rotation],
          scale: [...component.transform.scale],
        },
      })),
      geometries: this.firstParts.map((index) => {
        const { descriptor } = this.components[index].preview;
        return { digest: wireUnits(descriptor.digest), byteLength: descriptor.byteLength };
      }),
    };
  }

  /**
   * Name the parts: `volumeIds` one per part, `assetIds` one per distinct
   * geometry. A part whose exact bytes a project asset (other than the source)
   * already holds takes that asset instead of a new one, as the commit would
   * otherwise refuse the duplicate digest. Bad names throw
   * `VolumeSplitPreparationError` (`invalid-identity`).
   */
  parts(
    state: ProjectState,
    assets: AssetRepository,
    volumeIds: readonly VolumeId[],
    assetIds: readonly AssetId[],
  ): PreparedVolumeSplitPart[] {
    if (volumeIds.length !== this.partCount || assetIds.length !== this.geometryCount) {
      throw new VolumeSplitPreparationError(
        `A split into ${this.partCount} parts of ${this.geometryCount} geometries was named with ${volumeIds.length} volume and ${assetIds.length} asset IDs`,
        'invalid-identity',
      );
    }
    const named = assignVolumeSplitIdentities(this.components, this.guard.assetId, ({ partIndex }) => ({
      volumeId: volumeIds[partIndex],
      assetId: assetIds[this.partGeometries[partIndex]],
    }));
    const reusable = new Map<string, AssetPayload>();
    for (const descriptor of state.sourceAssets) {
      if (descriptor.id === this.guard.assetId || reusable.has(descriptor.digest)) continue;
      const payload = assets.get(descriptor.id);
      if (payload && canonicalStringify(payload.descriptor) === canonicalStringify(descriptor)) {
        reusable.set(descriptor.digest, payload);
      }
    }
    return named.map((part) => {
      const existing = reusable.get(part.asset.descriptor.digest);
      return existing ? { ...part, asset: existing } : part;
    });
  }

  /** The named parts as one staged work: parts of the source's object, or
   * with `objects`, one object per part. */
  work(
    parts: readonly PreparedVolumeSplitPart[],
    objects: readonly SeparatedObjectIdentity[] | undefined,
    limits: StagedInputLimits,
  ): StagedProjectWork {
    return objects === undefined
      ? singleStagedWork(captureSplitVolumeToPartsCommand(this.guard, parts, limits))
      : splitToObjectsStagedWork(this.guard, parts, objects, limits);
  }
}

/**
 * Prepare a volume's split from a state and its assets, with the workspace's
 * source checks in its order. Throws `VolumeSplitRefusal`.
 */
export function prepareVolumeSplit(
  state: ProjectState,
  assets: AssetRepository,
  volumeId: VolumeId,
): PreparedVolumeSplit {
  const found = findVolume(state, volumeId);
  if (!found) throw new VolumeSplitRefusal(`Unknown volume ${volumeId}`, 'unknownVolume');
  const source = found.volume.source.assetId;
  const descriptors = state.sourceAssets.filter((descriptor) => descriptor.id === source);
  if (descriptors.length !== 1) {
    throw new VolumeSplitRefusal(`Split source asset ${source} is not declared exactly once`, 'assetMetadata');
  }
  const sourceAsset = assets.get(source);
  if (!sourceAsset) throw new VolumeSplitRefusal(`Split source asset ${source} is missing`, 'missingAsset');
  if (canonicalStringify(sourceAsset.descriptor) !== canonicalStringify(descriptors[0])) {
    throw new VolumeSplitRefusal(`Split source asset ${source} differs from its canonical descriptor`, 'assetMetadata');
  }
  const guard = captureVolumeSplitGuard(state, volumeId);
  let components;
  try {
    components = prepareVolumeSplitComponents({ sourceAsset, sourceTransform: found.volume.transform });
  } catch (error) {
    const code = error instanceof VolumeSplitPreparationError ? KERNEL_CODES[error.code] : undefined;
    if (code === undefined) throw error;
    throw new VolumeSplitRefusal((error as Error).message, code);
  }
  return new PreparedVolumeSplit(guard, components);
}

/** `VolumeSplitRequest` → `VolumeSplitReply`, with the prepared split. */
export function prepareVolumeSplitWire(
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectVolumeSplitRequestWire,
): { reply: ProjectVolumeSplitReplyWire; split?: PreparedVolumeSplit } {
  try {
    const split = prepareVolumeSplit(state, assets, wireText(request.volumeId) as VolumeId);
    return { reply: { prepared: split.preview() }, split };
  } catch (error) {
    if (!(error instanceof VolumeSplitRefusal)) throw error;
    return { reply: { refused: { code: error.code, message: wireUnits(error.message) } } };
  }
}

/**
 * A `VolumeSplitStage` as staged work over the state the split was prepared
 * from. Bad names refuse `StagedInputError('invalid')`; an input over its
 * budget, `StagedInputError('limit')`.
 */
export function stageVolumeSplitWire(
  split: PreparedVolumeSplit,
  state: ProjectState,
  assets: AssetRepository,
  request: ProjectVolumeSplitStageWire,
  limits: StagedInputLimits,
): StagedProjectWork {
  let parts;
  try {
    parts = split.parts(
      state,
      assets,
      request.volumeIds.map((id) => wireText(id) as VolumeId),
      request.assetIds.map((id) => wireText(id) as AssetId),
    );
  } catch (error) {
    if (error instanceof VolumeSplitPreparationError) throw new StagedInputError('invalid');
    throw error;
  }
  const objects =
    'value' in request.objects
      ? request.objects.value.map((identity) => ({
          sourceVolumeId: wireText(identity.sourceVolumeId) as VolumeId,
          objectId: wireText(identity.objectId) as ObjectId,
          instanceIds: identity.instanceIds.map((id) => wireText(id) as InstanceId),
        }))
      : undefined;
  return split.work(parts, objects, limits);
}
