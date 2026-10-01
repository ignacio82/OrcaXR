import type { AssetPayload, AssetRepositoryInternalSnapshot, AssetRepositorySnapshot } from '../assets';
import { canonicalStringify, cloneProjectState } from '../domain/canonical';
import type { ProjectState } from '../domain/model';
import type { CommandContext, ProjectCommand } from '../history/command';

function cloneAssets(assets: readonly AssetPayload[]): AssetRepositorySnapshot {
  return {
    entries: assets.map((asset) => ({
      descriptor: structuredDescriptorClone(asset.descriptor),
      bytes: asset.bytes.slice(),
    })),
  };
}

/**
 * One history entry owns the project and asset replacement. CommandBus wraps
 * apply/revert in its project/assets/selection rollback boundary.
 */
export class ImportProjectCommand implements ProjectCommand {
  readonly type = 'import-project';
  readonly dirtyCategories = ['projectData'] as const;
  private readonly nextState: ProjectState;
  private nextAssets?: AssetRepositorySnapshot;
  private nextAssetVersion?: AssetRepositoryInternalSnapshot;
  private readonly nextAssetBytes: number;
  private previousState?: ProjectState;
  private previousAssets?: AssetRepositoryInternalSnapshot;

  constructor(
    state: ProjectState,
    assets: readonly AssetPayload[],
    readonly label: string,
  ) {
    this.nextState = cloneProjectState(state);
    this.nextAssets = cloneAssets(assets);
    this.nextAssetBytes = assets.reduce((total, asset) => total + asset.bytes.byteLength, 0);
  }

  apply(context: CommandContext): void {
    this.previousState = context.project.getSnapshot().state;
    this.previousAssets = context.assets.captureInternal();
    if (this.nextAssetVersion) context.assets.restoreInternal(this.nextAssetVersion);
    else {
      // The first import always crosses the validating serialized boundary.
      context.assets.restore(this.nextAssets!);
      this.nextAssetVersion = context.assets.captureInternal();
      this.nextAssets = undefined;
    }
    context.project.replaceState(this.nextState, {
      reason: this.type,
      dirtyCategories: this.dirtyCategories,
    });
    context.selection.clear();
  }

  revert(context: CommandContext): void {
    if (!this.previousState || !this.previousAssets) {
      throw new Error('ImportProjectCommand has not been applied');
    }
    context.assets.restoreInternal(this.previousAssets);
    context.project.replaceState(this.previousState, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    const projectBytes = canonicalStringify(this.nextState).length;
    const previousBytes = this.previousState?.sourceAssets.reduce((total, asset) => total + asset.byteLength, 0) ?? 0;
    return Math.max(1, projectBytes + this.nextAssetBytes + previousBytes);
  }
}

function structuredDescriptorClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(structuredDescriptorClone) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, structuredDescriptorClone(child)])) as T;
}
