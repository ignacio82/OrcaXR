import { InMemoryAssetRepository, type AssetRepository, type AssetRepositorySnapshot } from './assets';
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

export interface EditorSessionOptions {
  initialState: ProjectState;
  serializer: ProjectSerializerPort;
  slicer: SliceAdapterPort;
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
  private readonly unsubscribeProject: () => void;
  private readonly unsubscribeSelection: () => void;
  private disposed = false;
  private transactionDepth = 0;

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
    this.unsubscribeProject = this.project.subscribe((change) => {
      for (const surface of this.surfaces) {
        try {
          surface.renderProject(change.current);
        } catch {
          // A projection cannot roll back or prevent a canonical commit.
        }
      }
    });
    this.unsubscribeSelection = this.selection.subscribe((snapshot) => {
      for (const surface of this.surfaces) {
        try {
          surface.renderSelection(snapshot);
        } catch {
          // A projection cannot roll back or prevent canonical selection.
        }
      }
    });
  }

  attachSurface(surface: EditorSurfacePort): () => void {
    this.assertActive();
    this.surfaces.add(surface);
    surface.renderProject(this.project.getSnapshot());
    surface.renderSelection(this.selection.getSnapshot());
    surface.renderHistory?.(this.commands.getHistorySnapshot());
    return () => {
      if (this.surfaces.delete(surface)) surface.dispose?.();
    };
  }

  execute(command: ProjectCommand, options?: { coalesce?: boolean }): void {
    this.assertActive();
    this.commands.execute(command, options);
    if (this.transactionDepth === 0) this.renderHistory();
  }

  transaction<T>(label: string, operation: () => T): T {
    this.assertActive();
    this.transactionDepth += 1;
    try {
      return this.commands.transaction(label, operation);
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) this.renderHistory();
    }
  }

  undo(): boolean {
    this.assertActive();
    const changed = this.commands.undo();
    if (changed) this.renderHistory();
    return changed;
  }

  redo(): boolean {
    this.assertActive();
    const changed = this.commands.redo();
    if (changed) this.renderHistory();
    return changed;
  }

  async save(cancellation?: CancellationToken): Promise<SerializedProject> {
    this.assertActive();
    const request = this.archiveSnapshot();
    const result = await this.options.serializer.serialize(request, cancellation);
    if (
      result.sourceRevision !== request.sourceRevision ||
      result.sourceHash !== request.sourceHash ||
      !this.project.isCurrent({ revision: request.sourceRevision, hash: request.sourceHash })
    ) {
      throw new StaleProjectResultError('Serialization');
    }
    this.commands.markCheckpoint();
    this.renderHistory();
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
    this.renderHistory();
    return [...parsed.warnings];
  }

  async slice(
    plateId: PlateId = this.project.getSnapshot().state.activePlateId,
    cancellation?: CancellationToken,
  ): Promise<SliceResult> {
    this.assertActive();
    const request = this.archiveSnapshot();
    if (!findPlate(request.state, plateId)) throw new Error(`Unknown plate ${plateId}`);
    const result = await this.options.slicer.slice({ ...request, plateId, cancellation });
    if (
      result.plateId !== plateId ||
      result.sourceRevision !== request.sourceRevision ||
      result.sourceHash !== request.sourceHash ||
      !this.project.isCurrent({ revision: request.sourceRevision, hash: request.sourceHash })
    ) {
      throw new StaleProjectResultError('Slice');
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProject();
    this.unsubscribeSelection();
    for (const surface of this.surfaces) surface.dispose?.();
    this.surfaces.clear();
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

  private renderHistory(): void {
    const snapshot = this.commands.getHistorySnapshot();
    for (const surface of this.surfaces) {
      try {
        surface.renderHistory?.(snapshot);
      } catch {
        // History projections are observers, not transaction participants.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('EditorSession is disposed');
  }
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
