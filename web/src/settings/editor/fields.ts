import { EngineOptionCatalog } from '../generated/loader';
import type { EngineGuiSurface, EngineOptionDefinition } from '../generated/types';
import { codecContractIssue, enumChoicesFor, validateSettingValue } from './codec';
import { isReviewedFullSpectrumProjectOverride } from './fullSpectrumSemantics';
import type {
  SettingsEditorMode,
  SettingsFieldProjection,
  SettingsFieldQuery,
  SettingsFieldSupport,
  SettingsSearchMatch,
  SettingsTechnology,
} from './types';

const MODE_RANK: Readonly<Record<SettingsEditorMode, number>> = {
  simple: 0,
  advanced: 1,
  develop: 2,
};

export function assessFieldSupport(
  catalog: EngineOptionCatalog,
  definition: EngineOptionDefinition,
  guiSurface?: EngineGuiSurface,
): SettingsFieldSupport {
  if (catalog.all(definition.key).length !== 1) {
    return unavailable('ambiguous-key-owners');
  }
  if (catalog.hasCustomGuiWidget(definition.key)) {
    return unavailable('custom-tab-widget');
  }
  if (definition.applicability.technology.value === 'unknown') {
    return unavailable('unknown-technology-applicability');
  }
  if (definition.presentation.readonly.value) return unavailable('readonly');
  if (definition.presentation.guiType.value !== 'undefined') {
    return unavailable(`special-widget:${definition.presentation.guiType.value}`);
  }
  if (definition.enum.valuesExtended.length > 0 || definition.enum.valuesU1.length > 0) {
    return unavailable('conditional-enum-domain');
  }
  const placements = catalog.guiPlacements(definition);
  const reviewedProjectOverride =
    guiSurface === 'process' &&
    (catalog.hasExactProjectConfigWrite(definition.key) || isReviewedFullSpectrumProjectOverride(definition.key));
  if (placements.length === 0 && !reviewedProjectOverride) {
    return unavailable('no-literal-gui-placement');
  }
  if (
    guiSurface !== undefined &&
    !reviewedProjectOverride &&
    !placements.some((placement) => placement.surface === guiSurface)
  ) {
    return unavailable(`gui-surface-unavailable:${guiSurface}`);
  }
  const codecIssue = codecContractIssue(definition);
  if (codecIssue) return unavailable(codecIssue);
  if (definition.default.provided) {
    const issues = validateSettingValue(definition, definition.default.value);
    if (issues.length > 0) return unavailable(`invalid-generated-default:${issues[0].code}`);
  }
  return { status: 'implemented' };
}

export function projectSettingsFields(
  catalog: EngineOptionCatalog,
  query: SettingsFieldQuery,
): SettingsFieldProjection[] {
  const tokens = tokenize(query.search ?? '');
  return catalog.definitions
    .map((definition) => projectField(catalog, definition, query.technology, tokens, query.guiSurface))
    .filter((field) => MODE_RANK[field.mode] <= MODE_RANK[query.mode])
    .filter(
      (field) =>
        field.applicability === 'applicable' ||
        (field.applicability === 'unknown' && query.includeUnknownApplicability) ||
        (field.applicability === 'not-applicable' && query.includeNonApplicable),
    )
    .filter((field) => query.includeUnavailable !== false || field.support.status === 'implemented')
    .filter((field) => tokens.length === 0 || tokens.every((token) => matchesToken(field, token)))
    .sort(compareFields);
}

export function projectSettingsField(
  catalog: EngineOptionCatalog,
  definition: EngineOptionDefinition,
  technology: SettingsTechnology = 'any',
  guiSurface?: EngineGuiSurface,
): SettingsFieldProjection {
  return projectField(catalog, definition, technology, [], guiSurface);
}

function projectField(
  catalog: EngineOptionCatalog,
  definition: EngineOptionDefinition,
  technology: SettingsTechnology,
  tokens: readonly string[],
  guiSurface?: EngineGuiSurface,
): SettingsFieldProjection {
  const label = definition.presentation.label.value ?? definition.key;
  const fullLabel = definition.presentation.fullLabel.value ?? undefined;
  const category = definition.presentation.category.value ?? 'Uncategorized';
  const guiLocations = catalog.guiPlacements(definition).map((placement) => ({
    placement,
    group: catalog.guiGroup(placement.groupId),
    tab: catalog.guiTab(placement.tabId),
  }));
  const primaryGuiLocation =
    (guiSurface === undefined
      ? undefined
      : guiLocations.find((location) => location.placement.surface === guiSurface)) ?? guiLocations[0];
  const field: SettingsFieldProjection = {
    id: definition.id,
    key: definition.key,
    owner: definition.owner,
    definition,
    label,
    ...(fullLabel ? { fullLabel } : {}),
    category,
    guiLocations,
    ...(primaryGuiLocation ? { primaryGuiLocation } : {}),
    ...(definition.presentation.tooltip.value ? { tooltip: definition.presentation.tooltip.value } : {}),
    ...(definition.presentation.unit.value ? { unit: definition.presentation.unit.value } : {}),
    mode: definition.applicability.mode.value,
    technology: definition.applicability.technology.value,
    applicability: technologyApplicability(definition, technology),
    support: assessFieldSupport(catalog, definition, guiSurface),
    enumChoices: enumChoicesFor(definition),
    searchMatches: [],
  };
  return { ...field, searchMatches: collectMatches(field, tokens) };
}

function technologyApplicability(
  definition: EngineOptionDefinition,
  requested: SettingsTechnology,
): SettingsFieldProjection['applicability'] {
  const technology = definition.applicability.technology.value;
  if (technology === 'unknown') return 'unknown';
  if (requested === 'any' || technology === 'any' || requested === technology) return 'applicable';
  return 'not-applicable';
}

function collectMatches(field: SettingsFieldProjection, tokens: readonly string[]): SettingsSearchMatch[] {
  const sources: Array<{
    field: SettingsSearchMatch['field'];
    text: string;
  }> = [
    { field: 'key', text: field.key },
    { field: 'label', text: field.label },
    ...(field.fullLabel ? [{ field: 'fullLabel' as const, text: field.fullLabel }] : []),
    { field: 'category', text: field.category },
    ...(field.primaryGuiLocation
      ? [
          { field: 'page' as const, text: field.primaryGuiLocation.tab.label },
          { field: 'group' as const, text: field.primaryGuiLocation.group.label },
          { field: 'surface' as const, text: field.primaryGuiLocation.placement.surface },
        ]
      : []),
    ...(field.tooltip ? [{ field: 'tooltip' as const, text: field.tooltip }] : []),
    { field: 'owner', text: field.owner },
    ...field.definition.behavior.aliases.value.map((text) => ({ field: 'alias' as const, text })),
    ...field.enumChoices.flatMap((choice) => [
      { field: 'enum' as const, text: choice.serialized },
      { field: 'enum' as const, text: choice.label },
    ]),
  ];
  const matches: SettingsSearchMatch[] = [];
  for (const source of sources) {
    const normalized = normalizeSearch(source.text);
    for (const token of tokens) {
      const start = normalized.indexOf(token);
      if (start >= 0) matches.push({ field: source.field, start, length: token.length, text: source.text });
    }
  }
  return matches;
}

function matchesToken(field: SettingsFieldProjection, token: string): boolean {
  return collectMatches(field, [token]).length > 0;
}

function tokenize(value: string): string[] {
  return Array.from(new Set(normalizeSearch(value).split(/\s+/).filter(Boolean)));
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase('en-US');
}

function compareFields(left: SettingsFieldProjection, right: SettingsFieldProjection): number {
  const leftGui = left.primaryGuiLocation;
  const rightGui = right.primaryGuiLocation;
  if (leftGui && rightGui) {
    const guiOrder =
      leftGui.tab.order - rightGui.tab.order ||
      leftGui.group.order - rightGui.group.order ||
      leftGui.placement.order - rightGui.placement.order;
    if (guiOrder !== 0) return guiOrder;
  } else if (leftGui) return -1;
  else if (rightGui) return 1;
  return (
    left.category.localeCompare(right.category, 'en') ||
    left.label.localeCompare(right.label, 'en') ||
    left.key.localeCompare(right.key, 'en') ||
    left.owner.localeCompare(right.owner, 'en') ||
    left.id.localeCompare(right.id, 'en')
  );
}

function unavailable(reason: string): SettingsFieldSupport {
  return { status: 'unavailable', reason };
}
