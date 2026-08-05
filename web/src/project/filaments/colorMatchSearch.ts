/**
 * Supplied-palette Match search for pinned Snapmaker OrcaSlicer v2.3.4
 * (`9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`).
 *
 * This ports `MixedColorMatchHelpers.cpp`'s preset generation and bounded
 * pair/triple search. Every preview uses the generated 330-coefficient pigment
 * model; RGB averaging is never used.
 */
import {
  MAX_AUTHORING_PHYSICAL_TOOL_ID,
  buildColorMatchSequence,
  colorMatchWeightsWithinRange,
  normalizeColorMatchWeights,
  projectMixedFilamentAuthoring,
  type MatchComponentInput,
  type MixedFilamentSerializableProjection,
} from './mixedFilamentAuthoring';
import { blendMultiFilamentPigment, blendPairFilamentPigment, parseOrcaMixedColor } from './filamentPigmentMixer';

export const SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE =
  'pinned-bundled-compatibility-with-explicit-filament-types' as const;

export type FilamentMaterialCategory = 'PLA' | 'PETG' | 'TPU' | 'PET' | 'ABS' | 'ASA' | 'PC' | 'PA' | 'SUPPORT';

export interface SuppliedMatchPaletteEntry {
  /** Strict six-digit HTML color. The array position is its one-based tool ID. */
  readonly color: string;
  /** Pinned `filament_type`, for example PLA-CF, PCTG, or PVA. */
  readonly filamentType: string;
}

export interface SuppliedPaletteMatchOptions {
  readonly palette: readonly SuppliedMatchPaletteEntry[];
  readonly minComponentPercent: number;
}

export interface SuppliedPaletteMatchSearchInput extends SuppliedPaletteMatchOptions {
  readonly targetColor: string;
}

export type SuppliedPaletteMatchIssueCode =
  | 'palette-size'
  | 'invalid-palette-color'
  | 'invalid-target-color'
  | 'invalid-filament-type'
  | 'invalid-min-component-percent'
  | 'no-compatible-recipe';

export interface SuppliedPaletteMatchIssue {
  readonly code: SuppliedPaletteMatchIssueCode;
  readonly message: string;
  readonly path: string;
}

export interface SuppliedPaletteMatchRecipe {
  readonly kind: 'pair' | 'triple';
  /** Physical tool IDs and exact integer percentages used by the search. */
  readonly components: readonly MatchComponentInput[];
  readonly previewColor: string;
  readonly deltaE2000: number | null;
  /** Projection produced by the existing pinned Match authoring seam. */
  readonly projection: MixedFilamentSerializableProjection;
}

export interface SuppliedPaletteMatchSearchStats {
  readonly pairCoarseEvaluations: number;
  readonly pairFineEvaluations: number;
  readonly tripleCoarseEvaluations: number;
  readonly tripleFineEvaluations: number;
  readonly candidatePoolToolIds: readonly number[];
  readonly earlyPairExit: boolean;
}

export interface SuppliedPaletteMatchSearchResult {
  readonly ok: boolean;
  readonly coverage: typeof SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE;
  readonly normalizedTargetColor: string | null;
  readonly recipe: SuppliedPaletteMatchRecipe | null;
  readonly bestPair: SuppliedPaletteMatchRecipe | null;
  readonly issues: readonly SuppliedPaletteMatchIssue[];
  readonly stats: SuppliedPaletteMatchSearchStats;
}

export interface SuppliedPaletteMatchCandidatesResult {
  readonly ok: boolean;
  readonly coverage: typeof SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE;
  readonly candidates: readonly SuppliedPaletteMatchRecipe[];
  readonly issues: readonly SuppliedPaletteMatchIssue[];
}

interface ValidatedPalette {
  readonly colors: readonly string[];
  readonly categories: readonly FilamentMaterialCategory[];
}

interface LabColor {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

interface InternalRecipe {
  readonly kind: 'pair' | 'triple';
  readonly ids: readonly number[];
  readonly weights: readonly number[];
  readonly previewColor: string;
  deltaE2000: number;
}

interface PairHeapEntry {
  readonly deltaE2000: number;
  readonly firstId: number;
  readonly secondId: number;
  readonly mixSecondPercent: number;
}

interface TripleHeapEntry {
  readonly deltaE2000: number;
  readonly firstId: number;
  readonly secondId: number;
  readonly thirdId: number;
  readonly firstWeight: number;
  readonly secondWeight: number;
}

const MATERIAL_CATEGORY_BY_TYPE: Readonly<Record<string, FilamentMaterialCategory>> = Object.freeze({
  PLA: 'PLA',
  'PLA-CF': 'PLA',
  PETG: 'PETG',
  'PETG-CF': 'PETG',
  PCTG: 'PETG',
  TPU: 'TPU',
  PET: 'PET',
  ABS: 'ABS',
  ASA: 'ASA',
  PC: 'PC',
  PA: 'PA',
  'PA-CF': 'PA',
  BVOH: 'SUPPORT',
  PVA: 'SUPPORT',
});

/** Bundled `filament_compatibility.json`, made symmetric during source load. */
const COMPATIBLE_PARTNERS: Readonly<Record<FilamentMaterialCategory, ReadonlySet<FilamentMaterialCategory>>> =
  Object.freeze({
    PLA: new Set<FilamentMaterialCategory>(['PLA', 'PC']),
    PETG: new Set<FilamentMaterialCategory>(['PETG', 'TPU', 'PET', 'ABS', 'ASA', 'PC']),
    TPU: new Set<FilamentMaterialCategory>(['TPU', 'PETG', 'PET']),
    PET: new Set<FilamentMaterialCategory>(['PET', 'PETG', 'TPU', 'ABS', 'ASA', 'PC']),
    ABS: new Set<FilamentMaterialCategory>(['ABS', 'PETG', 'PET', 'ASA', 'PC', 'PA']),
    ASA: new Set<FilamentMaterialCategory>(['ASA', 'PETG', 'PET', 'ABS', 'PC', 'PA']),
    PC: new Set<FilamentMaterialCategory>(['PC', 'PLA', 'PETG', 'PET', 'ABS', 'ASA', 'PA']),
    PA: new Set<FilamentMaterialCategory>(['PA', 'ABS', 'ASA', 'PC']),
    SUPPORT: new Set<FilamentMaterialCategory>(['SUPPORT']),
  });

export function classifyPinnedFilamentType(filamentType: string): FilamentMaterialCategory | null {
  if (typeof filamentType !== 'string') return null;
  return MATERIAL_CATEGORY_BY_TYPE[filamentType.trim().toUpperCase()] ?? null;
}

export function arePinnedFilamentCategoriesCompatible(
  first: FilamentMaterialCategory,
  second: FilamentMaterialCategory,
): boolean {
  return COMPATIBLE_PARTNERS[first].has(second);
}

/**
 * Generate the source preset list: compatible 50:50 pairs, then the first six
 * palette entries' compatible triples at 34/33/33 and each 50/25/25 rotation.
 * Duplicate pigment preview colors retain their first source-order candidate.
 */
export function generateSuppliedPaletteMatchCandidates(
  input: SuppliedPaletteMatchOptions,
): SuppliedPaletteMatchCandidatesResult {
  const issues: SuppliedPaletteMatchIssue[] = [];
  const palette = validatePaletteAndMinimum(input, issues);
  if (!palette) return freezeCandidatesResult([], issues);

  const compatibility = buildCompatibilityMatrix(palette.categories);
  const candidates: SuppliedPaletteMatchRecipe[] = [];
  const seenPreviewColors = new Set<string>();
  const addCandidate = (recipe: SuppliedPaletteMatchRecipe | null): void => {
    if (!recipe || seenPreviewColors.has(recipe.previewColor)) return;
    seenPreviewColors.add(recipe.previewColor);
    candidates.push(recipe);
  };

  for (let firstIndex = 0; firstIndex < palette.colors.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < palette.colors.length; secondIndex += 1) {
      if (!compatibility[firstIndex][secondIndex]) continue;
      addCandidate(
        buildPairRecipe(palette.colors, firstIndex + 1, secondIndex + 1, 50, input.minComponentPercent, null),
      );
    }
  }

  const tripleLimit = Math.min(palette.colors.length, 6);
  const equalWeights = normalizeColorMatchWeights([1, 1, 1], 3);
  for (let firstIndex = 0; firstIndex + 2 < tripleLimit; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex + 1 < tripleLimit; secondIndex += 1) {
      for (let thirdIndex = secondIndex + 1; thirdIndex < tripleLimit; thirdIndex += 1) {
        if (
          !compatibility[firstIndex][secondIndex] ||
          !compatibility[secondIndex][thirdIndex] ||
          !compatibility[firstIndex][thirdIndex]
        ) {
          continue;
        }
        const ids = [firstIndex + 1, secondIndex + 1, thirdIndex + 1];
        addCandidate(buildPresetTripleRecipe(palette.colors, ids, equalWeights, input.minComponentPercent));
        for (let dominantIndex = 0; dominantIndex < 3; dominantIndex += 1) {
          const weights = [25, 25, 25];
          weights[dominantIndex] = 50;
          addCandidate(buildPresetTripleRecipe(palette.colors, ids, weights, input.minComponentPercent));
        }
      }
    }
  }

  return freezeCandidatesResult(candidates, issues);
}

/**
 * Run the pinned bounded search:
 * pair coarse 5%/top 30 → pair ±4 fine → optional top-eight-color triple
 * coarse 10%/top 20 → triple ±9 fine → unified ΔE and ≤0.5 pair preference.
 */
export function searchSuppliedPaletteColorMatch(
  input: SuppliedPaletteMatchSearchInput,
): SuppliedPaletteMatchSearchResult {
  const issues: SuppliedPaletteMatchIssue[] = [];
  const palette = validatePaletteAndMinimum(input, issues);
  const normalizedTarget = normalizeStrictColor(input.targetColor);
  if (!normalizedTarget) {
    issues.push(
      makeIssue('invalid-target-color', 'Target color must be exactly six hexadecimal RGB digits.', 'targetColor'),
    );
  }

  const mutableStats = {
    pairCoarseEvaluations: 0,
    pairFineEvaluations: 0,
    tripleCoarseEvaluations: 0,
    tripleFineEvaluations: 0,
    candidatePoolToolIds: [] as number[],
    earlyPairExit: false,
  };
  if (!palette || !normalizedTarget) {
    return freezeSearchResult(normalizedTarget, null, null, issues, mutableStats);
  }

  const targetLab = pinnedSrgbToLab(normalizedTarget);
  const paletteLab = palette.colors.map((color) => pinnedSrgbToLab(color));
  const compatibility = buildCompatibilityMatrix(palette.categories);
  const loopMinimum = Math.max(1, clamp(input.minComponentPercent, 0, 50));
  const pairHeap = new BoundedWorstHeap<PairHeapEntry>(30, (entry) => entry.deltaE2000);
  const pairPreviewCache = new Map<string, string>();
  let best: InternalRecipe | null = null;

  const pairPreview = (firstId: number, secondId: number, percent: number): string => {
    const key = `${firstId}/${secondId}/${percent}`;
    const cached = pairPreviewCache.get(key);
    if (cached) return cached;
    const preview = blendPairFilamentPigment(
      palette.colors[firstId - 1],
      palette.colors[secondId - 1],
      Math.fround(Math.fround(percent) / Math.fround(100)),
    );
    pairPreviewCache.set(key, preview);
    return preview;
  };
  const evaluatePair = (firstId: number, secondId: number, percent: number): number =>
    pinnedDeltaE2000Lab(targetLab, pinnedSrgbToLab(pairPreview(firstId, secondId, percent)));
  const updateBestPair = (firstId: number, secondId: number, percent: number, deltaE2000: number): void => {
    if (best !== null && !(deltaE2000 + 1e-6 < best.deltaE2000)) return;
    best = {
      kind: 'pair',
      ids: Object.freeze([firstId, secondId]),
      weights: Object.freeze([100 - percent, percent]),
      previewColor: pairPreview(firstId, secondId, percent),
      deltaE2000,
    };
  };

  for (let firstIndex = 0; firstIndex < palette.colors.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < palette.colors.length; secondIndex += 1) {
      if (!compatibility[firstIndex][secondIndex]) continue;
      for (let percent = loopMinimum; percent <= 100 - loopMinimum; percent += 5) {
        const deltaE2000 = evaluatePair(firstIndex + 1, secondIndex + 1, percent);
        mutableStats.pairCoarseEvaluations += 1;
        updateBestPair(firstIndex + 1, secondIndex + 1, percent, deltaE2000);
        pairHeap.offer({
          deltaE2000,
          firstId: firstIndex + 1,
          secondId: secondIndex + 1,
          mixSecondPercent: percent,
        });
      }
    }
  }

  for (const coarse of pairHeap.drainWorstFirst()) {
    const fineMinimum = Math.max(loopMinimum, coarse.mixSecondPercent - 5 + 1);
    const fineMaximum = Math.min(100 - loopMinimum, coarse.mixSecondPercent + 5 - 1);
    for (let percent = fineMinimum; percent <= fineMaximum; percent += 1) {
      if ((percent - loopMinimum) % 5 === 0) continue;
      const deltaE2000 = evaluatePair(coarse.firstId, coarse.secondId, percent);
      mutableStats.pairFineEvaluations += 1;
      updateBestPair(coarse.firstId, coarse.secondId, percent, deltaE2000);
    }
  }

  const bestPair = best ? cloneInternalRecipe(best) : null;
  if (bestPair && bestPair.deltaE2000 <= 0.5) {
    mutableStats.earlyPairExit = true;
    return freezeSearchResult(
      normalizedTarget,
      toPublicRecipe(bestPair, input.minComponentPercent, normalizedTarget),
      toPublicRecipe(bestPair, input.minComponentPercent, normalizedTarget),
      issues,
      mutableStats,
    );
  }

  const rankedIds = paletteLab
    .map((lab, index) => ({ deltaE2000: pinnedDeltaE2000Lab(targetLab, lab), id: index + 1 }))
    .sort((left, right) => left.deltaE2000 - right.deltaE2000 || left.id - right.id);
  const candidatePool = rankedIds
    .slice(0, Math.min(palette.colors.length, 8))
    .map((entry) => entry.id)
    .sort((left, right) => left - right);
  mutableStats.candidatePoolToolIds.push(...candidatePool);

  if (candidatePool.length >= 3) {
    const tripleHeap = new BoundedWorstHeap<TripleHeapEntry>(20, (entry) => entry.deltaE2000);
    const evaluateTriple = (
      firstId: number,
      secondId: number,
      thirdId: number,
      firstWeight: number,
      secondWeight: number,
    ): { readonly previewColor: string; readonly deltaE2000: number } => {
      const thirdWeight = 100 - firstWeight - secondWeight;
      const previewColor = blendMultiFilamentPigment([
        [palette.colors[firstId - 1], firstWeight],
        [palette.colors[secondId - 1], secondWeight],
        [palette.colors[thirdId - 1], thirdWeight],
      ]);
      return Object.freeze({
        previewColor,
        deltaE2000: pinnedDeltaE2000Lab(targetLab, pinnedSrgbToLab(previewColor)),
      });
    };
    const updateBestTriple = (
      firstId: number,
      secondId: number,
      thirdId: number,
      firstWeight: number,
      secondWeight: number,
      previewColor: string,
      deltaE2000: number,
    ): void => {
      if (best !== null && !(deltaE2000 + 1e-6 < best.deltaE2000)) return;
      best = {
        kind: 'triple',
        ids: Object.freeze([firstId, secondId, thirdId]),
        weights: Object.freeze([firstWeight, secondWeight, 100 - firstWeight - secondWeight]),
        previewColor,
        deltaE2000,
      };
    };

    for (let firstPoolIndex = 0; firstPoolIndex + 2 < candidatePool.length; firstPoolIndex += 1) {
      for (let secondPoolIndex = firstPoolIndex + 1; secondPoolIndex + 1 < candidatePool.length; secondPoolIndex += 1) {
        for (let thirdPoolIndex = secondPoolIndex + 1; thirdPoolIndex < candidatePool.length; thirdPoolIndex += 1) {
          const firstId = candidatePool[firstPoolIndex];
          const secondId = candidatePool[secondPoolIndex];
          const thirdId = candidatePool[thirdPoolIndex];
          if (
            !compatibility[firstId - 1][secondId - 1] ||
            !compatibility[secondId - 1][thirdId - 1] ||
            !compatibility[firstId - 1][thirdId - 1]
          ) {
            continue;
          }
          for (let firstWeight = loopMinimum; firstWeight <= 100 - 2 * loopMinimum; firstWeight += 10) {
            for (let secondWeight = loopMinimum; firstWeight + secondWeight <= 100 - loopMinimum; secondWeight += 10) {
              const evaluated = evaluateTriple(firstId, secondId, thirdId, firstWeight, secondWeight);
              mutableStats.tripleCoarseEvaluations += 1;
              updateBestTriple(
                firstId,
                secondId,
                thirdId,
                firstWeight,
                secondWeight,
                evaluated.previewColor,
                evaluated.deltaE2000,
              );
              tripleHeap.offer({
                deltaE2000: evaluated.deltaE2000,
                firstId,
                secondId,
                thirdId,
                firstWeight,
                secondWeight,
              });
            }
          }
        }
      }
    }

    for (const coarse of tripleHeap.drainWorstFirst()) {
      const firstMinimum = Math.max(loopMinimum, coarse.firstWeight - 10 + 1);
      const firstMaximum = Math.min(100 - 2 * loopMinimum, coarse.firstWeight + 10 - 1);
      for (let firstWeight = firstMinimum; firstWeight <= firstMaximum; firstWeight += 1) {
        if ((firstWeight - loopMinimum) % 10 === 0) continue;
        const secondMinimum = Math.max(loopMinimum, coarse.secondWeight - 10 + 1);
        const secondMaximum = Math.min(100 - firstWeight - loopMinimum, coarse.secondWeight + 10 - 1);
        for (let secondWeight = secondMinimum; secondWeight <= secondMaximum; secondWeight += 1) {
          if ((secondWeight - loopMinimum) % 10 === 0) continue;
          const thirdWeight = 100 - firstWeight - secondWeight;
          if (thirdWeight < loopMinimum) continue;
          const evaluated = evaluateTriple(coarse.firstId, coarse.secondId, coarse.thirdId, firstWeight, secondWeight);
          mutableStats.tripleFineEvaluations += 1;
          updateBestTriple(
            coarse.firstId,
            coarse.secondId,
            coarse.thirdId,
            firstWeight,
            secondWeight,
            evaluated.previewColor,
            evaluated.deltaE2000,
          );
        }
      }
    }
  }

  // The pair/triple update closures mutate `best`; retain that fact across
  // TypeScript's closure-local control-flow analysis.
  let finalizedBest = best as InternalRecipe | null;
  if (finalizedBest) {
    finalizedBest.deltaE2000 = pinnedColorDeltaE2000(normalizedTarget, finalizedBest.previewColor);
  }
  if (bestPair) {
    bestPair.deltaE2000 = pinnedColorDeltaE2000(normalizedTarget, bestPair.previewColor);
    if (finalizedBest === null || bestPair.deltaE2000 + 1e-6 < finalizedBest.deltaE2000) {
      finalizedBest = bestPair;
    } else if (finalizedBest.kind === 'triple' && bestPair.deltaE2000 <= finalizedBest.deltaE2000 + 0.5) {
      finalizedBest = bestPair;
    }
  }

  if (!finalizedBest) {
    issues.push(
      makeIssue(
        'no-compatible-recipe',
        'The supplied palette has no compatible two- or three-filament Match recipe.',
        'palette',
      ),
    );
  }
  return freezeSearchResult(
    normalizedTarget,
    finalizedBest ? toPublicRecipe(finalizedBest, input.minComponentPercent, normalizedTarget) : null,
    bestPair ? toPublicRecipe(bestPair, input.minComponentPercent, normalizedTarget) : null,
    issues,
    mutableStats,
  );
}

/** Float-staged sRGB/Lab/DeltaE00 pipeline used by the pinned helper. */
export function pinnedColorDeltaE2000(first: string, second: string): number {
  const normalizedFirst = normalizeStrictColor(first);
  const normalizedSecond = normalizeStrictColor(second);
  if (!normalizedFirst || !normalizedSecond) throw new RangeError('DeltaE colors must be six-digit HTML colors');
  return pinnedDeltaE2000Lab(pinnedSrgbToLab(normalizedFirst), pinnedSrgbToLab(normalizedSecond));
}

function validatePaletteAndMinimum(
  input: SuppliedPaletteMatchOptions,
  issues: SuppliedPaletteMatchIssue[],
): ValidatedPalette | null {
  if (input.palette.length < 2 || input.palette.length > MAX_AUTHORING_PHYSICAL_TOOL_ID) {
    issues.push(
      makeIssue(
        'palette-size',
        `Palette must contain 2 to ${MAX_AUTHORING_PHYSICAL_TOOL_ID} physical filaments.`,
        'palette',
      ),
    );
  }
  if (
    !Number.isSafeInteger(input.minComponentPercent) ||
    input.minComponentPercent < 0 ||
    input.minComponentPercent > 50
  ) {
    issues.push(
      makeIssue(
        'invalid-min-component-percent',
        'Minimum component percent must be an integer from 0 to 50.',
        'minComponentPercent',
      ),
    );
  }

  const colors: string[] = [];
  const categories: FilamentMaterialCategory[] = [];
  for (let index = 0; index < input.palette.length; index += 1) {
    const normalizedColor = normalizeStrictColor(input.palette[index].color);
    if (!normalizedColor) {
      issues.push(
        makeIssue(
          'invalid-palette-color',
          'Palette color must be exactly six hexadecimal RGB digits.',
          `palette[${index}].color`,
        ),
      );
    } else {
      colors.push(normalizedColor);
    }
    const category = classifyPinnedFilamentType(input.palette[index].filamentType);
    if (!category) {
      issues.push(
        makeIssue(
          'invalid-filament-type',
          'Filament type is not classified by the pinned material compatibility table.',
          `palette[${index}].filamentType`,
        ),
      );
    } else {
      categories.push(category);
    }
  }
  return issues.length === 0
    ? Object.freeze({ colors: Object.freeze(colors), categories: Object.freeze(categories) })
    : null;
}

function buildCompatibilityMatrix(categories: readonly FilamentMaterialCategory[]): readonly (readonly boolean[])[] {
  return Object.freeze(
    categories.map((first, firstIndex) =>
      Object.freeze(
        categories.map(
          (second, secondIndex) => firstIndex === secondIndex || arePinnedFilamentCategoriesCompatible(first, second),
        ),
      ),
    ),
  );
}

function buildPairRecipe(
  palette: readonly string[],
  firstId: number,
  secondId: number,
  mixSecondPercent: number,
  minimum: number,
  targetColor: string | null,
): SuppliedPaletteMatchRecipe | null {
  const percent = clamp(mixSecondPercent, 0, 100);
  const weights = [100 - percent, percent];
  if (!colorMatchWeightsWithinRange(weights, minimum)) return null;
  const previewColor = blendPairFilamentPigment(
    palette[firstId - 1],
    palette[secondId - 1],
    Math.fround(Math.fround(percent) / Math.fround(100)),
  );
  return makePublicRecipe('pair', [firstId, secondId], weights, previewColor, minimum, targetColor);
}

function buildPresetTripleRecipe(
  palette: readonly string[],
  ids: readonly number[],
  weights: readonly number[],
  minimum: number,
): SuppliedPaletteMatchRecipe | null {
  if (!colorMatchWeightsWithinRange(weights, minimum)) return null;
  const weightedIds = ids
    .map((id, index) => ({ id, weight: weights[index] }))
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.id - right.id);
  if (weightedIds.length < 3) return null;
  const orderedIds = weightedIds.map((entry) => entry.id);
  const orderedWeights = weightedIds.map((entry) => entry.weight);
  const sequence = buildColorMatchSequence(orderedIds, orderedWeights);
  if (sequence.length === 0) return null;
  const counts = new Array<number>(palette.length).fill(0);
  for (const id of sequence) counts[id - 1] += 1;
  const previewColor = blendMultiFilamentPigment(
    counts.flatMap((weight, index) => (weight > 0 ? [[palette[index], weight] as const] : [])),
  );
  return makePublicRecipe('triple', orderedIds, orderedWeights, previewColor, minimum, null);
}

function toPublicRecipe(recipe: InternalRecipe, minimum: number, targetColor: string): SuppliedPaletteMatchRecipe {
  return makePublicRecipe(
    recipe.kind,
    recipe.ids,
    recipe.weights,
    recipe.previewColor,
    minimum,
    targetColor,
    recipe.deltaE2000,
  );
}

function makePublicRecipe(
  kind: 'pair' | 'triple',
  ids: readonly number[],
  weights: readonly number[],
  previewColor: string,
  minimum: number,
  targetColor: string | null,
  knownDeltaE?: number,
): SuppliedPaletteMatchRecipe {
  const components = Object.freeze(ids.map((toolId, index) => Object.freeze({ toolId, weight: weights[index] })));
  const authoring = projectMixedFilamentAuthoring(
    {
      mode: 'match',
      components,
      targetColor: targetColor ?? previewColor,
      minComponentPercent: minimum,
    },
    { physicalToolCount: Math.max(...ids) },
  );
  if (!authoring.ok || !authoring.projection) {
    throw new Error('Internal Match candidate violated the pinned authoring contract');
  }
  return Object.freeze({
    kind,
    components,
    previewColor,
    deltaE2000: targetColor ? (knownDeltaE ?? pinnedColorDeltaE2000(targetColor, previewColor)) : null,
    projection: authoring.projection,
  });
}

function cloneInternalRecipe(recipe: InternalRecipe): InternalRecipe {
  return {
    kind: recipe.kind,
    ids: recipe.ids,
    weights: recipe.weights,
    previewColor: recipe.previewColor,
    deltaE2000: recipe.deltaE2000,
  };
}

function normalizeStrictColor(value: string): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  const withHash = normalized.startsWith('#') ? normalized : `#${normalized}`;
  return /^#[0-9A-F]{6}$/.test(withHash) ? withHash : null;
}

function pinnedSrgbToLab(color: string): LabColor {
  const rgb = parseOrcaMixedColor(color);
  const red = f32(rgb[0] / 255);
  const green = f32(rgb[1] / 255);
  const blue = f32(rgb[2] / 255);
  const linearRed = f32(pivotRgb(red));
  const linearGreen = f32(pivotRgb(green));
  const linearBlue = f32(pivotRgb(blue));
  const x = floatLinear3(0.412453, linearRed, 0.35758, linearGreen, 0.180423, linearBlue);
  const y = floatLinear3(0.212671, linearRed, 0.71516, linearGreen, 0.072169, linearBlue);
  const z = floatLinear3(0.019334, linearRed, 0.119193, linearGreen, 0.950227, linearBlue);
  const pivotX = pivotXyz(x / 95.047);
  const pivotY = pivotXyz(y / 100);
  const pivotZ = pivotXyz(z / 108.883);
  return Object.freeze({
    L: f32(116 * pivotY - 16),
    a: f32(500 * (pivotX - pivotY)),
    b: f32(200 * (pivotY - pivotZ)),
  });
}

function pinnedDeltaE2000Lab(first: LabColor, second: LabColor): number {
  const averageL = f32(f32(first.L + second.L) / 2);
  const c1 = f32(Math.sqrt(first.a ** 2 + first.b ** 2));
  const c2 = f32(Math.sqrt(second.a ** 2 + second.b ** 2));
  const averageC = f32(f32(c1 + c2) / 2);
  const averageC7 = averageC ** 7;
  const g = f32((1 - Math.sqrt(averageC7 / (averageC7 + 25 ** 7))) / 2);
  const a1Prime = f32(first.a * (1 + g));
  const a2Prime = f32(second.a * (1 + g));
  const c1Prime = f32(Math.sqrt(a1Prime ** 2 + first.b ** 2));
  const c2Prime = f32(Math.sqrt(a2Prime ** 2 + second.b ** 2));
  const averageCPrime = f32(f32(c1Prime + c2Prime) / 2);
  let h1Prime = f32((360 * Math.atan2(first.b, a1Prime)) / (2 * Math.PI));
  let h2Prime = f32((360 * Math.atan2(second.b, a2Prime)) / (2 * Math.PI));
  if (h1Prime < 0) h1Prime = f32(h1Prime + 360);
  if (h2Prime < 0) h2Prime = f32(h2Prime + 360);
  const hueDifference = f32(Math.abs(f32(h1Prime - h2Prime)));
  const averageHPrime =
    hueDifference > 180 ? f32(f32(f32(h1Prime + h2Prime) + 360) / 2) : f32(f32(h1Prime + h2Prime) / 2);
  const degreesToRadians = (degrees: number): number => (2 * Math.PI * degrees) / 360;
  const t = f32(
    1 -
      0.17 * Math.cos(degreesToRadians(f32(averageHPrime - 30))) +
      0.24 * Math.cos(degreesToRadians(f32(2 * averageHPrime))) +
      0.32 * Math.cos(degreesToRadians(f32(f32(3 * averageHPrime) + 6))) -
      0.2 * Math.cos(degreesToRadians(f32(f32(4 * averageHPrime) - 63))),
  );
  let deltaHPrime = f32(h2Prime - h1Prime);
  if (Math.abs(deltaHPrime) > 180) {
    deltaHPrime = f32(deltaHPrime + (h2Prime <= h1Prime ? 360 : -360));
  }
  const deltaLPrime = f32(second.L - first.L);
  const deltaCPrime = f32(c2Prime - c1Prime);
  const chromaRoot = f32(Math.sqrt(f32(c1Prime * c2Prime)));
  deltaHPrime = f32(2 * chromaRoot * Math.sin(degreesToRadians(deltaHPrime) / 2));
  const averageLMinus50 = averageL - 50;
  const sL = f32(1 + (0.015 * averageLMinus50 ** 2) / Math.sqrt(20 + averageLMinus50 ** 2));
  const sC = f32(1 + 0.045 * averageCPrime);
  const sH = f32(1 + 0.015 * averageCPrime * t);
  const deltaRotation = f32(30 * Math.exp(-(((averageHPrime - 275) / 25) ** 2)));
  const averageCPrime7 = averageCPrime ** 7;
  const rC = f32(2 * Math.sqrt(averageCPrime7 / (averageCPrime7 + 25 ** 7)));
  const rT = f32(-rC * Math.sin(2 * degreesToRadians(deltaRotation)));
  const lightnessTerm = f32(deltaLPrime / sL);
  const chromaTerm = f32(deltaCPrime / sC);
  const hueTerm = f32(deltaHPrime / sH);
  const rotationTerm = f32(f32(rT * chromaTerm) * hueTerm);
  return f32(Math.sqrt(lightnessTerm ** 2 + chromaTerm ** 2 + hueTerm ** 2 + rotationTerm));
}

function pivotRgb(value: number): number {
  return (value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92) * 100;
}

function pivotXyz(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function floatLinear3(
  firstCoefficient: number,
  firstValue: number,
  secondCoefficient: number,
  secondValue: number,
  thirdCoefficient: number,
  thirdValue: number,
): number {
  const first = f32(f32(firstCoefficient) * firstValue);
  const second = f32(f32(secondCoefficient) * secondValue);
  const third = f32(f32(thirdCoefficient) * thirdValue);
  return f32(f32(first + second) + third);
}

function f32(value: number): number {
  return Math.fround(value);
}

function makeIssue(code: SuppliedPaletteMatchIssueCode, message: string, path: string): SuppliedPaletteMatchIssue {
  return Object.freeze({ code, message, path });
}

function freezeCandidatesResult(
  candidates: readonly SuppliedPaletteMatchRecipe[],
  issues: readonly SuppliedPaletteMatchIssue[],
): SuppliedPaletteMatchCandidatesResult {
  const frozenIssues = Object.freeze([...issues]);
  return Object.freeze({
    ok: frozenIssues.length === 0,
    coverage: SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE,
    candidates: Object.freeze([...candidates]),
    issues: frozenIssues,
  });
}

function freezeSearchResult(
  normalizedTargetColor: string | null,
  recipe: SuppliedPaletteMatchRecipe | null,
  bestPair: SuppliedPaletteMatchRecipe | null,
  issues: readonly SuppliedPaletteMatchIssue[],
  stats: {
    readonly pairCoarseEvaluations: number;
    readonly pairFineEvaluations: number;
    readonly tripleCoarseEvaluations: number;
    readonly tripleFineEvaluations: number;
    readonly candidatePoolToolIds: readonly number[];
    readonly earlyPairExit: boolean;
  },
): SuppliedPaletteMatchSearchResult {
  const frozenIssues = Object.freeze([...issues]);
  return Object.freeze({
    ok: frozenIssues.length === 0 && recipe !== null,
    coverage: SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE,
    normalizedTargetColor,
    recipe,
    bestPair,
    issues: frozenIssues,
    stats: Object.freeze({
      ...stats,
      candidatePoolToolIds: Object.freeze([...stats.candidatePoolToolIds]),
    }),
  });
}

class BoundedWorstHeap<T> {
  readonly #values: T[] = [];

  constructor(
    readonly capacity: number,
    readonly score: (value: T) => number,
  ) {}

  offer(value: T): void {
    if (this.#values.length < this.capacity) {
      this.#values.push(value);
      this.#bubbleUp(this.#values.length - 1);
      return;
    }
    if (this.#values.length === 0 || !(this.score(value) < this.score(this.#values[0]))) return;
    this.#values[0] = value;
    this.#bubbleDown(0);
  }

  drainWorstFirst(): readonly T[] {
    const drained: T[] = [];
    while (this.#values.length > 0) drained.push(this.#popWorst());
    return Object.freeze(drained);
  }

  #popWorst(): T {
    const worst = this.#values[0];
    const tail = this.#values.pop();
    if (this.#values.length > 0 && tail !== undefined) {
      this.#values[0] = tail;
      this.#bubbleDown(0);
    }
    return worst;
  }

  #bubbleUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!(this.score(this.#values[parent]) < this.score(this.#values[index]))) break;
      [this.#values[parent], this.#values[index]] = [this.#values[index], this.#values[parent]];
      index = parent;
    }
  }

  #bubbleDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.#values.length && this.score(this.#values[largest]) < this.score(this.#values[left])) {
        largest = left;
      }
      if (right < this.#values.length && this.score(this.#values[largest]) < this.score(this.#values[right])) {
        largest = right;
      }
      if (largest === index) return;
      [this.#values[index], this.#values[largest]] = [this.#values[largest], this.#values[index]];
      index = largest;
    }
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
