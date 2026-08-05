/**
 * Pure authoring projection for Snapmaker OrcaSlicer v2.3.4, pinned at
 * commit 9fd12ffb2b1b80c9fb4c14564754d2ec1573a626.
 *
 * Behavioral anchors:
 * - `MixedFilamentDialog.cpp:235-240`: per-mode component limits.
 * - `MixedFilamentDialog.cpp:1363-1375`: component uniqueness.
 * - `MixedFilamentDialog.cpp:1880-1889`: Ratio triangle clamp/renormalize.
 * - `MixedFilamentDialog.cpp:3180-3344`: exact Ratio, Match, and Gradient wire fields.
 * - `MixedColorMatchHelpers.cpp:27-99`: target color and integer weight normalization.
 * - `MixedColorMatchHelpers.cpp:338-577`: ΔE2000 comparison and pair preference.
 * - `MixedColorMatchHelpers.cpp:681-835`: candidate bounds/order/sequence.
 * - `ColorSpaceConvert.cpp:22-30,79-109,142-208`: sRGB/Lab conversion and ΔE2000.
 * - `MixedFilament.cpp:760-779`: compact and slash-delimited component IDs.
 * - `MixedFilament.hpp:243`: 64-physical-filament engine limit.
 *
 * Full Match palette enumeration is intentionally not reproduced here: the
 * pinned search also depends on material compatibility plus the separate
 * 330-coefficient pigment mixer. This module validates and deterministically
 * ranks supplied, already pigment-rendered candidates without replacing that
 * model with an approximation.
 */

export const MAX_AUTHORING_PHYSICAL_TOOL_ID = 64;
export const MATCH_RECIPE_SEARCH_COVERAGE = 'supplied-candidates-only' as const;

export const ORCA_DISTRIBUTION_LAYER_CYCLE = 0 as const;
export const ORCA_DISTRIBUTION_SIMPLE = 2 as const;

export type MixedFilamentAuthoringMode = 'ratio' | 'match' | 'gradient';

export interface RatioAuthoringInput {
  readonly mode: 'ratio';
  /** Two or three unique, one-based physical tool IDs. */
  readonly componentIds: readonly number[];
  /** Hidden compatibility field remains explicit for three-color Ratio. */
  readonly mixBPercent: number;
  /** Required for three-color Ratio; arbitrary non-negative proportions. */
  readonly triangleWeightsPercent?: readonly number[];
}

export interface GradientAuthoringInput {
  readonly mode: 'gradient';
  readonly componentIds: readonly number[];
  readonly direction: 'a-to-b' | 'b-to-a';
  readonly localZMaxSublayers: number;
}

export interface MatchComponentInput {
  readonly toolId: number;
  readonly weight: number;
}

export interface MatchAuthoringInput {
  readonly mode: 'match';
  /** Two to four unique physical components; zero-weight extras are omitted. */
  readonly components: readonly MatchComponentInput[];
  readonly targetColor: string;
  readonly minComponentPercent: number;
}

export type MixedFilamentAuthoringInput = RatioAuthoringInput | GradientAuthoringInput | MatchAuthoringInput;

export interface MixedFilamentAuthoringOptions {
  readonly physicalToolCount: number;
}

/** JSON-safe field projection consumed by a later canonical/wire adapter. */
export interface MixedFilamentSerializableProjection {
  readonly ui_mode: 0 | 2 | 3;
  readonly component_a: number;
  readonly component_b: number;
  readonly mix_b_percent: number;
  readonly ratio_a: number;
  readonly ratio_b: number;
  readonly manual_pattern: string;
  readonly gradient_component_ids: string;
  readonly gradient_component_weights: string;
  readonly distribution_mode: 0 | 2;
  readonly local_z_max_sublayers: number;
  readonly gradient_enabled: boolean;
  readonly gradient_start: number;
  readonly gradient_end: number;
  readonly custom: true;
}

export type MixedFilamentAuthoringIssueCode =
  | 'invalid-physical-tool-count'
  | 'component-count'
  | 'invalid-component-id'
  | 'duplicate-component'
  | 'invalid-percent'
  | 'triangle-weights-required'
  | 'unexpected-triangle-weights'
  | 'invalid-weight'
  | 'invalid-weight-total'
  | 'invalid-gradient-direction'
  | 'invalid-sublayer-count'
  | 'invalid-target-color'
  | 'invalid-min-component-percent'
  | 'component-below-minimum'
  | 'insufficient-active-components'
  | 'invalid-preview-color'
  | 'no-valid-candidates';

export interface MixedFilamentAuthoringLocation {
  readonly path: string;
  readonly componentIndex?: number;
  /** UTF-16 offset within the located string field, inclusive. */
  readonly startOffset?: number;
  /** UTF-16 offset within the located string field, exclusive. */
  readonly endOffset?: number;
}

export interface MixedFilamentAuthoringIssue {
  readonly code: MixedFilamentAuthoringIssueCode;
  readonly message: string;
  readonly location: MixedFilamentAuthoringLocation;
}

export interface MixedFilamentAuthoringResult {
  readonly ok: boolean;
  readonly mode: MixedFilamentAuthoringMode;
  readonly projection: MixedFilamentSerializableProjection | null;
  /** Present only for valid Match target input; not persisted by the pinned row. */
  readonly normalizedTargetColor?: string;
  readonly issues: readonly MixedFilamentAuthoringIssue[];
}

export class MixedFilamentAuthoringValidationError extends Error {
  override readonly name = 'MixedFilamentAuthoringValidationError';

  constructor(readonly result: MixedFilamentAuthoringResult) {
    super(
      result.issues.length === 1
        ? result.issues[0].message
        : `Mixed filament authoring has ${result.issues.length} validation issues`,
    );
  }
}

export interface MatchRecipeCandidateInput {
  readonly components: readonly MatchComponentInput[];
  /** Exact preview from the pinned pigment mixer, not a naïve RGB average. */
  readonly previewColor: string;
}

export interface MatchRecipeRankingInput {
  readonly physicalToolCount: number;
  readonly targetColor: string;
  readonly minComponentPercent: number;
  readonly candidates: readonly MatchRecipeCandidateInput[];
}

export interface RankedMatchRecipeCandidate {
  readonly sourceIndex: number;
  readonly previewColor: string;
  readonly deltaE2000: number;
  readonly projection: MixedFilamentSerializableProjection;
}

export interface MatchRecipeRankingResult {
  readonly ok: boolean;
  readonly coverage: typeof MATCH_RECIPE_SEARCH_COVERAGE;
  readonly normalizedTargetColor: string | null;
  /** First entry is the pinned winner, including its ≤0.5 pair preference. */
  readonly candidates: readonly RankedMatchRecipeCandidate[];
  readonly issues: readonly MixedFilamentAuthoringIssue[];
}

export interface CieLabColor {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** Validate authoring state and emit deterministic pinned-engine row fields. */
export function projectMixedFilamentAuthoring(
  input: MixedFilamentAuthoringInput,
  options: MixedFilamentAuthoringOptions,
): MixedFilamentAuthoringResult {
  const issues: MixedFilamentAuthoringIssue[] = [];
  validatePhysicalToolCount(options.physicalToolCount, issues);

  let projection: MixedFilamentSerializableProjection | null;
  let normalizedTargetColor: string | undefined;
  if (input.mode === 'ratio') {
    projection = projectRatio(input, options.physicalToolCount, issues);
  } else if (input.mode === 'gradient') {
    projection = projectGradient(input, options.physicalToolCount, issues);
  } else {
    const match = projectMatch(input, options.physicalToolCount, issues);
    projection = match.projection;
    normalizedTargetColor = match.normalizedTargetColor;
  }

  const frozenIssues = Object.freeze([...issues]);
  const result: MixedFilamentAuthoringResult = {
    ok: frozenIssues.length === 0 && projection !== null,
    mode: input.mode,
    projection: frozenIssues.length === 0 ? projection : null,
    ...(normalizedTargetColor ? { normalizedTargetColor } : {}),
    issues: frozenIssues,
  };
  return Object.freeze(result);
}

export function requireMixedFilamentAuthoring(
  input: MixedFilamentAuthoringInput,
  options: MixedFilamentAuthoringOptions,
): MixedFilamentSerializableProjection {
  const result = projectMixedFilamentAuthoring(input, options);
  if (!result.ok || !result.projection) throw new MixedFilamentAuthoringValidationError(result);
  return result.projection;
}

/**
 * Four clamp/renormalize passes from the Ratio triangle drag handler. Input is
 * expressed as non-negative proportions and first normalized to barycentric
 * coordinates, as the pinned picker does before this loop.
 */
export function normalizeRatioTriangleWeights(weights: readonly number[]): readonly [number, number, number] {
  if (weights.length !== 3 || weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new RangeError('Ratio triangle requires exactly three finite non-negative weights');
  }
  const total = weights[0] + weights[1] + weights[2];
  if (total <= 0) throw new RangeError('Ratio triangle weights must have a positive total');
  return normalizeRatioTriangleBarycentricWeights([weights[0] / total, weights[1] / total, weights[2] / total]);
}

/**
 * The Ratio picker's raw barycentric clamp loop. Unlike authored proportions,
 * pointer coordinates may lie outside the triangle and therefore be negative.
 */
export function normalizeRatioTriangleBarycentricWeights(
  weights: readonly number[],
): readonly [number, number, number] {
  if (weights.length !== 3 || weights.some((weight) => !Number.isFinite(weight))) {
    throw new RangeError('Ratio triangle requires exactly three finite barycentric weights');
  }
  let first = weights[0];
  let second = weights[1];
  let third = weights[2];
  for (let pass = 0; pass < 4; pass += 1) {
    first = clamp(first, 0.1, 0.9);
    second = clamp(second, 0.1, 0.9);
    third = clamp(third, 0.1, 0.9);
    const sum = first + second + third;
    if (sum > 0) {
      first /= sum;
      second /= sum;
      third /= sum;
    }
  }
  return Object.freeze([first, second, third]);
}

/** Integer weights written by `collect_result` for three-color Ratio. */
export function ratioTriangleWireWeights(weights: readonly number[]): readonly [number, number, number] {
  const normalized = normalizeRatioTriangleWeights(weights);
  const first = positiveLround(normalized[0] * 100);
  const second = positiveLround(normalized[1] * 100);
  return Object.freeze([first, second, 100 - first - second]);
}

/** Largest-remainder normalization from `normalize_color_match_weights`. */
export function normalizeColorMatchWeights(weights: readonly number[], count: number): readonly number[] {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new RangeError('Match weight count must be a non-negative integer');
  if (weights.some((weight) => !Number.isSafeInteger(weight)))
    throw new RangeError('Match weights must be safe integers');
  if (count === 0) return Object.freeze([]);
  const out =
    weights.length === count ? [...weights] : new Array<number>(count).fill(count > 0 ? Math.trunc(100 / count) : 0);
  let sum = 0;
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Math.max(0, out[index]);
    sum += out[index];
  }
  if (sum <= 0 && count > 0) {
    out.fill(0);
    out[0] = 100;
    return Object.freeze(out);
  }

  const remainders = new Array<number>(count).fill(0);
  let assigned = 0;
  for (let index = 0; index < count; index += 1) {
    const exact = (100 * out[index]) / sum;
    out[index] = Math.floor(exact);
    remainders[index] = exact - out[index];
    assigned += out[index];
  }
  let missing = Math.max(0, 100 - assigned);
  while (missing > 0) {
    let bestIndex = 0;
    let bestRemainder = -1;
    for (let index = 0; index < remainders.length; index += 1) {
      if (remainders[index] > bestRemainder) {
        bestRemainder = remainders[index];
        bestIndex = index;
      }
    }
    out[bestIndex] += 1;
    remainders[bestIndex] = 0;
    missing -= 1;
  }
  return Object.freeze(out);
}

/** Exact active-component minimum rule from the pinned Match helper. */
export function colorMatchWeightsWithinRange(weights: readonly number[], minComponentPercent: number): boolean {
  if (minComponentPercent <= 0) return true;
  const minimum = clamp(Math.trunc(minComponentPercent), 0, 50);
  let active = 0;
  for (const weight of weights) {
    if (weight <= 0) continue;
    active += 1;
    if (weight < minimum) return false;
  }
  return active >= 2;
}

/** Bounded, evenly distributed Match sequence (`k_max_cycle = 48`). */
export function buildColorMatchSequence(ids: readonly number[], weights: readonly number[]): readonly number[] {
  if (ids.length === 0 || ids.length !== weights.length) return Object.freeze([]);
  const filteredIds: number[] = [];
  const counts: number[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const weight = Math.max(0, weights[index]);
    if (weight <= 0) continue;
    filteredIds.push(ids[index]);
    counts.push(Math.max(1, positiveLround((weight / 100) * 48)));
  }
  if (filteredIds.length === 0) return Object.freeze([]);
  let cycle = counts.reduce((sum, count) => sum + count, 0);
  while (cycle > 48) {
    let largestIndex = 0;
    for (let index = 1; index < counts.length; index += 1) {
      if (counts[index] > counts[largestIndex]) largestIndex = index;
    }
    if (counts[largestIndex] <= 1) break;
    counts[largestIndex] -= 1;
    cycle -= 1;
  }
  if (cycle <= 0) return Object.freeze([]);

  const sequence: number[] = [];
  const emitted = new Array<number>(counts.length).fill(0);
  for (let position = 0; position < cycle; position += 1) {
    let bestIndex = 0;
    let bestScore = -1e9;
    for (let index = 0; index < counts.length; index += 1) {
      const target = ((position + 1) * counts[index]) / Math.max(1, cycle);
      const score = target - emitted[index];
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    emitted[bestIndex] += 1;
    sequence.push(filteredIds[bestIndex]);
  }
  return Object.freeze(sequence);
}

/** Trim, uppercase, and add `#`, matching the pinned Match text field. */
export function normalizeColorMatchHex(value: string): string {
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 && !normalized.startsWith('#') ? `#${normalized}` : normalized;
}

export function isValidColorMatchHex(value: string): boolean {
  return /^#[0-9A-F]{6}$/.test(normalizeColorMatchHex(value));
}

/**
 * CIEDE2000 formula used by the pinned `DeltaE00` helper. JavaScript evaluates
 * it in binary64; the pinned C++ stores intermediates in `float`, so callers
 * must not treat the returned decimal as a byte-identical C++ trace value.
 */
export function deltaE2000Lab(first: CieLabColor, second: CieLabColor): number {
  const averageL = (first.L + second.L) / 2;
  const c1 = Math.hypot(first.a, first.b);
  const c2 = Math.hypot(second.a, second.b);
  const averageC = (c1 + c2) / 2;
  const averageC7 = averageC ** 7;
  const g = (1 - Math.sqrt(averageC7 / (averageC7 + 25 ** 7))) / 2;
  const a1Prime = first.a * (1 + g);
  const a2Prime = second.a * (1 + g);
  const c1Prime = Math.hypot(a1Prime, first.b);
  const c2Prime = Math.hypot(a2Prime, second.b);
  const averageCPrime = (c1Prime + c2Prime) / 2;
  let h1Prime = radiansToDegrees(Math.atan2(first.b, a1Prime));
  let h2Prime = radiansToDegrees(Math.atan2(second.b, a2Prime));
  if (h1Prime < 0) h1Prime += 360;
  if (h2Prime < 0) h2Prime += 360;
  const averageHPrime = Math.abs(h1Prime - h2Prime) > 180 ? (h1Prime + h2Prime + 360) / 2 : (h1Prime + h2Prime) / 2;
  const t =
    1 -
    0.17 * Math.cos(degreesToRadians(averageHPrime - 30)) +
    0.24 * Math.cos(degreesToRadians(2 * averageHPrime)) +
    0.32 * Math.cos(degreesToRadians(3 * averageHPrime + 6)) -
    0.2 * Math.cos(degreesToRadians(4 * averageHPrime - 63));
  let deltaHPrime = h2Prime - h1Prime;
  if (Math.abs(deltaHPrime) > 180) deltaHPrime += h2Prime <= h1Prime ? 360 : -360;
  const deltaLPrime = second.L - first.L;
  const deltaCPrime = c2Prime - c1Prime;
  deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(degreesToRadians(deltaHPrime) / 2);
  const sL = 1 + (0.015 * (averageL - 50) ** 2) / Math.sqrt(20 + (averageL - 50) ** 2);
  const sC = 1 + 0.045 * averageCPrime;
  const sH = 1 + 0.015 * averageCPrime * t;
  const deltaTheta = 30 * Math.exp(-(((averageHPrime - 275) / 25) ** 2));
  const averageCPrime7 = averageCPrime ** 7;
  const rC = 2 * Math.sqrt(averageCPrime7 / (averageCPrime7 + 25 ** 7));
  const rT = -rC * Math.sin(2 * degreesToRadians(deltaTheta));
  const lTerm = deltaLPrime / sL;
  const cTerm = deltaCPrime / sC;
  const hTerm = deltaHPrime / sH;
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rT * cTerm * hTerm);
}

/** ΔE2000 between two strict six-digit sRGB hex colors. */
export function colorDeltaE2000(first: string, second: string): number {
  const firstRgb = requireRgb(first);
  const secondRgb = requireRgb(second);
  return deltaE2000Lab(rgbToLab(firstRgb), rgbToLab(secondRgb));
}

/**
 * Score supplied pigment-rendered Match recipes and reproduce the pinned final
 * choice: strict ΔE improvements win, but a pair wins when a multi-color gain
 * is no greater than 0.5 ΔE.
 */
export function rankColorMatchCandidates(input: MatchRecipeRankingInput): MatchRecipeRankingResult {
  const issues: MixedFilamentAuthoringIssue[] = [];
  validatePhysicalToolCount(input.physicalToolCount, issues);
  validateMinimumPercent(input.minComponentPercent, 'minComponentPercent', issues);
  const normalizedTarget = validateColor(input.targetColor, 'targetColor', 'invalid-target-color', issues);
  const scored: RankedMatchRecipeCandidate[] = [];

  if (issues.length === 0 && normalizedTarget) {
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index];
      const localIssues: MixedFilamentAuthoringIssue[] = [];
      const projected = projectMatch(
        {
          mode: 'match',
          components: candidate.components,
          targetColor: normalizedTarget,
          minComponentPercent: input.minComponentPercent,
        },
        input.physicalToolCount,
        localIssues,
      );
      for (const issue of localIssues) issues.push(prefixIssue(issue, `candidates[${index}].`));
      const preview = validateColor(
        candidate.previewColor,
        `candidates[${index}].previewColor`,
        'invalid-preview-color',
        issues,
      );
      if (!projected.projection || localIssues.length > 0 || !preview) continue;
      scored.push(
        Object.freeze({
          sourceIndex: index,
          previewColor: preview,
          deltaE2000: colorDeltaE2000(normalizedTarget, preview),
          projection: projected.projection,
        }),
      );
    }
  }

  scored.sort(compareRankedCandidates);
  applyPinnedPairPreference(scored);
  if (scored.length === 0 && issues.length === 0) {
    issues.push(
      makeIssue('no-valid-candidates', 'Provide at least one valid, pigment-rendered Match candidate.', 'candidates'),
    );
  }
  return Object.freeze({
    ok: issues.length === 0 && scored.length > 0,
    coverage: MATCH_RECIPE_SEARCH_COVERAGE,
    normalizedTargetColor: normalizedTarget ?? null,
    candidates: Object.freeze(scored),
    issues: Object.freeze(issues),
  });
}

function projectRatio(
  input: RatioAuthoringInput,
  physicalToolCount: number,
  issues: MixedFilamentAuthoringIssue[],
): MixedFilamentSerializableProjection | null {
  validateComponentIds(input.componentIds, 2, 3, physicalToolCount, 'componentIds', issues);
  validatePercent(input.mixBPercent, 'mixBPercent', issues);
  if (input.componentIds.length === 2) {
    if (input.triangleWeightsPercent !== undefined) {
      issues.push(
        makeIssue(
          'unexpected-triangle-weights',
          'Two-color Ratio uses mixBPercent and must not include triangle weights.',
          'triangleWeightsPercent',
        ),
      );
    }
    if (issues.length > 0) return null;
    const [ratioA, ratioB] = ratioCadence(input.mixBPercent);
    return freezeProjection({
      ui_mode: 0,
      component_a: input.componentIds[0],
      component_b: input.componentIds[1],
      mix_b_percent: input.mixBPercent,
      ratio_a: ratioA,
      ratio_b: ratioB,
      manual_pattern: '',
      gradient_component_ids: '',
      gradient_component_weights: '',
      distribution_mode: ORCA_DISTRIBUTION_SIMPLE,
      local_z_max_sublayers: 0,
      gradient_enabled: false,
      gradient_start: 0.8,
      gradient_end: 0.2,
      custom: true,
    });
  }

  const triangle = input.triangleWeightsPercent;
  if (!triangle) {
    issues.push(
      makeIssue(
        'triangle-weights-required',
        'Three-color Ratio requires exactly three triangle weights.',
        'triangleWeightsPercent',
      ),
    );
  } else {
    validateWeights(triangle, 3, 'triangleWeightsPercent', issues, undefined, false);
  }
  if (issues.length > 0 || !triangle || input.componentIds.length !== 3) return null;
  let wireWeights: readonly [number, number, number];
  try {
    wireWeights = ratioTriangleWireWeights(triangle);
  } catch {
    issues.push(
      makeIssue(
        'invalid-weight-total',
        'Three-color Ratio weights must have a positive total.',
        'triangleWeightsPercent',
      ),
    );
    return null;
  }
  return freezeProjection({
    ui_mode: 0,
    component_a: input.componentIds[0],
    component_b: input.componentIds[1],
    mix_b_percent: input.mixBPercent,
    ratio_a: 1,
    ratio_b: 1,
    manual_pattern: '',
    gradient_component_ids: encodeGradientComponentIds(input.componentIds),
    gradient_component_weights: wireWeights.join('/'),
    distribution_mode: ORCA_DISTRIBUTION_LAYER_CYCLE,
    local_z_max_sublayers: 0,
    gradient_enabled: false,
    gradient_start: 0.8,
    gradient_end: 0.2,
    custom: true,
  });
}

function projectGradient(
  input: GradientAuthoringInput,
  physicalToolCount: number,
  issues: MixedFilamentAuthoringIssue[],
): MixedFilamentSerializableProjection | null {
  validateComponentIds(input.componentIds, 2, 2, physicalToolCount, 'componentIds', issues);
  if (input.direction !== 'a-to-b' && input.direction !== 'b-to-a') {
    issues.push(makeIssue('invalid-gradient-direction', 'Gradient direction must be a-to-b or b-to-a.', 'direction'));
  }
  if (!Number.isSafeInteger(input.localZMaxSublayers) || input.localZMaxSublayers < 0) {
    issues.push(
      makeIssue(
        'invalid-sublayer-count',
        'localZMaxSublayers must be a non-negative safe integer.',
        'localZMaxSublayers',
      ),
    );
  }
  if (issues.length > 0 || input.componentIds.length !== 2) return null;
  const aToB = input.direction === 'a-to-b';
  return freezeProjection({
    ui_mode: 3,
    component_a: input.componentIds[0],
    component_b: input.componentIds[1],
    mix_b_percent: 50,
    ratio_a: 1,
    ratio_b: 1,
    manual_pattern: '',
    gradient_component_ids: '',
    gradient_component_weights: '',
    distribution_mode: ORCA_DISTRIBUTION_LAYER_CYCLE,
    local_z_max_sublayers: Math.max(2, input.localZMaxSublayers),
    gradient_enabled: true,
    gradient_start: aToB ? 0.8 : 0.2,
    gradient_end: aToB ? 0.2 : 0.8,
    custom: true,
  });
}

function projectMatch(
  input: MatchAuthoringInput,
  physicalToolCount: number,
  issues: MixedFilamentAuthoringIssue[],
): { readonly projection: MixedFilamentSerializableProjection | null; readonly normalizedTargetColor?: string } {
  const ids = input.components.map((component) => component.toolId);
  validateComponentIds(ids, 2, 4, physicalToolCount, 'components', issues, 'toolId');
  validateWeights(
    input.components.map((component) => component.weight),
    input.components.length,
    'components',
    issues,
    'weight',
  );
  validateMinimumPercent(input.minComponentPercent, 'minComponentPercent', issues);
  const normalizedTargetColor = validateColor(input.targetColor, 'targetColor', 'invalid-target-color', issues);
  if (issues.length > 0) return { projection: null, ...(normalizedTargetColor ? { normalizedTargetColor } : {}) };

  const weights = normalizeColorMatchWeights(
    input.components.map((component) => component.weight),
    input.components.length,
  );
  const active = weights
    .map((weight, index) => ({ toolId: ids[index], weight, sourceIndex: index }))
    .filter((component) => component.weight > 0);
  if (!colorMatchWeightsWithinRange(weights, input.minComponentPercent)) {
    for (let index = 0; index < weights.length; index += 1) {
      if (weights[index] > 0 && weights[index] < input.minComponentPercent) {
        issues.push(
          makeIssue(
            'component-below-minimum',
            `Active Match weight ${weights[index]}% is below the ${input.minComponentPercent}% minimum.`,
            `components[${index}].weight`,
            index,
          ),
        );
      }
    }
    if (active.length < 2) {
      issues.push(
        makeIssue(
          'insufficient-active-components',
          'Match requires at least two active components at the selected minimum.',
          'components',
        ),
      );
    }
  }
  if (input.components.length >= 3 && active.length < 3) {
    issues.push(
      makeIssue(
        'insufficient-active-components',
        'A multi-color Match recipe requires at least three positive components.',
        'components',
      ),
    );
  }
  if (issues.length > 0) return { projection: null, normalizedTargetColor };

  if (input.components.length === 2) {
    return {
      projection: freezeProjection({
        ui_mode: 2,
        component_a: ids[0],
        component_b: ids[1],
        mix_b_percent: weights[1],
        ratio_a: 1,
        ratio_b: 1,
        manual_pattern: '',
        gradient_component_ids: encodeGradientComponentIds(ids),
        gradient_component_weights: '',
        distribution_mode: ORCA_DISTRIBUTION_SIMPLE,
        local_z_max_sublayers: 0,
        gradient_enabled: false,
        gradient_start: 0.8,
        gradient_end: 0.2,
        custom: true,
      }),
      normalizedTargetColor,
    };
  }

  active.sort((left, right) => right.weight - left.weight || left.toolId - right.toolId);
  const orderedIds = active.map((component) => component.toolId);
  const orderedWeights = active.map((component) => component.weight);
  return {
    projection: freezeProjection({
      ui_mode: 2,
      component_a: orderedIds[0],
      component_b: orderedIds[1],
      // collect_result resets multi-color Match to its compatibility midpoint.
      mix_b_percent: 50,
      ratio_a: 1,
      ratio_b: 1,
      manual_pattern: '',
      gradient_component_ids: encodeGradientComponentIds(orderedIds),
      gradient_component_weights: orderedWeights.join('/'),
      distribution_mode: ORCA_DISTRIBUTION_LAYER_CYCLE,
      local_z_max_sublayers: 0,
      gradient_enabled: false,
      gradient_start: 0.8,
      gradient_end: 0.2,
      custom: true,
    }),
    normalizedTargetColor,
  };
}

function ratioCadence(mixBPercent: number): readonly [number, number] {
  if (mixBPercent <= 0) return [1, 0];
  if (mixBPercent >= 100) return [0, 1];
  const percentA = 100 - mixBPercent;
  const divisor = greatestCommonDivisor(percentA, mixBPercent);
  return [percentA / divisor, mixBPercent / divisor];
}

function greatestCommonDivisor(first: number, second: number): number {
  let left = Math.abs(first);
  let right = Math.abs(second);
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function validatePhysicalToolCount(count: number, issues: MixedFilamentAuthoringIssue[]): void {
  if (!Number.isSafeInteger(count) || count < 2 || count > MAX_AUTHORING_PHYSICAL_TOOL_ID) {
    issues.push(
      makeIssue(
        'invalid-physical-tool-count',
        `physicalToolCount must be a safe integer from 2 to ${MAX_AUTHORING_PHYSICAL_TOOL_ID}.`,
        '$options.physicalToolCount',
      ),
    );
  }
}

function validateComponentIds(
  ids: readonly number[],
  minimumCount: number,
  maximumCount: number,
  physicalToolCount: number,
  basePath: string,
  issues: MixedFilamentAuthoringIssue[],
  nestedField?: string,
): void {
  if (ids.length < minimumCount || ids.length > maximumCount) {
    const countDescription =
      minimumCount === maximumCount ? `exactly ${minimumCount}` : `${minimumCount} to ${maximumCount}`;
    issues.push(makeIssue('component-count', `This mode requires ${countDescription} physical components.`, basePath));
  }
  const seen = new Set<number>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const path = nestedField ? `${basePath}[${index}].${nestedField}` : `${basePath}[${index}]`;
    if (!Number.isSafeInteger(id) || id < 1 || id > physicalToolCount || id > MAX_AUTHORING_PHYSICAL_TOOL_ID) {
      issues.push(
        makeIssue(
          'invalid-component-id',
          `Component ${String(id)} must be a one-based physical tool ID available in this project.`,
          path,
          index,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(
        makeIssue(
          'duplicate-component',
          `Physical tool ${id} is already selected; every component must be unique.`,
          path,
          index,
        ),
      );
    }
    seen.add(id);
  }
}

function validatePercent(value: number, path: string, issues: MixedFilamentAuthoringIssue[]): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    issues.push(makeIssue('invalid-percent', `${path} must be an integer from 0 to 100.`, path));
  }
}

function validateWeights(
  weights: readonly number[],
  expectedCount: number,
  basePath: string,
  issues: MixedFilamentAuthoringIssue[],
  nestedField?: string,
  integerOnly = true,
): void {
  if (weights.length !== expectedCount) {
    issues.push(
      makeIssue('component-count', `Expected ${expectedCount} weights, received ${weights.length}.`, basePath),
    );
  }
  let total = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index];
    const path = nestedField ? `${basePath}[${index}].${nestedField}` : `${basePath}[${index}]`;
    if (!Number.isFinite(weight) || weight < 0 || (integerOnly && !Number.isSafeInteger(weight))) {
      const message = integerOnly
        ? 'Weights must be finite, non-negative safe integers.'
        : 'Weights must be finite and non-negative.';
      issues.push(makeIssue('invalid-weight', message, path, index));
    } else {
      total += weight;
    }
  }
  const invalidTotal = !Number.isFinite(total) || (integerOnly && !Number.isSafeInteger(total));
  if (weights.length > 0 && (total <= 0 || invalidTotal)) {
    issues.push(
      makeIssue(
        'invalid-weight-total',
        invalidTotal
          ? 'The combined weight must be finite and safely representable.'
          : 'At least one weight must be positive.',
        basePath,
      ),
    );
  }
}

function validateMinimumPercent(value: number, path: string, issues: MixedFilamentAuthoringIssue[]): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) {
    issues.push(
      makeIssue(
        'invalid-min-component-percent',
        'Match minimum component percent must be an integer from 0 to 50.',
        path,
      ),
    );
  }
}

function validateColor(
  value: string,
  path: string,
  code: 'invalid-target-color' | 'invalid-preview-color',
  issues: MixedFilamentAuthoringIssue[],
): string | undefined {
  const normalized = normalizeColorMatchHex(value);
  if (/^#[0-9A-F]{6}$/.test(normalized)) return normalized;
  issues.push(
    makeIssue(
      code,
      'Color must contain exactly six hexadecimal RGB digits, with an optional leading #.',
      path,
      undefined,
      0,
      value.length,
    ),
  );
  return undefined;
}

function encodeGradientComponentIds(ids: readonly number[]): string {
  const extended = ids.some((id) => id > 9);
  if (extended && ids.length === 1) return `/${ids[0]}`;
  return extended ? ids.join('/') : ids.join('');
}

function freezeProjection(projection: MixedFilamentSerializableProjection): MixedFilamentSerializableProjection {
  return Object.freeze(projection);
}

function makeIssue(
  code: MixedFilamentAuthoringIssueCode,
  message: string,
  path: string,
  componentIndex?: number,
  startOffset?: number,
  endOffset?: number,
): MixedFilamentAuthoringIssue {
  return Object.freeze({
    code,
    message,
    location: Object.freeze({
      path,
      ...(componentIndex !== undefined ? { componentIndex } : {}),
      ...(startOffset !== undefined ? { startOffset } : {}),
      ...(endOffset !== undefined ? { endOffset } : {}),
    }),
  });
}

function prefixIssue(issue: MixedFilamentAuthoringIssue, prefix: string): MixedFilamentAuthoringIssue {
  return Object.freeze({
    ...issue,
    location: Object.freeze({
      ...issue.location,
      path: `${prefix}${issue.location.path}`,
    }),
  });
}

function compareRankedCandidates(left: RankedMatchRecipeCandidate, right: RankedMatchRecipeCandidate): number {
  if (left.deltaE2000 + 1e-6 < right.deltaE2000) return -1;
  if (right.deltaE2000 + 1e-6 < left.deltaE2000) return 1;
  return left.sourceIndex - right.sourceIndex;
}

function applyPinnedPairPreference(candidates: RankedMatchRecipeCandidate[]): void {
  if (candidates.length === 0) return;
  const best = candidates[0];
  const bestPairIndex = candidates.findIndex(
    (candidate) => candidate.projection.distribution_mode === ORCA_DISTRIBUTION_SIMPLE,
  );
  if (
    bestPairIndex > 0 &&
    best.projection.distribution_mode !== ORCA_DISTRIBUTION_SIMPLE &&
    candidates[bestPairIndex].deltaE2000 <= best.deltaE2000 + 0.5
  ) {
    const [pair] = candidates.splice(bestPairIndex, 1);
    candidates.unshift(pair);
  }
}

function requireRgb(value: string): readonly [number, number, number] {
  const normalized = normalizeColorMatchHex(value);
  if (!/^#[0-9A-F]{6}$/.test(normalized)) {
    throw new RangeError(`Invalid six-digit RGB color ${JSON.stringify(value)}`);
  }
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function rgbToLab(rgb: readonly [number, number, number]): CieLabColor {
  const red = pivotRgb(rgb[0] / 255);
  const green = pivotRgb(rgb[1] / 255);
  const blue = pivotRgb(rgb[2] / 255);
  const x = 0.412453 * red + 0.35758 * green + 0.180423 * blue;
  const y = 0.212671 * red + 0.71516 * green + 0.072169 * blue;
  const z = 0.019334 * red + 0.119193 * green + 0.950227 * blue;
  const pivotX = pivotXyz(x / 95.047);
  const pivotY = pivotXyz(y / 100);
  const pivotZ = pivotXyz(z / 108.883);
  return Object.freeze({
    L: 116 * pivotY - 16,
    a: 500 * (pivotX - pivotY),
    b: 200 * (pivotY - pivotZ),
  });
}

function pivotRgb(value: number): number {
  return (value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92) * 100;
}

function pivotXyz(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function degreesToRadians(degrees: number): number {
  return (2 * Math.PI * degrees) / 360;
}

function radiansToDegrees(radians: number): number {
  return (360 * radians) / (2 * Math.PI);
}

function positiveLround(value: number): number {
  return Math.floor(value + 0.5);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
