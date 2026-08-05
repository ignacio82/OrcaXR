import type { MixedFilamentId, PhysicalFilamentId } from '../../project/domain/ids';
import { fnv1a64 } from '../../project/domain/canonical';
import {
  type SuppliedPaletteMatchRecipe,
  type SuppliedPaletteMatchSearchInput,
  type SuppliedPaletteMatchSearchResult,
} from '../../project/filaments/colorMatchSearch';
import { fullSpectrumMaterialCategory } from '../../project/filaments/fullSpectrumCompatibility';
import { stableCycleGroupsFromToolIds, type FullSpectrumRecipeDraft } from '../../project/filaments/fullSpectrumRecipe';
import {
  colorDeltaE2000,
  normalizeColorMatchWeights,
  projectMixedFilamentAuthoring,
  type MixedFilamentSerializableProjection,
} from '../../project/filaments/mixedFilamentAuthoring';
import type {
  CanonicalVirtualFilamentLibrarySnapshot,
  CanonicalVirtualFilamentMutationRequest,
} from '../../workspace/CanonicalWorkspaceController';
import type {
  AddVirtualFilamentRequest,
  DeleteVirtualFilamentRequest,
  DuplicateVirtualFilamentRequest,
  EditVirtualFilamentRequest,
  SetVirtualFilamentEnabledRequest,
  VirtualFilamentLibraryAdapter,
  VirtualFilamentLibraryRow,
  VirtualFilamentLibrarySnapshot,
  VirtualFilamentMatchCandidate,
  VirtualFilamentMatchSearchRequest,
  VirtualFilamentPhysicalChoice,
  VirtualFilamentValidatedComponent,
  VirtualFilamentValidatedDraft,
  VirtualFilamentValidatedWeightedComponent,
} from './VirtualFilamentLibrary';

interface CanonicalVirtualFilamentLibrarySource {
  getSnapshot(): CanonicalVirtualFilamentLibrarySnapshot;
  subscribe(listener: () => void): () => void;
  mutate(request: CanonicalVirtualFilamentMutationRequest): void | Promise<void>;
  searchMatch(input: SuppliedPaletteMatchSearchInput): Promise<SuppliedPaletteMatchSearchResult>;
  cancelMatchSearch(reason?: unknown): void;
  matchCandidates?(snapshot: CanonicalVirtualFilamentLibrarySnapshot): readonly VirtualFilamentMatchCandidate[];
  onError?(error: unknown): void;
}

type CanonicalMixedRow = CanonicalVirtualFilamentLibrarySnapshot['mixed'][number];
type CanonicalMixedFilament = CanonicalMixedRow['filament'];
type CanonicalFullSpectrumState = NonNullable<CanonicalMixedFilament['fullSpectrum']>;

/**
 * Stable-ID adapter between the DOM authoring surface and the canonical
 * FullSpectrum command boundary. It never keeps a second mutable library.
 */
export class CanonicalVirtualFilamentLibraryAdapter implements VirtualFilamentLibraryAdapter {
  private matchSearchCache?: {
    readonly key: string;
    readonly candidates: readonly VirtualFilamentMatchCandidate[];
  };

  constructor(private readonly source: CanonicalVirtualFilamentLibrarySource) {}

  getSnapshot(): VirtualFilamentLibrarySnapshot {
    const canonical = this.source.getSnapshot();
    return projectCanonicalVirtualFilamentLibrary(canonical, this.source.matchCandidates?.(canonical) ?? []);
  }

  subscribe(listener: () => void): () => void {
    return this.source.subscribe(listener);
  }

  async searchMatchCandidates(
    request: VirtualFilamentMatchSearchRequest,
  ): Promise<readonly VirtualFilamentMatchCandidate[]> {
    const canonical = this.currentForGuard(request);
    const key =
      `${canonical.sourceRevision}\u0000${canonical.sourceHash}\u0000` +
      `${request.targetColor}\u0000${request.minComponentPercent}`;
    if (this.matchSearchCache?.key === key) return this.matchSearchCache.candidates;

    const eligible = canonical.physical.filter(
      (entry) => entry.enabled && fullSpectrumMaterialCategory(entry.material) !== undefined,
    );
    if (eligible.length < 2) return Object.freeze([]);
    const result = await this.source.searchMatch({
      palette: eligible.map((entry) => ({
        color: normalizeSixDigitColor(entry.color),
        filamentType: entry.material,
      })),
      targetColor: request.targetColor,
      minComponentPercent: request.minComponentPercent,
    });
    this.currentForGuard(request);
    const candidates = dedupeCandidates(
      [result.recipe, result.bestPair]
        .filter((recipe): recipe is SuppliedPaletteMatchRecipe => recipe !== null)
        .map((recipe) => matchSearchCandidate(recipe, eligible)),
    );
    const frozen = Object.freeze(candidates);
    this.matchSearchCache = { key, candidates: frozen };
    return frozen;
  }

  cancelMatchCandidateSearch(reason?: unknown): void {
    this.source.cancelMatchSearch(reason);
  }

  async onAdd(request: AddVirtualFilamentRequest): Promise<void> {
    const canonical = this.currentForGuard(request);
    await this.source.mutate({
      operation: 'add',
      expectedRevision: request.expectedRevision,
      sourceHash: request.sourceHash,
      draft: toFullSpectrumRecipeDraft(request.draft, canonical),
    });
  }

  async onEdit(request: EditVirtualFilamentRequest): Promise<void> {
    const canonical = this.currentForGuard(request);
    const filamentId = resolveMixedFilamentId(canonical, request.filamentId);
    await this.source.mutate({
      operation: 'edit',
      expectedRevision: request.expectedRevision,
      sourceHash: request.sourceHash,
      filamentId,
      draft: toFullSpectrumRecipeDraft(request.draft, canonical, filamentId),
    });
  }

  async onDuplicate(request: DuplicateVirtualFilamentRequest): Promise<void> {
    const canonical = this.currentForGuard(request);
    const sourceFilamentId = resolveMixedFilamentId(canonical, request.sourceFilamentId);
    await this.source.mutate({
      operation: 'duplicate',
      expectedRevision: request.expectedRevision,
      sourceHash: request.sourceHash,
      sourceFilamentId,
      draft: toFullSpectrumRecipeDraft(request.draft, canonical, sourceFilamentId, true),
    });
  }

  async onSetEnabled(request: SetVirtualFilamentEnabledRequest): Promise<void> {
    const canonical = this.currentForGuard(request);
    await this.source.mutate({
      operation: 'set-enabled',
      expectedRevision: request.expectedRevision,
      sourceHash: request.sourceHash,
      filamentId: resolveMixedFilamentId(canonical, request.filamentId),
      enabled: request.enabled,
    });
  }

  async onDelete(request: DeleteVirtualFilamentRequest): Promise<void> {
    const canonical = this.currentForGuard(request);
    await this.source.mutate({
      operation: 'delete',
      expectedRevision: request.expectedRevision,
      sourceHash: request.sourceHash,
      filamentId: resolveMixedFilamentId(canonical, request.filamentId),
    });
  }

  onError(error: unknown): void {
    this.source.onError?.(error);
  }

  private currentForGuard(request: {
    readonly expectedRevision: number;
    readonly sourceHash: string;
  }): CanonicalVirtualFilamentLibrarySnapshot {
    const current = this.source.getSnapshot();
    if (current.sourceRevision !== request.expectedRevision || current.sourceHash !== request.sourceHash) {
      throw new Error('The virtual filament draft no longer matches the canonical project.');
    }
    return current;
  }
}

function matchSearchCandidate(
  recipe: SuppliedPaletteMatchRecipe,
  eligible: readonly CanonicalVirtualFilamentLibrarySnapshot['physical'][number][],
): VirtualFilamentMatchCandidate {
  const components = recipe.components.map((component) => {
    const physical = eligible[component.toolId - 1];
    if (!physical) throw new Error(`Pinned Match search returned unknown local tool ${component.toolId}`);
    return Object.freeze({
      filamentId: physical.id,
      weight: component.weight,
    });
  });
  const identity = components.map((component) => `${component.filamentId}@${component.weight}`).join('+');
  const digest = fnv1a64(new TextEncoder().encode(`${recipe.kind}:${identity}:${recipe.previewColor}`));
  return Object.freeze({
    id: `pinned-match:${digest}`,
    label: `Pinned ${recipe.kind} search`,
    components: Object.freeze(components),
    previewColor: normalizeSixDigitColor(recipe.previewColor),
  });
}

export function projectCanonicalVirtualFilamentLibrary(
  canonical: CanonicalVirtualFilamentLibrarySnapshot,
  suppliedCandidates: readonly VirtualFilamentMatchCandidate[] = [],
): VirtualFilamentLibrarySnapshot {
  const physicalChoices = canonical.physical.map(toPhysicalChoice);
  const toolByPhysicalId = new Map(canonical.physical.map((entry) => [entry.id, entry.engineToolId] as const));
  const mixedRows: VirtualFilamentLibraryRow[] = [];
  const persistedCandidates: VirtualFilamentMatchCandidate[] = [];

  for (const row of canonical.mixed) {
    if (!row.hasExactFullSpectrumState || !row.filament.fullSpectrum) continue;
    const projected = projectCanonicalMixedRow(row, canonical, toolByPhysicalId);
    mixedRows.push(projected.row);
    if (projected.persistedCandidate) persistedCandidates.push(projected.persistedCandidate);
  }

  const candidates = dedupeCandidates([...suppliedCandidates, ...persistedCandidates]);
  return Object.freeze({
    sourceRevision: canonical.sourceRevision,
    sourceHash: canonical.sourceHash,
    physicalChoices: Object.freeze(physicalChoices),
    mixedRows: Object.freeze(mixedRows),
    matchCandidates: Object.freeze(candidates),
  });
}

export function toFullSpectrumRecipeDraft(
  draft: VirtualFilamentValidatedDraft,
  canonical: CanonicalVirtualFilamentLibrarySnapshot,
  sourceFilamentId?: MixedFilamentId,
  preserveSourceEnabled = false,
): FullSpectrumRecipeDraft {
  const physicalByTextId = new Map(canonical.physical.map((entry) => [String(entry.id), entry.id] as const));
  const source = sourceFilamentId
    ? canonical.mixed.find((row) => row.filament.id === sourceFilamentId)?.filament
    : undefined;
  const common = {
    name: draft.name,
    displayColor: normalizeSixDigitColor(draft.displayColor),
    componentASurfaceOffsetMm: draft.componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm: draft.componentBSurfaceOffsetMm,
    ...(preserveSourceEnabled && source ? { enabled: source.enabled } : {}),
  };
  const physicalId = (value: string): PhysicalFilamentId => {
    const resolved = physicalByTextId.get(value);
    if (!resolved) throw new Error(`Unknown physical filament ${value}`);
    return resolved;
  };

  if (draft.mode === 'ratio') {
    return {
      ...common,
      mode: 'ratio',
      componentFilamentIds: draft.components.map((component) => physicalId(component.filamentId)),
      mixBPercent: draft.mixBPercent,
      ...(draft.triangleWeightsPercent ? { triangleWeightsPercent: [...draft.triangleWeightsPercent] } : {}),
    };
  }
  if (draft.mode === 'cycle') {
    return {
      ...common,
      mode: 'cycle',
      manualPatternGroups: stableCycleGroupsFromToolIds(
        canonical.physical.map((entry) => ({
          id: entry.id,
          name: entry.name,
          toolId: entry.engineToolId,
          material: entry.material,
          color: entry.color,
          config: {},
          enabled: entry.enabled,
        })),
        draft.groups,
      ),
    };
  }
  if (draft.mode === 'match') {
    return {
      ...common,
      mode: 'match',
      components: draft.components.map((component) => ({
        filamentId: physicalId(component.filamentId),
        weight: component.weight,
      })),
      targetColor: draft.normalizedTargetColor,
      minComponentPercent: draft.minComponentPercent,
    };
  }
  return {
    ...common,
    mode: 'gradient',
    componentFilamentIds: [physicalId(draft.components[0].filamentId), physicalId(draft.components[1].filamentId)],
    direction: draft.direction,
    localZMaxSublayers: draft.localZMaxSublayers,
  };
}

function toPhysicalChoice(
  entry: CanonicalVirtualFilamentLibrarySnapshot['physical'][number],
): VirtualFilamentPhysicalChoice {
  const category = fullSpectrumMaterialCategory(entry.material);
  return Object.freeze({
    id: entry.id,
    toolId: entry.engineToolId,
    name: entry.name || `Head ${entry.engineToolId}`,
    material: entry.material || 'Unknown',
    color: normalizeSixDigitColor(entry.color),
    enabled: entry.enabled,
    compatible: category !== undefined,
    ...(category
      ? {}
      : {
          incompatibilityReason: `${entry.material || 'Unknown material'} is absent from the pinned compatibility table.`,
        }),
  });
}

function projectCanonicalMixedRow(
  canonicalRow: CanonicalMixedRow,
  canonical: CanonicalVirtualFilamentLibrarySnapshot,
  toolByPhysicalId: ReadonlyMap<PhysicalFilamentId, number>,
): {
  readonly row: VirtualFilamentLibraryRow;
  readonly persistedCandidate?: VirtualFilamentMatchCandidate;
} {
  const filament = canonicalRow.filament;
  const fullSpectrum = filament.fullSpectrum;
  if (!fullSpectrum) throw new Error(`Virtual filament ${filament.id} has no exact FullSpectrum state`);
  const mode = inferMode(filament, fullSpectrum);
  const name = normalizeDisplayName(filament.name);
  const displayColor = normalizeSixDigitColor(filament.displayColor);
  const surfaceOffsets = {
    componentASurfaceOffsetMm: fullSpectrum.componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm: fullSpectrum.componentBSurfaceOffsetMm,
  };
  const component = (id: PhysicalFilamentId): VirtualFilamentValidatedComponent =>
    Object.freeze({
      filamentId: id,
      toolId: requireToolId(toolByPhysicalId, id),
    });

  let draft: VirtualFilamentValidatedDraft;
  let persistedCandidate: VirtualFilamentMatchCandidate | undefined;
  if (mode === 'cycle') {
    const groups = fullSpectrum.manualPatternGroups.map((group) =>
      Object.freeze(group.map((id) => requireToolId(toolByPhysicalId, id))),
    );
    const sequence = groups.flat();
    const uniqueIds = [...new Set(fullSpectrum.manualPatternGroups.flat())];
    draft = Object.freeze({
      name,
      displayColor,
      ...surfaceOffsets,
      mode: 'cycle',
      manualPattern: encodeDirectToolPattern(groups),
      normalizedPattern: encodeDirectToolPattern(groups),
      components: Object.freeze(uniqueIds.map(component)),
      groups: Object.freeze(groups),
      sequence: Object.freeze(sequence),
    });
  } else if (mode === 'gradient') {
    const ids = gradientPair(fullSpectrum);
    const components = Object.freeze([component(ids[0]), component(ids[1])]) as readonly [
      VirtualFilamentValidatedComponent,
      VirtualFilamentValidatedComponent,
    ];
    const direction = fullSpectrum.gradientStart >= fullSpectrum.gradientEnd ? 'a-to-b' : 'b-to-a';
    const localZMaxSublayers = Math.max(2, fullSpectrum.localZMaxSublayers);
    const projection = requireProjection(
      projectMixedFilamentAuthoring(
        {
          mode: 'gradient',
          componentIds: components.map((entry) => entry.toolId),
          direction,
          localZMaxSublayers,
        },
        { physicalToolCount: canonical.physical.length },
      ).projection,
      filament.id,
    );
    draft = Object.freeze({
      name,
      displayColor,
      ...surfaceOffsets,
      mode: 'gradient',
      components,
      direction,
      localZMaxSublayers,
      projection,
    });
  } else if (mode === 'match') {
    const ids = matchComponentIds(filament, fullSpectrum);
    const weights = matchComponentWeights(filament, fullSpectrum, ids);
    const components = Object.freeze(
      ids.map((id, index) =>
        Object.freeze({
          ...component(id),
          weight: weights[index],
        }),
      ),
    ) as readonly VirtualFilamentValidatedWeightedComponent[];
    const targetColor =
      filament.distribution.mode === 'match' ? normalizeSixDigitColor(filament.distribution.targetColor) : displayColor;
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'match',
        components: components.map((entry) => ({
          toolId: entry.toolId,
          weight: entry.weight,
        })),
        targetColor,
        minComponentPercent: 0,
      },
      { physicalToolCount: canonical.physical.length },
    );
    const projection = requireProjection(result.projection, filament.id);
    const normalizedTargetColor = result.normalizedTargetColor ?? targetColor;
    const candidateId = `persisted:${filament.id}`;
    persistedCandidate = Object.freeze({
      id: candidateId,
      label: `${name} (saved recipe)`,
      components: Object.freeze(
        components.map((entry) => Object.freeze({ filamentId: entry.filamentId, weight: entry.weight })),
      ),
      previewColor: displayColor,
    });
    draft = Object.freeze({
      name,
      displayColor,
      ...surfaceOffsets,
      mode: 'match',
      targetColor,
      normalizedTargetColor,
      minComponentPercent: 0,
      selectedCandidateId: candidateId,
      previewColor: displayColor,
      deltaE2000: colorDeltaE2000(normalizedTargetColor, displayColor),
      components,
      projection,
    });
  } else {
    const ids = ratioComponentIds(fullSpectrum);
    const components = Object.freeze(ids.map(component));
    const triangleWeights =
      ids.length === 3
        ? (Object.freeze(ratioTriangleWeights(filament, fullSpectrum, ids)) as readonly [number, number, number])
        : undefined;
    const projection = requireProjection(
      projectMixedFilamentAuthoring(
        {
          mode: 'ratio',
          componentIds: components.map((entry) => entry.toolId),
          mixBPercent: fullSpectrum.mixBPercent,
          ...(triangleWeights ? { triangleWeightsPercent: triangleWeights } : {}),
        },
        { physicalToolCount: canonical.physical.length },
      ).projection,
      filament.id,
    );
    draft = Object.freeze({
      name,
      displayColor,
      ...surfaceOffsets,
      mode: 'ratio',
      components,
      mixBPercent: fullSpectrum.mixBPercent,
      ...(triangleWeights ? { triangleWeightsPercent: triangleWeights } : {}),
      projection,
    });
  }

  return {
    row: Object.freeze({
      id: filament.id,
      enabled: filament.enabled,
      draft,
      ...(canonicalRow.dependencyPaths.length > 0
        ? { dependencyLabels: Object.freeze([...canonicalRow.dependencyPaths]) }
        : {}),
    }),
    ...(persistedCandidate ? { persistedCandidate } : {}),
  };
}

function inferMode(
  filament: CanonicalMixedFilament,
  fullSpectrum: CanonicalFullSpectrumState,
): 'ratio' | 'cycle' | 'match' | 'gradient' {
  if (fullSpectrum.uiMode === 0) return 'ratio';
  if (fullSpectrum.uiMode === 1) return 'cycle';
  if (fullSpectrum.uiMode === 2) return 'match';
  if (fullSpectrum.uiMode === 3) return 'gradient';
  if (fullSpectrum.manualPatternGroups.length > 0 || filament.distribution.mode === 'cycle') return 'cycle';
  if (fullSpectrum.gradientEnabled || filament.distribution.mode === 'gradient') return 'gradient';
  if (filament.distribution.mode === 'match') return 'match';
  return 'ratio';
}

function ratioComponentIds(fullSpectrum: CanonicalFullSpectrumState): PhysicalFilamentId[] {
  const ids =
    fullSpectrum.gradientComponentIds.length >= 2 && fullSpectrum.gradientComponentIds.length <= 3
      ? [...fullSpectrum.gradientComponentIds]
      : [fullSpectrum.componentAId, fullSpectrum.componentBId];
  return uniquePhysicalIds(ids, 2, 3, 'Ratio');
}

function gradientPair(fullSpectrum: CanonicalFullSpectrumState): readonly [PhysicalFilamentId, PhysicalFilamentId] {
  const ids =
    fullSpectrum.gradientComponentIds.length === 2
      ? fullSpectrum.gradientComponentIds
      : [fullSpectrum.componentAId, fullSpectrum.componentBId];
  const unique = uniquePhysicalIds(ids, 2, 2, 'Gradient');
  return [unique[0], unique[1]];
}

function matchComponentIds(
  filament: CanonicalMixedFilament,
  fullSpectrum: CanonicalFullSpectrumState,
): PhysicalFilamentId[] {
  const ids =
    fullSpectrum.gradientComponentIds.length >= 2
      ? [...fullSpectrum.gradientComponentIds]
      : filament.components.map((entry) => entry.filamentId);
  return uniquePhysicalIds(ids, 2, 4, 'Match');
}

function matchComponentWeights(
  filament: CanonicalMixedFilament,
  fullSpectrum: CanonicalFullSpectrumState,
  ids: readonly PhysicalFilamentId[],
): number[] {
  const byId = new Map(filament.components.map((entry) => [entry.filamentId, Math.round(entry.weight)] as const));
  const raw =
    fullSpectrum.gradientComponentWeights.length === ids.length
      ? fullSpectrum.gradientComponentWeights.map((weight) => Math.round(weight))
      : ids.map((id, index) => {
          const known = byId.get(id);
          if (known !== undefined) return known;
          return index === 0 ? 100 - fullSpectrum.mixBPercent : index === 1 ? fullSpectrum.mixBPercent : 0;
        });
  return [...normalizeColorMatchWeights(raw, ids.length)];
}

function ratioTriangleWeights(
  filament: CanonicalMixedFilament,
  fullSpectrum: CanonicalFullSpectrumState,
  ids: readonly PhysicalFilamentId[],
): [number, number, number] {
  const byId = new Map(filament.components.map((entry) => [entry.filamentId, entry.weight] as const));
  const weights =
    fullSpectrum.gradientComponentWeights.length === 3
      ? fullSpectrum.gradientComponentWeights
      : ids.map((id) => byId.get(id) ?? 0);
  if (weights.length !== 3 || weights.every((weight) => weight <= 0)) {
    throw new Error(`Virtual filament ${filament.id} has invalid Ratio triangle weights`);
  }
  return [weights[0], weights[1], weights[2]];
}

function uniquePhysicalIds(
  ids: readonly PhysicalFilamentId[],
  minimum: number,
  maximum: number,
  label: string,
): PhysicalFilamentId[] {
  const unique = ids.filter((id, index) => ids.indexOf(id) === index);
  if (unique.length < minimum || unique.length > maximum) {
    throw new Error(`${label} needs ${minimum}${minimum === maximum ? '' : `–${maximum}`} unique physical heads`);
  }
  return unique;
}

function requireToolId(tools: ReadonlyMap<PhysicalFilamentId, number>, id: PhysicalFilamentId): number {
  const toolId = tools.get(id);
  if (!toolId) throw new Error(`Virtual recipe references missing physical filament ${id}`);
  return toolId;
}

function requireProjection(
  projection: MixedFilamentSerializableProjection | null,
  filamentId: MixedFilamentId,
): MixedFilamentSerializableProjection {
  if (!projection) throw new Error(`Virtual filament ${filamentId} cannot be projected for authoring`);
  return Object.freeze({ ...projection });
}

function resolveMixedFilamentId(canonical: CanonicalVirtualFilamentLibrarySnapshot, value: string): MixedFilamentId {
  const row = canonical.mixed.find((entry) => String(entry.filament.id) === value);
  if (!row) throw new Error(`Unknown virtual filament ${value}`);
  return row.filament.id;
}

function encodeDirectToolPattern(groups: readonly (readonly number[])[]): string {
  return groups
    .map((group) => group.map((toolId) => (toolId < 10 ? String(toolId) : `[${toolId}]`)).join(''))
    .join(',');
}

function normalizeSixDigitColor(value: string): string {
  const match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid FullSpectrum color ${JSON.stringify(value)}`);
  return `#${match[1].toUpperCase()}`;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Virtual filament name cannot be empty');
  return normalized.length <= 120 ? normalized : normalized.slice(0, 120);
}

function dedupeCandidates(candidates: readonly VirtualFilamentMatchCandidate[]): VirtualFilamentMatchCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}
