/**
 * Defensive importer for `mixed_filament_definitions` emitted by pinned
 * Snapmaker Orca v2.3.4. Invalid rows are reported and skipped; callers retain
 * the raw project setting, so unsupported data is never silently discarded.
 */

import type { MixedFilamentId, PhysicalFilamentId } from '../domain/ids';
import type {
  FullSpectrumRecipeState,
  MixedComponent,
  MixedDistribution,
  MixedFilament,
  PhysicalFilament,
} from '../domain/model';
import { parseManualCyclePattern } from './manualCyclePattern';
import { normalizeColorMatchWeights } from './mixedFilamentAuthoring';

export interface FullSpectrumImportedMaterial {
  readonly name: string;
  readonly color: string;
}

export interface FullSpectrumImportIssue {
  readonly rowIndex: number;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly sourceRow: string;
}

export interface FullSpectrumImportResult {
  readonly filaments: readonly MixedFilament[];
  readonly issues: readonly FullSpectrumImportIssue[];
}

export interface FullSpectrumImportOptions {
  readonly createId: (rowIndex: number, upstreamStableId: string) => MixedFilamentId;
  /** Enabled mixed materials in row order, after the physical material rows. */
  readonly mixedMaterials?: readonly FullSpectrumImportedMaterial[];
}

interface ParsedRow {
  componentA: number;
  componentB: number;
  enabled: boolean;
  custom: boolean;
  originAuto: boolean;
  mixBPercent: number;
  gradientToolIds: number[];
  gradientWeights: number[];
  manualPattern: string;
  distributionMode: 0 | 2;
  localZMaxSublayers: number;
  componentASurfaceOffsetMm: number;
  componentBSurfaceOffsetMm: number;
  deleted: boolean;
  upstreamStableId: string;
  uiMode: -1 | 0 | 1 | 2 | 3;
  gradientEnabled: boolean;
  gradientStart: number;
  gradientEnd: number;
}

export function importFullSpectrumDefinitions(
  serialized: string,
  physicalFilaments: readonly PhysicalFilament[],
  options: FullSpectrumImportOptions,
): FullSpectrumImportResult {
  const issues: FullSpectrumImportIssue[] = [];
  const filaments: MixedFilament[] = [];
  const usedStableIds = new Set<string>();
  let nextStableId = 1n;
  let enabledMaterialIndex = 0;

  for (const [rowIndex, sourceRow] of serialized.split(';').entries()) {
    if (!sourceRow.trim()) continue;
    const issue = (severity: 'warning' | 'error', message: string) => {
      issues.push({ rowIndex, severity, message, sourceRow });
    };
    const parsed = parseRow(sourceRow, physicalFilaments.length, issue);
    if (!parsed) continue;
    let stableId = parsed.upstreamStableId;
    if (stableId === '0' || usedStableIds.has(stableId)) {
      while (usedStableIds.has(nextStableId.toString())) nextStableId += 1n;
      const replacement = nextStableId.toString();
      issue(
        'warning',
        stableId === '0'
          ? `Legacy stable ID 0 was assigned deterministic ID ${replacement}`
          : `Duplicate stable ID ${stableId} was assigned deterministic ID ${replacement}`,
      );
      stableId = replacement;
      nextStableId += 1n;
    }
    usedStableIds.add(stableId);

    const enabled = parsed.enabled && !parsed.deleted;
    const importedMaterial = enabled ? options.mixedMaterials?.[enabledMaterialIndex++] : undefined;
    const componentAId = physicalFilaments[parsed.componentA - 1].id;
    const componentBId = physicalFilaments[parsed.componentB - 1].id;
    const gradientComponentIds = parsed.gradientToolIds.map((toolId) => physicalFilaments[toolId - 1].id);
    const pattern = stablePatternGroups(parsed.manualPattern, parsed, physicalFilaments, issue);
    if (pattern === null) continue;

    const fullSpectrum: FullSpectrumRecipeState = {
      schemaVersion: 1,
      upstreamStableId: stableId,
      uiMode: parsed.uiMode,
      componentAId,
      componentBId,
      ratioA: inferredRatioA(parsed),
      ratioB: inferredRatioB(parsed),
      mixBPercent:
        pattern.length > 0 ? patternMixBPercent(pattern, componentBId) : Math.max(0, Math.min(100, parsed.mixBPercent)),
      manualPatternGroups: pattern,
      gradientComponentIds,
      gradientComponentWeights: parsed.gradientWeights,
      pointillismAllFilaments: false,
      distributionMode: parsed.distributionMode,
      localZMaxSublayers: parsed.localZMaxSublayers,
      gradientEnabled: parsed.gradientEnabled,
      gradientStart: parsed.gradientStart,
      gradientEnd: parsed.gradientEnd,
      componentASurfaceOffsetMm: parsed.componentASurfaceOffsetMm,
      componentBSurfaceOffsetMm: parsed.componentBSurfaceOffsetMm,
      deleted: parsed.deleted,
      custom: parsed.custom,
      originAuto: parsed.originAuto,
    };
    const components = importedComponents(fullSpectrum);
    const displayColor = normalizeColor(importedMaterial?.color ?? physicalFilaments[parsed.componentA - 1].color);
    const distribution = importedDistribution(fullSpectrum, components, displayColor);
    if (parsed.uiMode === 2) {
      issue(
        'warning',
        'The upstream compact row does not persist the Match target; the imported display color is retained as its target',
      );
    }
    filaments.push({
      id: options.createId(rowIndex, stableId),
      name: importedMaterial?.name?.trim() || `Virtual filament ${rowIndex + 1}`,
      displayColor,
      components,
      distribution,
      fullSpectrum,
      config: {},
      enabled,
      extensionData: {
        orcaxrFullSpectrumImport: {
          source: 'mixed_filament_definitions',
          rowIndex,
          targetColorRecoverable: parsed.uiMode !== 2,
        },
      },
    });
  }

  return {
    filaments: Object.freeze(filaments),
    issues: Object.freeze(issues),
  };
}

function parseRow(
  sourceRow: string,
  physicalCount: number,
  issue: (severity: 'warning' | 'error', message: string) => void,
): ParsedRow | null {
  const tokens = sourceRow.split(',').map((token) => token.trim());
  if (tokens.length < 4) {
    issue('error', 'Mixed-filament row has fewer than four required fields');
    return null;
  }
  const current = tokens.length !== 4;
  const componentA = strictInteger(tokens[0]);
  const componentB = strictInteger(tokens[1]);
  const enabledValue = strictInteger(tokens[2]);
  const customValue = current ? strictInteger(tokens[3]) : 1;
  const mixValue = strictInteger(tokens[current ? 4 : 3]);
  if (
    componentA === null ||
    componentB === null ||
    enabledValue === null ||
    customValue === null ||
    mixValue === null
  ) {
    issue('error', 'Mixed-filament row has a malformed required integer field');
    return null;
  }
  if (
    componentA < 1 ||
    componentB < 1 ||
    componentA > physicalCount ||
    componentB > physicalCount ||
    componentA === componentB
  ) {
    issue('error', `Mixed-filament pair ${componentA}/${componentB} is outside the ${physicalCount}-tool library`);
    return null;
  }

  let originAuto = customValue === 0;
  let gradientIdsRaw = '';
  let gradientWeightsRaw = '';
  let manualPattern = '';
  let distributionMode = 2;
  let localZMaxSublayers = 0;
  let componentASurfaceOffsetMm = 0;
  let componentBSurfaceOffsetMm = 0;
  let deleted = false;
  let upstreamStableId = '0';
  let uiMode: -1 | 0 | 1 | 2 | 3 = -1;
  let gradientEnabled = false;
  let gradientStart = 0.8;
  let gradientEnd = 0.2;
  let tokenIndex = current ? 5 : tokens.length;

  if (current && tokens.length >= 6) {
    const legacy = tokens[5];
    if (legacy === '0' || legacy === '1') {
      tokenIndex = 6;
      if (legacy === '1') issue('warning', 'Compiled-out pointillisme flag was normalized to false');
    } else if (!legacy || /^[gGmMrR]/.test(legacy)) {
      tokenIndex = 5;
    } else {
      manualPattern = legacy;
      tokenIndex = 6;
    }
  }

  const patternTokens = manualPattern ? [manualPattern] : [];
  for (let index = tokenIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const prefix = token[0].toLowerCase();
    if (prefix === 'g') {
      gradientIdsRaw = token.slice(1);
    } else if (prefix === 'w') {
      gradientWeightsRaw = token.slice(1);
    } else if (prefix === 'm') {
      distributionMode = clampInteger(strictInteger(token.slice(1)) ?? distributionMode, 0, 2);
    } else if (prefix === 'z') {
      localZMaxSublayers = Math.max(0, strictInteger(token.slice(1)) ?? localZMaxSublayers);
    } else if (prefix === 'x' && token.length >= 3 && /[ab]/i.test(token[1])) {
      const offset = Number(token.slice(2));
      if (Number.isFinite(offset)) {
        if (token[1].toLowerCase() === 'a') componentASurfaceOffsetMm = clamp(offset, -2, 2);
        else componentBSurfaceOffsetMm = clamp(offset, -2, 2);
      }
    } else if (prefix === 'd') {
      deleted = (strictInteger(token.slice(1)) ?? (deleted ? 1 : 0)) !== 0;
    } else if (prefix === 'o') {
      originAuto = (strictInteger(token.slice(1)) ?? (originAuto ? 1 : 0)) !== 0;
    } else if (prefix === 'u' && /^(0|[1-9][0-9]*)$/.test(token.slice(1))) {
      try {
        const candidate = BigInt(token.slice(1));
        if (candidate <= 0xffff_ffff_ffff_ffffn) upstreamStableId = candidate.toString();
      } catch {
        // Retain zero; deterministic allocation and a warning happen above.
      }
    } else if (/^cm/i.test(token)) {
      const candidate = strictInteger(token.slice(2));
      if (candidate !== null) uiMode = clampInteger(candidate, -1, 3) as -1 | 0 | 1 | 2 | 3;
    } else if (prefix === 'r') {
      const match = /^r([^/]+)\/([^/]+)\/([^/]+)$/i.exec(token);
      if (match) {
        const flag = strictInteger(match[1]);
        const start = Number(match[2]);
        const end = Number(match[3]);
        if (
          flag !== null &&
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start > 0 &&
          start < 1 &&
          end > 0 &&
          end < 1
        ) {
          gradientEnabled = flag !== 0;
          gradientStart = clamp(start, 0.01, 0.99);
          gradientEnd = clamp(end, 0.01, 0.99);
          if (Math.abs(gradientStart - gradientEnd) < 0.05) gradientEnabled = false;
        }
      }
    } else {
      patternTokens.push(token);
    }
  }
  manualPattern = patternTokens.join(',');

  const gradientToolIds = decodeGradientIds(gradientIdsRaw, physicalCount);
  if (gradientIdsRaw && gradientToolIds === null) {
    issue('error', 'Gradient component IDs reference a missing or malformed physical tool');
    return null;
  }
  const gradientWeights = normalizeGradientWeights(gradientWeightsRaw, gradientToolIds?.length ?? 0);
  const normalizedDistributionMode = normalizeDistributionMode(distributionMode, gradientToolIds?.length ?? 0);
  return {
    componentA,
    componentB,
    enabled: enabledValue !== 0,
    custom: current ? customValue !== 0 : true,
    originAuto,
    mixBPercent: clampInteger(mixValue, 0, 100),
    gradientToolIds: gradientToolIds ?? [],
    gradientWeights,
    manualPattern,
    distributionMode: normalizedDistributionMode,
    localZMaxSublayers,
    componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm,
    deleted,
    upstreamStableId,
    uiMode,
    gradientEnabled,
    gradientStart,
    gradientEnd,
  };
}

function stablePatternGroups(
  manualPattern: string,
  row: ParsedRow,
  physical: readonly PhysicalFilament[],
  issue: (severity: 'warning' | 'error', message: string) => void,
): PhysicalFilamentId[][] | null {
  if (!manualPattern) return [];
  const parsed = parseManualCyclePattern(manualPattern, {
    availableToolIds: Array.from({ length: physical.length }, (_, index) => index + 1),
  });
  if (!parsed.ok) {
    issue('error', `Manual Cycle pattern is invalid: ${parsed.issues.map((entry) => entry.message).join(' ')}`);
    return null;
  }
  return parsed.groups.map((group) =>
    group.tokens.map((token) => {
      const physicalTool = token.toolId === 1 ? row.componentA : token.toolId === 2 ? row.componentB : token.toolId;
      return physical[physicalTool - 1].id;
    }),
  );
}

function importedComponents(recipe: FullSpectrumRecipeState): MixedComponent[] {
  const ordered: PhysicalFilamentId[] = [];
  const add = (id: PhysicalFilamentId) => {
    if (!ordered.includes(id)) ordered.push(id);
  };
  add(recipe.componentAId);
  add(recipe.componentBId);
  recipe.gradientComponentIds.forEach(add);
  recipe.manualPatternGroups.flat().forEach(add);

  const weights = new Map<PhysicalFilamentId, number>();
  if (
    recipe.gradientComponentIds.length > 0 &&
    recipe.gradientComponentWeights.length === recipe.gradientComponentIds.length
  ) {
    recipe.gradientComponentIds.forEach((id, index) => weights.set(id, recipe.gradientComponentWeights[index]));
  } else if (recipe.manualPatternGroups.length > 0) {
    recipe.manualPatternGroups.flat().forEach((id) => weights.set(id, (weights.get(id) ?? 0) + 1));
  } else {
    weights.set(recipe.componentAId, 100 - recipe.mixBPercent);
    weights.set(recipe.componentBId, recipe.mixBPercent);
  }
  return ordered.map((filamentId) => ({ filamentId, weight: weights.get(filamentId) ?? 0 }));
}

function importedDistribution(
  recipe: FullSpectrumRecipeState,
  components: readonly MixedComponent[],
  displayColor: string,
): MixedDistribution {
  if (recipe.manualPatternGroups.length > 0 || recipe.uiMode === 1) return { mode: 'cycle' };
  if (recipe.uiMode === 2) return { mode: 'match', targetColor: displayColor };
  if (recipe.gradientEnabled || recipe.uiMode === 3) {
    return {
      mode: 'gradient',
      startWeights: components.map((component) =>
        component.filamentId === recipe.componentAId
          ? recipe.gradientStart
          : component.filamentId === recipe.componentBId
            ? 1 - recipe.gradientStart
            : 0,
      ),
      endWeights: components.map((component) =>
        component.filamentId === recipe.componentAId
          ? recipe.gradientEnd
          : component.filamentId === recipe.componentBId
            ? 1 - recipe.gradientEnd
            : 0,
      ),
    };
  }
  return { mode: 'ratio' };
}

function patternMixBPercent(
  groups: readonly (readonly PhysicalFilamentId[])[],
  componentBId: PhysicalFilamentId,
): number {
  if (groups.length === 0) return 50;
  const average = groups.reduce(
    (sum, group) => sum + group.filter((id) => id === componentBId).length / group.length,
    0,
  );
  return Math.round((100 * average) / groups.length);
}

function inferredRatioA(row: ParsedRow): number {
  if (row.uiMode !== 0 || row.gradientToolIds.length >= 3) return 1;
  if (row.mixBPercent >= 100) return 0;
  if (row.mixBPercent <= 0) return 1;
  const divisor = gcd(100 - row.mixBPercent, row.mixBPercent);
  return (100 - row.mixBPercent) / divisor;
}

function inferredRatioB(row: ParsedRow): number {
  if (row.uiMode !== 0 || row.gradientToolIds.length >= 3) return 1;
  if (row.mixBPercent <= 0) return 0;
  if (row.mixBPercent >= 100) return 1;
  const divisor = gcd(100 - row.mixBPercent, row.mixBPercent);
  return row.mixBPercent / divisor;
}

function decodeGradientIds(value: string, physicalCount: number): number[] | null {
  if (!value) return [];
  const rawTokens = value.includes('/') ? value.split('/').filter(Boolean) : [...value];
  const result: number[] = [];
  for (const raw of rawTokens) {
    if (!/^[0-9]+$/.test(raw)) return null;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1 || id > Math.min(64, physicalCount)) return null;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function normalizeGradientWeights(value: string, expectedCount: number): number[] {
  if (expectedCount === 0) return [];
  const parsed = [...value.matchAll(/[0-9]+/g)].map((match) => Number(match[0]));
  if (parsed.length !== expectedCount || parsed.every((weight) => weight === 0)) return [];
  return [...normalizeColorMatchWeights(parsed, expectedCount)];
}

function normalizeDistributionMode(value: number, gradientCount: number): 0 | 2 {
  if (value === 1) return gradientCount >= 3 ? 0 : 2;
  return value === 0 ? 0 : 2;
}

function normalizeColor(value: string): string {
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}${match[2] ? match[2].toUpperCase() : ''}` : '#808080';
}

function strictInteger(value: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gcd(first: number, second: number): number {
  let left = Math.abs(first);
  let right = Math.abs(second);
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}
