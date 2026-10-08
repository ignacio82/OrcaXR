/**
 * The Objects tree over a session's shared contract: one page of the visible
 * rows the panels render (`projectObjectsTree`, then `buildObjectTreeView`
 * under the host's expansion, filter, selection and focus), or the selection
 * activating a row commits (`objectTreeSelectionRequest`, then
 * `resolveObjectTreeSelection`). The host keeps its view state and passes it
 * with every request; the selection may be the session's whole selection, of
 * which the tree sees only its own entities. The Rust core answers the same
 * requests (`orcaxr_project::objects_tree`).
 */
import type {
  ProjectObjectTreeEntityWire,
  ProjectObjectTreeReplyWire,
  ProjectObjectTreeRequestWire,
  ProjectObjectTreeRowKindWire,
  ProjectObjectTreeRowWire,
  ProjectOptionalObjectTreeEntityWire,
  ProjectOptionalTextWire,
  ProjectSelectionEntityWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { ProjectState, VolumeRole } from '../domain/model';
import { projectObjectsTree } from './projection';
import {
  objectTreeSelectionRequest,
  resolveObjectTreeSelection,
  type ObjectTreeEntitySelection,
} from './selectionRequest';
import type { ObjectTreeEntityRef, ObjectTreeRowKind, ObjectTreeVisibleRow } from './types';
import { buildObjectTreeView } from './view';

/** The most rows one page may hold. */
export const OBJECT_TREE_MAX_PAGE = 64;

export class ObjectTreeRequestError extends Error {
  readonly code = 'invalid_request';
  constructor() {
    super('The Objects tree page is larger than the contract allows.');
    this.name = 'ObjectTreeRequestError';
  }
}

const KINDS: Readonly<Record<Exclude<ObjectTreeRowKind, 'info' | 'error'>, ProjectObjectTreeRowKindWire>> = {
  plate: 'plate',
  object: 'object',
  volume: 'volume',
  'instance-group': 'instanceGroup',
  instance: 'instance',
  settings: 'settings',
  'layer-group': 'layerGroup',
  'layer-range': 'layerRange',
};
const ROLES = {
  model: 'model',
  'negative-volume': 'negativeVolume',
  'parameter-modifier': 'parameterModifier',
  'support-blocker': 'supportBlocker',
  'support-enforcer': 'supportEnforcer',
} as const satisfies Record<VolumeRole, string>;

export function answerObjectTreeRequest(
  state: ProjectState,
  request: ProjectObjectTreeRequestWire,
): ProjectObjectTreeReplyWire {
  const projection = projectObjectsTree(state);
  const selection = treeSelection(request);
  const view = buildObjectTreeView(projection, {
    ...('keys' in request.expansion ? { expandedKeys: new Set(request.expansion.keys.map(wireText)) } : {}),
    filterQuery: wireText(request.filterQuery),
    selection,
    ...optionalKey('focusedKey', request.focusedKey),
  });
  const operation = request.operation;
  if ('page' in operation) {
    const { start, count } = operation.page;
    if (count > OBJECT_TREE_MAX_PAGE) throw new ObjectTreeRequestError();
    const first = Math.min(start, view.rows.length);
    return {
      page: {
        totalRows: view.rows.length,
        focusKey: optionalText(view.focusKey),
        filterActive: view.filterActive,
        rows: view.rows.slice(first, first + count).map(rowWire),
      },
    };
  }
  const select = operation.select;
  const row = view.rowsByKey.get(wireText(select.key));
  const anchorKey = 'value' in select.anchorKey ? wireText(select.anchorKey.value) : undefined;
  const asked = row ? objectTreeSelectionRequest(view, row, select.mode, anchorKey) : undefined;
  if (!asked?.request) return { ignored: {} };
  const resolved = resolveObjectTreeSelection(selection, asked.request);
  return {
    selected: {
      refs: resolved.refs.map(entityWire),
      primary: optionalEntity(resolved.primary),
      anchorKey: optionalText(asked.anchorKey),
    },
  };
}

/** The tree's share of a selection: project and filament references dropped,
 * and a primary outside the tree with them. */
function treeSelection(request: ProjectObjectTreeRequestWire): ObjectTreeEntitySelection {
  const refs = request.selection.flatMap((entity) => {
    const ref = entityRef(entity);
    return ref ? [ref] : [];
  });
  const primary = 'value' in request.primary ? entityRef(request.primary.value) : undefined;
  return { refs, ...(primary ? { primary } : {}) };
}

function entityRef(entity: ProjectSelectionEntityWire): ObjectTreeEntityRef | undefined {
  if ('plate' in entity) return { kind: 'plate', id: wireText(entity.plate) } as ObjectTreeEntityRef;
  if ('object' in entity) return { kind: 'object', id: wireText(entity.object) } as ObjectTreeEntityRef;
  if ('volume' in entity) return { kind: 'volume', id: wireText(entity.volume) } as ObjectTreeEntityRef;
  if ('instance' in entity) return { kind: 'instance', id: wireText(entity.instance) } as ObjectTreeEntityRef;
  if ('layerRange' in entity) return { kind: 'layer-range', id: wireText(entity.layerRange) } as ObjectTreeEntityRef;
  return undefined;
}

function entityWire(ref: ObjectTreeEntityRef): ProjectObjectTreeEntityWire {
  const id = wireUnits(ref.id);
  switch (ref.kind) {
    case 'plate':
      return { plate: id };
    case 'object':
      return { object: id };
    case 'volume':
      return { volume: id };
    case 'instance':
      return { instance: id };
    case 'layer-range':
      return { layerRange: id };
  }
}

function optionalEntity(ref: ObjectTreeEntityRef | undefined): ProjectOptionalObjectTreeEntityWire {
  return ref ? { value: entityWire(ref) } : { absent: {} };
}

function optionalText(text: string | undefined): ProjectOptionalTextWire {
  return text === undefined ? { absent: {} } : { value: wireUnits(text) };
}

function optionalKey<K extends string>(name: K, text: ProjectOptionalTextWire): { [key in K]?: string } {
  return 'value' in text ? ({ [name]: wireText(text.value) } as { [key in K]: string }) : {};
}

function rowWire(row: ObjectTreeVisibleRow): ProjectObjectTreeRowWire {
  if (row.kind === 'info' || row.kind === 'error') throw new Error('Diagnostic rows are not projected');
  const { indicators, accessibility } = row;
  return {
    key: wireUnits(row.key),
    kind: KINDS[row.kind],
    parentKey: optionalText(row.parentKey),
    label: wireUnits(row.label),
    description: optionalText(row.description),
    entity: optionalEntity(row.entity),
    owner: optionalEntity(row.owner),
    indicators: {
      printable: indicators.printable === undefined ? 'unknown' : indicators.printable ? 'printable' : 'notPrintable',
      filament: indicators.filament
        ? {
            value: {
              id: wireUnits(indicators.filament.id),
              name: wireUnits(indicators.filament.name),
              color: wireUnits(indicators.filament.color),
              mixed: indicators.filament.mixed,
              inherited: indicators.filament.inherited,
            },
          }
        : { absent: {} },
      paint: indicators.paint ? { value: { ...indicators.paint } } : { absent: {} },
      editable: indicators.editable,
      settingsCount: indicators.settingsCount === undefined ? { absent: {} } : { value: indicators.settingsCount },
      volumeRole: indicators.volumeRole ? { value: ROLES[indicators.volumeRole] } : { absent: {} },
    },
    matchedFilter: row.matchedFilter,
    focused: row.focused,
    selected: accessibility.selected,
    level: accessibility.level,
    positionInSet: accessibility.positionInSet,
    setSize: accessibility.setSize,
    expansion: accessibility.expanded === undefined ? 'leaf' : accessibility.expanded ? 'expanded' : 'collapsed',
  };
}
