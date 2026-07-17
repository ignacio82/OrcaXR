import { selectionKey } from '../selection';
import { normalizeSearch } from './projection';
import type {
  ObjectTreeProjection,
  ObjectTreeRow,
  ObjectTreeRowKey,
  ObjectTreeView,
  ObjectTreeViewOptions,
  ObjectTreeVisibleRow,
} from './types';

export class ObjectTreeExpansionState {
  private readonly expanded: Set<ObjectTreeRowKey>;

  constructor(initial: Iterable<ObjectTreeRowKey> = []) {
    this.expanded = new Set(initial);
  }

  isExpanded(key: ObjectTreeRowKey): boolean {
    return this.expanded.has(key);
  }

  setExpanded(key: ObjectTreeRowKey, value: boolean): boolean {
    if (value) {
      if (this.expanded.has(key)) return false;
      this.expanded.add(key);
      return true;
    }
    return this.expanded.delete(key);
  }

  toggle(key: ObjectTreeRowKey): boolean {
    const value = !this.expanded.has(key);
    this.setExpanded(key, value);
    return value;
  }

  expandAncestors(projection: ObjectTreeProjection, key: ObjectTreeRowKey): void {
    let parent = projection.rowsByKey.get(key)?.parentKey;
    while (parent) {
      this.expanded.add(parent);
      parent = projection.rowsByKey.get(parent)?.parentKey;
    }
  }

  expandAll(projection: ObjectTreeProjection): void {
    for (const row of projection.rowsByKey.values()) if (row.childrenKeys.length > 0) this.expanded.add(row.key);
  }

  reconcile(projection: ObjectTreeProjection): void {
    for (const key of this.expanded) if (!projection.rowsByKey.has(key)) this.expanded.delete(key);
  }

  snapshot(): ReadonlySet<ObjectTreeRowKey> {
    return new Set(this.expanded);
  }
}

export function buildObjectTreeView(
  projection: ObjectTreeProjection,
  options: ObjectTreeViewOptions = {},
): ObjectTreeView {
  const expanded = options.expandedKeys ?? new Set(projection.defaultExpandedKeys);
  const normalizedQuery = normalizeSearch(options.filterQuery ?? '');
  const tokens = normalizedQuery ? normalizedQuery.split(' ') : [];
  const directMatches = new Set<ObjectTreeRowKey>();
  const included = tokens.length > 0 ? new Set<ObjectTreeRowKey>() : undefined;
  if (included) {
    for (const row of projection.rowsByKey.values()) {
      if (tokens.every((token) => row.searchText.includes(token))) directMatches.add(row.key);
    }
    for (const key of directMatches) {
      includeAncestors(projection, key, included);
      includeDescendants(projection, key, included);
    }
  }

  const selection = options.selection ?? { refs: [] };
  const selected = new Set(selection.refs.map(selectionKey));
  const primaryKey = selection.primary ? projection.entityRowKeys.get(selectionKey(selection.primary)) : undefined;
  const provisional: Array<
    Omit<ObjectTreeVisibleRow, 'focused' | 'accessibility'> & {
      level: number;
      position: number;
      setSize: number;
      rowExpanded?: boolean;
    }
  > = [];
  const visit = (keys: readonly ObjectTreeRowKey[], level: number): void => {
    const siblings = keys.filter((key) => !included || included.has(key));
    siblings.forEach((key, index) => {
      const row = projection.rowsByKey.get(key);
      if (!row) return;
      const visibleChildren = row.childrenKeys.filter((child) => !included || included.has(child));
      const isExpanded = visibleChildren.length > 0 && (included ? true : expanded.has(row.key));
      provisional.push({
        ...row,
        matchedFilter: directMatches.has(row.key),
        level,
        position: index + 1,
        setSize: siblings.length,
        ...(row.childrenKeys.length > 0 ? { rowExpanded: isExpanded } : {}),
      });
      if (isExpanded) visit(visibleChildren, level + 1);
    });
  };
  visit(projection.rootKeys, 1);

  const visibleKeys = new Set(provisional.map((row) => row.key));
  const focusKey =
    (options.focusedKey && visibleKeys.has(options.focusedKey) ? options.focusedKey : undefined) ??
    (primaryKey && visibleKeys.has(primaryKey) ? primaryKey : undefined) ??
    provisional[0]?.key;
  const rows: ObjectTreeVisibleRow[] = provisional.map(({ level, position, setSize, rowExpanded, ...row }) => {
    const rowSelected = row.entity ? selected.has(selectionKey(row.entity)) : false;
    const focused = row.key === focusKey;
    return {
      ...row,
      focused,
      accessibility: {
        level,
        positionInSet: position,
        setSize,
        ...(rowExpanded === undefined ? {} : { expanded: rowExpanded }),
        selected: rowSelected,
        disabled: !row.indicators.editable,
        tabIndex: focused ? 0 : -1,
      },
    };
  });
  return {
    rows,
    rowsByKey: new Map(rows.map((row) => [row.key, row])),
    indexByKey: new Map(rows.map((row, index) => [row.key, index])),
    focusKey,
    filterQuery: options.filterQuery ?? '',
    filterActive: tokens.length > 0,
  };
}

function includeAncestors(
  projection: ObjectTreeProjection,
  key: ObjectTreeRowKey,
  included: Set<ObjectTreeRowKey>,
): void {
  let current: ObjectTreeRow | undefined = projection.rowsByKey.get(key);
  while (current) {
    included.add(current.key);
    current = current.parentKey ? projection.rowsByKey.get(current.parentKey) : undefined;
  }
}

function includeDescendants(
  projection: ObjectTreeProjection,
  key: ObjectTreeRowKey,
  included: Set<ObjectTreeRowKey>,
): void {
  const row = projection.rowsByKey.get(key);
  if (!row) return;
  included.add(key);
  for (const child of row.childrenKeys) includeDescendants(projection, child, included);
}
