import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import { remapFacetChannelValues } from '../domain/facetRefinement';
import type { FilamentId, IdSource, LayerRangeId, ObjectId, PhysicalFilamentId, VolumeId } from '../domain/ids';
import type { MixedFilament, ProjectState } from '../domain/model';
import { findLayerRange, findObject, findVolume } from '../domain/selectors';
import { assertValidProjectState } from '../domain/validation';
import type { CommandContext, ProjectCommand } from '../history/command';

export type FilamentAssignmentTarget =
  | { kind: 'object'; objectId: ObjectId }
  | { kind: 'volume'; objectId: ObjectId; volumeId: VolumeId }
  | { kind: 'layer-range'; objectId: ObjectId; layerRangeId: LayerRangeId };

export interface FilamentAssignmentChange {
  target: FilamentAssignmentTarget;
  /** null explicitly clears the local value so child scopes inherit. */
  filamentId: FilamentId | null;
}

abstract class SnapshotFilamentCommand implements ProjectCommand {
  abstract readonly type: string;
  abstract readonly label: string;
  readonly dirtyCategories = ['projectData'] as const;
  private previous?: ProjectState;
  private next?: ProjectState;

  protected abstract mutate(state: ProjectState): void;

  isNoop(context: CommandContext): boolean {
    const current = context.project.getSnapshot().state;
    const next = this.buildNext(current);
    return canonicalStringify(current) === canonicalStringify(next);
  }

  apply(context: CommandContext): void {
    const current = cloneProjectState(context.project.getSnapshot().state);
    const next = this.buildNext(current);
    this.previous = current;
    this.next = next;
    context.project.replaceState(next, { reason: this.type, dirtyCategories: this.dirtyCategories });
  }

  revert(context: CommandContext): void {
    if (!this.previous) throw new Error(`${this.constructor.name} has not been applied`);
    context.project.replaceState(this.previous, {
      reason: `revert:${this.type}`,
      dirtyCategories: this.dirtyCategories,
    });
  }

  estimateBytes(): number {
    return (
      (this.previous ? canonicalStringify(this.previous).length : 0) +
      (this.next ? canonicalStringify(this.next).length : 1)
    );
  }

  private buildNext(current: ProjectState): ProjectState {
    const next = cloneProjectState(current);
    this.mutate(next);
    assertValidProjectState(next);
    return next;
  }
}

/** One loaded slot the printer reported, mapped to a canonical physical tool. */
export interface PrinterFilamentSlotFacts {
  readonly toolId: number;
  readonly color: string;
  /**
   * The canonical filament type — PLA, PETG, ABS. This becomes `filament_type`
   * in the exported 3MF and is matched against the FullSpectrum compatibility
   * table, so it stays a plain type even when the machine reports a finer
   * grade; the grade goes in `subType`.
   */
  readonly material: string;
  /** The machine's own finer grade, such as Matte or SnapSpeed. Display only. */
  readonly subType?: string;
  readonly vendor?: string;
}

/**
 * A readable name for a slot, or undefined when the machine said nothing worth
 * renaming for.
 *
 * A printer that reports only the bare type would otherwise rename a carefully
 * chosen "Elegoo PLA Matte" to "PLA", which is strictly less information than
 * the project already had. A name is only offered when the machine adds a
 * vendor or a grade on top of the type.
 */
export function printerFilamentSlotName(slot: PrinterFilamentSlotFacts): string | undefined {
  const vendor = slot.vendor?.trim();
  const subType = slot.subType?.trim();
  if (!vendor && !subType) return undefined;
  return [vendor, slot.material.trim(), subType].filter(Boolean).join(' ');
}

/**
 * Adopt the filaments a connected printer says are loaded.
 *
 * Only the facts the machine actually reports are written — colour, type,
 * grade, and vendor. Preset identity is deliberately untouched: the printer
 * knows what is in the slot, not which catalog preset the operator intends to
 * slice with.
 *
 * A slot the project has no tool for is *adopted* when the caller supplies an
 * id source, because "sync with the filaments in my printer" means ending up
 * with those filaments — recolouring only the tools that happen to exist
 * already leaves a four-slot machine half-imported into a one-tool project.
 *
 * The reverse is reported, never done: a tool the printer did not report is
 * left in place. Objects, volumes, and layer ranges may be assigned to it, and
 * deleting it would silently strip those assignments to satisfy a machine that
 * merely has an empty slot.
 */
export class SyncPhysicalFilamentsFromPrinterCommand extends SnapshotFilamentCommand {
  readonly type = 'sync-physical-filaments-from-printer';
  readonly label = 'Sync filaments from printer';
  readonly dirtyCategories = ['projectData'] as const;

  /**
   * @param ids Supplying an id source lets a reported slot with no canonical
   * tool be adopted as a new one. Omitting it keeps the older behaviour of
   * reporting that slot as unmatched and changing nothing.
   */
  constructor(
    private readonly slots: readonly PrinterFilamentSlotFacts[],
    private readonly ids?: IdSource,
  ) {
    super();
    for (const slot of slots) {
      if (!Number.isSafeInteger(slot.toolId) || slot.toolId < 0) {
        throw new Error(`Printer slot tool id ${slot.toolId} must be a non-negative integer`);
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(slot.color)) {
        throw new Error(`Printer slot ${slot.toolId + 1} reported an unusable colour ${slot.color}`);
      }
      if (!slot.material.trim()) {
        throw new Error(`Printer slot ${slot.toolId + 1} reported no material`);
      }
    }
  }

  /** What this command would do, so a caller can report it before applying. */
  static describe(
    state: ProjectState,
    slots: readonly PrinterFilamentSlotFacts[],
    canAdopt = false,
  ): PrinterFilamentSyncSummary {
    const byTool = new Map(state.filaments.physical.map((filament) => [filament.toolId, filament]));
    const reported = new Set(slots.map((slot) => slot.toolId));
    const applied: number[] = [];
    const added: number[] = [];
    const unmatched: number[] = [];
    for (const slot of slots) {
      const filament = byTool.get(slot.toolId);
      if (!filament) {
        (canAdopt ? added : unmatched).push(slot.toolId);
        continue;
      }
      const name = printerFilamentSlotName(slot);
      if (
        filament.color !== slot.color ||
        filament.material !== slot.material ||
        filament.config.filament_type !== slot.material ||
        (name && filament.name !== name)
      ) {
        applied.push(slot.toolId);
      }
    }
    const extra = state.filaments.physical
      .map((filament) => filament.toolId)
      .filter((toolId) => !reported.has(toolId))
      .sort((left, right) => left - right);
    return {
      applied: Object.freeze(applied),
      added: Object.freeze(added.sort((left, right) => left - right)),
      unmatched: Object.freeze(unmatched),
      extra: Object.freeze(extra),
    };
  }

  protected mutate(state: ProjectState): void {
    const byTool = new Map(state.filaments.physical.map((filament) => [filament.toolId, filament]));
    for (const slot of this.slots) {
      const filament = byTool.get(slot.toolId);
      const name = printerFilamentSlotName(slot);
      if (!filament) {
        if (!this.ids) continue;
        state.filaments.physical.push({
          id: this.ids.next<'physical-filament'>('physical-filament'),
          name: name || `Tool ${slot.toolId + 1}`,
          toolId: slot.toolId,
          material: slot.material,
          color: slot.color,
          ...(slot.vendor?.trim() ? { vendor: slot.vendor.trim() } : {}),
          // The same fact in the place the slicer and the profile constraints
          // read it from. A tool carrying only `material` looks to preflight
          // like a tool that declares no type at all.
          config: { filament_type: slot.material },
          enabled: true,
        });
        continue;
      }
      filament.color = slot.color;
      filament.material = slot.material;
      // `filament_type` is where both the exported 3MF and the per-tool profile
      // constraint read the material. Updating only `material` left the two
      // disagreeing, and preflight then rejected the very filament the printer
      // had just reported as loaded — "PLA is not supported on tool 2".
      filament.config.filament_type = slot.material;
      if (name) filament.name = name;
      if (slot.vendor?.trim()) filament.vendor = slot.vendor.trim();
    }
    // Tools stay in slot order so the palette and every tool index agree.
    state.filaments.physical.sort((left, right) => left.toolId - right.toolId);
    // A machine reporting a slot the project has no room for is also reporting
    // how many tools it has. Raising the count is part of adopting the slot;
    // lowering it is not, because a tool that is merely unloaded may still have
    // objects assigned to it.
    const highestTool = state.filaments.physical.reduce((highest, filament) => Math.max(highest, filament.toolId), -1);
    state.printer.toolCount = Math.max(state.printer.toolCount, highestTool + 1);
  }
}

/** What a printer sync changed, adopted, skipped, and left alone. */
export interface PrinterFilamentSyncSummary {
  /** Existing tools whose colour, type, or name the machine disagreed with. */
  readonly applied: readonly number[];
  /** Reported slots with no canonical tool, adopted as new ones. */
  readonly added: readonly number[];
  /** Reported slots with no canonical tool that were left alone. */
  readonly unmatched: readonly number[];
  /** Project tools the printer did not report; kept, never deleted. */
  readonly extra: readonly number[];
}

/** One atomic command for homogeneous or heterogeneous assignment scopes. */
export class SetFilamentAssignmentsCommand extends SnapshotFilamentCommand {
  readonly type: string;
  readonly label: string;
  private readonly assignments: FilamentAssignmentChange[];

  constructor(assignments: readonly FilamentAssignmentChange[], options: { type?: string; label?: string } = {}) {
    super();
    this.assignments = assignments.map((assignment) => cloneJson(assignment));
    const keys = this.assignments.map((assignment) => assignmentTargetKey(assignment.target));
    if (new Set(keys).size !== keys.length) throw new Error('Batch contains duplicate filament assignment targets');
    this.type = options.type ?? 'set-filament-assignments';
    this.label =
      options.label ?? (assignments.length === 1 ? 'Assign filament' : `Assign ${assignments.length} scopes`);
  }

  protected mutate(state: ProjectState): void {
    const destinationIds = new Set(
      this.assignments.flatMap((assignment) => (assignment.filamentId ? [assignment.filamentId] : [])),
    );
    destinationIds.forEach((id) => requireEnabledFilament(state, id));
    for (const assignment of this.assignments) applyAssignment(state, assignment);
  }
}

export class SetObjectFilamentCommand extends SetFilamentAssignmentsCommand {
  constructor(objectId: ObjectId, filamentId: FilamentId | null) {
    super([{ target: { kind: 'object', objectId }, filamentId }], {
      type: 'set-object-filament',
      label: filamentId ? 'Assign object filament' : 'Clear object filament',
    });
  }
}

export class SetVolumeFilamentCommand extends SetFilamentAssignmentsCommand {
  constructor(objectId: ObjectId, volumeId: VolumeId, filamentId: FilamentId | null) {
    super([{ target: { kind: 'volume', objectId, volumeId }, filamentId }], {
      type: 'set-volume-filament',
      label: filamentId ? 'Assign volume filament' : 'Inherit object filament',
    });
  }
}

export class SetLayerRangeFilamentCommand extends SetFilamentAssignmentsCommand {
  constructor(objectId: ObjectId, layerRangeId: LayerRangeId, filamentId: FilamentId | null) {
    super([{ target: { kind: 'layer-range', objectId, layerRangeId }, filamentId }], {
      type: 'set-layer-range-filament',
      label: filamentId ? 'Assign layer-range filament' : 'Inherit object filament',
    });
  }
}

/**
 * Rewrite one or more source filament IDs to one enabled destination without
 * deleting the source definitions. Mixed component collisions are coalesced.
 */
export class RemapFilamentsCommand extends SnapshotFilamentCommand {
  readonly type = 'remap-filaments';
  readonly label: string;
  private readonly sourceIds: FilamentId[];

  constructor(
    sourceIds: readonly FilamentId[],
    private readonly destinationId: FilamentId,
  ) {
    super();
    if (sourceIds.length === 0) throw new Error('Filament remap requires at least one source');
    if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Filament remap sources must be unique');
    if (sourceIds.includes(destinationId)) throw new Error('Filament remap cannot map a source to itself');
    this.sourceIds = [...sourceIds];
    this.label = sourceIds.length === 1 ? 'Remap filament' : `Remap ${sourceIds.length} filaments`;
  }

  protected mutate(state: ProjectState): void {
    requireEnabledFilament(state, this.destinationId);
    this.sourceIds.forEach((id) => requireFilament(state, id));
    const destinationIsPhysical = state.filaments.physical.some((filament) => filament.id === this.destinationId);
    const remapsRecipeComponent = state.filaments.mixed.some((filament) =>
      filament.components.some((component) => this.sourceIds.includes(component.filamentId)),
    );
    if (!destinationIsPhysical && remapsRecipeComponent) {
      throw new Error(
        'Mixed-filament recipe components can only be remapped to a physical filament in Snapmaker v2.3.4',
      );
    }
    const replacements = new Map<FilamentId, FilamentId>(
      this.sourceIds.map((sourceId) => [sourceId, this.destinationId]),
    );

    for (const plate of state.plates) {
      if (plate.wipeTower?.filamentId) {
        plate.wipeTower.filamentId = replacements.get(plate.wipeTower.filamentId) ?? plate.wipeTower.filamentId;
      }
      for (const object of plate.objects) {
        if (object.filamentId) object.filamentId = replacements.get(object.filamentId) ?? object.filamentId;
        for (const volume of object.volumes) {
          if (volume.filamentId) volume.filamentId = replacements.get(volume.filamentId) ?? volume.filamentId;
          // Both halves of the channel are remapped together, because a
          // subdivided facet whose children all became the same filament is no
          // longer subdivided and its value moves to the assignments.
          const remapped = remapFacetChannelValues(
            volume.annotations.color,
            volume.annotations.refinement?.color,
            (value) => replacements.get(value) ?? value,
          );
          volume.annotations.color = remapped.assignments;
          if (volume.annotations.refinement) {
            if (remapped.encoding) volume.annotations.refinement.color = remapped.encoding;
            else {
              delete volume.annotations.refinement.color;
              if (Object.keys(volume.annotations.refinement).length === 0) delete volume.annotations.refinement;
            }
          }
        }
        for (const range of object.layerRanges) {
          if (range.filamentId) range.filamentId = replacements.get(range.filamentId) ?? range.filamentId;
        }
      }
    }
    state.filaments.mixed.forEach((filament) => remapMixedComponents(filament, replacements));
  }
}

/**
 * Reversible tombstone semantics. Definitions and all stable references stay
 * present because canonical deletion is unsafe without a reference/GC policy.
 */
export class SetFilamentEnabledCommand extends SnapshotFilamentCommand {
  readonly type = 'set-filament-enabled';
  readonly label: string;

  constructor(
    private readonly filamentId: FilamentId,
    private readonly enabled: boolean,
    private readonly reason = 'user',
  ) {
    super();
    this.label = enabled ? 'Enable filament' : 'Disable filament';
  }

  protected mutate(state: ProjectState): void {
    const filament = requireFilament(state, this.filamentId);
    filament.enabled = this.enabled;
    if (this.enabled) {
      if (filament.extensionData?.orcaxrFilamentLifecycle !== undefined) {
        const extensionData = { ...filament.extensionData };
        delete extensionData.orcaxrFilamentLifecycle;
        filament.extensionData = Object.keys(extensionData).length > 0 ? extensionData : undefined;
      }
    } else {
      filament.extensionData = {
        ...filament.extensionData,
        orcaxrFilamentLifecycle: {
          state: 'disabled',
          reason: this.reason,
          semantics: 'tombstone-preserve-references',
        },
      };
    }
  }
}

export class DisableFilamentCommand extends SetFilamentEnabledCommand {
  constructor(filamentId: FilamentId, reason = 'user') {
    super(filamentId, false, reason);
  }
}

function applyAssignment(state: ProjectState, assignment: FilamentAssignmentChange): void {
  const { target, filamentId } = assignment;
  switch (target.kind) {
    case 'object': {
      const found = findObject(state, target.objectId);
      if (!found) throw new Error(`Unknown object ${target.objectId}`);
      if (filamentId) found.object.filamentId = filamentId;
      else delete found.object.filamentId;
      return;
    }
    case 'volume': {
      const found = findVolume(state, target.volumeId);
      if (!found) throw new Error(`Unknown volume ${target.volumeId}`);
      if (found.object.id !== target.objectId) {
        throw new Error(`Volume ${target.volumeId} is not owned by object ${target.objectId}`);
      }
      if (filamentId) found.volume.filamentId = filamentId;
      else delete found.volume.filamentId;
      return;
    }
    case 'layer-range': {
      const found = findLayerRange(state, target.layerRangeId);
      if (!found) throw new Error(`Unknown layer range ${target.layerRangeId}`);
      if (found.object.id !== target.objectId) {
        throw new Error(`Layer range ${target.layerRangeId} is not owned by object ${target.objectId}`);
      }
      if (filamentId) found.layerRange.filamentId = filamentId;
      else delete found.layerRange.filamentId;
    }
  }
}

function remapMixedComponents(filament: MixedFilament, replacements: ReadonlyMap<FilamentId, FilamentId>): void {
  if (!filament.components.some((component) => replacements.has(component.filamentId))) return;
  const gradient = filament.distribution.mode === 'gradient' ? filament.distribution : undefined;
  const groups = new Map<
    PhysicalFilamentId,
    { filamentId: PhysicalFilamentId; weight: number; startWeight: number; endWeight: number }
  >();
  filament.components.forEach((component, index) => {
    const filamentId = (replacements.get(component.filamentId) ?? component.filamentId) as PhysicalFilamentId;
    const existing = groups.get(filamentId);
    const startWeight = gradient?.startWeights[index] ?? 0;
    const endWeight = gradient?.endWeights[index] ?? 0;
    if (existing) {
      existing.weight += component.weight;
      existing.startWeight += startWeight;
      existing.endWeight += endWeight;
    } else {
      groups.set(filamentId, { filamentId, weight: component.weight, startWeight, endWeight });
    }
  });
  const merged = [...groups.values()];
  filament.components = merged.map(({ filamentId, weight }) => ({ filamentId, weight }));
  if (gradient) {
    filament.distribution = {
      ...gradient,
      startWeights: merged.map((component) => component.startWeight),
      endWeights: merged.map((component) => component.endWeight),
    };
  }
}

function requireEnabledFilament(state: ProjectState, id: FilamentId) {
  const filament = requireFilament(state, id);
  if (!filament.enabled) throw new Error(`Destination filament ${id} is disabled`);
  return filament;
}

function requireFilament(state: ProjectState, id: FilamentId) {
  const filament = [...state.filaments.physical, ...state.filaments.mixed].find((candidate) => candidate.id === id);
  if (!filament) throw new Error(`Unknown filament ${id}`);
  return filament;
}

function assignmentTargetKey(target: FilamentAssignmentTarget): string {
  switch (target.kind) {
    case 'object':
      return `object:${target.objectId}`;
    case 'volume':
      return `volume:${target.objectId}:${target.volumeId}`;
    case 'layer-range':
      return `layer-range:${target.objectId}:${target.layerRangeId}`;
  }
}
