import { canonicalStringify, cloneJson, cloneProjectState, deepFreeze } from '../domain/canonical';
import type { MixedFilamentId, PhysicalFilamentId } from '../domain/ids';
import type { MixedFilament, PhysicalFilament } from '../domain/model';
import { assertValidProjectState } from '../domain/validation';
import type { CommandContext, ProjectCommand } from '../history/command';
import {
  regenerateFullSpectrumAutoPairs,
  type FullSpectrumAutoPairAllocatedIdentity,
  type FullSpectrumAutoPairIdentityAllocator,
  type FullSpectrumAutoPairProjectionRow,
  type FullSpectrumAutoPairTombstoneSuppression,
} from './autoPairProjection';
import { blendPairFilamentPigment } from './filamentPigmentMixer';

export interface FullSpectrumAutoPairReconciliation {
  readonly filaments: readonly MixedFilament[];
  readonly changed: boolean;
  readonly createdRowIds: readonly MixedFilamentId[];
  readonly droppedRowIds: readonly MixedFilamentId[];
  readonly tombstoneSuppressions: readonly FullSpectrumAutoPairTombstoneSuppression[];
}

/** Persisted app preference corresponding to pinned `auto_generate_gradients`. */
export interface FullSpectrumAutoPairGenerationPreferences {
  readonly enabled: boolean;
}

export interface FullSpectrumAutoPairReconciliationGuard {
  readonly expectedRevision: number;
  readonly sourceHash: string;
}

export class StaleFullSpectrumAutoPairReconciliationError extends Error {
  override readonly name = 'StaleFullSpectrumAutoPairReconciliationError';

  constructor() {
    super('Auto-pair reconciliation was prepared for a stale canonical project revision');
  }
}

/**
 * Project-model adapter around the stable-ID lifecycle projection.
 *
 * Non-custom rows are rebuilt with the pinned manager's default 1:1/50% Simple
 * fields, while canonical identity, enabled/deleted state, config, and opaque
 * extension metadata survive. Authored/custom rows retain their complete
 * recipe data and input order. Legacy rows without exact FullSpectrum state
 * remain after the exact custom section in their original relative order.
 */
export function reconcileFullSpectrumAutoPairFilaments(
  physicalFilaments: readonly PhysicalFilament[],
  existingFilaments: readonly MixedFilament[],
  allocateIdentity: FullSpectrumAutoPairIdentityAllocator,
): FullSpectrumAutoPairReconciliation {
  const physicalIds = physicalFilaments.map((filament) => filament.id);
  const exactRows = existingFilaments.flatMap((filament) => {
    const recipe = filament.fullSpectrum;
    if (!recipe) return [];
    return [
      {
        id: filament.id,
        componentAId: recipe.componentAId,
        componentBId: recipe.componentBId,
        upstreamStableId: recipe.upstreamStableId,
        enabled: filament.enabled,
        deleted: recipe.deleted,
        custom: recipe.custom,
        originAuto: recipe.originAuto,
      } satisfies FullSpectrumAutoPairProjectionRow,
    ];
  });
  const projection = regenerateFullSpectrumAutoPairs(physicalIds, exactRows, allocateIdentity);
  const physicalById = new Map(physicalFilaments.map((filament) => [filament.id, filament]));
  const existingById = new Map(existingFilaments.map((filament) => [filament.id, filament]));
  const projectedById = new Map<MixedFilamentId, MixedFilament>();

  for (const row of projection.autoPairRows) {
    const existing = existingById.get(row.id);
    projectedById.set(
      row.id,
      row.custom
        ? updateCustomLifecycle(requireExactFilament(existing, row.id), row)
        : buildPinnedAutoPair(row, physicalById, existing),
    );
  }
  for (const row of projection.customRows) {
    projectedById.set(row.id, updateCustomLifecycle(requireExactFilament(existingById.get(row.id), row.id), row));
  }

  const autoRows = projection.autoPairRows.map((row) => projectedById.get(row.id)!);
  const customIds = new Set(projection.customRows.map((row) => row.id));
  const customAndLegacyRows: MixedFilament[] = [];
  for (const existing of existingFilaments) {
    if (!existing.fullSpectrum) {
      customAndLegacyRows.push(cloneJson(existing));
      continue;
    }
    if (customIds.has(existing.id)) customAndLegacyRows.push(projectedById.get(existing.id)!);
  }
  const filaments = [...autoRows, ...customAndLegacyRows];
  return deepFreeze({
    filaments,
    changed: canonicalStringify(existingFilaments) !== canonicalStringify(filaments),
    createdRowIds: [...projection.createdRowIds],
    droppedRowIds: [...projection.droppedRowIds],
    tombstoneSuppressions: projection.tombstoneSuppressions.map((suppression) => ({ ...suppression })),
  }) as FullSpectrumAutoPairReconciliation;
}

/** Reconcile one guarded canonical revision as one reversible history entry. */
export class ReconcileFullSpectrumAutoPairsCommand implements ProjectCommand {
  readonly type = 'reconcile-full-spectrum-auto-pairs';
  readonly dirtyCategories = ['projectData'] as const;
  private readonly nextFilaments: MixedFilament[];
  private previousFilaments?: MixedFilament[];

  constructor(
    private readonly guard: FullSpectrumAutoPairReconciliationGuard,
    filaments: readonly MixedFilament[],
    readonly label = 'Reconcile automatic virtual filaments',
  ) {
    this.nextFilaments = filaments.map((filament) => cloneJson(filament));
  }

  isNoop(context: CommandContext): boolean {
    this.assertInitialGuard(context);
    return (
      canonicalStringify(context.project.getSnapshot().state.filaments.mixed) === canonicalStringify(this.nextFilaments)
    );
  }

  apply(context: CommandContext): void {
    const current = context.project.getSnapshot();
    if (!this.previousFilaments) {
      this.assertInitialGuard(context);
      this.previousFilaments = cloneJson(current.state.filaments.mixed);
    } else if (canonicalStringify(current.state.filaments.mixed) !== canonicalStringify(this.previousFilaments)) {
      throw new Error('Automatic virtual filaments changed after reconciliation was prepared');
    }
    replaceMixedFilaments(context, this.nextFilaments, this.type);
  }

  revert(context: CommandContext): void {
    if (!this.previousFilaments) {
      throw new Error('ReconcileFullSpectrumAutoPairsCommand has not been applied');
    }
    replaceMixedFilaments(context, this.previousFilaments, `revert:${this.type}`);
  }

  estimateBytes(): number {
    return (
      canonicalStringify(this.nextFilaments).length +
      (this.previousFilaments ? canonicalStringify(this.previousFilaments).length : 1)
    );
  }

  private assertInitialGuard(context: CommandContext): void {
    const current = context.project.getSnapshot();
    if (current.revision !== this.guard.expectedRevision || current.hash !== this.guard.sourceHash) {
      throw new StaleFullSpectrumAutoPairReconciliationError();
    }
  }
}

export function allocateFullSpectrumAutoPairIdentity(
  createId: () => MixedFilamentId,
  createUpstreamStableId: (id: MixedFilamentId) => string,
): FullSpectrumAutoPairIdentityAllocator {
  return () => {
    const id = createId();
    return Object.freeze({
      id,
      upstreamStableId: createUpstreamStableId(id),
    } satisfies FullSpectrumAutoPairAllocatedIdentity);
  };
}

function buildPinnedAutoPair(
  row: FullSpectrumAutoPairProjectionRow,
  physicalById: ReadonlyMap<PhysicalFilamentId, PhysicalFilament>,
  existing: MixedFilament | undefined,
): MixedFilament {
  const componentA = requirePhysical(physicalById, row.componentAId);
  const componentB = requirePhysical(physicalById, row.componentBId);
  return {
    id: row.id,
    name: existing?.name ?? `Mixed Filament ${componentA.name} + ${componentB.name}`,
    displayColor: blendPairFilamentPigment(componentA.color, componentB.color, 0.5),
    components: [
      { filamentId: componentA.id, weight: 50 },
      { filamentId: componentB.id, weight: 50 },
    ],
    distribution: { mode: 'ratio' },
    fullSpectrum: {
      schemaVersion: 1,
      upstreamStableId: row.upstreamStableId,
      uiMode: -1,
      componentAId: componentA.id,
      componentBId: componentB.id,
      ratioA: 1,
      ratioB: 1,
      mixBPercent: 50,
      manualPatternGroups: [],
      gradientComponentIds: [],
      gradientComponentWeights: [],
      pointillismAllFilaments: false,
      distributionMode: 2,
      localZMaxSublayers: 0,
      gradientEnabled: false,
      gradientStart: 0.8,
      gradientEnd: 0.2,
      componentASurfaceOffsetMm: 0,
      componentBSurfaceOffsetMm: 0,
      deleted: row.deleted,
      custom: false,
      originAuto: true,
    },
    config: cloneJson(existing?.config ?? {}),
    enabled: row.enabled,
    ...(existing?.extensionData ? { extensionData: cloneJson(existing.extensionData) } : {}),
  };
}

function updateCustomLifecycle(existing: MixedFilament, row: FullSpectrumAutoPairProjectionRow): MixedFilament {
  const next = cloneJson(existing);
  const recipe = next.fullSpectrum;
  if (!recipe) throw new Error(`Mixed filament ${row.id} lost its exact FullSpectrum state`);
  next.enabled = row.enabled;
  recipe.componentAId = row.componentAId;
  recipe.componentBId = row.componentBId;
  recipe.upstreamStableId = row.upstreamStableId;
  recipe.deleted = row.deleted;
  recipe.custom = row.custom;
  recipe.originAuto = row.originAuto;
  return next;
}

function requirePhysical(
  physicalById: ReadonlyMap<PhysicalFilamentId, PhysicalFilament>,
  id: PhysicalFilamentId,
): PhysicalFilament {
  const physical = physicalById.get(id);
  if (!physical) throw new Error(`Auto-pair projection references missing physical filament ${id}`);
  return physical;
}

function requireExactFilament(filament: MixedFilament | undefined, id: MixedFilamentId): MixedFilament {
  if (!filament?.fullSpectrum) throw new Error(`Auto-pair projection references missing exact filament ${id}`);
  return filament;
}

function replaceMixedFilaments(context: CommandContext, mixed: readonly MixedFilament[], reason: string): void {
  const next = cloneProjectState(context.project.getSnapshot().state);
  next.filaments.mixed = mixed.map((filament) => cloneJson(filament));
  assertValidProjectState(next);
  context.project.replaceState(next, { reason, dirtyCategories: ['projectData'] });
}
