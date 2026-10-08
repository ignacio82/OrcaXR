import type { ObjectTreeSelectionMode } from './interaction';
import type { ObjectTreeEntityRef, ObjectTreeRowKey, ObjectTreeView, ObjectTreeVisibleRow } from './types';

/** What activating an Objects tree row asks the selection owner for. */
export interface ObjectTreeSelectionRequest {
  readonly mode: ObjectTreeSelectionMode;
  readonly rowKey: ObjectTreeRowKey;
  readonly target: ObjectTreeEntityRef;
  /** The prior replace/toggle target when it remains visible. */
  readonly anchor?: ObjectTreeEntityRef;
  /** Exact visible entity range, populated only for range selection. */
  readonly range?: readonly ObjectTreeEntityRef[];
}

/** The tree's share of the selection: no project or filament references. */
export interface ObjectTreeEntitySelection {
  readonly refs: readonly ObjectTreeEntityRef[];
  readonly primary?: ObjectTreeEntityRef;
}

/**
 * The request a visible row makes, and the anchor the next range selection
 * measures from: replace and toggle move the anchor to the row, range keeps
 * it. A range spans the visible rows between the anchor and the row (each
 * entity once), or is the row alone when the anchor is not visible. A row
 * without an entity asks for nothing.
 */
export function objectTreeSelectionRequest(
  view: ObjectTreeView,
  row: ObjectTreeVisibleRow,
  mode: ObjectTreeSelectionMode,
  anchorKey: ObjectTreeRowKey | undefined,
): { readonly request?: ObjectTreeSelectionRequest; readonly anchorKey?: ObjectTreeRowKey } {
  if (!row.entity) return anchorKey === undefined ? {} : { anchorKey };
  const anchorRow = anchorKey ? view.rowsByKey.get(anchorKey) : undefined;
  let range: ObjectTreeEntityRef[] | undefined;
  let nextAnchor = anchorKey;
  if (mode === 'range') {
    const anchorIndex = anchorKey ? view.indexByKey.get(anchorKey) : undefined;
    const targetIndex = view.indexByKey.get(row.key);
    if (anchorIndex === undefined || targetIndex === undefined) {
      range = [{ ...row.entity }];
    } else {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      range = deduplicate(
        view.rows.slice(start, end + 1).flatMap((candidate) => (candidate.entity ? [{ ...candidate.entity }] : [])),
      );
    }
  } else {
    nextAnchor = row.key;
  }
  return {
    request: {
      mode,
      rowKey: row.key,
      target: { ...row.entity },
      ...(anchorRow?.entity ? { anchor: { ...anchorRow.entity } } : {}),
      ...(range ? { range } : {}),
    },
    ...(nextAnchor === undefined ? {} : { anchorKey: nextAnchor }),
  };
}

/**
 * The selection a request commits, from the tree selection it was made
 * against. Replace selects the target; range selects its span with the target
 * primary. Toggle adds the target as primary, or removes it and keeps the
 * previous primary while it is still selected (else the last remaining entry).
 */
export function resolveObjectTreeSelection(
  selection: ObjectTreeEntitySelection,
  request: ObjectTreeSelectionRequest,
): ObjectTreeEntitySelection {
  if (request.mode === 'replace') return { refs: [{ ...request.target }], primary: { ...request.target } };
  if (request.mode === 'range') {
    const refs = (request.range ?? [request.target]).map((entity) => ({ ...entity }));
    return { refs, primary: { ...request.target } };
  }
  const targetKey = entityKey(request.target);
  const refs = selection.refs.map((entity) => ({ ...entity }));
  const index = refs.findIndex((candidate) => entityKey(candidate) === targetKey);
  if (index >= 0) refs.splice(index, 1);
  else refs.push({ ...request.target });
  const existing = selection.primary;
  const primary =
    index < 0
      ? { ...request.target }
      : existing && refs.some((candidate) => entityKey(candidate) === entityKey(existing))
        ? { ...existing }
        : refs.at(-1);
  return { refs, ...(primary ? { primary } : {}) };
}

function entityKey(entity: ObjectTreeEntityRef): string {
  return `${entity.kind}:${entity.id}`;
}

function deduplicate(entities: readonly ObjectTreeEntityRef[]): ObjectTreeEntityRef[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const key = entityKey(entity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
