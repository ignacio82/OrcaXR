import { canonicalStringify, cloneProjectState, deepFreeze, projectFingerprint } from './domain/canonical';
import type { DirtyCategory, ProjectState } from './domain/model';
import { assertValidProjectState } from './domain/validation';

export interface ProjectRevisionGuard {
  revision: number;
  hash: string;
}

export interface ProjectSnapshot extends ProjectRevisionGuard {
  /** Runtime-deep-frozen canonical state. */
  state: ProjectState;
}

export interface ProjectChange {
  previous: ProjectSnapshot;
  current: ProjectSnapshot;
  reason: string;
  dirtyCategories: readonly DirtyCategory[];
}

export type ProjectSubscriber = (change: ProjectChange) => void;

export interface ProjectStorePort {
  getSnapshot(): ProjectSnapshot;
  replaceState(
    next: ProjectState,
    options?: { reason?: string; dirtyCategories?: readonly DirtyCategory[] },
  ): ProjectSnapshot;
  subscribe(subscriber: ProjectSubscriber): () => void;
  isCurrent(guard: ProjectRevisionGuard): boolean;
}

/** Canonical state owner. Every accepted replacement receives a newer revision. */
export class ProjectStore implements ProjectStorePort {
  private state: ProjectState;
  private revision = 0;
  private hash: string;
  private readonly subscribers = new Set<ProjectSubscriber>();

  constructor(initialState: ProjectState) {
    assertValidProjectState(initialState);
    this.state = deepFreeze(cloneProjectState(initialState));
    this.hash = projectFingerprint(this.state);
  }

  getSnapshot(): ProjectSnapshot {
    return { state: this.state, revision: this.revision, hash: this.hash };
  }

  replaceState(
    next: ProjectState,
    options: { reason?: string; dirtyCategories?: readonly DirtyCategory[] } = {},
  ): ProjectSnapshot {
    // Validated once, on the copy that is actually stored. Validating the
    // caller's object first as well doubled the cost of every commit for no
    // extra guarantee: `cloneProjectState` is a faithful JSON clone, so it
    // cannot turn a valid state into an invalid one, and validating the
    // candidate is what proves the stored state is sound.
    const candidate = cloneProjectState(next);
    assertValidProjectState(candidate);
    const nextHash = projectFingerprint(candidate);
    const previous = this.getSnapshot();
    this.state = deepFreeze(candidate);
    this.revision += 1;
    this.hash = nextHash;
    const current = this.getSnapshot();
    this.emit({
      previous,
      current,
      reason: options.reason ?? 'replace-state',
      dirtyCategories: options.dirtyCategories ?? ['projectData'],
    });
    return current;
  }

  subscribe(subscriber: ProjectSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  isCurrent(guard: ProjectRevisionGuard): boolean {
    return guard.revision === this.revision && guard.hash === this.hash;
  }

  /** Used by atomic command rollback; the new revision intentionally stays monotonic. */
  restoreState(state: ProjectState, reason = 'atomic-rollback'): ProjectSnapshot {
    return this.replaceState(state, { reason, dirtyCategories: [] });
  }

  hasSameContent(state: ProjectState): boolean {
    return canonicalStringify(this.state) === canonicalStringify(state);
  }

  private emit(change: ProjectChange): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(change);
      } catch {
        // Observers cannot make a committed domain mutation fail half-way.
      }
    }
  }
}
