/**
 * Which filament each selected scope prints with, and which filaments the
 * project offers: the snapshot the inspector's assignment selector, the
 * selection's one-click filament bar and the headset's swatch row all read
 * (`CanonicalWorkspaceController.getFilamentAssignmentSnapshot`), and the
 * assignment a choice makes of it (`setFilamentAssignments`).
 *
 * Platform-free: the shared Rust core answers the same questions
 * (`orcaxr_project::filaments::assignment`), pinned against this module by
 * `filament-assignment-vectors.json` through `FilamentAssignmentExchange.ts`.
 */
import { compareCanonicalText } from '../project/domain/canonical';
import type { FilamentId, ObjectId, PhysicalFilamentId } from '../project/domain/ids';
import type { MixedFilament, ProjectState } from '../project/domain/model';
import { findInstance, findLayerRange, findObject, findVolume, resolveFilament } from '../project/domain/selectors';
import type { FilamentAssignmentChange } from '../project/filaments/commands';
import type { ObjectTreeEntityRef } from '../project/objects/types';

export type CanonicalFilamentAssignableEntityRef = Extract<
  ObjectTreeEntityRef,
  { kind: 'object' | 'volume' | 'layer-range' }
>;

export interface CanonicalFilamentOption {
  readonly id: FilamentId;
  readonly kind: 'physical' | 'mixed';
  readonly name: string;
  readonly color: string;
  readonly enabled: boolean;
  readonly material?: string;
  readonly presetId?: string;
  readonly toolId?: number;
  readonly distributionMode?: MixedFilament['distribution']['mode'];
  readonly recipe: readonly {
    /** Recipes always reference stable physical-head IDs, never virtual rows. */
    readonly filamentId: PhysicalFilamentId;
    readonly name: string;
    readonly color: string;
    readonly weight: number;
  }[];
  readonly warnings: readonly string[];
}

export interface CanonicalFilamentAssignmentScope {
  readonly entity: CanonicalFilamentAssignableEntityRef;
  readonly objectId: ObjectId;
  readonly label: string;
  readonly localFilamentId?: FilamentId;
  readonly inheritedFilamentId?: FilamentId;
  readonly effectiveFilamentId?: FilamentId;
}

/** The snapshot without the revision guard the controller stamps on it. */
export interface FilamentAssignmentResolution {
  readonly scopes: readonly CanonicalFilamentAssignmentScope[];
  readonly unsupportedSelection: readonly ObjectTreeEntityRef[];
  readonly options: readonly CanonicalFilamentOption[];
}

/**
 * Resolve assignable scopes for `refs` against `state`. An instance stands
 * for its object (upstream has no per-copy filament), so a multi-copy
 * selection collapses to the one scope it is; a plate, or an instance whose
 * object no longer exists, stays explicit as unsupported so a UI cannot
 * silently apply to only part of a selection. An object, part or height range
 * the project lacks throws.
 */
export function filamentAssignmentResolution(
  state: ProjectState,
  refs: readonly ObjectTreeEntityRef[],
): FilamentAssignmentResolution {
  const scopes: CanonicalFilamentAssignmentScope[] = [];
  const unsupportedSelection: ObjectTreeEntityRef[] = [];
  const seen = new Set<string>();
  for (const requested of refs) {
    const ref = instanceAssignmentScopeRef(state, requested);
    const key = objectTreeEntityKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = resolveFilamentAssignmentScope(state, ref);
    if (scope) scopes.push(scope);
    else unsupportedSelection.push(Object.freeze({ ...ref }));
  }
  return Object.freeze({
    scopes: Object.freeze(scopes),
    unsupportedSelection: Object.freeze(unsupportedSelection),
    options: canonicalFilamentOptions(state),
  });
}

/**
 * The assignment changes that give every entity `filamentId` (null removes
 * each one's local assignment), checked as the controller checks them before
 * submitting one command: at least one scope, a destination the project has
 * and has enabled, entities it has.
 */
export function filamentAssignmentChanges(
  state: ProjectState,
  entities: readonly CanonicalFilamentAssignableEntityRef[],
  filamentId: FilamentId | null,
): FilamentAssignmentChange[] {
  if (entities.length === 0) throw new Error('Filament assignment requires at least one assignable scope');
  if (filamentId) {
    const destination = [...state.filaments.physical, ...state.filaments.mixed].find(
      (candidate) => candidate.id === filamentId,
    );
    if (!destination) throw new Error(`Unknown filament ${filamentId}`);
    if (!destination.enabled) throw new Error(`Destination filament ${filamentId} is disabled`);
  }
  return entities.map((entity) => filamentAssignmentChange(state, entity, filamentId));
}

/**
 * Every filament the project offers: physical heads by tool, then mixed
 * recipes by name, ties by ID — in code-unit order, so the list reads the
 * same in every browser language.
 */
export function canonicalFilamentOptions(state: ProjectState): readonly CanonicalFilamentOption[] {
  const physicalById = new Map(state.filaments.physical.map((filament) => [filament.id, filament]));
  const physical = [...state.filaments.physical]
    .sort((left, right) => left.toolId - right.toolId || compareCanonicalText(left.id, right.id))
    .map((filament): CanonicalFilamentOption => {
      const warnings: string[] = [];
      if (!filament.enabled) warnings.push('This physical filament is disabled.');
      if (filament.toolId < 0 || filament.toolId >= state.printer.toolCount) {
        warnings.push(`Tool ${filament.toolId} is outside the printer's configured head range.`);
      }
      if (!filament.presetId) warnings.push('No filament preset snapshot is linked to this head.');
      return Object.freeze({
        id: filament.id,
        kind: 'physical',
        name: filament.name,
        color: filament.color,
        enabled: filament.enabled,
        material: filament.material,
        ...(filament.presetId ? { presetId: filament.presetId } : {}),
        toolId: filament.toolId,
        recipe: Object.freeze([]),
        warnings: Object.freeze(warnings),
      });
    });
  const mixed = [...state.filaments.mixed]
    .sort((left, right) => compareCanonicalText(left.name, right.name) || compareCanonicalText(left.id, right.id))
    .map((filament): CanonicalFilamentOption => {
      const warnings: string[] = [];
      if (!filament.enabled) warnings.push('This virtual filament is disabled.');
      const recipe = filament.components.map((component) => {
        const physicalFilament = physicalById.get(component.filamentId);
        if (!physicalFilament) warnings.push(`Recipe component ${component.filamentId} is missing.`);
        else if (!physicalFilament.enabled) warnings.push(`Recipe component ${physicalFilament.name} is disabled.`);
        return Object.freeze({
          filamentId: component.filamentId,
          name: physicalFilament?.name ?? 'Missing physical filament',
          color: physicalFilament?.color ?? '#808080',
          weight: component.weight,
        });
      });
      const materials = [
        ...new Set(
          filament.components.flatMap((component) => {
            const material = physicalById.get(component.filamentId)?.material;
            return material ? [material] : [];
          }),
        ),
      ].sort();
      if (materials.length > 1) {
        warnings.push(`Recipe combines ${materials.join(' and ')}; verify material compatibility before slicing.`);
      }
      return Object.freeze({
        id: filament.id,
        kind: 'mixed',
        name: filament.name,
        color: filament.displayColor,
        enabled: filament.enabled,
        ...(materials.length > 0 ? { material: materials.join(' + ') } : {}),
        distributionMode: filament.distribution.mode,
        recipe: Object.freeze(recipe),
        warnings: Object.freeze(warnings),
      });
    });
  return Object.freeze([...physical, ...mixed]);
}

/**
 * The ref a filament assignment should act on: an instance stands for the
 * object it is a copy of, everything else stands for itself. An instance whose
 * object no longer exists stays an instance and is reported unsupported.
 */
function instanceAssignmentScopeRef(state: ProjectState, ref: ObjectTreeEntityRef): ObjectTreeEntityRef {
  if (ref.kind !== 'instance') return ref;
  const found = findInstance(state, ref.id);
  return found ? { kind: 'object', id: found.object.id } : ref;
}

function resolveFilamentAssignmentScope(
  state: ProjectState,
  ref: ObjectTreeEntityRef,
): CanonicalFilamentAssignmentScope | undefined {
  switch (ref.kind) {
    case 'object': {
      const found = findObject(state, ref.id);
      if (!found) throw new Error(`Unknown object ${ref.id}`);
      return freezeFilamentAssignmentScope({
        entity: ref,
        objectId: found.object.id,
        label: found.object.name,
        localFilamentId: found.object.filamentId,
        effectiveFilamentId: found.object.filamentId,
      });
    }
    case 'volume': {
      const found = findVolume(state, ref.id);
      if (!found) throw new Error(`Unknown volume ${ref.id}`);
      const resolved = resolveFilament(found.object, found.volume);
      return freezeFilamentAssignmentScope({
        entity: ref,
        objectId: found.object.id,
        label: `${found.object.name} / ${found.volume.name}`,
        localFilamentId: resolved.local,
        inheritedFilamentId: resolved.inherited,
        effectiveFilamentId: resolved.effective,
      });
    }
    case 'layer-range': {
      const found = findLayerRange(state, ref.id);
      if (!found) throw new Error(`Unknown layer-range ${ref.id}`);
      const resolved = resolveFilament(found.object, found.layerRange);
      return freezeFilamentAssignmentScope({
        entity: ref,
        objectId: found.object.id,
        label: `${found.object.name} / ${formatZ(found.layerRange.minZMm)}–${formatZ(found.layerRange.maxZMm)} mm`,
        localFilamentId: resolved.local,
        inheritedFilamentId: resolved.inherited,
        effectiveFilamentId: resolved.effective,
      });
    }
    case 'plate':
    case 'instance':
      return undefined;
  }
}

function freezeFilamentAssignmentScope(scope: CanonicalFilamentAssignmentScope): CanonicalFilamentAssignmentScope {
  return Object.freeze({
    entity: Object.freeze({ ...scope.entity }),
    objectId: scope.objectId,
    label: scope.label,
    ...(scope.localFilamentId ? { localFilamentId: scope.localFilamentId } : {}),
    ...(scope.inheritedFilamentId ? { inheritedFilamentId: scope.inheritedFilamentId } : {}),
    ...(scope.effectiveFilamentId ? { effectiveFilamentId: scope.effectiveFilamentId } : {}),
  });
}

function filamentAssignmentChange(
  state: ProjectState,
  entity: CanonicalFilamentAssignableEntityRef,
  filamentId: FilamentId | null,
): FilamentAssignmentChange {
  switch (entity.kind) {
    case 'object': {
      const found = findObject(state, entity.id);
      if (!found) throw new Error(`Unknown object ${entity.id}`);
      return { target: { kind: 'object', objectId: found.object.id }, filamentId };
    }
    case 'volume': {
      const found = findVolume(state, entity.id);
      if (!found) throw new Error(`Unknown volume ${entity.id}`);
      return {
        target: { kind: 'volume', objectId: found.object.id, volumeId: found.volume.id },
        filamentId,
      };
    }
    case 'layer-range': {
      const found = findLayerRange(state, entity.id);
      if (!found) throw new Error(`Unknown layer-range ${entity.id}`);
      return {
        target: {
          kind: 'layer-range',
          objectId: found.object.id,
          layerRangeId: found.layerRange.id,
        },
        filamentId,
      };
    }
    default:
      throw new Error(`Unsupported filament assignment scope ${String((entity as ObjectTreeEntityRef).kind)}`);
  }
}

function objectTreeEntityKey(ref: ObjectTreeEntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

function formatZ(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}
