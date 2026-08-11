import {
  canonicalStringify,
  cloneProjectState,
  deepFreeze,
  isDeeplyFrozen,
  projectFingerprint,
} from './domain/canonical';
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
    // Same order as `replaceState`: validate the frozen copy that is kept, so
    // the answer is memoized against the object every later reader will see.
    this.state = deepFreeze(cloneProjectState(initialState));
    assertValidProjectState(this.state);
    this.hash = projectFingerprint(this.state);
  }

  getSnapshot(): ProjectSnapshot {
    return { state: this.state, revision: this.revision, hash: this.hash };
  }

  replaceState(
    next: ProjectState,
    options: { reason?: string; dirtyCategories?: readonly DirtyCategory[] } = {},
  ): ProjectSnapshot {
    // Validated once, on the state that is actually stored. Validating the
    // caller's object as well doubled the cost of every commit for no extra
    // guarantee: a faithful clone cannot turn a valid state into an invalid one.
    //
    // The defensive copy exists so a caller cannot mutate stored state behind
    // the store's back; a state already frozen all the way down cannot be
    // mutated by anyone, so copying it buys nothing. And freezing *before*
    // validating and hashing is what makes those two answers reusable: both are
    // pure functions of a state that can no longer change, so preflight,
    // capture, the slice coordinator, and undo get them for free instead of
    // re-deriving them on a state the store already vouched for.
    const candidate = isDeeplyFrozen(next) ? next : deepFreeze(cloneProjectState(next));
    assertValidProjectState(candidate);
    const nextHash = projectFingerprint(candidate);
    const previous = this.getSnapshot();
    this.state = candidate;
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
