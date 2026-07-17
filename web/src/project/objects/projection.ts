import type { FilamentId } from '../domain/ids';
import { resolveFilament } from '../domain/selectors';
import type {
  ConfigMap,
  FacetAnnotations,
  LayerRange,
  ProjectInstance,
  ProjectObject,
  ProjectPlate,
  ProjectState,
  ProjectVolume,
} from '../domain/model';
import { selectionKey } from '../selection';
import type {
  ObjectTreeDiagnostic,
  ObjectTreeEntityRef,
  ObjectTreeFilamentBadge,
  ObjectTreeIndicators,
  ObjectTreeProjection,
  ObjectTreeProjectionOptions,
  ObjectTreeRow,
  ObjectTreeRowKey,
} from './types';

interface MutableRow extends Omit<ObjectTreeRow, 'childrenKeys'> {
  childrenKeys: ObjectTreeRowKey[];
}

export function projectObjectsTree(
  state: ProjectState,
  options: ObjectTreeProjectionOptions = {},
): ObjectTreeProjection {
  const rows = new Map<ObjectTreeRowKey, MutableRow>();
  const roots: ObjectTreeRowKey[] = [];
  const entityRows = new Map<string, ObjectTreeRowKey>();
  const defaultExpanded = new Set<ObjectTreeRowKey>();

  const add = (row: MutableRow): void => {
    if (rows.has(row.key)) throw new Error(`Duplicate Objects tree row key ${row.key}`);
    rows.set(row.key, row);
    if (row.entity) {
      const key = selectionKey(row.entity);
      if (entityRows.has(key)) throw new Error(`Canonical entity ${key} has multiple primary tree rows`);
      entityRows.set(key, row.key);
    }
    if (row.parentKey) {
      const parent = rows.get(row.parentKey);
      if (!parent) throw new Error(`Objects tree parent ${row.parentKey} must be added first`);
      parent.childrenKeys.push(row.key);
    } else {
      roots.push(row.key);
    }
  };

  for (const plate of [...state.plates].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  )) {
    const plateRef: ObjectTreeEntityRef = { kind: 'plate', id: plate.id };
    const plateKey = entityRowKey(plateRef);
    add(
      row({
        key: plateKey,
        kind: 'plate',
        label: plate.name,
        description: `${plate.objects.length} object${plate.objects.length === 1 ? '' : 's'}`,
        entity: plateRef,
        indicators: indicators(state, plateRef, { printable: plate.printable }, options),
        search: [plate.name, plate.id, 'plate'],
      }),
    );
    defaultExpanded.add(plateKey);

    for (const object of plate.objects) {
      projectObject(state, plate, object, plateKey, add, defaultExpanded, options);
    }
  }

  for (const diagnostic of [...(options.diagnostics ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    addDiagnostic(diagnostic, rows, roots, entityRows, add);
  }

  const frozenRows = new Map<ObjectTreeRowKey, ObjectTreeRow>();
  for (const [key, value] of rows) {
    frozenRows.set(key, Object.freeze({ ...value, childrenKeys: Object.freeze([...value.childrenKeys]) }));
  }
  return {
    rowsByKey: frozenRows,
    rootKeys: Object.freeze([...roots]),
    entityRowKeys: new Map(entityRows),
    defaultExpandedKeys: Object.freeze([...defaultExpanded]),
  };
}

export function entityRowKey(ref: ObjectTreeEntityRef): ObjectTreeRowKey {
  return `${ref.kind}:${ref.id}`;
}

export function objectTreeRowId(key: ObjectTreeRowKey): string {
  return `orcaxr-object-row-${encodeURIComponent(key)}`;
}

function projectObject(
  state: ProjectState,
  plate: ProjectPlate,
  object: ProjectObject,
  plateKey: ObjectTreeRowKey,
  add: (row: MutableRow) => void,
  defaultExpanded: Set<ObjectTreeRowKey>,
  options: ObjectTreeProjectionOptions,
): void {
  const objectRef: ObjectTreeEntityRef = { kind: 'object', id: object.id };
  const objectKey = entityRowKey(objectRef);
  const objectPaint = sumPaint(object.volumes.map((volume) => volume.annotations));
  add(
    row({
      key: objectKey,
      parentKey: plateKey,
      kind: 'object',
      label: object.name,
      description: `${object.volumes.length} part${object.volumes.length === 1 ? '' : 's'}, ${object.instances.length} instance${object.instances.length === 1 ? '' : 's'}`,
      entity: objectRef,
      indicators: indicators(
        state,
        objectRef,
        {
          printable: plate.printable && object.instances.some((instance) => instance.printable),
          filament: filamentBadge(state, object.filamentId, false),
          paint: objectPaint,
        },
        options,
      ),
      search: [object.name, object.id, 'object', ...Object.keys(object.config)],
    }),
  );
  defaultExpanded.add(objectKey);

  for (const volume of object.volumes) projectVolume(state, object, volume, objectKey, add, options);

  const instanceGroupKey = `instance-group:${object.id}`;
  add(
    row({
      key: instanceGroupKey,
      parentKey: objectKey,
      kind: 'instance-group',
      label: `Instances (${object.instances.length})`,
      owner: objectRef,
      indicators: indicators(state, objectRef, { editable: true }, options),
      search: ['instances', object.name],
    }),
  );
  object.instances.forEach((instance, index) =>
    projectInstance(state, plate, object, instance, index, instanceGroupKey, add, options),
  );

  addSettings(state, objectRef, object.config, objectKey, add, options);

  const layerGroupKey = `layer-group:${object.id}`;
  add(
    row({
      key: layerGroupKey,
      parentKey: objectKey,
      kind: 'layer-group',
      label: `Layer ranges (${object.layerRanges.length})`,
      owner: objectRef,
      indicators: indicators(state, objectRef, { editable: true }, options),
      search: ['layer ranges', 'height ranges', object.name],
    }),
  );
  [...object.layerRanges]
    .sort((left, right) => left.minZMm - right.minZMm || left.id.localeCompare(right.id))
    .forEach((range) => projectLayerRange(state, object, range, layerGroupKey, add, options));
}

function projectVolume(
  state: ProjectState,
  object: ProjectObject,
  volume: ProjectVolume,
  objectKey: ObjectTreeRowKey,
  add: (row: MutableRow) => void,
  options: ObjectTreeProjectionOptions,
): void {
  const ref: ObjectTreeEntityRef = { kind: 'volume', id: volume.id };
  const key = entityRowKey(ref);
  const resolved = resolveFilament(object, volume);
  add(
    row({
      key,
      parentKey: objectKey,
      kind: 'volume',
      label: volume.name,
      description: volume.role,
      entity: ref,
      indicators: indicators(
        state,
        ref,
        {
          filament: filamentBadge(state, resolved.effective, !resolved.local && Boolean(resolved.inherited)),
          paint: sumPaint([volume.annotations]),
          settingsCount: Object.keys(volume.config).length,
          volumeRole: volume.role,
        },
        options,
      ),
      search: [volume.name, volume.id, volume.role, ...Object.keys(volume.config)],
    }),
  );
  addSettings(state, ref, volume.config, key, add, options);
}

function projectInstance(
  state: ProjectState,
  plate: ProjectPlate,
  object: ProjectObject,
  instance: ProjectInstance,
  index: number,
  parentKey: ObjectTreeRowKey,
  add: (row: MutableRow) => void,
  options: ObjectTreeProjectionOptions,
): void {
  const ref: ObjectTreeEntityRef = { kind: 'instance', id: instance.id };
  const label = instance.name?.trim() || `Instance ${index + 1}`;
  add(
    row({
      key: entityRowKey(ref),
      parentKey,
      kind: 'instance',
      label,
      entity: ref,
      indicators: indicators(
        state,
        ref,
        {
          printable: plate.printable && instance.printable,
          filament: filamentBadge(state, object.filamentId, true),
        },
        options,
      ),
      search: [label, instance.id, object.name, 'instance'],
    }),
  );
}

function projectLayerRange(
  state: ProjectState,
  object: ProjectObject,
  range: LayerRange,
  parentKey: ObjectTreeRowKey,
  add: (row: MutableRow) => void,
  options: ObjectTreeProjectionOptions,
): void {
  const ref: ObjectTreeEntityRef = { kind: 'layer-range', id: range.id };
  const resolved = resolveFilament(object, range);
  const label = `${formatMm(range.minZMm)}–${formatMm(range.maxZMm)} mm`;
  add(
    row({
      key: entityRowKey(ref),
      parentKey,
      kind: 'layer-range',
      label,
      entity: ref,
      indicators: indicators(
        state,
        ref,
        {
          filament: filamentBadge(state, resolved.effective, !resolved.local && Boolean(resolved.inherited)),
          settingsCount: Object.keys(range.config).length,
        },
        options,
      ),
      search: [label, range.id, 'layer range', 'height range', ...Object.keys(range.config)],
    }),
  );
}

function addSettings(
  state: ProjectState,
  owner: ObjectTreeEntityRef,
  config: ConfigMap,
  parentKey: ObjectTreeRowKey,
  add: (row: MutableRow) => void,
  options: ObjectTreeProjectionOptions,
): void {
  const count = Object.keys(config).length;
  add(
    row({
      key: `settings:${parentKey}`,
      parentKey,
      kind: 'settings',
      label: count === 0 ? 'Settings' : `Settings (${count})`,
      description: count === 0 ? 'Inherited defaults' : `${count} local override${count === 1 ? '' : 's'}`,
      owner,
      indicators: indicators(state, owner, { editable: true, settingsCount: count }, options),
      search: ['settings', 'overrides', ...Object.keys(config)],
    }),
  );
}

function addDiagnostic(
  diagnostic: ObjectTreeDiagnostic,
  rows: Map<ObjectTreeRowKey, MutableRow>,
  _roots: ObjectTreeRowKey[],
  entityRows: Map<string, ObjectTreeRowKey>,
  add: (row: MutableRow) => void,
): void {
  const requestedParent =
    diagnostic.parentKey ?? (diagnostic.entity ? entityRows.get(selectionKey(diagnostic.entity)) : undefined);
  const parentKey = requestedParent && rows.has(requestedParent) ? requestedParent : undefined;
  const kind = diagnostic.severity === 'error' ? 'error' : 'info';
  const key = `diagnostic:${encodeURIComponent(parentKey ?? 'root')}:${kind}:${encodeURIComponent(diagnostic.id)}`;
  add(
    row({
      key,
      parentKey,
      kind,
      label: diagnostic.message,
      description: diagnostic.code,
      owner: diagnostic.entity,
      indicators: { editable: false },
      search: [diagnostic.message, diagnostic.code, diagnostic.severity],
    }),
  );
}

function indicators(
  state: ProjectState,
  entity: ObjectTreeEntityRef,
  base: Partial<ObjectTreeIndicators>,
  options: ObjectTreeProjectionOptions,
): ObjectTreeIndicators {
  const external = options.resolveStatus?.(state, entity);
  return {
    ...base,
    ...(external?.printable === undefined ? {} : { printable: external.printable }),
    ...(external?.sinking === undefined ? {} : { sinking: external.sinking }),
    editable: external?.editable ?? base.editable ?? true,
  };
}

function filamentBadge(
  state: ProjectState,
  id: FilamentId | undefined,
  inherited: boolean,
): ObjectTreeFilamentBadge | undefined {
  if (!id) return undefined;
  const physical = state.filaments.physical.find((filament) => filament.id === id);
  if (physical) return { id, name: physical.name, color: physical.color, mixed: false, inherited };
  const mixed = state.filaments.mixed.find((filament) => filament.id === id);
  return mixed
    ? { id, name: mixed.name, color: mixed.displayColor, mixed: true, inherited }
    : { id, name: 'Missing filament', color: '#808080', mixed: false, inherited };
}

function sumPaint(annotations: readonly FacetAnnotations[]): { colorFacetCount: number; supportFacetCount: number } {
  return {
    colorFacetCount: annotations.reduce(
      (sum, entry) => sum + entry.color.reduce((count, assignment) => count + assignment.triangles.length, 0),
      0,
    ),
    supportFacetCount: annotations.reduce(
      (sum, entry) => sum + entry.support.reduce((count, assignment) => count + assignment.triangles.length, 0),
      0,
    ),
  };
}

function row(input: {
  key: ObjectTreeRowKey;
  kind: MutableRow['kind'];
  label: string;
  indicators: ObjectTreeIndicators;
  search: readonly string[];
  parentKey?: ObjectTreeRowKey;
  description?: string;
  entity?: ObjectTreeEntityRef;
  owner?: ObjectTreeEntityRef;
}): MutableRow {
  return {
    key: input.key,
    id: objectTreeRowId(input.key),
    kind: input.kind,
    parentKey: input.parentKey,
    childrenKeys: [],
    label: input.label,
    description: input.description,
    entity: input.entity,
    owner: input.owner,
    indicators: input.indicators,
    searchText: normalizeSearch([...input.search, input.description ?? ''].join(' ')),
  };
}

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
