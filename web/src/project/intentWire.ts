/**
 * Canonical domain values in the shared intent contract's encoding — the
 * inverse of the decoders `PreparedProjectCommands` applies, so a browser route
 * can submit exactly the command its synchronous predecessor executed. Text is
 * UTF-16 units through one bounded encoder per intent.
 */
import type {
  ProjectFullSpectrumInputWire,
  ProjectMixedComponentInputWire,
  ProjectMixedDistributionInputWire,
  ProjectMixedFilamentInputWire,
} from '../../../contracts/generated/project-intents';
import { canonicalStringify } from './domain/canonical';
import type { FullSpectrumRecipeState, MixedComponent, MixedDistribution, MixedFilament } from './domain/model';

export type IntentText = (value: string) => number[];

const optionalNumber = (value: number | undefined) => (value === undefined ? { absent: {} } : { value });
const UI_MODES = { [-1]: 'legacy', 0: 'ui0', 1: 'ui1', 2: 'ui2', 3: 'ui3' } as const;
const DISTRIBUTION_MODES = { 0: 'm0', 2: 'm2' } as const;

export function mixedComponentWire(component: MixedComponent, text: IntentText): ProjectMixedComponentInputWire {
  return { filamentId: text(component.filamentId), weight: component.weight };
}

export function mixedDistributionWire(
  distribution: MixedDistribution,
  text: IntentText,
): ProjectMixedDistributionInputWire {
  switch (distribution.mode) {
    case 'ratio':
      return { ratio: {} };
    case 'cycle':
      return { cycle: { cycleLengthMm: optionalNumber(distribution.cycleLengthMm) } };
    case 'match':
      return { match: { targetColor: text(distribution.targetColor) } };
    case 'gradient':
      return {
        gradient: {
          startZMm: optionalNumber(distribution.startZMm),
          endZMm: optionalNumber(distribution.endZMm),
          startWeights: [...distribution.startWeights],
          endWeights: [...distribution.endWeights],
        },
      };
  }
}

export function fullSpectrumWire(recipe: FullSpectrumRecipeState, text: IntentText): ProjectFullSpectrumInputWire {
  return {
    upstreamStableId: text(recipe.upstreamStableId),
    uiMode: UI_MODES[recipe.uiMode],
    componentAId: text(recipe.componentAId),
    componentBId: text(recipe.componentBId),
    ratioA: recipe.ratioA,
    ratioB: recipe.ratioB,
    mixBPercent: recipe.mixBPercent,
    manualPatternGroups: recipe.manualPatternGroups.map((group) => group.map(text)),
    gradientComponentIds: recipe.gradientComponentIds.map(text),
    gradientComponentWeights: [...recipe.gradientComponentWeights],
    distributionMode: DISTRIBUTION_MODES[recipe.distributionMode],
    localZMaxSublayers: recipe.localZMaxSublayers,
    gradientEnabled: recipe.gradientEnabled,
    gradientStart: recipe.gradientStart,
    gradientEnd: recipe.gradientEnd,
    componentASurfaceOffsetMm: recipe.componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm: recipe.componentBSurfaceOffsetMm,
    deleted: recipe.deleted,
    custom: recipe.custom,
    originAuto: recipe.originAuto,
  };
}

export function mixedFilamentWire(filament: MixedFilament, text: IntentText): ProjectMixedFilamentInputWire {
  return {
    mixedFilamentId: text(filament.id),
    name: text(filament.name),
    displayColor: text(filament.displayColor),
    components: filament.components.map((component) => mixedComponentWire(component, text)),
    distribution: mixedDistributionWire(filament.distribution, text),
    fullSpectrum: filament.fullSpectrum ? { value: fullSpectrumWire(filament.fullSpectrum, text) } : { absent: {} },
    configJson: text(canonicalStringify(filament.config)),
    enabled: filament.enabled,
    extensionDataJson: filament.extensionData
      ? { value: text(canonicalStringify(filament.extensionData)) }
      : { absent: {} },
  };
}
