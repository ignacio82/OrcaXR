import type {
  EngineGuiGroup,
  EngineGuiPlacement,
  EngineGuiSurface,
  EngineGuiTab,
  EngineOptionDefinition,
  EngineOptionValue,
} from '../generated/types';

export type SettingsEditorMode = 'simple' | 'advanced' | 'develop';
export type SettingsTechnology = 'fff' | 'sla' | 'any';

export type SettingsValueMap = Readonly<Record<string, EngineOptionValue>>;

export interface SettingsValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface SettingsEnumChoice {
  serialized: string;
  label: string;
}

export interface SettingsFieldSupport {
  status: 'implemented' | 'unavailable';
  reason?: string;
}

export interface SettingsSearchMatch {
  field:
    'key' | 'label' | 'fullLabel' | 'category' | 'page' | 'group' | 'surface' | 'tooltip' | 'owner' | 'alias' | 'enum';
  start: number;
  length: number;
  text: string;
}

export interface SettingsGuiLocation {
  group: EngineGuiGroup;
  placement: EngineGuiPlacement;
  tab: EngineGuiTab;
}

export interface SettingsFieldProjection {
  id: string;
  key: string;
  owner: string;
  definition: EngineOptionDefinition;
  label: string;
  fullLabel?: string;
  category: string;
  guiLocations: readonly SettingsGuiLocation[];
  primaryGuiLocation?: SettingsGuiLocation;
  tooltip?: string;
  unit?: string;
  mode: SettingsEditorMode;
  technology: 'unknown' | 'any' | 'fff' | 'sla';
  applicability: 'applicable' | 'not-applicable' | 'unknown';
  support: SettingsFieldSupport;
  enumChoices: readonly SettingsEnumChoice[];
  searchMatches: readonly SettingsSearchMatch[];
}

export interface SettingsFieldQuery {
  mode: SettingsEditorMode;
  technology: SettingsTechnology;
  guiSurface?: EngineGuiSurface;
  search?: string;
  includeNonApplicable?: boolean;
  includeUnknownApplicability?: boolean;
  includeUnavailable?: boolean;
}

export type SettingsValueOrigin = 'changed' | 'inherited' | 'default' | 'unset';

export interface SettingsFieldState {
  field: SettingsFieldProjection;
  value?: EngineOptionValue;
  serializedValue?: string;
  origin: SettingsValueOrigin;
  hasLocalOverride: boolean;
  changed: boolean;
  draftChanged: boolean;
  draftRaw?: string;
  draftValue?: EngineOptionValue;
  draftSerialized?: string;
  issues: readonly SettingsValidationIssue[];
}

export interface SettingsFieldComparison {
  fieldId: string;
  key: string;
  defaultValue?: EngineOptionValue;
  inheritedValue?: EngineOptionValue;
  overrideValue?: EngineOptionValue;
  effectiveValue?: EngineOptionValue;
  draftValue?: EngineOptionValue;
  effectiveEqualsDefault: boolean;
  draftEqualsEffective: boolean;
}

export interface SettingsDraftChange {
  fieldId: string;
  key: string;
  owner: string;
  action: 'set' | 'remove';
  previousValue?: EngineOptionValue;
  value?: EngineOptionValue;
  serialized?: string;
}

export interface SettingsDraftCommit {
  baseRevision: number;
  revision: number;
  changes: readonly SettingsDraftChange[];
  nextOverrides: SettingsValueMap;
}

export interface SettingsDraftEditorOptions {
  mode?: SettingsEditorMode;
  technology?: SettingsTechnology;
  guiSurface?: EngineGuiSurface;
  inherited?: SettingsValueMap;
  overrides?: SettingsValueMap;
}

export class SettingsDraftCommitError extends Error {
  constructor(readonly issues: readonly SettingsValidationIssue[]) {
    super(`Settings draft contains ${issues.length} validation issue${issues.length === 1 ? '' : 's'}`);
    this.name = 'SettingsDraftCommitError';
  }
}
