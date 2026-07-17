import { EngineOptionCatalog } from '../generated/loader';
import type { EngineOptionDefinition } from '../generated/types';
import { codecContractIssue, enumChoicesFor, validateSettingValue } from './codec';
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
): SettingsFieldSupport {
  if (catalog.all(definition.key).length !== 1) {
    return unavailable('ambiguous-key-owners');
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
    .map((definition) => projectField(catalog, definition, query.technology, tokens))
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
): SettingsFieldProjection {
  return projectField(catalog, definition, technology, []);
}

function projectField(
  catalog: EngineOptionCatalog,
  definition: EngineOptionDefinition,
  technology: SettingsTechnology,
  tokens: readonly string[],
): SettingsFieldProjection {
  const label = definition.presentation.label.value ?? definition.key;
  const fullLabel = definition.presentation.fullLabel.value ?? undefined;
  const category = definition.presentation.category.value ?? 'Uncategorized';
  const field: SettingsFieldProjection = {
    id: definition.id,
    key: definition.key,
    owner: definition.owner,
    definition,
    label,
    ...(fullLabel ? { fullLabel } : {}),
    category,
    ...(definition.presentation.tooltip.value ? { tooltip: definition.presentation.tooltip.value } : {}),
    ...(definition.presentation.unit.value ? { unit: definition.presentation.unit.value } : {}),
    mode: definition.applicability.mode.value,
    technology: definition.applicability.technology.value,
    applicability: technologyApplicability(definition, technology),
    support: assessFieldSupport(catalog, definition),
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
