/**
 * MixedFilamentPreview — faithful TypeScript port of libslic3r's FullSpectrum
 * mixed-filament ("virtual filament") parsing + display-color computation
 * (third_party/OrcaSlicer/src/libslic3r/MixedFilament.cpp, patched tree).
 *
 * A FullSpectrum 3MF assigns parts/paint to filament IDs beyond the physical
 * count; ID `numPhysical + k` resolves to the k-th ENABLED, non-deleted row of
 * `mixed_filament_definitions` (MixedFilamentManager::mixed_index_from_filament_id).
 * Each row's on-screen color comes from compute_mixed_filament_display_color,
 * which blends the component colors through the filament_mixer pigment model
 * (degree-4 polynomial approximating Mixbox) — NOT a naive sRGB lerp, which is
 * why blue+yellow reads green like the desktop app, not gray.
 *
 * Pure functions, no THREE — unit-testable in isolation.
 */
import { COEF, INTERCEPT, N_FEATURES, N_INPUTS, POWERS } from './filamentMixerModel';
import { normalizeManualCyclePattern } from '../project/filaments/manualCyclePattern';

export interface MixedFilamentDef {
  componentA: number;
  componentB: number;
  stableId: number;
  mixBPercent: number;
  manualPattern: string;
  gradientComponentIds: string;
  gradientComponentWeights: string;
  /** 0 = LayerCycle, 1 = SameLayerPointillisme, 2 = Simple. */
  distributionMode: number;
  localZMaxSublayers: number;
  componentASurfaceOffset: number;
  componentBSurfaceOffset: number;
  enabled: boolean;
  deleted: boolean;
  custom: boolean;
  originAuto: boolean;
}

export interface MixedPreviewSettings {
  nominalLayerHeight: number;
  mixedLowerBound: number;
  mixedUpperBound: number;
  localZMode: boolean;
  wallLoops: number;
}

export const DEFAULT_PREVIEW_SETTINGS: MixedPreviewSettings = {
  nominalLayerHeight: 0.2,
  mixedLowerBound: 0.04,
  mixedUpperBound: 0.16,
  localZMode: false,
  wallLoops: 1,
};

const DIST_LAYER_CYCLE = 0;
const DIST_SAME_LAYER_POINTILLISME = 1;
const DIST_SIMPLE = 2;

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// filament_mixer pigment lerp (filament_mixer_model.h)
// ---------------------------------------------------------------------------

/** Pigment-style RGB mix, byte-exact port of filament_mixer::lerp. */
export function filamentMixerLerp(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
  t: number,
): [number, number, number] {
  if (t <= 0) return [r1, g1, b1];
  if (t >= 1) return [r2, g2, b2];
  const x = [r1, g1, b1, r2, g2, b2, t];
  const out: number[] = [0, 0, 0];
  for (let c = 0; c < 3; c++) out[c] = INTERCEPT[c];
  for (let i = 0; i < N_FEATURES; i++) {
    let val = 1.0;
    for (let j = 0; j < N_INPUTS; j++) {
      const exp = POWERS[i * N_INPUTS + j];
      for (let e = 0; e < exp; e++) val *= x[j];
    }
    for (let c = 0; c < 3; c++) out[c] += val * COEF[i * 3 + c];
  }
  // C++ truncates (static_cast<int>) then clamps to [0, 255].
  return [
    clampInt(Math.trunc(out[0]), 0, 255),
    clampInt(Math.trunc(out[1]), 0, 255),
    clampInt(Math.trunc(out[2]), 0, 255),
  ];
}

function parseHexColor(hex: string): [number, number, number] {
  if (hex && hex.length >= 7 && hex[0] === '#') {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
  }
  return [0, 0, 0];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** MixedFilamentManager::blend_color — pair blend at ratio_b/(ratio_a+ratio_b). */
export function blendColor(colorA: string, colorB: string, ratioA: number, ratioB: number): string {
  const safeA = Math.max(0, ratioA);
  const safeB = Math.max(0, ratioB);
  const total = safeA + safeB;
  const t = total > 0 ? safeB / total : 0.5;
  const [r1, g1, b1] = parseHexColor(colorA);
  const [r2, g2, b2] = parseHexColor(colorB);
  const [r, g, b] = filamentMixerLerp(r1, g1, b1, r2, g2, b2, t);
  return rgbToHex(r, g, b);
}

/** MixedFilamentManager::blend_color_multi — weighted pairwise pigment blend. */
export function blendColorMulti(colorPercents: [string, number][]): string {
  if (colorPercents.length === 0) return '#000000';
  if (colorPercents.length === 1) return colorPercents[0][0];
  const colors: { rgb: [number, number, number]; pct: number }[] = [];
  let totalPct = 0;
  for (const [hex, pct] of colorPercents) {
    if (pct <= 0) continue;
    colors.push({ rgb: parseHexColor(hex), pct });
    totalPct += pct;
  }
  if (colors.length === 0 || totalPct <= 0) return '#000000';
  let [r, g, b] = colors[0].rgb;
  let accumulated = colors[0].pct;
  for (let i = 1; i < colors.length; i++) {
    const next = colors[i];
    const newTotal = accumulated + next.pct;
    if (newTotal <= 0) continue;
    const t = next.pct / newTotal;
    [r, g, b] = filamentMixerLerp(r, g, b, next.rgb[0], next.rgb[1], next.rgb[2], t);
    accumulated = newTotal;
  }
  return rgbToHex(r, g, b);
}

// ---------------------------------------------------------------------------
// Manual pattern / gradient helpers
// ---------------------------------------------------------------------------

/** Canonical pinned-engine manual Cycle-pattern normalization. */
export const normalizeManualPattern = normalizeManualCyclePattern;

function splitManualPatternGroups(pattern: string): string[] {
  return pattern.split(',').filter((g) => g.length > 0);
}

function mixPercentFromNormalizedPattern(pattern: string): number {
  const groups = splitManualPatternGroups(pattern);
  if (groups.length === 0) return 50;
  let blendB = 0;
  for (const group of groups) {
    const countB = [...group].filter((c) => c === '2').length;
    blendB += countB / group.length;
  }
  return clampInt(Math.round((100 * blendB) / groups.length), 0, 100);
}

function decodeGradientComponentIds(components: string, numPhysical: number): number[] {
  const ids: number[] = [];
  if (!components || numPhysical === 0) return ids;
  const seen = new Set<number>();
  for (const c of components) {
    if (c < '1' || c > '9') continue;
    const id = c.charCodeAt(0) - 48;
    if (id === 0 || id > numPhysical || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeGradientComponentIds(components: string): string {
  let normalized = '';
  const seen = new Set<string>();
  for (const c of components) {
    if (c < '1' || c > '9' || seen.has(c)) continue;
    seen.add(c);
    normalized += c;
  }
  return normalized;
}

function parseGradientWeightTokens(weights: string): number[] {
  const out: number[] = [];
  let token = '';
  for (const c of weights) {
    if (c >= '0' && c <= '9') {
      token += c;
      continue;
    }
    if (token) {
      out.push(Math.max(0, parseInt(token, 10)));
      token = '';
    }
  }
  if (token) out.push(Math.max(0, parseInt(token, 10)));
  return out;
}

function normalizeWeightVectorToPercent(weights: number[]): number[] {
  const out = new Array<number>(weights.length).fill(0);
  if (weights.length === 0) return out;
  let sum = 0;
  for (const w of weights) sum += Math.max(0, w);
  if (sum <= 0) return out;
  const remainders = new Array<number>(weights.length).fill(0);
  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    const exact = (100 * Math.max(0, weights[i])) / sum;
    out[i] = Math.floor(exact);
    remainders[i] = exact - out[i];
    assigned += out[i];
  }
  let missing = Math.max(0, 100 - assigned);
  while (missing > 0) {
    let bestIdx = 0;
    let bestRem = -1;
    for (let i = 0; i < remainders.length; i++) {
      if (weights[i] <= 0) continue;
      if (remainders[i] > bestRem) {
        bestRem = remainders[i];
        bestIdx = i;
      }
    }
    out[bestIdx]++;
    remainders[bestIdx] = 0;
    missing--;
  }
  return out;
}

function normalizeGradientComponentWeights(weights: string, expectedComponents: number): string {
  if (expectedComponents === 0) return '';
  const parsed = parseGradientWeightTokens(weights);
  if (parsed.length !== expectedComponents) return '';
  const normalized = normalizeWeightVectorToPercent(parsed);
  const sum = normalized.reduce((a, b) => a + b, 0);
  return sum > 0 ? normalized.join('/') : '';
}

function decodeGradientComponentWeights(weights: string, expectedComponents: number): number[] {
  if (expectedComponents === 0) return [];
  const parsed = parseGradientWeightTokens(weights);
  if (parsed.length !== expectedComponents) return [];
  const normalized = normalizeWeightVectorToPercent(parsed);
  const sum = normalized.reduce((a, b) => a + b, 0);
  return sum > 0 ? normalized : [];
}

// ---------------------------------------------------------------------------
// Preview sequences (which physical filament each preview slice uses)
// ---------------------------------------------------------------------------

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

function decodeManualPatternPreviewToken(
  token: string,
  componentA: number,
  componentB: number,
  numPhysical: number,
): number {
  let extruderId = 0;
  if (token === '1') extruderId = componentA;
  else if (token === '2') extruderId = componentB;
  else if (token >= '3' && token <= '9') extruderId = token.charCodeAt(0) - 48;
  return extruderId >= 1 && extruderId <= numPhysical ? extruderId : 0;
}

function buildGroupedManualPatternPreviewSequence(
  pattern: string,
  componentA: number,
  componentB: number,
  numPhysical: number,
  wallLoops: number,
): number[] {
  const sequence: number[] = [];
  if (numPhysical === 0) return sequence;
  const normalized = normalizeManualPattern(pattern);
  if (!normalized) return sequence;
  const groups = splitManualPatternGroups(normalized);
  if (groups.length === 0) return sequence;

  if (groups.length === 1) {
    for (const token of normalized) {
      const extruderId = decodeManualPatternPreviewToken(token, componentA, componentB, numPhysical);
      if (extruderId !== 0) sequence.push(extruderId);
    }
    return sequence;
  }

  const K_MAX_PREVIEW_CYCLE = 48;
  let cycle = 1;
  for (const group of groups) {
    if (!group) continue;
    cycle = lcm(cycle, group.length);
    if (cycle >= K_MAX_PREVIEW_CYCLE) {
      cycle = K_MAX_PREVIEW_CYCLE;
      break;
    }
  }
  const previewWallLoops = Math.max(1, wallLoops === 0 ? groups.length : wallLoops);
  for (let layerIdx = 0; layerIdx < cycle; layerIdx++) {
    for (let wallIdx = 0; wallIdx < previewWallLoops; wallIdx++) {
      const group = groups[Math.min(wallIdx, groups.length - 1)];
      if (!group) continue;
      const token = group[layerIdx % group.length];
      const extruderId = decodeManualPatternPreviewToken(token, componentA, componentB, numPhysical);
      if (extruderId !== 0) sequence.push(extruderId);
    }
  }
  return sequence;
}

function effectivePairPreviewRatios(percentB: number): [number, number] {
  const mixB = clampInt(percentB, 0, 100);
  let ratioA = 1;
  let ratioB = 0;
  if (mixB >= 100) {
    ratioA = 0;
    ratioB = 1;
  } else if (mixB > 0) {
    const pctB = mixB;
    const pctA = 100 - pctB;
    const bIsMajor = pctB >= pctA;
    const majorPct = bIsMajor ? pctB : pctA;
    const minorPct = bIsMajor ? pctA : pctB;
    const majorLayers = Math.max(1, Math.round(majorPct / Math.max(1, minorPct)));
    ratioA = bIsMajor ? 1 : majorLayers;
    ratioB = bIsMajor ? majorLayers : 1;
  }
  if (ratioA > 0 && ratioB > 0) {
    const g = gcd(ratioA, ratioB);
    if (g > 1) {
      ratioA /= g;
      ratioB /= g;
    }
  }
  return [Math.max(0, ratioA), Math.max(0, ratioB)];
}

function buildEffectivePairPreviewSequence(
  componentA: number,
  componentB: number,
  percentB: number,
  limitCycle: boolean,
): number[] {
  const sequence: number[] = [];
  if (componentA === 0 || componentB === 0 || componentA === componentB) return sequence;
  let [ratioA, ratioB] = effectivePairPreviewRatios(percentB);
  const K_MAX_CYCLE = 24;
  if (limitCycle && ratioA > 0 && ratioB > 0 && ratioA + ratioB > K_MAX_CYCLE) {
    const scale = K_MAX_CYCLE / (ratioA + ratioB);
    ratioA = Math.max(1, Math.round(ratioA * scale));
    ratioB = Math.max(1, Math.round(ratioB * scale));
  }
  if (ratioA === 0 && ratioB === 0) ratioA = 1;
  const cycle = Math.max(1, ratioA + ratioB);
  for (let pos = 0; pos < cycle; pos++) {
    const bBefore = Math.floor((pos * ratioB) / cycle);
    const bAfter = Math.floor(((pos + 1) * ratioB) / cycle);
    sequence.push(bAfter > bBefore ? componentB : componentA);
  }
  return sequence;
}

function buildWeightedGradientSequence(ids: number[], weights: number[]): number[] {
  if (ids.length === 0) return [];
  let filteredIds: number[] = [];
  let counts: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const w = i < weights.length ? Math.max(0, weights[i]) : 0;
    if (w <= 0) continue;
    filteredIds.push(ids[i]);
    counts.push(w);
  }
  if (filteredIds.length === 0) {
    filteredIds = [...ids];
    counts = new Array(ids.length).fill(1);
  }
  let g = 0;
  for (const c of counts) g = gcd(g, Math.max(1, c));
  if (g > 1) counts = counts.map((c) => Math.max(1, Math.floor(c / g)));
  let cycle = counts.reduce((a, b) => a + b, 0);
  const K_MAX_CYCLE = 48;
  if (cycle > K_MAX_CYCLE) {
    const scale = K_MAX_CYCLE / cycle;
    counts = counts.map((c) => Math.max(1, Math.round(c * scale)));
    cycle = counts.reduce((a, b) => a + b, 0);
    while (cycle > K_MAX_CYCLE) {
      let maxIdx = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[maxIdx]) maxIdx = i;
      if (counts[maxIdx] <= 1) break;
      counts[maxIdx]--;
      cycle--;
    }
  }
  if (cycle <= 0) return [];
  const sequence: number[] = [];
  const emitted = new Array(counts.length).fill(0);
  for (let pos = 0; pos < cycle; pos++) {
    let bestIdx = 0;
    let bestScore = -1e9;
    for (let i = 0; i < counts.length; i++) {
      const target = ((pos + 1) * counts[i]) / cycle;
      const score = target - emitted[i];
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    emitted[bestIdx]++;
    sequence.push(filteredIds[bestIdx]);
  }
  return sequence;
}

function blendDisplayColorFromSequence(
  colors: string[],
  numPhysical: number,
  sequence: number[],
  fallback: string,
): string {
  if (colors.length === 0 || sequence.length === 0 || numPhysical === 0) return fallback;
  const counts = new Array<number>(numPhysical + 1).fill(0);
  let total = 0;
  for (const id of sequence) {
    if (id === 0 || id > numPhysical) continue;
    counts[id]++;
    total++;
  }
  if (total === 0) return fallback;
  const colorPercents: [string, number][] = [];
  for (let id = 1; id <= numPhysical; id++) {
    if (counts[id] === 0 || id > colors.length) continue;
    colorPercents.push([colors[id - 1], counts[id]]);
  }
  if (colorPercents.length === 0) return fallback;
  if (colorPercents.length === 1) return colorPercents[0][0];
  return blendColorMulti(colorPercents);
}

// ---------------------------------------------------------------------------
// Display color (compute_mixed_filament_display_color)
// ---------------------------------------------------------------------------

/**
 * mixed_filament_effective_local_z_preview_mix_b_percent, simplified: the
 * local-z pass-height simulation (build_local_z_preview_pass_heights) shifts
 * the percentage a few points at most; outside local-z mode the C++ returns
 * clamp(mix_b) exactly, and that's the path every current project uses
 * (dithering_local_z_mode defaults to 0). Approximate local-z with the same
 * clamp rather than porting the 250-line pass planner.
 */
function effectiveMixBPercent(def: MixedFilamentDef): number {
  return clampInt(def.mixBPercent, 0, 100);
}

function supportsBiasApparentColor(
  def: MixedFilamentDef,
  settings: MixedPreviewSettings,
  biasModeEnabled: boolean,
): boolean {
  if (!biasModeEnabled) return false;
  if (settings.localZMode) return false;
  if (def.distributionMode === DIST_SAME_LAYER_POINTILLISME) return false;
  if (normalizeManualPattern(def.manualPattern) !== '') return false;
  if (decodeGradientComponentIds(def.gradientComponentIds, 9).length >= 3) return false;
  return def.componentA >= 1 && def.componentB >= 1 && def.componentA !== def.componentB;
}

function referenceNozzleMm(componentA: number, componentB: number, nozzleDiameters: number[]): number {
  const samples: number[] = [];
  for (const id of [componentA, componentB]) {
    if (id >= 1 && id <= nozzleDiameters.length) samples.push(Math.max(0.05, nozzleDiameters[id - 1]));
  }
  if (samples.length === 0) return 0.4;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function apparentMixBPercent(mixBPercent: number, offsetA: number, offsetB: number, referenceWidthMm: number): number {
  const safeReference = Math.max(0.05, Math.abs(referenceWidthMm));
  const maxBias = clampInt(safeReference, 0.01, 0.35);
  const canonicalBias = offsetB - offsetA; // canonical_signed_bias_value
  const shiftPct = (-100 * clampInt(canonicalBias, -maxBias, maxBias)) / safeReference;
  return clampInt(Math.round(clampInt(mixBPercent, 0, 100) + shiftPct), 0, 100);
}

const DISPLAY_FALLBACK = '#26A69A';

/** Port of compute_mixed_filament_display_color. */
export function mixedFilamentDisplayColor(
  def: MixedFilamentDef,
  physicalColors: string[],
  settings: MixedPreviewSettings = DEFAULT_PREVIEW_SETTINGS,
  componentBiasEnabled = true,
  nozzleDiameters: number[] = [],
): string {
  const numPhysical = physicalColors.length;
  if (numPhysical === 0) return DISPLAY_FALLBACK;

  if (
    supportsBiasApparentColor(def, settings, componentBiasEnabled) &&
    def.componentA >= 1 &&
    def.componentB >= 1 &&
    def.componentA <= numPhysical &&
    def.componentB <= numPhysical
  ) {
    const baseB = effectiveMixBPercent(def);
    let apparentA = 100 - baseB;
    let apparentB = baseB;
    if (supportsBiasApparentColor(def, settings, componentBiasEnabled)) {
      const ref = referenceNozzleMm(def.componentA, def.componentB, nozzleDiameters);
      apparentB = apparentMixBPercent(baseB, def.componentASurfaceOffset, def.componentBSurfaceOffset, ref);
      apparentA = 100 - apparentB;
    }
    return blendColor(physicalColors[def.componentA - 1], physicalColors[def.componentB - 1], apparentA, apparentB);
  }

  const normalizedPattern = normalizeManualPattern(def.manualPattern);
  if (normalizedPattern) {
    const sequence = buildGroupedManualPatternPreviewSequence(
      normalizedPattern,
      def.componentA,
      def.componentB,
      numPhysical,
      settings.wallLoops,
    );
    if (sequence.length > 0) {
      return blendDisplayColorFromSequence(physicalColors, numPhysical, sequence, DISPLAY_FALLBACK);
    }
  }

  if (def.distributionMode !== DIST_SIMPLE) {
    const gradientIds = decodeGradientComponentIds(def.gradientComponentIds, numPhysical);
    if (gradientIds.length >= 3) {
      const gradientWeights = decodeGradientComponentWeights(def.gradientComponentWeights, gradientIds.length);
      const sequence = buildWeightedGradientSequence(
        gradientIds,
        gradientWeights.length ? gradientWeights : new Array(gradientIds.length).fill(1),
      );
      if (sequence.length > 0) {
        return blendDisplayColorFromSequence(physicalColors, numPhysical, sequence, DISPLAY_FALLBACK);
      }
    }
  }

  const effectiveMixB = effectiveMixBPercent(def);
  const sameLayerMode = def.distributionMode === DIST_SAME_LAYER_POINTILLISME;
  const pairSequence = buildEffectivePairPreviewSequence(def.componentA, def.componentB, effectiveMixB, sameLayerMode);
  if (pairSequence.length > 0) {
    return blendDisplayColorFromSequence(physicalColors, numPhysical, pairSequence, DISPLAY_FALLBACK);
  }

  if (def.componentA === 0 || def.componentB === 0 || def.componentA > numPhysical || def.componentB > numPhysical) {
    return DISPLAY_FALLBACK;
  }
  const mixB = clampInt(def.mixBPercent, 0, 100);
  return blendColor(physicalColors[def.componentA - 1], physicalColors[def.componentB - 1], 100 - mixB, mixB);
}

// ---------------------------------------------------------------------------
// Wire-format parsing (parse_row_definition + load_custom_entries semantics)
// ---------------------------------------------------------------------------

const clampSurfaceOffset = (v: number) => clampInt(v, -2, 2);

function normalizeDistributionModeWithoutPointillism(mode: number, gradientComponentIds: string): number {
  const clamped = clampInt(mode, DIST_LAYER_CYCLE, DIST_SIMPLE);
  if (clamped !== DIST_SAME_LAYER_POINTILLISME) return clamped;
  return decodeGradientComponentIds(gradientComponentIds, 9).length >= 3 ? DIST_LAYER_CYCLE : DIST_SIMPLE;
}

function parseRowDefinition(row: string): MixedFilamentDef | null {
  const tokens = row.split(',').map((t) => t.trim());
  if (tokens.length < 4) return null;
  const parseIntStrict = (t: string): number | null => {
    if (!/^-?\d+$/.test(t)) return null;
    return parseInt(t, 10);
  };
  const values = [0, 0, 1, 1, 50];
  if (tokens.length === 4) {
    // Legacy: a,b,enabled,mix
    const idx = [0, 1, 2, 4];
    for (let i = 0; i < 4; i++) {
      const v = parseIntStrict(tokens[i]);
      if (v === null) return null;
      values[idx[i]] = v;
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const v = parseIntStrict(tokens[i]);
      if (v === null) return null;
      values[i] = v;
    }
  }
  if (values[0] <= 0 || values[1] <= 0) return null;

  const def: MixedFilamentDef = {
    componentA: values[0],
    componentB: values[1],
    stableId: 0,
    mixBPercent: clampInt(values[4], 0, 100),
    manualPattern: '',
    gradientComponentIds: '',
    gradientComponentWeights: '',
    distributionMode: DIST_SIMPLE,
    localZMaxSublayers: 0,
    componentASurfaceOffset: 0,
    componentBSurfaceOffset: 0,
    enabled: values[2] !== 0,
    deleted: false,
    custom: tokens.length === 4 ? true : values[3] !== 0,
    originAuto: false,
  };
  def.originAuto = !def.custom;

  let tokenIdx = 5;
  let manualPattern = '';
  if (tokens.length >= 6) {
    const legacy = tokens[5];
    if (legacy === '0' || legacy === '1') {
      tokenIdx = 6; // legacy pointillism flag (retired)
    } else if (legacy === '' || legacy[0] === 'g' || legacy[0] === 'G' || legacy[0] === 'm' || legacy[0] === 'M') {
      tokenIdx = 5;
    } else {
      manualPattern = legacy;
      tokenIdx = 6;
    }
  }

  const patternTokens: string[] = [];
  if (manualPattern) patternTokens.push(manualPattern);
  for (let i = tokenIdx; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const head = tok[0].toLowerCase();
    if (head === 'g') {
      def.gradientComponentIds = tok.slice(1);
      continue;
    }
    if (head === 'w') {
      def.gradientComponentWeights = tok.slice(1);
      continue;
    }
    if (head === 'm') {
      const v = parseIntStrict(tok.slice(1).trim());
      if (v !== null) def.distributionMode = clampInt(v, DIST_LAYER_CYCLE, DIST_SIMPLE);
      continue;
    }
    if (head === 'z') {
      const v = parseIntStrict(tok.slice(1).trim());
      if (v !== null) def.localZMaxSublayers = Math.max(0, v);
      continue;
    }
    if (head === 'x' && tok.length >= 3) {
      const component = tok[1].toLowerCase();
      if (component === 'a' || component === 'b') {
        const v = parseFloat(tok.slice(2));
        if (Number.isFinite(v)) {
          if (component === 'a') def.componentASurfaceOffset = clampSurfaceOffset(v);
          else def.componentBSurfaceOffset = clampSurfaceOffset(v);
        }
        continue;
      }
    }
    if (head === 'd') {
      const v = parseIntStrict(tok.slice(1).trim());
      if (v !== null) def.deleted = v !== 0;
      continue;
    }
    if (head === 'o') {
      const v = parseIntStrict(tok.slice(1).trim());
      if (v !== null) def.originAuto = v !== 0;
      continue;
    }
    if (head === 'u') {
      const t = tok.slice(1).trim();
      if (/^\d+$/.test(t)) def.stableId = parseInt(t, 10);
      continue;
    }
    patternTokens.push(tok);
  }
  if (patternTokens.length > 0) manualPattern = patternTokens.join(',');

  def.gradientComponentIds = normalizeGradientComponentIds(def.gradientComponentIds);
  def.gradientComponentWeights = normalizeGradientComponentWeights(
    def.gradientComponentWeights,
    def.gradientComponentIds.length,
  );
  def.manualPattern = normalizeManualPattern(manualPattern);
  if (def.manualPattern) def.mixBPercent = mixPercentFromNormalizedPattern(def.manualPattern);
  if (def.deleted) def.enabled = false;
  def.distributionMode = normalizeDistributionModeWithoutPointillism(def.distributionMode, def.gradientComponentIds);
  return def;
}

/**
 * Parse a `mixed_filament_definitions` string into rows, applying the same
 * rejection rules as MixedFilamentManager::load_custom_entries (component
 * bounds, a != b). Row order is preserved: virtual filament ID
 * `numPhysical + k` is the k-th row with `enabled && !deleted` (1-based k).
 */
export function parseMixedFilamentDefinitions(serialized: string, numPhysical: number): MixedFilamentDef[] {
  const out: MixedFilamentDef[] = [];
  if (!serialized || numPhysical < 2) return out;
  for (const row of serialized.split(';')) {
    if (!row) continue;
    const def = parseRowDefinition(row);
    if (!def) continue;
    if (def.componentA > numPhysical || def.componentB > numPhysical) continue;
    if (def.componentA === def.componentB) continue;
    out.push(def);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project-level convenience
// ---------------------------------------------------------------------------

export interface VirtualFilament {
  /** 1-based filament ID as paint states / part extruders reference it. */
  id: number;
  /** '#RRGGBB' display color (pigment-blended like the desktop UI). */
  color: string;
  /** Short human label, e.g. "P1+P3 50%" or "P1/P4 pattern". */
  label: string;
  def: MixedFilamentDef;
}

const cfgStr = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.length ? `${v[0]}` : '';
  return `${v}`;
};

/**
 * Resolve a 3MF project_settings.config object into the list of virtual
 * (mixed) filaments: parsing `mixed_filament_definitions`, filtering to
 * enabled rows, and computing each one's desktop-parity display color.
 * Virtual IDs continue after the physical filaments: with 4 physical
 * filaments the first enabled row is filament 5.
 */
export function virtualFilamentsFromConfig(cfg: Record<string, unknown>): VirtualFilament[] {
  const physical: string[] =
    Array.isArray(cfg.filament_colour) && cfg.filament_colour.length
      ? (cfg.filament_colour as string[])
      : Array.isArray(cfg.extruder_colour)
        ? (cfg.extruder_colour as string[])
        : [];
  const serialized = cfgStr(cfg.mixed_filament_definitions);
  if (!serialized || physical.length < 2) return [];

  const settings: MixedPreviewSettings = {
    ...DEFAULT_PREVIEW_SETTINGS,
    nominalLayerHeight: parseFloat(cfgStr(cfg.layer_height)) || DEFAULT_PREVIEW_SETTINGS.nominalLayerHeight,
    mixedLowerBound:
      parseFloat(cfgStr(cfg.mixed_filament_height_lower_bound)) || DEFAULT_PREVIEW_SETTINGS.mixedLowerBound,
    mixedUpperBound:
      parseFloat(cfgStr(cfg.mixed_filament_height_upper_bound)) || DEFAULT_PREVIEW_SETTINGS.mixedUpperBound,
    localZMode: cfgStr(cfg.dithering_local_z_mode) === '1',
    wallLoops: parseInt(cfgStr(cfg.wall_loops), 10) || 1,
  };
  const nozzles = Array.isArray(cfg.nozzle_diameter)
    ? (cfg.nozzle_diameter as unknown[]).map((v) => parseFloat(`${v}`) || 0.4)
    : [];

  const out: VirtualFilament[] = [];
  let id = physical.length;
  for (const def of parseMixedFilamentDefinitions(serialized, physical.length)) {
    if (!def.enabled || def.deleted) continue;
    id++;
    const color = mixedFilamentDisplayColor(def, physical, settings, true, nozzles);
    const label = def.manualPattern
      ? `P${def.componentA}/P${def.componentB} · ${def.manualPattern}`
      : `P${def.componentA}+P${def.componentB} · ${100 - def.mixBPercent}/${def.mixBPercent}`;
    out.push({ id, color, label, def });
  }
  return out;
}

/**
 * Full display palette for a project: physical filament colors followed by
 * the virtual filaments' display colors, indexed by (filamentId - 1). This is
 * what part-extruder and paint-state lookups should use — indexing only the
 * physical palette (or worse, wrapping modulo it) is how a FullSpectrum model
 * renders in 4 colors instead of 38.
 */
export function fullDisplayPalette(cfg: Record<string, unknown>): string[] {
  const physical: string[] =
    Array.isArray(cfg.filament_colour) && cfg.filament_colour.length
      ? (cfg.filament_colour as string[])
      : Array.isArray(cfg.extruder_colour)
        ? (cfg.extruder_colour as string[])
        : [];
  return [...physical, ...virtualFilamentsFromConfig(cfg).map((v) => v.color)];
}
