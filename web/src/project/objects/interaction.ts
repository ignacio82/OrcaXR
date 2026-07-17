import { selectionKey, type SelectionRef, type SelectionStorePort } from '../selection';
import type { ObjectTreeRowKey, ObjectTreeView } from './types';
import { ObjectTreeExpansionState } from './view';

export type ObjectTreeSelectionMode = 'replace' | 'toggle' | 'range';
export type ObjectTreeNavigationCommand = 'previous' | 'next' | 'parent' | 'child' | 'first' | 'last';

export class ObjectTreeSelectionController {
  private anchorKey?: ObjectTreeRowKey;

  constructor(private readonly selection: SelectionStorePort) {}

  apply(view: ObjectTreeView, key: ObjectTreeRowKey, mode: ObjectTreeSelectionMode): boolean {
    const row = view.rowsByKey.get(key);
    if (!row?.entity) return false;
    if (mode === 'replace') {
      this.selection.set([row.entity], row.entity);
      this.anchorKey = key;
      return true;
    }
    if (mode === 'toggle') {
      const refs = this.selection.getSnapshot().refs.map(cloneRef);
      const index = refs.findIndex((ref) => selectionKey(ref) === selectionKey(row.entity!));
      if (index >= 0) refs.splice(index, 1);
      else refs.push(cloneRef(row.entity));
      this.selection.set(refs, index >= 0 ? refs.at(-1) : row.entity);
      this.anchorKey = key;
      return true;
    }
    const anchorIndex = this.anchorKey ? view.indexByKey.get(this.anchorKey) : undefined;
    const targetIndex = view.indexByKey.get(key);
    if (anchorIndex === undefined || targetIndex === undefined) {
      this.selection.set([row.entity], row.entity);
      this.anchorKey = key;
      return true;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const refs = deduplicateRefs(
      view.rows.slice(start, end + 1).flatMap((candidate) => (candidate.entity ? [candidate.entity] : [])),
    );
    this.selection.set(refs, row.entity);
    return true;
  }

  setAnchor(key: ObjectTreeRowKey | undefined): void {
    this.anchorKey = key;
  }

  getAnchor(): ObjectTreeRowKey | undefined {
    return this.anchorKey;
  }
}

export class ObjectTreeNavigator {
  private focusKey?: ObjectTreeRowKey;

  constructor(
    private readonly expansion: ObjectTreeExpansionState,
    private readonly selection: ObjectTreeSelectionController,
  ) {}

  reconcile(view: ObjectTreeView): ObjectTreeRowKey | undefined {
    if (!this.focusKey || !view.rowsByKey.has(this.focusKey)) this.focusKey = view.focusKey;
    return this.focusKey;
  }

  setFocus(view: ObjectTreeView, key: ObjectTreeRowKey): boolean {
    if (!view.rowsByKey.has(key)) return false;
    this.focusKey = key;
    return true;
  }

  getFocus(): ObjectTreeRowKey | undefined {
    return this.focusKey;
  }

  navigate(view: ObjectTreeView, command: ObjectTreeNavigationCommand): ObjectTreeRowKey | undefined {
    this.reconcile(view);
    if (!this.focusKey) return undefined;
    const index = view.indexByKey.get(this.focusKey);
    if (index === undefined) return this.focusKey;
    const current = view.rows[index];
    switch (command) {
      case 'previous':
        this.focusKey = view.rows[Math.max(0, index - 1)]?.key;
        break;
      case 'next':
        this.focusKey = view.rows[Math.min(view.rows.length - 1, index + 1)]?.key;
        break;
      case 'first':
        this.focusKey = view.rows[0]?.key;
        break;
      case 'last':
        this.focusKey = view.rows.at(-1)?.key;
        break;
      case 'child': {
        if (current.childrenKeys.length === 0) break;
        if (!current.accessibility.expanded) this.expansion.setExpanded(current.key, true);
        else {
          const child = view.rows.slice(index + 1).find((row) => row.parentKey === current.key);
          if (child) this.focusKey = child.key;
        }
        break;
      }
      case 'parent':
        if (current.accessibility.expanded) this.expansion.setExpanded(current.key, false);
        else if (current.parentKey && view.rowsByKey.has(current.parentKey)) this.focusKey = current.parentKey;
        break;
    }
    return this.focusKey;
  }

  activate(view: ObjectTreeView, mode: ObjectTreeSelectionMode = 'replace'): boolean {
    this.reconcile(view);
    return this.focusKey ? this.selection.apply(view, this.focusKey, mode) : false;
  }
}

function deduplicateRefs(refs: readonly SelectionRef[]): SelectionRef[] {
  const seen = new Set<string>();
  return refs
    .filter((ref) => {
      const key = selectionKey(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(cloneRef);
}

function cloneRef<T extends SelectionRef>(ref: T): T {
  return { ...ref };
}
