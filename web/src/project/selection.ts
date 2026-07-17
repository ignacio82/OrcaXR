import type { FilamentId, InstanceId, LayerRangeId, ObjectId, PlateId, VolumeId } from './domain/ids';
import type { ProjectState } from './domain/model';
import { findInstance, findLayerRange, findObject, findPlate, findVolume } from './domain/selectors';

export type SelectionRef =
  | { kind: 'project' }
  | { kind: 'plate'; id: PlateId }
  | { kind: 'object'; id: ObjectId }
  | { kind: 'volume'; id: VolumeId }
  | { kind: 'instance'; id: InstanceId }
  | { kind: 'layer-range'; id: LayerRangeId }
  | { kind: 'filament'; id: FilamentId };

export interface SelectionSnapshot {
  refs: SelectionRef[];
  primary?: SelectionRef;
}

export type SelectionSubscriber = (current: SelectionSnapshot, previous: SelectionSnapshot) => void;

export interface SelectionStorePort {
  getSnapshot(): SelectionSnapshot;
  set(refs: readonly SelectionRef[], primary?: SelectionRef): void;
  clear(): void;
  subscribe(subscriber: SelectionSubscriber): () => void;
}

export class SelectionStore implements SelectionStorePort {
  private snapshot: SelectionSnapshot = { refs: [] };
  private readonly subscribers = new Set<SelectionSubscriber>();

  getSnapshot(): SelectionSnapshot {
    return cloneSelection(this.snapshot);
  }

  set(refs: readonly SelectionRef[], primary?: SelectionRef): void {
    const unique = deduplicate(refs);
    const chosenPrimary = primary ?? unique.at(-1);
    if (chosenPrimary && !unique.some((ref) => selectionKey(ref) === selectionKey(chosenPrimary))) {
      throw new Error('Primary selection must be part of the selection set');
    }
    this.commit({ refs: unique, primary: chosenPrimary });
  }

  add(ref: SelectionRef, makePrimary = true): void {
    const refs = deduplicate([...this.snapshot.refs, ref]);
    this.commit({ refs, primary: makePrimary ? ref : this.snapshot.primary });
  }

  toggle(ref: SelectionRef): void {
    const key = selectionKey(ref);
    const exists = this.snapshot.refs.some((candidate) => selectionKey(candidate) === key);
    if (exists) {
      const refs = this.snapshot.refs.filter((candidate) => selectionKey(candidate) !== key);
      const primary =
        this.snapshot.primary && selectionKey(this.snapshot.primary) !== key ? this.snapshot.primary : refs.at(-1);
      this.commit({ refs, primary });
    } else {
      this.add(ref);
    }
  }

  clear(): void {
    this.commit({ refs: [] });
  }

  restore(snapshot: SelectionSnapshot): void {
    this.set(snapshot.refs, snapshot.primary);
  }

  prune(state: ProjectState): void {
    const refs = this.snapshot.refs.filter((ref) => selectionExists(state, ref));
    const primary =
      this.snapshot.primary && refs.some((ref) => selectionKey(ref) === selectionKey(this.snapshot.primary!))
        ? this.snapshot.primary
        : refs.at(-1);
    this.commit({ refs, primary });
  }

  subscribe(subscriber: SelectionSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private commit(next: SelectionSnapshot): void {
    if (selectionEqual(this.snapshot, next)) return;
    const previous = this.getSnapshot();
    this.snapshot = cloneSelection(next);
    const current = this.getSnapshot();
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(current, previous);
      } catch {
        // Selection observers are projections and cannot veto canonical state.
      }
    }
  }
}

export function selectionExists(state: ProjectState, ref: SelectionRef): boolean {
  switch (ref.kind) {
    case 'project':
      return true;
    case 'plate':
      return Boolean(findPlate(state, ref.id));
    case 'object':
      return Boolean(findObject(state, ref.id));
    case 'volume':
      return Boolean(findVolume(state, ref.id));
    case 'instance':
      return Boolean(findInstance(state, ref.id));
    case 'layer-range':
      return Boolean(findLayerRange(state, ref.id));
    case 'filament':
      return [...state.filaments.physical, ...state.filaments.mixed].some((filament) => filament.id === ref.id);
  }
}

export function selectionKey(ref: SelectionRef): string {
  return ref.kind === 'project' ? 'project' : `${ref.kind}:${ref.id}`;
}

function deduplicate(refs: readonly SelectionRef[]): SelectionRef[] {
  const result: SelectionRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = selectionKey(ref);
    if (!seen.has(key)) {
      result.push({ ...ref });
      seen.add(key);
    }
  }
  return result;
}

function cloneSelection(snapshot: SelectionSnapshot): SelectionSnapshot {
  const clone: SelectionSnapshot = {
    refs: snapshot.refs.map((ref) => ({ ...ref })),
  };
  if (snapshot.primary) clone.primary = { ...snapshot.primary };
  return clone;
}

function selectionEqual(left: SelectionSnapshot, right: SelectionSnapshot): boolean {
  if (left.refs.length !== right.refs.length) return false;
  if (left.refs.some((ref, index) => selectionKey(ref) !== selectionKey(right.refs[index]))) return false;
  return (
    (left.primary ? selectionKey(left.primary) : undefined) ===
    (right.primary ? selectionKey(right.primary) : undefined)
  );
}
