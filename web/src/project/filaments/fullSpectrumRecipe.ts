/**
 * Stable canonical adapter for Snapmaker OrcaSlicer v2.3.4 FullSpectrum rows.
 *
 * The project graph keeps physical filament IDs. One-based row numbers exist
 * only inside `serializeFullSpectrumDefinition`, where they are rebuilt from
 * the current physical order. This is what makes physical-row reorder safe.
 */

import { cloneJson, fnv1a64 } from '../domain/canonical';
import type { MixedFilamentId, PhysicalFilamentId } from '../domain/ids';
import type {
  FullSpectrumRecipeState,
  MixedComponent,
  MixedDistribution,
  MixedFilament,
  PhysicalFilament,
} from '../domain/model';
import {
  requireMixedFilamentAuthoring,
  type GradientAuthoringInput,
  type MatchAuthoringInput,
  type MixedFilamentSerializableProjection,
  type RatioAuthoringInput,
} from './mixedFilamentAuthoring';
import { inspectFullSpectrumCompatibility } from './fullSpectrumCompatibility';

export const FULL_SPECTRUM_ENGINE_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626';
export const FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM = 2;

interface FullSpectrumDraftBase {
  readonly name: string;
  readonly displayColor: string;
  readonly enabled?: boolean;
  readonly componentASurfaceOffsetMm?: number;
  readonly componentBSurfaceOffsetMm?: number;
}

export interface FullSpectrumRatioDraft extends FullSpectrumDraftBase {
  readonly mode: 'ratio';
  readonly componentFilamentIds: readonly PhysicalFilamentId[];
  readonly mixBPercent: number;
  readonly triangleWeightsPercent?: readonly number[];
}

export interface FullSpectrumCycleDraft extends FullSpectrumDraftBase {
  readonly mode: 'cycle';
  /** Exact perimeter groups and sequence, already mapped to stable physical IDs. */
  readonly manualPatternGroups: readonly (readonly PhysicalFilamentId[])[];
}

export interface FullSpectrumMatchDraft extends FullSpectrumDraftBase {
  readonly mode: 'match';
  readonly components: readonly { readonly filamentId: PhysicalFilamentId; readonly weight: number }[];
  readonly targetColor: string;
  readonly minComponentPercent: number;
}

export interface FullSpectrumGradientDraft extends FullSpectrumDraftBase {
  readonly mode: 'gradient';
  readonly componentFilamentIds: readonly [PhysicalFilamentId, PhysicalFilamentId];
  readonly direction: 'a-to-b' | 'b-to-a';
  readonly localZMaxSublayers: number;
}

export type FullSpectrumRecipeDraft =
  FullSpectrumRatioDraft | FullSpectrumCycleDraft | FullSpectrumMatchDraft | FullSpectrumGradientDraft;

export class FullSpectrumRecipeValidationError extends Error {
  override readonly name = 'FullSpectrumRecipeValidationError';

  constructor(message: string) {
    super(message);
  }
}

/** Build a complete canonical row without mutating project or draft input. */
export function createFullSpectrumMixedFilament(
  id: MixedFilamentId,
  physicalFilaments: readonly PhysicalFilament[],
  draft: FullSpectrumRecipeDraft,
  upstreamStableId = fullSpectrumStableNumericId(id),
): MixedFilament {
  const name = draft.name.trim();
  const displayColor = normalizeDisplayColor(draft.displayColor);
  if (!name) throw new FullSpectrumRecipeValidationError('Virtual filament name cannot be empty');
  validateOffsets(draft);
  validatePhysicalLibrary(physicalFilaments);
  validateUnsigned64(upstreamStableId);

  const built =
    draft.mode === 'ratio'
      ? buildRatio(physicalFilaments, draft)
      : draft.mode === 'cycle'
        ? buildCycle(physicalFilaments, draft)
        : draft.mode === 'match'
          ? buildMatch(physicalFilaments, draft)
          : buildGradient(physicalFilaments, draft);
  const compatibilityIds =
    built.fullSpectrum.manualPatternGroups.length > 0
      ? built.fullSpectrum.manualPatternGroups.flat()
      : [built.fullSpectrum.componentAId, built.fullSpectrum.componentBId, ...built.fullSpectrum.gradientComponentIds];
  const compatibility = inspectFullSpectrumCompatibility(physicalFilaments, compatibilityIds);
  if (!compatibility.allowed) throw new FullSpectrumRecipeValidationError(compatibility.reason);

  return {
    id,
    name,
    displayColor,
    components: built.components.map((component) => ({ ...component })),
    distribution: cloneDistribution(built.distribution),
    fullSpectrum: {
      ...built.fullSpectrum,
      upstreamStableId,
      componentASurfaceOffsetMm: draft.componentASurfaceOffsetMm ?? 0,
      componentBSurfaceOffsetMm: draft.componentBSurfaceOffsetMm ?? 0,
    },
    config: {},
    enabled: draft.enabled ?? true,
  };
}

/** Preserve identity/config/opaque metadata while replacing every authored field. */
export function replaceFullSpectrumMixedFilament(
  current: MixedFilament,
  physicalFilaments: readonly PhysicalFilament[],
  draft: FullSpectrumRecipeDraft,
): MixedFilament {
  const replacement = createFullSpectrumMixedFilament(
    current.id,
    physicalFilaments,
    draft,
    current.fullSpectrum?.upstreamStableId ?? fullSpectrumStableNumericId(current.id),
  );
  replacement.config = { ...current.config };
  if (current.extensionData) replacement.extensionData = cloneJson(current.extensionData);
  if (draft.enabled === undefined) replacement.enabled = current.enabled;
  if (replacement.fullSpectrum && current.fullSpectrum?.originAuto) {
    replacement.fullSpectrum.originAuto = true;
  }
  return replacement;
}

/**
 * Map parsed one-based Cycle groups to stable IDs. No user sequence is
 * normalized, flattened, sorted, or deduplicated.
 */
export function stableCycleGroupsFromToolIds(
  physicalFilaments: readonly PhysicalFilament[],
  groups: readonly (readonly number[])[],
): readonly (readonly PhysicalFilamentId[])[] {
  validatePhysicalLibrary(physicalFilaments);
  if (groups.length === 0 || groups.some((group) => group.length === 0)) {
    throw new FullSpectrumRecipeValidationError('Cycle needs at least one non-empty perimeter group');
  }
  return Object.freeze(
    groups.map((group, groupIndex) =>
      Object.freeze(
        group.map((toolId, tokenIndex) => {
          if (!Number.isSafeInteger(toolId) || toolId < 1 || toolId > physicalFilaments.length) {
            throw new FullSpectrumRecipeValidationError(
              `Cycle group ${groupIndex + 1} token ${tokenIndex + 1} references unknown physical tool ${toolId}`,
            );
          }
          return physicalFilaments[toolId - 1].id;
        }),
      ),
    ),
  );
}

/** Exact field order emitted by `MixedFilamentManager::serialize_custom_entries`. */
export function serializeFullSpectrumDefinition(
  filament: MixedFilament,
  physicalFilaments: readonly PhysicalFilament[],
): string {
  const recipe = filament.fullSpectrum;
  if (!recipe) throw new FullSpectrumRecipeValidationError(`Mixed filament ${filament.id} has no exact engine state`);
  validatePhysicalLibrary(physicalFilaments);
  validateUnsigned64(recipe.upstreamStableId);
  const slots = physicalSlotMap(physicalFilaments);

  let componentAId = recipe.componentAId;
  let componentBId = recipe.componentBId;
  if (recipe.manualPatternGroups.length > 0) {
    [componentAId, componentBId] = cycleEnginePair(recipe.manualPatternGroups, physicalFilaments);
  }
  const componentA = requirePhysicalSlot(slots, componentAId, 'component A');
  const componentB = requirePhysicalSlot(slots, componentBId, 'component B');
  if (componentA === componentB) throw new FullSpectrumRecipeValidationError('Component A and B must be different');

  const gradientSlots = recipe.gradientComponentIds.map((id, index) =>
    requirePhysicalSlot(slots, id, `gradient component ${index + 1}`),
  );
  const pattern = encodeStablePattern(recipe.manualPatternGroups, slots, componentAId, componentBId);
  const mixBPercent =
    recipe.manualPatternGroups.length > 0
      ? cycleMixBPercent(recipe.manualPatternGroups, componentBId)
      : recipe.mixBPercent;
  const row = [
    String(componentA),
    String(componentB),
    filament.enabled ? '1' : '0',
    recipe.custom ? '1' : '0',
    String(mixBPercent),
    '0',
    `g${encodeGradientComponentIds(gradientSlots)}`,
    `w${recipe.gradientComponentWeights.join('/')}`,
    `m${recipe.distributionMode}`,
    `z${recipe.localZMaxSublayers}`,
    `xa${formatSurfaceOffset(recipe.componentASurfaceOffsetMm)}`,
    `xb${formatSurfaceOffset(recipe.componentBSurfaceOffsetMm)}`,
    `d${recipe.deleted ? 1 : 0}`,
    `o${recipe.originAuto ? 1 : 0}`,
    `u${recipe.upstreamStableId}`,
  ];
  if (recipe.uiMode >= 0) row.push(`cm${recipe.uiMode}`);
  if (recipe.gradientEnabled) {
    row.push(`r1/${recipe.gradientStart.toFixed(4)}/${recipe.gradientEnd.toFixed(4)}`);
  }
  if (pattern) row.push(pattern);
  return row.join(',');
}

function buildRatio(
  physical: readonly PhysicalFilament[],
  draft: FullSpectrumRatioDraft,
): {
  components: MixedComponent[];
  distribution: MixedDistribution;
  fullSpectrum: Omit<
    FullSpectrumRecipeState,
    'upstreamStableId' | 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'
  >;
} {
  const toolIds = draft.componentFilamentIds.map((id, index) =>
    requireEnabledToolId(physical, id, `Ratio component ${index + 1}`),
  );
  const input: RatioAuthoringInput = {
    mode: 'ratio',
    componentIds: toolIds,
    mixBPercent: draft.mixBPercent,
    ...(draft.triangleWeightsPercent ? { triangleWeightsPercent: [...draft.triangleWeightsPercent] } : {}),
  };
  const projection = requireMixedFilamentAuthoring(input, { physicalToolCount: physical.length });
  return fromProjection(physical, projection, {
    mode: 'ratio',
    componentWeights:
      projection.gradient_component_weights.length > 0
        ? decodeWeights(projection.gradient_component_weights)
        : [100 - projection.mix_b_percent, projection.mix_b_percent],
  });
}

function buildMatch(
  physical: readonly PhysicalFilament[],
  draft: FullSpectrumMatchDraft,
): {
  components: MixedComponent[];
  distribution: MixedDistribution;
  fullSpectrum: Omit<
    FullSpectrumRecipeState,
    'upstreamStableId' | 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'
  >;
} {
  const input: MatchAuthoringInput = {
    mode: 'match',
    components: draft.components.map((component, index) => ({
      toolId: requireEnabledToolId(physical, component.filamentId, `Match component ${index + 1}`),
      weight: component.weight,
    })),
    targetColor: draft.targetColor,
    minComponentPercent: draft.minComponentPercent,
  };
  const projection = requireMixedFilamentAuthoring(input, { physicalToolCount: physical.length });
  const weights =
    projection.gradient_component_weights.length > 0
      ? decodeWeights(projection.gradient_component_weights)
      : [100 - projection.mix_b_percent, projection.mix_b_percent];
  return fromProjection(physical, projection, {
    mode: 'match',
    targetColor: normalizeDisplayColor(draft.targetColor),
    componentWeights: weights,
  });
}

function buildGradient(
  physical: readonly PhysicalFilament[],
  draft: FullSpectrumGradientDraft,
): {
  components: MixedComponent[];
  distribution: MixedDistribution;
  fullSpectrum: Omit<
    FullSpectrumRecipeState,
    'upstreamStableId' | 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'
  >;
} {
  const input: GradientAuthoringInput = {
    mode: 'gradient',
    componentIds: draft.componentFilamentIds.map((id, index) =>
      requireEnabledToolId(physical, id, `Gradient component ${index + 1}`),
    ),
    direction: draft.direction,
    localZMaxSublayers: draft.localZMaxSublayers,
  };
  const projection = requireMixedFilamentAuthoring(input, { physicalToolCount: physical.length });
  const startWeights =
    draft.direction === 'a-to-b' ? [projection.gradient_start, 1 - projection.gradient_start] : [0.2, 0.8];
  const endWeights = draft.direction === 'a-to-b' ? [projection.gradient_end, 1 - projection.gradient_end] : [0.8, 0.2];
  return fromProjection(physical, projection, {
    mode: 'gradient',
    componentWeights: [50, 50],
    startWeights,
    endWeights,
  });
}

function buildCycle(
  physical: readonly PhysicalFilament[],
  draft: FullSpectrumCycleDraft,
): {
  components: MixedComponent[];
  distribution: MixedDistribution;
  fullSpectrum: Omit<
    FullSpectrumRecipeState,
    'upstreamStableId' | 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'
  >;
} {
  if (draft.manualPatternGroups.length === 0 || draft.manualPatternGroups.some((group) => group.length === 0)) {
    throw new FullSpectrumRecipeValidationError('Cycle needs at least one non-empty perimeter group');
  }
  const counts = new Map<PhysicalFilamentId, number>();
  const groups = draft.manualPatternGroups.map((group, groupIndex) =>
    group.map((id, tokenIndex) => {
      requireEnabledToolId(physical, id, `Cycle group ${groupIndex + 1} token ${tokenIndex + 1}`);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return id;
    }),
  );
  const [componentAId, componentBId] = cycleEnginePair(groups, physical);
  if (!counts.has(componentAId)) counts.set(componentAId, 0);
  if (!counts.has(componentBId)) counts.set(componentBId, 0);
  const components = [...counts].map(([filamentId, weight]) => ({ filamentId, weight }));
  return {
    components,
    distribution: { mode: 'cycle' },
    fullSpectrum: {
      schemaVersion: 1,
      uiMode: 1,
      componentAId,
      componentBId,
      ratioA: 1,
      ratioB: 1,
      mixBPercent: cycleMixBPercent(groups, componentBId),
      manualPatternGroups: groups,
      gradientComponentIds: [],
      gradientComponentWeights: [],
      pointillismAllFilaments: false,
      distributionMode: 2,
      localZMaxSublayers: 0,
      gradientEnabled: false,
      gradientStart: 0.8,
      gradientEnd: 0.2,
      deleted: false,
      custom: true,
      originAuto: false,
    },
  };
}

function fromProjection(
  physical: readonly PhysicalFilament[],
  projection: MixedFilamentSerializableProjection,
  options:
    | { mode: 'ratio'; componentWeights: readonly number[] }
    | { mode: 'match'; targetColor: string; componentWeights: readonly number[] }
    | {
        mode: 'gradient';
        componentWeights: readonly number[];
        startWeights: readonly number[];
        endWeights: readonly number[];
      },
): {
  components: MixedComponent[];
  distribution: MixedDistribution;
  fullSpectrum: Omit<
    FullSpectrumRecipeState,
    'upstreamStableId' | 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'
  >;
} {
  const componentAId = physical[projection.component_a - 1]?.id;
  const componentBId = physical[projection.component_b - 1]?.id;
  if (!componentAId || !componentBId)
    throw new FullSpectrumRecipeValidationError('Projection references a missing tool');
  const gradientToolIds = decodeGradientComponentIds(projection.gradient_component_ids);
  const orderedIds =
    gradientToolIds.length > 0
      ? gradientToolIds.map((toolId) => {
          const id = physical[toolId - 1]?.id;
          if (!id) throw new FullSpectrumRecipeValidationError(`Projection references unknown gradient tool ${toolId}`);
          return id;
        })
      : [componentAId, componentBId];
  const componentWeights =
    options.componentWeights.length === orderedIds.length
      ? [...options.componentWeights]
      : orderedIds.map((_, index) =>
          index < 2 ? [100 - projection.mix_b_percent, projection.mix_b_percent][index] : 0,
        );
  const components = orderedIds.map((filamentId, index) => ({ filamentId, weight: componentWeights[index] }));
  const distribution: MixedDistribution =
    options.mode === 'ratio'
      ? { mode: 'ratio' }
      : options.mode === 'match'
        ? { mode: 'match', targetColor: options.targetColor }
        : {
            mode: 'gradient',
            startWeights: [...options.startWeights],
            endWeights: [...options.endWeights],
          };
  return {
    components,
    distribution,
    fullSpectrum: {
      schemaVersion: 1,
      uiMode: projection.ui_mode,
      componentAId,
      componentBId,
      ratioA: projection.ratio_a,
      ratioB: projection.ratio_b,
      mixBPercent: projection.mix_b_percent,
      manualPatternGroups: [],
      gradientComponentIds: orderedIds.length > 2 || projection.gradient_component_ids ? orderedIds : [],
      gradientComponentWeights: decodeWeights(projection.gradient_component_weights),
      pointillismAllFilaments: false,
      distributionMode: projection.distribution_mode,
      localZMaxSublayers: projection.local_z_max_sublayers,
      gradientEnabled: projection.gradient_enabled,
      gradientStart: projection.gradient_start,
      gradientEnd: projection.gradient_end,
      deleted: false,
      custom: projection.custom,
      originAuto: false,
    },
  };
}

function cycleEnginePair(
  groups: readonly (readonly PhysicalFilamentId[])[],
  physical: readonly PhysicalFilament[],
): [PhysicalFilamentId, PhysicalFilamentId] {
  if (physical.length < 2)
    throw new FullSpectrumRecipeValidationError('FullSpectrum requires at least two physical tools');
  const used = new Set(groups.flat());
  const firstSlot = physical[0].id;
  const secondSlot = physical[1].id;
  const orderedUsed = [...groups.flat()].filter((id, index, all) => all.indexOf(id) === index);
  let componentA = used.has(firstSlot) ? firstSlot : orderedUsed.find((id) => id !== secondSlot);
  let componentB = used.has(secondSlot) ? secondSlot : orderedUsed.find((id) => id !== componentA);
  componentA ??= firstSlot;
  componentB ??= physical.find((entry) => entry.id !== componentA)?.id;
  if (!componentB || componentA === componentB) {
    throw new FullSpectrumRecipeValidationError('FullSpectrum requires two distinct physical tools');
  }
  return [componentA, componentB];
}

function encodeStablePattern(
  groups: readonly (readonly PhysicalFilamentId[])[],
  slots: ReadonlyMap<PhysicalFilamentId, number>,
  componentAId: PhysicalFilamentId,
  componentBId: PhysicalFilamentId,
): string {
  return groups
    .map((group, groupIndex) =>
      group
        .map((id, tokenIndex) => {
          if (id === componentAId) return '1';
          if (id === componentBId) return '2';
          const slot = requirePhysicalSlot(slots, id, `Cycle group ${groupIndex + 1} token ${tokenIndex + 1}`);
          if (slot <= 2) {
            throw new FullSpectrumRecipeValidationError(
              `Cycle cannot encode physical slot ${slot} without making it component ${slot === 1 ? 'A' : 'B'}`,
            );
          }
          return slot < 10 ? String(slot) : `[${slot}]`;
        })
        .join(''),
    )
    .join(',');
}

function cycleMixBPercent(
  groups: readonly (readonly PhysicalFilamentId[])[],
  componentBId: PhysicalFilamentId,
): number {
  if (groups.length === 0) return 50;
  const mean = groups.reduce((sum, group) => {
    const count = group.filter((id) => id === componentBId).length;
    return sum + count / group.length;
  }, 0);
  return Math.round((100 * mean) / groups.length);
}

function physicalSlotMap(physical: readonly PhysicalFilament[]): Map<PhysicalFilamentId, number> {
  return new Map(physical.map((entry, index) => [entry.id, index + 1]));
}

function requirePhysicalSlot(
  slots: ReadonlyMap<PhysicalFilamentId, number>,
  id: PhysicalFilamentId,
  label: string,
): number {
  const slot = slots.get(id);
  if (!slot) throw new FullSpectrumRecipeValidationError(`${label} ${id} is missing from the physical library`);
  return slot;
}

function requireEnabledToolId(physical: readonly PhysicalFilament[], id: PhysicalFilamentId, label: string): number {
  const index = physical.findIndex((entry) => entry.id === id);
  if (index < 0) throw new FullSpectrumRecipeValidationError(`${label} ${id} is missing from the physical library`);
  if (!physical[index].enabled) throw new FullSpectrumRecipeValidationError(`${label} ${id} is disabled`);
  return index + 1;
}

function validatePhysicalLibrary(physical: readonly PhysicalFilament[]): void {
  if (physical.length < 2)
    throw new FullSpectrumRecipeValidationError('FullSpectrum requires at least two physical tools');
  if (physical.length > 64)
    throw new FullSpectrumRecipeValidationError('The pinned engine supports at most 64 physical tools');
  const ids = new Set<PhysicalFilamentId>();
  for (const entry of physical) {
    if (ids.has(entry.id)) throw new FullSpectrumRecipeValidationError(`Duplicate physical filament ID ${entry.id}`);
    ids.add(entry.id);
  }
}

function validateOffsets(draft: FullSpectrumDraftBase): void {
  for (const [label, value] of [
    ['Component A surface offset', draft.componentASurfaceOffsetMm ?? 0],
    ['Component B surface offset', draft.componentBSurfaceOffsetMm ?? 0],
  ] as const) {
    if (!Number.isFinite(value) || Math.abs(value) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM) {
      throw new FullSpectrumRecipeValidationError(`${label} must be within -2 mm and 2 mm`);
    }
  }
}

function validateUnsigned64(value: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new FullSpectrumRecipeValidationError('Upstream stable ID must be unsigned decimal text');
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) {
    throw new FullSpectrumRecipeValidationError('Upstream stable ID exceeds uint64');
  }
}

export function fullSpectrumStableNumericId(value: string): string {
  const parsed = BigInt(`0x${fnv1a64(new TextEncoder().encode(value))}`);
  return (parsed === 0n ? 1n : parsed).toString(10);
}

function normalizeDisplayColor(value: string): string {
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (!match) throw new FullSpectrumRecipeValidationError(`Invalid color ${JSON.stringify(value)}`);
  return `#${match[1].toUpperCase()}`;
}

function decodeGradientComponentIds(value: string): number[] {
  if (!value) return [];
  if (value.includes('/')) {
    return value
      .split('/')
      .filter(Boolean)
      .map((entry) => Number(entry));
  }
  return [...value].map(Number);
}

function encodeGradientComponentIds(ids: readonly number[]): string {
  return ids.some((id) => id > 9) ? ids.join('/') : ids.join('');
}

function decodeWeights(value: string): number[] {
  return value ? value.split('/').map(Number) : [];
}

function formatSurfaceOffset(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM) {
    throw new FullSpectrumRecipeValidationError('Surface offset is outside the pinned -2 mm to 2 mm range');
  }
  const formatted = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return formatted === '-0' || formatted === '' ? '0' : formatted;
}

function cloneDistribution(distribution: MixedDistribution): MixedDistribution {
  if (distribution.mode !== 'gradient') return { ...distribution };
  return {
    ...distribution,
    startWeights: [...distribution.startWeights],
    endWeights: [...distribution.endWeights],
  };
}
