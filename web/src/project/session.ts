import {
  InMemoryAssetRepository,
  assetBundleFingerprint,
  type AssetRepository,
  type AssetRepositorySnapshot,
} from './assets';
import { canonicalStringify } from './domain/canonical';
import type { PlateId } from './domain/ids';
import type { ProjectState } from './domain/model';
import { findPlate } from './domain/selectors';
import { assertValidProjectState } from './domain/validation';
import { CommandBus, type CommandBusOptions } from './history/commandBus';
import type { ProjectCommand } from './history/command';
import type {
  CancellationToken,
  EditorSurfacePort,
  ProjectProjectionFailure,
  ProjectProjectionHealthSnapshot,
  ProjectProjectionHealthSubscriber,
  ProjectArchiveSnapshot,
  ProjectSerializerPort,
  SerializedProject,
  SliceAdapterPort,
  SliceResult,
} from './ports';
import { SelectionStore } from './selection';
import { ProjectStore } from './store';

export class StaleProjectResultError extends Error {
  constructor(operation: string) {
    super(`${operation} completed for a stale project revision`);
    this.name = 'StaleProjectResultError';
  }
}

export class UnhealthyProjectProjectionError extends Error {
  constructor(
    readonly operation: 'save' | 'slice',
    readonly health: ProjectProjectionHealthSnapshot,
  ) {
    const count = health.projectFailures.length;
    super(
      `Cannot ${operation}: ${count} attached editor surface${count === 1 ? '' : 's'} failed to render the current project`,
    );
    this.name = 'UnhealthyProjectProjectionError';
  }
}

export interface EditorSessionOptions {
  initialState: ProjectState;
  serializer: ProjectSerializerPort;
  /** Legacy headless adapter; production slicing composes CanonicalSliceJobCoordinator. */
  slicer?: SliceAdapterPort;
  assets?: AssetRepository;
  selection?: SelectionStore;
  history?: CommandBusOptions;
}

/**
 * Browser-independent orchestration root. UI surfaces, codecs, and slicers are
 * injected ports; no Three.js, XRBlocks, DOM, or worker construction occurs.
 */
export class EditorSession {
  readonly project: ProjectStore;
  readonly selection: SelectionStore;
  readonly assets: AssetRepository;
  readonly commands: CommandBus;
  private readonly surfaces = new Set<EditorSurfacePort>();
  private readonly surfaceRecords = new Map<EditorSurfacePort, { id: number; label: string }>();
  private readonly projectProjectionFailures = new Map<EditorSurfacePort, ProjectProjectionFailure>();
  private readonly projectionHealthSubscribers = new Set<ProjectProjectionHealthSubscriber>();
  private readonly unsubscribeProject: () => void;
  private readonly unsubscribeSelection: () => void;
  private readonly unsubscribeHistory: () => void;
  private nextSurfaceId = 1;
  private disposed = false;

  constructor(private readonly options: EditorSessionOptions) {
    this.project = new ProjectStore(options.initialState);
    this.selection = options.selection ?? new SelectionStore();
    this.assets = options.assets ?? new InMemoryAssetRepository();
    assertBundleAssets(options.initialState, this.assets);
    this.commands = new CommandBus(
      { project: this.project, selection: this.selection, assets: this.assets },
      options.history,
    );
    this.commands.markCheckpoint();
    this.unsubscribeProject = this.project.subscribe((change) => this.renderProject(change.current));
    this.unsubscribeSelection = this.selection.subscribe((snapshot) => {
      for (const surface of this.surfaces) {
        try {
          surface.renderSelection(snapshot);
        } catch {
          // A projection cannot roll back or prevent canonical selection.
        }
      }
    });
    this.unsubscribeHistory = this.commands.subscribeHistory((snapshot) => this.renderHistory(snapshot));
  }

  attachSurface(surface: EditorSurfacePort): () => void {
    this.assertActive();
    if (!this.surfaces.has(surface)) {
      const id = this.nextSurfaceId;
      this.nextSurfaceId += 1;
      this.surfaces.add(surface);
      this.surfaceRecords.set(surface, {
        id,
        label: boundedText(surface.projectionLabel, `Editor surface ${id}`, 64),
      });
    }
    this.renderProjectOnSurfaces([surface], this.project.getSnapshot());
    try {
      surface.renderSelection(this.selection.getSnapshot());
    } catch {
      // Selection projection failures never participate in canonical state.
    }
    try {
      surface.renderHistory?.(this.commands.getHistorySnapshot());
    } catch {
      // History projection failures never participate in canonical state.
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.detachSurface(surface);
    };
  }

  getProjectionHealthSnapshot(): ProjectProjectionHealthSnapshot {
    const projectFailures = [...this.projectProjectionFailures.values()]
      .sort((left, right) => left.surfaceId - right.surfaceId)
      .map((failure) => Object.freeze({ ...failure }));
    return Object.freeze({
      healthy: projectFailures.length === 0,
      projectFailures: Object.freeze(projectFailures),
    });
  }

  subscribeProjectionHealth(subscriber: ProjectProjectionHealthSubscriber): () => void {
    this.assertActive();
    this.projectionHealthSubscribers.add(subscriber);
    return () => this.projectionHealthSubscribers.delete(subscriber);
  }

  execute(command: ProjectCommand, options?: { coalesce?: boolean }): void {
    this.assertActive();
    this.commands.execute(command, options);
  }

  transaction<T>(
    label: string,
    operation: () => T extends PromiseLike<unknown> ? never : T,
  ): T extends PromiseLike<unknown> ? never : T {
    this.assertActive();
    return this.commands.transaction(label, operation);
  }

  undo(): boolean {
    this.assertActive();
    return this.commands.undo();
  }

  redo(): boolean {
    this.assertActive();
    return this.commands.redo();
  }

  async save(cancellation?: CancellationToken): Promise<SerializedProject> {
    this.assertActive();
    this.assertProjectProjectionHealthy('save');
    const request = this.archiveSnapshot();
    const sourceAssetHash = assetBundleFingerprint(request.assets);
    const result = await this.options.serializer.serialize(request, cancellation);
    if (
      result.sourceRevision !== request.sourceRevision ||
      result.sourceHash !== request.sourceHash ||
      !this.project.isCurrent({ revision: request.sourceRevision, hash: request.sourceHash }) ||
      assetBundleFingerprint(this.assets.list()) !== sourceAssetHash
    ) {
      throw new StaleProjectResultError('Serialization');
    }
    this.assertProjectProjectionHealthy('save');
    this.commands.markCheckpoint();
    return result;
  }

  async open(bytes: Uint8Array, cancellation?: CancellationToken): Promise<string[]> {
    this.assertActive();
    const parsed = await this.options.serializer.deserialize(bytes, cancellation);
    assertValidProjectState(parsed.state);
    const nextAssets: AssetRepositorySnapshot = { entries: parsed.assets };
    // Validate the whole bundle in a temporary immutable repository before commit.
    const staged = new InMemoryAssetRepository();
    staged.restore(nextAssets);
    assertBundleAssets(parsed.state, staged);

    this.assets.restore(nextAssets);
    this.project.replaceState(parsed.state, { reason: 'open-project', dirtyCategories: [] });
    this.selection.clear();
    this.commands.clearHistory({ markCheckpoint: true });
    return [...parsed.warnings];
  }

  /**
   * Replace the complete project/archive authority and establish a fresh clean
   * history root. Callers must resolve dirty confirmation before this seam.
   */
  reset(state: ProjectState, assets: AssetRepositorySnapshot = { entries: [] }): void {
    this.assertActive();
    assertValidProjectState(state);
    const staged = new InMemoryAssetRepository();
    staged.restore(assets);
    assertBundleAssets(state, staged);

    this.assets.restore(assets);
    this.project.replaceState(state, { reason: 'reset-project', dirtyCategories: [] });
    this.selection.clear();
    this.commands.clearHistory({ markCheckpoint: true });
  }

  async slice(
    plateId: PlateId = this.project.getSnapshot().state.activePlateId,
    cancellation?: CancellationToken,
  ): Promise<SliceResult> {
    this.assertActive();
    this.assertProjectProjectionHealthy('slice');
    const slicer = this.options.slicer;
    if (!slicer) {
      throw new Error('EditorSession slicing is not configured; use CanonicalSliceJobCoordinator');
    }
    const request = this.archiveSnapshot();
    const sourceAssetHash = assetBundleFingerprint(request.assets);
    if (!findPlate(request.state, plateId)) throw new Error(`Unknown plate ${plateId}`);
    const result = await slicer.slice({ ...request, plateId, cancellation });
    if (
      result.plateId !== plateId ||
      result.sourceRevision !== request.sourceRevision ||
      result.sourceHash !== request.sourceHash ||
      !this.project.isCurrent({ revision: request.sourceRevision, hash: request.sourceHash }) ||
      assetBundleFingerprint(this.assets.list()) !== sourceAssetHash
    ) {
      throw new StaleProjectResultError('Slice');
    }
    this.assertProjectProjectionHealthy('slice');
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProject();
    this.unsubscribeSelection();
    this.unsubscribeHistory();
    const previousHealth = this.getProjectionHealthSnapshot();
    for (const surface of this.surfaces) {
      try {
        surface.dispose?.();
      } catch {
        // Surface teardown cannot prevent the session from releasing observers.
      }
    }
    this.surfaces.clear();
    this.surfaceRecords.clear();
    this.projectProjectionFailures.clear();
    this.emitProjectionHealth(previousHealth);
    this.projectionHealthSubscribers.clear();
  }

  private archiveSnapshot(): ProjectArchiveSnapshot {
    const snapshot = this.project.getSnapshot();
    assertBundleAssets(snapshot.state, this.assets);
    return {
      state: snapshot.state,
      assets: this.assets.list(),
      sourceRevision: snapshot.revision,
      sourceHash: snapshot.hash,
    };
  }

  private renderHistory(snapshot = this.commands.getHistorySnapshot()): void {
    for (const surface of this.surfaces) {
      try {
        surface.renderHistory?.(snapshot);
      } catch {
        // History projections are observers, not transaction participants.
      }
    }
  }

  private renderProject(snapshot = this.project.getSnapshot()): void {
    this.renderProjectOnSurfaces([...this.surfaces], snapshot);
  }

  private renderProjectOnSurfaces(
    surfaces: readonly EditorSurfacePort[],
    snapshot: ReturnType<ProjectStore['getSnapshot']>,
  ): void {
    const previousHealth = this.getProjectionHealthSnapshot();
    for (const surface of surfaces) {
      const record = this.surfaceRecords.get(surface);
      if (!record || !this.surfaces.has(surface)) continue;
      try {
        surface.renderProject(snapshot);
        this.projectProjectionFailures.delete(surface);
      } catch (error) {
        this.projectProjectionFailures.set(
          surface,
          Object.freeze({
            surfaceId: record.id,
            surfaceLabel: record.label,
            projectRevision: snapshot.revision,
            message: boundedProjectionFailureMessage(error),
          }),
        );
      }
    }
    this.emitProjectionHealth(previousHealth);
  }

  private detachSurface(surface: EditorSurfacePort): void {
    if (!this.surfaces.delete(surface)) return;
    const previousHealth = this.getProjectionHealthSnapshot();
    this.surfaceRecords.delete(surface);
    this.projectProjectionFailures.delete(surface);
    this.emitProjectionHealth(previousHealth);
    try {
      surface.dispose?.();
    } catch {
      // Projection teardown is an observer and cannot poison canonical state.
    }
  }

  private emitProjectionHealth(previous: ProjectProjectionHealthSnapshot): void {
    const current = this.getProjectionHealthSnapshot();
    if (projectionHealthEqual(current, previous)) return;
    for (const subscriber of [...this.projectionHealthSubscribers]) {
      try {
        subscriber(current, previous);
      } catch {
        // Health observers cannot veto a canonical commit or projection update.
      }
    }
  }

  private assertProjectProjectionHealthy(operation: 'save' | 'slice'): void {
    const health = this.getProjectionHealthSnapshot();
    if (!health.healthy) throw new UnhealthyProjectProjectionError(operation, health);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('EditorSession is disposed');
  }
}

function boundedProjectionFailureMessage(error: unknown): string {
  let raw = 'Project rendering failed';
  try {
    if (error instanceof Error) {
      raw = error.message ? `${error.name || 'Error'}: ${error.message}` : error.name || raw;
    } else if (typeof error === 'string') {
      raw = error;
    }
  } catch {
    // Hostile error objects do not get to escape the projection boundary.
  }
  return boundedText(raw, 'Project rendering failed', 160);
}

function boundedText(value: string | undefined, fallback: string, limit: number): string {
  const withoutControls = Array.from(value ?? '', (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? ' ' : character;
  }).join('');
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, limit);
}

function projectionHealthEqual(left: ProjectProjectionHealthSnapshot, right: ProjectProjectionHealthSnapshot): boolean {
  return (
    left.healthy === right.healthy &&
    left.projectFailures.length === right.projectFailures.length &&
    left.projectFailures.every((failure, index) => {
      const other = right.projectFailures[index];
      return (
        other !== undefined &&
        failure.surfaceId === other.surfaceId &&
        failure.surfaceLabel === other.surfaceLabel &&
        failure.projectRevision === other.projectRevision &&
        failure.message === other.message
      );
    })
  );
}

function assertBundleAssets(state: ProjectState, repository: AssetRepository): void {
  const expected = new Map(state.sourceAssets.map((descriptor) => [descriptor.id, descriptor]));
  for (const descriptor of state.sourceAssets) {
    const payload = repository.get(descriptor.id);
    if (!payload) throw new Error(`Project bundle is missing source asset ${descriptor.id}`);
    if (canonicalStringify(payload.descriptor) !== canonicalStringify(descriptor)) {
      throw new Error(`Project bundle metadata differs for source asset ${descriptor.id}`);
    }
  }
  for (const payload of repository.list()) {
    if (!expected.has(payload.descriptor.id)) {
      throw new Error(`Project bundle contains undeclared asset ${payload.descriptor.id}`);
    }
  }
}
