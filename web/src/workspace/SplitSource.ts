/**
 * What "Split to Objects" and "Split to Parts" would split, read from the
 * canonical state as the workspace reads it before it splits: the object
 * holding the selected instance, refused in the workspace's words when the
 * split could not keep everything the object carries. The confirmation the
 * workspace shows, the split it commits and the shared Rust core
 * (`orcaxr_project::split::source`, through `SplitSourceExchange.ts`) all
 * read this one definition.
 */
import { facetAnnotationsHaveAssignments } from '../project/domain/facetRefinement';
import type { InstanceId, ObjectId, PlateId, VolumeId } from '../project/domain/ids';
import type { ProjectObject, ProjectState } from '../project/domain/model';
import { findInstance } from '../project/domain/selectors';

const CORE_FACET_ATTRIBUTES_KEY = 'https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes';

/** Which split reads the source: separate objects, or parts of the same object. */
export type SplitSourceTarget = 'objects' | 'parts';

/** The object a split replaces, as the workspace's confirmation describes it. */
export interface SplitSource {
  readonly plateId: PlateId;
  readonly objectId: ObjectId;
  readonly objectName: string;
  /** Promote the object's existing volumes, or separate one volume by connected body. */
  readonly strategy: 'existing-volumes' | 'connected-components';
  readonly volumeIds: readonly VolumeId[];
  /** Every volume's triangles. */
  readonly triangleCount: number;
  /** Every placement the split replaces, in the object's order. */
  readonly instanceIds: readonly InstanceId[];
}

export class CanonicalSplitToObjectsTriangleLimitError extends Error {
  constructor(
    readonly triangleCount: number,
    readonly limit: number,
  ) {
    super(
      `Split to Objects is limited to ${limit.toLocaleString('en-US')} triangles while connected-component analysis remains synchronous; this model has ${triangleCount.toLocaleString('en-US')}`,
    );
    this.name = 'CanonicalSplitToObjectsTriangleLimitError';
  }
}

/**
 * The workspace's refusals before either split, in its order: an object it
 * would have to drop data from, or a single volume whose connected bodies are
 * analysed synchronously beyond [synchronousTriangleLimit].
 */
export function assertSplitToObjectsSource(object: ProjectObject, synchronousTriangleLimit: number): void {
  if (object.volumes.length === 0) throw new Error('Split to Objects requires at least one model volume');
  if (object.volumes.some((volume) => volume.role !== 'model')) {
    throw new Error('Split to Objects cannot discard modifier, negative, support-enforcer, or support-blocker volumes');
  }
  if (object.volumes.some((volume) => volume.source.triangleCount < 3)) {
    throw new Error('Split to Objects cannot preserve volumes or connected components below three facets');
  }
  if (object.layerRanges.length > 0) {
    throw new Error('Split to Objects requires an explicit layer-range distribution before promotion');
  }
  if (object.extensionData && Object.keys(object.extensionData).length > 0) {
    throw new Error('Split to Objects requires an explicit object-extension distribution before promotion');
  }
  if (object.volumes.length !== 1) return;

  const volume = object.volumes[0];
  if (volume.source.triangleCount > synchronousTriangleLimit) {
    throw new CanonicalSplitToObjectsTriangleLimitError(volume.source.triangleCount, synchronousTriangleLimit);
  }
  if (facetAnnotationsHaveAssignments(volume.annotations)) {
    throw new Error(
      'Split to Objects cannot yet remap painted facet annotations onto connected components; clear or preserve them explicitly first',
    );
  }
  if (Object.prototype.hasOwnProperty.call(volume.extensionData ?? {}, CORE_FACET_ATTRIBUTES_KEY)) {
    throw new Error(
      'Split to Objects cannot preserve opaque triangle-indexed 3MF extension metadata without an explicit facet map',
    );
  }
}

/**
 * The object instance [instanceId] places, as [target] would split it, or
 * the workspace's refusal (thrown): an instance the project no longer has,
 * an object the split would lose data from, and — splitting to parts — an
 * object that already has several.
 */
export function splitSourceOf(
  state: ProjectState,
  instanceId: InstanceId,
  target: SplitSourceTarget,
  synchronousTriangleLimit: number,
): SplitSource {
  const found = findInstance(state, instanceId);
  if (!found) {
    throw new Error(
      target === 'objects'
        ? `Selected instance ${instanceId} is no longer in the canonical project`
        : `Selected instance ${instanceId} not found`,
    );
  }
  const { plate, object } = found;
  assertSplitToObjectsSource(object, synchronousTriangleLimit);
  if (target === 'parts' && object.volumes.length !== 1) {
    throw new Error(`Object "${object.name}" already has ${object.volumes.length} parts`);
  }
  return {
    plateId: plate.id,
    objectId: object.id,
    objectName: object.name,
    strategy: object.volumes.length > 1 ? 'existing-volumes' : 'connected-components',
    volumeIds: object.volumes.map((volume) => volume.id),
    triangleCount: object.volumes.reduce((total, volume) => total + volume.source.triangleCount, 0),
    instanceIds: object.instances.map((instance) => instance.id),
  };
}
