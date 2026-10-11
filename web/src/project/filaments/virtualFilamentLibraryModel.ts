/**
 * The virtual filament library's authoring model, free of the DOM: the
 * snapshot the library renders and its checks, the author dialog's fields and
 * their defaults, and everything the dialog computes from them — each mode's
 * validation, issues and preview, the Match ranking, the Ratio and Gradient
 * previews, the triangle picker's coordinates and the rows' summaries.
 * `VirtualFilamentLibrary` renders it; the shared Rust core answers the same
 * questions (`orcaxr_project::filaments::library`) for the Android app.
 */
import {
  MATCH_RECIPE_SEARCH_COVERAGE,
  MAX_AUTHORING_PHYSICAL_TOOL_ID,
  normalizeColorMatchWeights,
  normalizeRatioTriangleBarycentricWeights,
  normalizeRatioTriangleWeights,
  projectMixedFilamentAuthoring,
  rankColorMatchCandidates,
  type MixedFilamentSerializableProjection,
  type RankedMatchRecipeCandidate,
} from './mixedFilamentAuthoring';
import { blendPairFilamentPigment, filamentRgbToHex, parseOrcaMixedColor } from './filamentPigmentMixer';
import { FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM } from './fullSpectrumRecipe';
import { parseManualCyclePattern, type ManualCyclePatternParseResult } from './manualCyclePattern';

export const VIRTUAL_FILAMENT_NAME_LIMIT = 120;
export const VIRTUAL_FILAMENT_MATCH_COVERAGE = MATCH_RECIPE_SEARCH_COVERAGE;

export type VirtualFilamentMode = 'ratio' | 'cycle' | 'match' | 'gradient';

export interface VirtualFilamentPhysicalChoice {
  readonly id: string;
  /** One-based transient tool ID understood by the pinned engine. */
  readonly toolId: number;
  readonly name: string;
  readonly material: string;
  readonly color: string;
  readonly enabled: boolean;
  readonly compatible: boolean;
  readonly incompatibilityReason?: string;
}

export interface VirtualFilamentMatchCandidateComponent {
  readonly filamentId: string;
  readonly weight: number;
}

/**
 * A candidate preview must come from the pinned pigment model. This surface
 * ranks only these supplied candidates and never substitutes RGB averaging.
 */
export interface VirtualFilamentMatchCandidate {
  readonly id: string;
  readonly label?: string;
  readonly components: readonly VirtualFilamentMatchCandidateComponent[];
  readonly previewColor: string;
}

export interface VirtualFilamentValidatedComponent {
  readonly filamentId: string;
  readonly toolId: number;
}

export interface VirtualFilamentValidatedWeightedComponent extends VirtualFilamentValidatedComponent {
  readonly weight: number;
}

interface VirtualFilamentValidatedDraftBase {
  readonly name: string;
  readonly displayColor: string;
  readonly componentASurfaceOffsetMm: number;
  readonly componentBSurfaceOffsetMm: number;
  readonly mode: VirtualFilamentMode;
}

export interface VirtualFilamentRatioDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'ratio';
  readonly components: readonly VirtualFilamentValidatedComponent[];
  readonly mixBPercent: number;
  /** The exact user-authored proportions. The projection records normalized wire weights. */
  readonly triangleWeightsPercent?: readonly [number, number, number];
  readonly projection: MixedFilamentSerializableProjection;
}

export interface VirtualFilamentCycleDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'cycle';
  /** Exact accepted authoring text; it is not rewritten behind the user's cursor. */
  readonly manualPattern: string;
  /** Exact bracket syntax consumed by the pinned engine. */
  readonly normalizedPattern: string;
  readonly components: readonly VirtualFilamentValidatedComponent[];
  readonly groups: readonly (readonly number[])[];
  readonly sequence: readonly number[];
}

export interface VirtualFilamentMatchDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'match';
  readonly targetColor: string;
  readonly normalizedTargetColor: string;
  readonly minComponentPercent: number;
  readonly selectedCandidateId: string;
  readonly previewColor: string;
  readonly deltaE2000: number;
  readonly components: readonly VirtualFilamentValidatedWeightedComponent[];
  readonly projection: MixedFilamentSerializableProjection;
}

export interface VirtualFilamentGradientDraft extends VirtualFilamentValidatedDraftBase {
  readonly mode: 'gradient';
  readonly components: readonly [VirtualFilamentValidatedComponent, VirtualFilamentValidatedComponent];
  readonly direction: 'a-to-b' | 'b-to-a';
  readonly localZMaxSublayers: number;
  readonly projection: MixedFilamentSerializableProjection;
}

export type VirtualFilamentValidatedDraft =
  VirtualFilamentRatioDraft | VirtualFilamentCycleDraft | VirtualFilamentMatchDraft | VirtualFilamentGradientDraft;

export interface VirtualFilamentLibraryRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly draft: VirtualFilamentValidatedDraft;
  /** Human-readable canonical references shown before destructive deletion. */
  readonly dependencyLabels?: readonly string[];
}

/** Immutable canonical projection consumed by the DOM-only surface. */
export interface VirtualFilamentLibrarySnapshot {
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly physicalChoices: readonly VirtualFilamentPhysicalChoice[];
  readonly mixedRows: readonly VirtualFilamentLibraryRow[];
  readonly matchCandidates: readonly VirtualFilamentMatchCandidate[];
}

export interface VirtualFilamentRatioForm {
  componentCount: 2 | 3;
  componentIds: string[];
  mixBPercent: string;
  triangleWeights: [string, string, string];
}

export interface VirtualFilamentCycleForm {
  manualPattern: string;
}

export interface VirtualFilamentMatchForm {
  targetColor: string;
  minComponentPercent: string;
  selectedCandidateId?: string;
}

export interface VirtualFilamentGradientForm {
  componentIds: [string, string];
  direction: 'a-to-b' | 'b-to-a';
  localZMaxSublayers: string;
}

/** The author dialog's fields, exactly as typed. */
export interface VirtualFilamentAuthorForm {
  name: string;
  displayColor: string;
  componentASurfaceOffsetMm: string;
  componentBSurfaceOffsetMm: string;
  mode: VirtualFilamentMode;
  ratio: VirtualFilamentRatioForm;
  cycle: VirtualFilamentCycleForm;
  match: VirtualFilamentMatchForm;
  gradient: VirtualFilamentGradientForm;
}

export type VirtualFilamentAuthorOperation = 'add' | 'edit' | 'duplicate';

export interface VirtualFilamentIssue {
  readonly message: string;
  readonly field?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

export interface VirtualFilamentMatchRankView {
  readonly candidate: VirtualFilamentMatchCandidate;
  readonly ranked: RankedMatchRecipeCandidate;
}

export interface VirtualFilamentMatchRanking {
  readonly normalizedTargetColor?: string;
  readonly ranked: readonly VirtualFilamentMatchRankView[];
  readonly issues: readonly VirtualFilamentIssue[];
}

/** What the dialog knows of its Match search: still running, its candidates, or why it failed. */
export interface VirtualFilamentMatchSearchStatus {
  readonly status: 'pending' | 'ready' | 'error';
  readonly candidates: readonly VirtualFilamentMatchCandidate[];
  readonly error?: string;
}

export interface VirtualFilamentDraftValidation {
  readonly draft?: VirtualFilamentValidatedDraft;
  readonly issues: readonly VirtualFilamentIssue[];
  readonly preview: string;
  readonly matchRanking?: VirtualFilamentMatchRanking;
}

/** The Ratio mode's predicted mix: its colour and words. */
export interface VirtualFilamentRatioPreview {
  readonly color: string;
  readonly text: string;
}

/** The Gradient mode's vertical preview: top and bottom colours and words. */
export interface VirtualFilamentGradientPreview {
  readonly top: string;
  readonly bottom: string;
  readonly text: string;
}

/** Where the triangle picker draws its marker (in its 240 × 216 view box) and what it reads. */
export interface VirtualFilamentTriangleMarker {
  readonly x: number;
  readonly y: number;
  readonly weights: readonly [number, number, number];
  readonly valueText: string;
}

/** The triangle picker's corners, A at the top, in its 240 × 216 view box. */
export const VIRTUAL_FILAMENT_TRIANGLE_VERTICES = Object.freeze([
  Object.freeze({ x: 120, y: 18, label: 'A' }),
  Object.freeze({ x: 18, y: 198, label: 'B' }),
  Object.freeze({ x: 222, y: 198, label: 'C' }),
] as const);

/** The heads a recipe can newly select: enabled and compatible. */
export function selectablePhysical(snapshot: VirtualFilamentLibrarySnapshot): readonly VirtualFilamentPhysicalChoice[] {
  return snapshot.physicalChoices.filter((choice) => choice.enabled && choice.compatible);
}

/** The library's status line when no operation reports its own. */
export function libraryStatus(snapshot: VirtualFilamentLibrarySnapshot): string {
  const selectable = selectablePhysical(snapshot);
  return (
    `${snapshot.mixedRows.length} virtual ${snapshot.mixedRows.length === 1 ? 'filament' : 'filaments'}; ` +
    `${selectable.length} of ${snapshot.physicalChoices.length} physical heads selectable.`
  );
}

/** A new dialog's fields: the first selectable heads, grey, a 50 % Ratio. */
export function defaultAuthorState(snapshot: VirtualFilamentLibrarySnapshot): VirtualFilamentAuthorForm {
  const selectable = selectablePhysical(snapshot);
  const first = selectable[0]?.id ?? '';
  const second = selectable[1]?.id ?? '';
  const third = selectable[2]?.id ?? first;
  return {
    name: 'Virtual filament',
    displayColor: '#808080',
    componentASurfaceOffsetMm: '0',
    componentBSurfaceOffsetMm: '0',
    mode: 'ratio',
    ratio: {
      componentCount: 2,
      componentIds: [first, second, third],
      mixBPercent: '50',
      triangleWeights: ['34', '33', '33'],
    },
    cycle: { manualPattern: '' },
    match: { targetColor: '#808080', minComponentPercent: '10' },
    gradient: { componentIds: [first, second], direction: 'a-to-b', localZMaxSublayers: '2' },
  };
}

/** A row's recipe loaded into the dialog's fields (its mode's fields; the others keep their defaults). */
export function loadDraft(target: VirtualFilamentAuthorForm, source: VirtualFilamentValidatedDraft): void {
  target.name = source.name;
  target.displayColor = source.displayColor;
  target.componentASurfaceOffsetMm = String(source.componentASurfaceOffsetMm);
  target.componentBSurfaceOffsetMm = String(source.componentBSurfaceOffsetMm);
  target.mode = source.mode;
  if (source.mode === 'ratio') {
    target.ratio.componentCount = source.components.length === 3 ? 3 : 2;
    target.ratio.componentIds = source.components.map((component) => component.filamentId);
    target.ratio.mixBPercent = String(source.mixBPercent);
    if (source.triangleWeightsPercent) {
      target.ratio.triangleWeights = source.triangleWeightsPercent.map(String) as [string, string, string];
    }
  } else if (source.mode === 'cycle') {
    target.cycle.manualPattern = source.manualPattern;
  } else if (source.mode === 'match') {
    target.match.targetColor = source.targetColor;
    target.match.minComponentPercent = String(source.minComponentPercent);
    target.match.selectedCandidateId = source.selectedCandidateId;
  } else {
    target.gradient.componentIds = [source.components[0].filamentId, source.components[1].filamentId];
    target.gradient.direction = source.direction;
    target.gradient.localZMaxSublayers = String(source.localZMaxSublayers);
  }
}

/** The fields the author dialog opens with for `operation` on `row` (none when adding). */
export function authorFormFor(
  snapshot: VirtualFilamentLibrarySnapshot,
  operation: VirtualFilamentAuthorOperation,
  row?: VirtualFilamentLibraryRow,
): VirtualFilamentAuthorForm {
  const defaults = defaultAuthorState(snapshot);
  const source = row?.draft;
  if (source) loadDraft(defaults, source);
  if (operation === 'duplicate' && source) defaults.name = duplicateName(source.name);
  return defaults;
}

/** Validate the dialog's fields for their mode against the snapshot (and the dialog's Match search). */
export function validateAuthorForm(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot | undefined,
  search?: VirtualFilamentMatchSearchStatus,
): VirtualFilamentDraftValidation {
  const commonIssues = validateCommon(state);
  if (!snapshot) {
    return { issues: [...commonIssues, { message: 'No canonical snapshot is available.' }], preview: '' };
  }
  if (state.mode === 'ratio') return validateRatio(state, snapshot, commonIssues);
  if (state.mode === 'cycle') return validateCycle(state, snapshot, commonIssues);
  if (state.mode === 'match') return validateMatch(state, snapshot, commonIssues, search);
  return validateGradient(state, snapshot, commonIssues);
}

function validateCommon(state: VirtualFilamentAuthorForm): VirtualFilamentIssue[] {
  const issues: VirtualFilamentIssue[] = [];
  if (!state.name) issues.push({ message: 'Name is required.', field: 'name' });
  else if (state.name !== state.name.trim()) {
    issues.push({ message: 'Name must not start or end with whitespace.', field: 'name' });
  } else if (state.name.length > VIRTUAL_FILAMENT_NAME_LIMIT) {
    issues.push({
      message: `Name cannot exceed ${VIRTUAL_FILAMENT_NAME_LIMIT} characters.`,
      field: 'name',
    });
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(state.displayColor)) {
    issues.push({ message: 'Display badge color must be exactly #RRGGBB.', field: 'display-color' });
  }
  for (const [label, field, value] of [
    ['Component A', 'component-a-surface-offset', state.componentASurfaceOffsetMm],
    ['Component B', 'component-b-surface-offset', state.componentBSurfaceOffsetMm],
  ] as const) {
    const parsed = parseStrictFinite(value);
    if (parsed === undefined || Math.abs(parsed) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM) {
      issues.push({
        message: `${label} surface offset must be a finite number from -${FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM} to +${FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM} mm.`,
        field,
      });
    }
  }
  return issues;
}

function validatedSurfaceOffsets(
  state: VirtualFilamentAuthorForm,
): Pick<VirtualFilamentValidatedDraftBase, 'componentASurfaceOffsetMm' | 'componentBSurfaceOffsetMm'> {
  const componentASurfaceOffsetMm = parseStrictFinite(state.componentASurfaceOffsetMm);
  const componentBSurfaceOffsetMm = parseStrictFinite(state.componentBSurfaceOffsetMm);
  if (
    componentASurfaceOffsetMm === undefined ||
    componentBSurfaceOffsetMm === undefined ||
    Math.abs(componentASurfaceOffsetMm) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM ||
    Math.abs(componentBSurfaceOffsetMm) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM
  ) {
    throw new Error('Surface offsets were requested before common authoring validation passed');
  }
  return { componentASurfaceOffsetMm, componentBSurfaceOffsetMm };
}

function validateRatio(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly VirtualFilamentIssue[],
): VirtualFilamentDraftValidation {
  const issues = [...commonIssues];
  const count = state.ratio.componentCount;
  const selectedIds = state.ratio.componentIds.slice(0, count);
  const components = resolveComponents(selectedIds, snapshot, issues, 'ratio-component');
  const mixBPercent = parseStrictInteger(state.ratio.mixBPercent);
  if (mixBPercent === undefined) {
    issues.push({ message: 'Component B percent must be an integer from 0 to 100.', field: 'ratio-mix-b' });
  }
  let triangle: [number, number, number] | undefined;
  if (count === 3) {
    const parsed = state.ratio.triangleWeights.map(parseStrictFinite);
    if (parsed.some((value) => value === undefined || value < 0)) {
      issues.push({
        message: 'All three triangle proportions must be finite non-negative numbers.',
        field: 'ratio-weight-0',
      });
    } else {
      triangle = parsed as [number, number, number];
    }
  }

  let projection: MixedFilamentSerializableProjection | undefined;
  if (components.length === count && mixBPercent !== undefined && (count === 2 || triangle)) {
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'ratio',
        componentIds: components.map((component) => component.toolId),
        mixBPercent,
        ...(triangle ? { triangleWeightsPercent: triangle } : {}),
      },
      { physicalToolCount: snapshot.physicalChoices.length },
    );
    if (result.projection) projection = result.projection;
    else issues.push(...result.issues.map(authoringIssue));
  }

  const preview = projection
    ? count === 2
      ? `Exact cadence: A ${projection.ratio_a} layer${projection.ratio_a === 1 ? '' : 's'} / B ${
          projection.ratio_b
        } layer${projection.ratio_b === 1 ? '' : 's'}; badge ${state.displayColor}.`
      : `Exact saved triangle weights: ${projection.gradient_component_weights.replaceAll(
          '/',
          '% / ',
        )}%; badge ${state.displayColor}.`
    : 'Complete the Ratio recipe to preview its exact pinned-engine fields.';
  if (!projection || issues.length > 0) return { issues: freezeArray(issues), preview };
  return {
    draft: freezeDraft<VirtualFilamentRatioDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'ratio',
      components,
      mixBPercent: mixBPercent!,
      ...(triangle ? { triangleWeightsPercent: Object.freeze([...triangle]) as [number, number, number] } : {}),
      projection,
    }),
    issues: Object.freeze([]),
    preview,
  };
}

function validateCycle(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly VirtualFilamentIssue[],
): VirtualFilamentDraftValidation {
  const issues = [...commonIssues];
  const availableToolIds = selectablePhysical(snapshot).map((choice) => choice.toolId);
  const parsed = parseManualCyclePattern(state.cycle.manualPattern, { availableToolIds });
  issues.push(...parsed.issues.map(cycleIssue));
  const uniqueToolIds = [...new Set(parsed.sequence)];
  const byTool = new Map(snapshot.physicalChoices.map((choice) => [choice.toolId, choice]));
  const components = uniqueToolIds.flatMap((toolId) => {
    const choice = byTool.get(toolId);
    return choice ? [{ filamentId: choice.id, toolId }] : [];
  });
  const cycleWarning =
    uniqueToolIds.length === 1
      ? ' Warning: one distinct head cannot produce a new mixed color.'
      : uniqueToolIds.length > 4
        ? ' Warning: more than four heads may reduce recipe quality.'
        : '';
  const preview = parsed.syntaxValid
    ? `Exact engine pattern: ${parsed.normalized || '(none)'}; groups: ${patternGroupSummary(
        parsed,
        byTool,
      )}.${cycleWarning}`
    : 'Fix the located pattern errors before this exact sequence can be submitted.';
  if (!parsed.ok || issues.length > 0) {
    return { issues: freezeArray(dedupeIssues(issues)), preview };
  }
  return {
    draft: freezeDraft<VirtualFilamentCycleDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'cycle',
      manualPattern: state.cycle.manualPattern,
      normalizedPattern: parsed.normalized,
      components,
      groups: parsed.groups.map((group) => Object.freeze(group.tokens.map((token) => token.toolId))),
      sequence: Object.freeze([...parsed.sequence]),
    }),
    issues: Object.freeze([]),
    preview,
  };
}

function validateMatch(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly VirtualFilamentIssue[],
  search?: VirtualFilamentMatchSearchStatus,
): VirtualFilamentDraftValidation {
  const issues = [...commonIssues];
  const minimum = parseStrictInteger(state.match.minComponentPercent);
  if (minimum === undefined || minimum < 0 || minimum > 50) {
    issues.push({
      message: 'Minimum component percent must be an integer from 0 to 50.',
      field: 'match-minimum',
    });
  }
  if (search?.status === 'error') {
    issues.push({
      message: `Pinned Match search is unavailable: ${search.error ?? 'Unknown search error'}`,
      field: 'match-candidate',
    });
  }
  const dynamicCandidates = search?.status === 'ready' ? search.candidates : undefined;
  const ranking =
    minimum === undefined
      ? { ranked: Object.freeze([]), issues: Object.freeze([]) }
      : rankSuppliedCandidates(
          snapshot,
          state.match.targetColor,
          minimum,
          dynamicCandidates
            ? dedupeMatchCandidates([...dynamicCandidates, ...snapshot.matchCandidates])
            : snapshot.matchCandidates,
        );
  issues.push(...ranking.issues);
  const selected = ranking.ranked.find((entry) => entry.candidate.id === state.match.selectedCandidateId);
  if (ranking.ranked.length > 0 && !selected) {
    issues.push({
      message: 'Explicitly select one ranked supplied candidate.',
      field: 'match-candidate',
    });
  }
  const preview = selected
    ? `Selected ${selected.candidate.label ?? selected.candidate.id}: predicted ${
        selected.ranked.previewColor
      }, target ${ranking.normalizedTargetColor}, ΔE2000 ${selected.ranked.deltaE2000.toFixed(2)}.`
    : search?.status === 'pending'
      ? 'Searching the compatible physical palette for the closest pinned Match recipe.'
      : 'Enter a valid target and minimum, then explicitly select one supplied candidate.';
  if (!selected || minimum === undefined || !ranking.normalizedTargetColor || issues.length > 0) {
    return { issues: freezeArray(dedupeIssues(issues)), preview, matchRanking: ranking };
  }
  const physicalById = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  const normalizedWeights = normalizeColorMatchWeights(
    selected.candidate.components.map((component) => component.weight),
    selected.candidate.components.length,
  );
  const components = selected.candidate.components.map((component, index) => {
    const physical = physicalById.get(component.filamentId)!;
    return Object.freeze({
      filamentId: physical.id,
      toolId: physical.toolId,
      weight: normalizedWeights[index],
    });
  });
  return {
    draft: freezeDraft<VirtualFilamentMatchDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'match',
      targetColor: state.match.targetColor,
      normalizedTargetColor: ranking.normalizedTargetColor,
      minComponentPercent: minimum,
      selectedCandidateId: selected.candidate.id,
      previewColor: selected.ranked.previewColor,
      deltaE2000: selected.ranked.deltaE2000,
      components,
      projection: selected.ranked.projection,
    }),
    issues: Object.freeze([]),
    preview,
    matchRanking: ranking,
  };
}

function validateGradient(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot,
  commonIssues: readonly VirtualFilamentIssue[],
): VirtualFilamentDraftValidation {
  const issues = [...commonIssues];
  const components = resolveComponents(state.gradient.componentIds, snapshot, issues, 'gradient-component');
  const sublayers = parseStrictInteger(state.gradient.localZMaxSublayers);
  if (sublayers === undefined || sublayers < 2) {
    issues.push({
      message: 'Gradient Local-Z sublayers must be a safe integer of at least 2.',
      field: 'gradient-sublayers',
    });
  }
  let projection: MixedFilamentSerializableProjection | undefined;
  if (components.length === 2 && sublayers !== undefined && sublayers >= 2) {
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'gradient',
        componentIds: components.map((component) => component.toolId),
        direction: state.gradient.direction,
        localZMaxSublayers: sublayers,
      },
      { physicalToolCount: snapshot.physicalChoices.length },
    );
    if (result.projection) projection = result.projection;
    else issues.push(...result.issues.map(authoringIssue));
  }
  const preview = projection
    ? `${state.gradient.direction === 'a-to-b' ? 'A→B' : 'B→A'}: component A ${Math.round(
        projection.gradient_start * 100,
      )}% → ${Math.round(projection.gradient_end * 100)}%; component B ${Math.round(
        (1 - projection.gradient_start) * 100,
      )}% → ${Math.round((1 - projection.gradient_end) * 100)}%; ${projection.local_z_max_sublayers} Local-Z sublayers.`
    : 'Choose two distinct physical heads and at least two Local-Z sublayers.';
  if (!projection || components.length !== 2 || issues.length > 0) {
    return { issues: freezeArray(dedupeIssues(issues)), preview };
  }
  return {
    draft: freezeDraft<VirtualFilamentGradientDraft>({
      name: state.name,
      displayColor: state.displayColor,
      ...validatedSurfaceOffsets(state),
      mode: 'gradient',
      components: Object.freeze([components[0], components[1]]),
      direction: state.gradient.direction,
      localZMaxSublayers: sublayers!,
      projection,
    }),
    issues: Object.freeze([]),
    preview,
  };
}

/** Rank the snapshot's (or the given) candidates for `targetColor` at `minComponentPercent`. */
export function rankSuppliedCandidates(
  snapshot: VirtualFilamentLibrarySnapshot,
  targetColor: string,
  minComponentPercent: number,
  candidates: readonly VirtualFilamentMatchCandidate[] = snapshot.matchCandidates,
): VirtualFilamentMatchRanking {
  const byId = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  const eligible: VirtualFilamentMatchCandidate[] = [];
  const candidateIssues: VirtualFilamentIssue[] = [];
  for (const candidate of candidates) {
    const selectable = candidate.components.every((component) => {
      const physical = byId.get(component.filamentId);
      return physical?.enabled === true && physical.compatible;
    });
    if (!selectable) continue;
    const components = candidate.components.flatMap((component) => {
      const physical = byId.get(component.filamentId);
      return physical ? [{ toolId: physical.toolId, weight: component.weight }] : [];
    });
    const result = projectMixedFilamentAuthoring(
      { mode: 'match', components, targetColor, minComponentPercent },
      { physicalToolCount: snapshot.physicalChoices.length },
    );
    if (result.ok) eligible.push(candidate);
  }
  const ranked = rankColorMatchCandidates({
    physicalToolCount: snapshot.physicalChoices.length,
    targetColor,
    minComponentPercent,
    candidates: eligible.map((candidate) => ({
      components: candidate.components.map((component) => ({
        toolId: byId.get(component.filamentId)!.toolId,
        weight: component.weight,
      })),
      previewColor: candidate.previewColor,
    })),
  });
  if (!ranked.ok) candidateIssues.push(...ranked.issues.map(authoringIssue));
  const views = ranked.candidates.map((entry) =>
    Object.freeze({
      candidate: eligible[entry.sourceIndex],
      ranked: entry,
    }),
  );
  return Object.freeze({
    ...(ranked.normalizedTargetColor ? { normalizedTargetColor: ranked.normalizedTargetColor } : {}),
    ranked: Object.freeze(views),
    issues: freezeArray(dedupeIssues(candidateIssues)),
  });
}

/** A ranked candidate's title in the candidate list (`index` is zero-based). */
export function matchCandidateTitle(index: number, candidate: VirtualFilamentMatchCandidate): string {
  return `#${index + 1} · ${candidate.label ?? candidate.id}`;
}

/** A ranked candidate's details: its saved weights, predicted colour and ΔE2000. */
export function matchCandidateDetail(
  view: VirtualFilamentMatchRankView,
  snapshot: VirtualFilamentLibrarySnapshot | undefined,
): string {
  return (
    `${componentSummary(view.candidate.components, snapshot)} · predicted ${view.ranked.previewColor} · ` +
    `ΔE2000 ${view.ranked.deltaE2000.toFixed(2)}`
  );
}

function dedupeMatchCandidates(
  candidates: readonly VirtualFilamentMatchCandidate[],
): readonly VirtualFilamentMatchCandidate[] {
  const ids = new Set<string>();
  return Object.freeze(
    candidates.filter((candidate) => {
      if (ids.has(candidate.id)) return false;
      ids.add(candidate.id);
      return true;
    }),
  );
}

function resolveComponents(
  ids: readonly string[],
  snapshot: VirtualFilamentLibrarySnapshot,
  issues: VirtualFilamentIssue[],
  fieldPrefix: string,
): VirtualFilamentValidatedComponent[] {
  const byId = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  const seen = new Set<string>();
  const components: VirtualFilamentValidatedComponent[] = [];
  ids.forEach((id, index) => {
    const field = `${fieldPrefix}-${index}`;
    const choice = byId.get(id);
    if (!choice) {
      issues.push({ message: `Component ${index + 1} must choose a physical head.`, field });
      return;
    }
    if (!choice.enabled) issues.push({ message: `${choice.name} is disabled.`, field });
    if (!choice.compatible) {
      issues.push({
        message: `${choice.name} is incompatible${choice.incompatibilityReason ? `: ${choice.incompatibilityReason}` : '.'}`,
        field,
      });
    }
    if (seen.has(id)) {
      issues.push({ message: 'A recipe cannot select the same physical head more than once.', field });
      return;
    }
    seen.add(id);
    components.push(Object.freeze({ filamentId: id, toolId: choice.toolId }));
  });
  return components;
}

/** The Ratio mode's predicted mix colour, or undefined until its recipe is complete. */
export function ratioPigmentPreview(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot | undefined,
): VirtualFilamentRatioPreview | undefined {
  const byId = new Map((snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
  const choices = state.ratio.componentIds.slice(0, state.ratio.componentCount).map((id) => byId.get(id));
  let predictedColor: string | undefined;
  let method: string | undefined;
  if (state.ratio.componentCount === 2) {
    const mixBPercent = parseStrictInteger(state.ratio.mixBPercent);
    if (choices[0] && choices[1] && mixBPercent !== undefined && mixBPercent >= 0 && mixBPercent <= 100) {
      predictedColor = blendPairFilamentPigment(choices[0].color, choices[1].color, mixBPercent / 100);
      method = 'pinned two-filament pigment model';
    }
  } else {
    const weights = state.ratio.triangleWeights.map(parseStrictFinite);
    if (
      choices.length === 3 &&
      choices.every((choice) => choice !== undefined) &&
      weights.every((weight) => weight !== undefined && weight >= 0) &&
      weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0) > 0
    ) {
      const normalized = normalizeRatioTriangleWeights(weights as [number, number, number]);
      const first = parseOrcaMixedColor(choices[0]!.color);
      const second = parseOrcaMixedColor(choices[1]!.color);
      const third = parseOrcaMixedColor(choices[2]!.color);
      predictedColor = filamentRgbToHex([
        Math.round(first[0] * normalized[0] + second[0] * normalized[1] + third[0] * normalized[2]),
        Math.round(first[1] * normalized[0] + second[1] * normalized[1] + third[1] * normalized[2]),
        Math.round(first[2] * normalized[0] + second[2] * normalized[1] + third[2] * normalized[2]),
      ]);
      method = 'pinned triangle weighted-sRGB preview';
    }
  }
  if (!predictedColor || !method) return undefined;
  return Object.freeze({
    color: predictedColor,
    text: `Predicted mix ${predictedColor} · ${method}. Saved badge remains ${state.displayColor}.`,
  });
}

/** The Gradient mode's vertical preview, or undefined until both heads are chosen. */
export function gradientPreview(
  state: VirtualFilamentAuthorForm,
  snapshot: VirtualFilamentLibrarySnapshot | undefined,
): VirtualFilamentGradientPreview | undefined {
  const byId = new Map((snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
  const first = byId.get(state.gradient.componentIds[0]);
  const second = byId.get(state.gradient.componentIds[1]);
  if (!first || !second) return undefined;
  const top = state.gradient.direction === 'a-to-b' ? first : second;
  const bottom = state.gradient.direction === 'a-to-b' ? second : first;
  return Object.freeze({
    top: top.color,
    bottom: bottom.color,
    text:
      `${state.gradient.direction === 'a-to-b' ? 'A→B' : 'B→A'} vertical preview · ` +
      `A ${state.gradient.direction === 'a-to-b' ? '80%→20%' : '20%→80%'} · ` +
      `${first.name} / ${second.name}`,
  });
}

/** The triangle picker's marker for the typed proportions. */
export function triangleMarker(texts: readonly string[]): VirtualFilamentTriangleMarker {
  const weights = normalizeTriangleVisualWeights(texts.map((value) => Number(value)));
  const [a, b, c] = weights;
  const [first, second, third] = VIRTUAL_FILAMENT_TRIANGLE_VERTICES;
  return Object.freeze({
    x: (a * first.x + b * second.x + c * third.x) / 100,
    y: (a * first.y + b * second.y + c * third.y) / 100,
    weights,
    valueText: `A ${weights[0].toFixed(1)}%, B ${weights[1].toFixed(1)}%, C ${weights[2].toFixed(1)}%`,
  });
}

/** The proportions the picker writes for a point of its view box, as the fields show them. */
export function triangleWeightTextsAt(x: number, y: number): [string, string, string] {
  return triangleWeightsAtPoint(x, y, VIRTUAL_FILAMENT_TRIANGLE_VERTICES).map((weight) =>
    String(Number(weight.toFixed(2))),
  ) as [string, string, string];
}

export function normalizeTriangleVisualWeights(values: readonly number[]): [number, number, number] {
  const safe = [0, 1, 2].map((index) => {
    const value = values[index];
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }) as [number, number, number];
  const total = safe[0] + safe[1] + safe[2];
  if (total <= 0) return [34, 33, 33];
  return safe.map((value) => (value * 100) / total) as [number, number, number];
}

export function triangleWeightsAtPoint(
  x: number,
  y: number,
  vertices: readonly { readonly x: number; readonly y: number }[],
): [number, number, number] {
  const [a, b, c] = vertices;
  if (!a || !b || !c) return [34, 33, 33];
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < Number.EPSILON) return [34, 33, 33];
  const weightA = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
  const weightB = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
  return normalizeRatioTriangleBarycentricWeights([weightA, weightB, 1 - weightA - weightB]).map(
    (weight) => weight * 100,
  ) as [number, number, number];
}

/**
 * A snapshot checked and frozen as the library renders it: identifiers,
 * the contiguous one-based tool namespace, candidates and every row's recipe
 * re-derived through the pinned projection. Throws what makes it unusable.
 */
export function immutableSnapshot(input: VirtualFilamentLibrarySnapshot): VirtualFilamentLibrarySnapshot {
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    throw new Error('sourceRevision must be a non-negative safe integer');
  }
  if (!input.sourceHash || input.sourceHash !== input.sourceHash.trim()) {
    throw new Error('sourceHash must be non-empty canonical text');
  }
  if (input.physicalChoices.length > MAX_AUTHORING_PHYSICAL_TOOL_ID) {
    throw new Error(`At most ${MAX_AUTHORING_PHYSICAL_TOOL_ID} physical heads are supported`);
  }
  const physicalIds = new Set<string>();
  const toolIds = new Set<number>();
  const physicalChoices = input.physicalChoices.map((choice) => {
    assertIdentifier(choice.id, 'physical filament ID');
    if (physicalIds.has(choice.id)) throw new Error(`Duplicate physical filament ID ${choice.id}`);
    physicalIds.add(choice.id);
    if (!Number.isSafeInteger(choice.toolId) || choice.toolId < 1 || choice.toolId > input.physicalChoices.length) {
      throw new Error(`Physical tool ID ${choice.toolId} must be within 1..${input.physicalChoices.length}`);
    }
    if (toolIds.has(choice.toolId)) throw new Error(`Duplicate physical tool ID ${choice.toolId}`);
    toolIds.add(choice.toolId);
    if (!choice.name.trim() || !choice.material.trim()) throw new Error('Physical choice labels must not be empty');
    if (!/^#[0-9a-fA-F]{6}$/.test(choice.color)) throw new Error(`Invalid physical color ${choice.color}`);
    return Object.freeze({ ...choice });
  });
  const expectedTools = Array.from({ length: physicalChoices.length }, (_, index) => index + 1);
  if (expectedTools.some((toolId) => !toolIds.has(toolId))) {
    throw new Error('Physical tool IDs must form the contiguous pinned-engine namespace 1..N');
  }

  const candidateIds = new Set<string>();
  const matchCandidates = input.matchCandidates.map((candidate) => {
    assertIdentifier(candidate.id, 'Match candidate ID');
    if (candidateIds.has(candidate.id)) throw new Error(`Duplicate Match candidate ID ${candidate.id}`);
    candidateIds.add(candidate.id);
    if (!/^#[0-9a-fA-F]{6}$/.test(candidate.previewColor)) {
      throw new Error(`Invalid Match preview color ${candidate.previewColor}`);
    }
    if (candidate.components.length < 2 || candidate.components.length > 4) {
      throw new Error(`Match candidate ${candidate.id} must have two to four components`);
    }
    const seen = new Set<string>();
    const components = candidate.components.map((component) => {
      if (!physicalIds.has(component.filamentId)) {
        throw new Error(`Match candidate ${candidate.id} references unknown physical filament ${component.filamentId}`);
      }
      if (seen.has(component.filamentId)) {
        throw new Error(`Match candidate ${candidate.id} repeats physical filament ${component.filamentId}`);
      }
      seen.add(component.filamentId);
      if (!Number.isSafeInteger(component.weight) || component.weight < 0) {
        throw new Error(`Match candidate ${candidate.id} has an invalid weight`);
      }
      return Object.freeze({ ...component });
    });
    return Object.freeze({ ...candidate, components: Object.freeze(components) });
  });

  const mixedIds = new Set<string>();
  const mixedRows = input.mixedRows.map((row) => {
    assertIdentifier(row.id, 'virtual filament ID');
    if (mixedIds.has(row.id)) throw new Error(`Duplicate virtual filament ID ${row.id}`);
    mixedIds.add(row.id);
    assertSnapshotDraft(row.draft, physicalChoices);
    const dependencyLabels = Object.freeze([...(row.dependencyLabels ?? [])]);
    return Object.freeze({
      id: row.id,
      enabled: row.enabled,
      draft: cloneFrozenDraft(row.draft),
      ...(dependencyLabels.length > 0 ? { dependencyLabels } : {}),
    });
  });
  return Object.freeze({
    sourceRevision: input.sourceRevision,
    sourceHash: input.sourceHash,
    physicalChoices: Object.freeze(physicalChoices),
    mixedRows: Object.freeze(mixedRows),
    matchCandidates: Object.freeze(matchCandidates),
  });
}

function assertSnapshotDraft(
  draft: VirtualFilamentValidatedDraft,
  physicalChoices: readonly VirtualFilamentPhysicalChoice[],
): void {
  if (!draft.name || draft.name !== draft.name.trim() || draft.name.length > VIRTUAL_FILAMENT_NAME_LIMIT) {
    throw new Error('Virtual filament draft has an invalid name');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(draft.displayColor)) {
    throw new Error(`Virtual filament ${draft.name} has an invalid display color`);
  }
  for (const offset of [draft.componentASurfaceOffsetMm, draft.componentBSurfaceOffsetMm]) {
    if (!Number.isFinite(offset) || Math.abs(offset) > FULL_SPECTRUM_MAX_SURFACE_OFFSET_MM) {
      throw new Error(`Virtual filament ${draft.name} has an invalid component surface offset`);
    }
  }
  const byId = new Map(physicalChoices.map((choice) => [choice.id, choice]));
  const validateComponents = (
    components: readonly VirtualFilamentValidatedComponent[],
    minimum: number,
    maximum: number,
  ): number[] => {
    if (components.length < minimum || components.length > maximum) {
      throw new Error(`Virtual filament ${draft.name} has an invalid component count`);
    }
    const ids = new Set<string>();
    return components.map((component) => {
      const physical = byId.get(component.filamentId);
      if (!physical || physical.toolId !== component.toolId || ids.has(component.filamentId)) {
        throw new Error(`Virtual filament ${draft.name} has an invalid physical component`);
      }
      ids.add(component.filamentId);
      return component.toolId;
    });
  };

  if (draft.mode === 'ratio') {
    const toolIds = validateComponents(draft.components, 2, 3);
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'ratio',
        componentIds: toolIds,
        mixBPercent: draft.mixBPercent,
        ...(draft.triangleWeightsPercent ? { triangleWeightsPercent: draft.triangleWeightsPercent } : {}),
      },
      { physicalToolCount: physicalChoices.length },
    );
    requireMatchingProjection(draft, result.projection);
    return;
  }
  if (draft.mode === 'cycle') {
    const toolIds = validateComponents(draft.components, 1, MAX_AUTHORING_PHYSICAL_TOOL_ID);
    const parsed = parseManualCyclePattern(draft.manualPattern, {
      availableToolIds: physicalChoices.map((choice) => choice.toolId),
    });
    if (
      !parsed.ok ||
      parsed.normalized !== draft.normalizedPattern ||
      !sameNumbers(parsed.sequence, draft.sequence) ||
      parsed.groups.length !== draft.groups.length ||
      parsed.groups.some(
        (group, index) =>
          !sameNumbers(
            group.tokens.map((token) => token.toolId),
            draft.groups[index],
          ),
      ) ||
      !sameNumbers([...new Set(parsed.sequence)], toolIds)
    ) {
      throw new Error(`Virtual filament ${draft.name} has an invalid Cycle draft`);
    }
    return;
  }
  if (draft.mode === 'match') {
    const toolIds = validateComponents(draft.components, 2, 4);
    if (
      !draft.selectedCandidateId ||
      !/^#[0-9a-fA-F]{6}$/.test(draft.previewColor) ||
      !Number.isFinite(draft.deltaE2000) ||
      draft.deltaE2000 < 0
    ) {
      throw new Error(`Virtual filament ${draft.name} has invalid Match result metadata`);
    }
    const result = projectMixedFilamentAuthoring(
      {
        mode: 'match',
        components: toolIds.map((toolId, index) => ({
          toolId,
          weight: draft.components[index].weight,
        })),
        targetColor: draft.targetColor,
        minComponentPercent: draft.minComponentPercent,
      },
      { physicalToolCount: physicalChoices.length },
    );
    if (result.normalizedTargetColor !== draft.normalizedTargetColor) {
      throw new Error(`Virtual filament ${draft.name} has a mismatched normalized Match target`);
    }
    requireMatchingProjection(draft, result.projection);
    return;
  }
  const toolIds = validateComponents(draft.components, 2, 2);
  if (!Number.isSafeInteger(draft.localZMaxSublayers) || draft.localZMaxSublayers < 2) {
    throw new Error(`Virtual filament ${draft.name} has an invalid Local-Z sublayer count`);
  }
  const result = projectMixedFilamentAuthoring(
    {
      mode: 'gradient',
      componentIds: toolIds,
      direction: draft.direction,
      localZMaxSublayers: draft.localZMaxSublayers,
    },
    { physicalToolCount: physicalChoices.length },
  );
  requireMatchingProjection(draft, result.projection);
}

function requireMatchingProjection(
  draft: { readonly name: string; readonly projection: MixedFilamentSerializableProjection },
  projection: MixedFilamentSerializableProjection | null,
): void {
  if (!projection || !sameProjection(projection, draft.projection)) {
    throw new Error(`Virtual filament ${draft.name} has a mismatched pinned-engine projection`);
  }
}

function sameProjection(
  first: MixedFilamentSerializableProjection,
  second: MixedFilamentSerializableProjection,
): boolean {
  return (
    first.ui_mode === second.ui_mode &&
    first.component_a === second.component_a &&
    first.component_b === second.component_b &&
    first.mix_b_percent === second.mix_b_percent &&
    first.ratio_a === second.ratio_a &&
    first.ratio_b === second.ratio_b &&
    first.manual_pattern === second.manual_pattern &&
    first.gradient_component_ids === second.gradient_component_ids &&
    first.gradient_component_weights === second.gradient_component_weights &&
    first.distribution_mode === second.distribution_mode &&
    first.local_z_max_sublayers === second.local_z_max_sublayers &&
    first.gradient_enabled === second.gradient_enabled &&
    first.gradient_start === second.gradient_start &&
    first.gradient_end === second.gradient_end &&
    first.custom === second.custom
  );
}

function sameNumbers(first: readonly number[], second: readonly number[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function cloneFrozenDraft(draft: VirtualFilamentValidatedDraft): VirtualFilamentValidatedDraft {
  if (draft.mode === 'ratio') {
    return freezeDraft<VirtualFilamentRatioDraft>({
      ...draft,
      components: draft.components.map((component) => ({ ...component })),
      ...(draft.triangleWeightsPercent
        ? {
            triangleWeightsPercent: Object.freeze([...draft.triangleWeightsPercent]) as [number, number, number],
          }
        : {}),
      projection: Object.freeze({ ...draft.projection }),
    });
  }
  if (draft.mode === 'cycle') {
    return freezeDraft<VirtualFilamentCycleDraft>({
      ...draft,
      components: draft.components.map((component) => ({ ...component })),
      groups: draft.groups.map((group) => [...group]),
      sequence: [...draft.sequence],
    });
  }
  if (draft.mode === 'match') {
    return freezeDraft<VirtualFilamentMatchDraft>({
      ...draft,
      components: draft.components.map((component) => ({ ...component })),
      projection: Object.freeze({ ...draft.projection }),
    });
  }
  return freezeDraft<VirtualFilamentGradientDraft>({
    ...draft,
    components: [{ ...draft.components[0] }, { ...draft.components[1] }],
    projection: Object.freeze({ ...draft.projection }),
  });
}

function freezeDraft<T extends VirtualFilamentValidatedDraft>(draft: T): T {
  if ('components' in draft) {
    (draft as { components: readonly object[] }).components = Object.freeze(
      draft.components.map((component) => Object.freeze({ ...component })),
    );
  }
  if (draft.mode === 'cycle') {
    (draft as VirtualFilamentCycleDraft & { groups: readonly (readonly number[])[] }).groups = Object.freeze(
      draft.groups.map((group) => Object.freeze([...group])),
    );
    (draft as VirtualFilamentCycleDraft & { sequence: readonly number[] }).sequence = Object.freeze([
      ...draft.sequence,
    ]);
  }
  if (draft.mode === 'ratio' && draft.triangleWeightsPercent) {
    (
      draft as VirtualFilamentRatioDraft & {
        triangleWeightsPercent: readonly [number, number, number];
      }
    ).triangleWeightsPercent = Object.freeze([...draft.triangleWeightsPercent]) as [number, number, number];
  }
  if ('projection' in draft) {
    (draft as { projection: MixedFilamentSerializableProjection }).projection = Object.freeze({
      ...draft.projection,
    });
  }
  return Object.freeze(draft);
}

function authoringIssue(issue: {
  readonly message: string;
  readonly location: { readonly path: string };
}): VirtualFilamentIssue {
  return Object.freeze({ message: issue.message, field: pathToField(issue.location.path) });
}

function cycleIssue(issue: {
  readonly message: string;
  readonly location: { readonly startOffset: number; readonly endOffset: number };
}): VirtualFilamentIssue {
  return Object.freeze({
    message: issue.message,
    field: 'cycle-pattern',
    startOffset: issue.location.startOffset,
    endOffset: issue.location.endOffset,
  });
}

function pathToField(path: string): string | undefined {
  if (path.includes('mixBPercent')) return 'ratio-mix-b';
  if (path.includes('triangleWeightsPercent')) return 'ratio-weight-0';
  if (path.includes('targetColor')) return 'match-target';
  if (path.includes('minComponentPercent')) return 'match-minimum';
  if (path.includes('localZMaxSublayers')) return 'gradient-sublayers';
  return undefined;
}

export function parseStrictInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseStrictFinite(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeMatchTargetColor(value: string): string | undefined {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined;
}

export function validRangeValue(value: string, min: number, max: number, fallback: number): string {
  const parsed = parseStrictInteger(value);
  return String(parsed === undefined ? fallback : Math.min(max, Math.max(min, parsed)));
}

function patternGroupSummary(
  parsed: ManualCyclePatternParseResult,
  byTool: ReadonlyMap<number, VirtualFilamentPhysicalChoice>,
): string {
  return parsed.groups
    .map((group, index) => {
      const names = group.tokens.map((token) => {
        const physical = byTool.get(token.toolId);
        return physical ? `H${token.toolId} ${physical.name}` : `H${token.toolId}`;
      });
      return `group ${index + 1}: ${names.join(' → ') || 'empty'}`;
    })
    .join('; ');
}

/** A row's recipe in one line. */
export function draftSummary(draft: VirtualFilamentValidatedDraft, snapshot: VirtualFilamentLibrarySnapshot): string {
  const byId = new Map(snapshot.physicalChoices.map((choice) => [choice.id, choice]));
  if (draft.mode === 'ratio') {
    const names = draft.components.map((component) => byId.get(component.filamentId)?.name ?? component.filamentId);
    return draft.components.length === 2
      ? `${names.join(' + ')} · B ${draft.mixBPercent}%`
      : `${names.join(' + ')} · triangle ${draft.projection.gradient_component_weights}`;
  }
  if (draft.mode === 'cycle') return `Pattern ${draft.normalizedPattern}`;
  if (draft.mode === 'match') {
    return `Target ${draft.normalizedTargetColor} · predicted ${draft.previewColor} · candidate ${draft.selectedCandidateId}`;
  }
  return `${draft.direction === 'a-to-b' ? 'A→B' : 'B→A'} · A ${Math.round(
    draft.projection.gradient_start * 100,
  )}%→${Math.round(draft.projection.gradient_end * 100)}% · ${draft.localZMaxSublayers} sublayers`;
}

/** A candidate's saved weights, by head. */
export function componentSummary(
  components: readonly VirtualFilamentMatchCandidateComponent[],
  snapshot: VirtualFilamentLibrarySnapshot | undefined,
): string {
  const byId = new Map((snapshot?.physicalChoices ?? []).map((choice) => [choice.id, choice]));
  const normalized = normalizeColorMatchWeights(
    components.map((component) => component.weight),
    components.length,
  );
  return `Saved weights: ${components
    .map((component, index) => {
      const physical = byId.get(component.filamentId);
      return `${physical ? `H${physical.toolId} ${physical.name}` : component.filamentId} ${normalized[index]}%`;
    })
    .join(' / ')}`;
}

export function modeLabel(mode: VirtualFilamentMode): string {
  switch (mode) {
    case 'ratio':
      return 'Ratio';
    case 'cycle':
      return 'Cycle';
    case 'match':
      return 'Match';
    case 'gradient':
      return 'Gradient';
  }
}

/** A duplicate's name: ` copy` appended, the original shortened to keep it within the limit. */
export function duplicateName(name: string): string {
  const suffix = ' copy';
  return name.length + suffix.length <= VIRTUAL_FILAMENT_NAME_LIMIT
    ? `${name}${suffix}`
    : `${name.slice(0, VIRTUAL_FILAMENT_NAME_LIMIT - suffix.length)}${suffix}`;
}

export function staleDialogMessage(): string {
  return 'The canonical snapshot changed while this dialog was open. Cancel and reopen it before applying.';
}

export function dedupeIssues(issues: readonly VirtualFilamentIssue[]): VirtualFilamentIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field ?? ''}|${issue.startOffset ?? ''}|${issue.endOffset ?? ''}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim() || value.length > 256) throw new Error(`${label} is invalid`);
}
