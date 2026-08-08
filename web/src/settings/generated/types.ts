export const ENGINE_OPTION_SCHEMA_VERSION = 2 as const;
export const ENGINE_OPTION_SOURCE_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626' as const;
export const ENGINE_OPTION_SOURCE_TREE = '612a77a60f923a2b117de7fd695512e5451a179f' as const;
export const ENGINE_OPTION_PRINT_CONFIG_BLOB = 'c0a2676191497a3f22733801939c4879c92f4dd3' as const;
export const ENGINE_OPTION_CONFIG_HEADER_BLOB = 'cc2d6868e2b2a4f78b63833d6f428ce0077073a5' as const;
export const ENGINE_OPTION_TAB_SOURCE_BLOB = '32588f85e0f36f8bf931a24654c200748b995d85' as const;

export type EngineGuiSurface = 'process' | 'filament' | 'printer' | 'object' | 'plate';

export interface EngineGuiSourceProvenance {
  anchor: string;
  blob: typeof ENGINE_OPTION_TAB_SOURCE_BLOB;
  commit: typeof ENGINE_OPTION_SOURCE_COMMIT;
  line: number;
  path: 'src/slic3r/GUI/Tab.cpp';
  symbol: string;
  tree: typeof ENGINE_OPTION_SOURCE_TREE;
}

export interface EngineGuiTab {
  id: string;
  label: string;
  occurrence: number;
  order: number;
  resolution: 'literal' | 'runtime';
  source: EngineGuiSourceProvenance;
  surface: EngineGuiSurface;
  symbol: string;
}

export interface EngineGuiGroup extends EngineGuiTab {
  tabId: string;
}

export interface EngineGuiPlacement {
  definitionBinding: {
    definitionIds: readonly string[];
    status: 'exact' | 'ambiguous';
  };
  groupId: string;
  id: string;
  occurrence: number;
  optionKey: string;
  order: number;
  source: EngineGuiSourceProvenance;
  surface: EngineGuiSurface;
  symbol: string;
  tabId: string;
}

export interface EngineGuiUnresolvedCall {
  expression: string;
  kind: 'dynamic-option-key' | 'custom-widget';
  source: EngineGuiSourceProvenance;
  status: 'unresolved-fail-closed';
}

export interface EngineGuiLayout {
  coverage: {
    ambiguousDefinitionKeys: readonly string[];
    definitionsWithoutLiteralPlacement: number;
    dynamicPlacements: number;
    exactDefinitionBindings: number;
    groups: number;
    literalPlacements: number;
    projectConfigWrites: number;
    specialWidgets: number;
    tabs: number;
    uniqueLiteralPlacementKeys: number;
  };
  groups: readonly EngineGuiGroup[];
  placements: readonly EngineGuiPlacement[];
  semanticDispositions: {
    dependencies: { reason: string; status: 'unresolved-unenforced' };
    resetRules: { reason: string; status: 'unresolved-unenforced' };
    scopes: { reason: string; status: 'unresolved-fail-closed' };
  };
  scopeEvidence: {
    projectConfigWrites: readonly {
      optionKey: string;
      source: EngineGuiSourceProvenance;
      status: 'exact-project-config-write';
    }[];
  };
  source: {
    blob: typeof ENGINE_OPTION_TAB_SOURCE_BLOB;
    commit: typeof ENGINE_OPTION_SOURCE_COMMIT;
    path: 'src/slic3r/GUI/Tab.cpp';
    tree: typeof ENGINE_OPTION_SOURCE_TREE;
  };
  status: 'manifest-literal-partial';
  tabs: readonly EngineGuiTab[];
  unresolved: {
    dynamicPlacements: readonly EngineGuiUnresolvedCall[];
    specialWidgets: readonly (EngineGuiUnresolvedCall & { optionKey: string })[];
  };
}

export type EngineOptionType =
  | 'coNone'
  | 'coFloat'
  | 'coFloats'
  | 'coInt'
  | 'coInts'
  | 'coString'
  | 'coStrings'
  | 'coPercent'
  | 'coPercents'
  | 'coFloatOrPercent'
  | 'coFloatsOrPercents'
  | 'coPoint'
  | 'coPoints'
  | 'coPoint3'
  | 'coBool'
  | 'coBools'
  | 'coEnum'
  | 'coEnums';

export type EngineOptionValueType =
  'none' | 'float' | 'int' | 'string' | 'float-or-percent' | 'point2' | 'point3' | 'bool' | 'enum';

export type EngineOptionValue =
  null | boolean | number | string | { percent: boolean; value: number } | readonly EngineOptionValue[];

export interface ResolvedExpressionValue<T> {
  expression?: string;
  inference?: string;
  resolved: true;
  value: T;
}

export interface ResolvedSourceValue<T> extends ResolvedExpressionValue<T> {
  provided: boolean;
}

export interface MissingEngineDefault {
  provided: false;
  resolved: false;
}

export interface ResolvedEngineDefault extends ResolvedSourceValue<EngineOptionValue> {
  className?: string | null;
  expression: string;
  kind: 'scalar' | 'vector' | 'point' | 'float-or-percent' | 'enum' | 'enum-vector' | 'cpp-expression';
  provided: true;
  symbols?: readonly string[];
}

export type EngineOptionDefault = MissingEngineDefault | ResolvedEngineDefault;

export interface EngineOptionStorage {
  nullable: boolean;
  optionType: EngineOptionType;
  percentSemantics: 'none' | 'percent' | 'float-or-percent';
  serialization: {
    collectionDelimiter: ',' | ';' | null;
    componentDelimiter: ',' | 'x' | null;
    nilToken: 'nil' | null;
    percentSuffix: '%' | null;
  };
  shape: 'scalar' | 'vector';
  valueType: EngineOptionValueType;
}

export interface EngineOptionEnumEntry {
  serialized: string;
  valueExpression: string;
}

export interface EngineOptionEnumMap {
  entries: readonly EngineOptionEnumEntry[];
  line: number;
  name: string;
}

export interface EngineOptionEnumMetadata {
  keyMapExpression: ResolvedSourceValue<string | null>;
  labels: readonly ResolvedExpressionValue<string>[];
  labelsExtended: readonly ResolvedExpressionValue<string>[];
  labelsU1: readonly ResolvedExpressionValue<string>[];
  storageMap: EngineOptionEnumMap | null;
  values: readonly ResolvedExpressionValue<string>[];
  valuesExtended: readonly ResolvedExpressionValue<string>[];
  valuesU1: readonly ResolvedExpressionValue<string>[];
}

export interface EngineOptionProvenance {
  anchor: string;
  blob: typeof ENGINE_OPTION_PRINT_CONFIG_BLOB;
  commit: typeof ENGINE_OPTION_SOURCE_COMMIT;
  derivedFrom?: unknown;
  line: number;
  path: 'src/libslic3r/PrintConfig.cpp';
  repository: string;
  symbol: string;
  tree: typeof ENGINE_OPTION_SOURCE_TREE;
}

export interface EngineOptionDefinition {
  applicability: {
    mode: ResolvedSourceValue<'simple' | 'advanced' | 'develop'>;
    technology: ResolvedSourceValue<'unknown' | 'any' | 'fff' | 'sla'>;
  };
  behavior: {
    aliases: ResolvedSourceValue<readonly string[]>;
    cli: ResolvedSourceValue<string | null>;
    cliParams: ResolvedSourceValue<string | null>;
    ratioOver: ResolvedSourceValue<string | null>;
  };
  constraints: {
    max: ResolvedSourceValue<number | null>;
    maxLiteral: ResolvedSourceValue<number>;
    min: ResolvedSourceValue<number | null>;
  };
  default: EngineOptionDefault;
  enum: EngineOptionEnumMetadata;
  id: string;
  key: string;
  owner: string;
  presentation: {
    category: ResolvedSourceValue<string | null>;
    fullLabel: ResolvedSourceValue<string | null>;
    fullWidth: ResolvedSourceValue<boolean>;
    guiFlags: ResolvedSourceValue<string>;
    guiType: ResolvedSourceValue<string>;
    height: ResolvedSourceValue<number | null>;
    label: ResolvedSourceValue<string | null>;
    multiline: ResolvedSourceValue<boolean>;
    readonly: ResolvedSourceValue<boolean>;
    tooltip: ResolvedSourceValue<string | null>;
    unit: ResolvedSourceValue<string | null>;
    width: ResolvedSourceValue<number | null>;
  };
  provenance: EngineOptionProvenance;
  registrationKind: 'literal' | 'macro' | 'derived-axis' | 'derived-nullable';
  sourceAssignments: readonly {
    expression: string;
    field: string;
    line: number;
    operation: string;
    sourceVariable?: string;
  }[];
  storage: EngineOptionStorage;
}

export interface EngineOptionSchema {
  coverage: {
    definitions: number;
    definitionsWithoutExplicitDefault: readonly { id: string; key: string; owner: string }[];
    derivedAxisDefinitions: number;
    derivedNullableDefinitions: number;
    duplicateKeys: readonly { count: number; key: string; owners: readonly string[] }[];
    enumWithoutStorageMap: number;
    missingDefaults: number;
    printConfigDefinitions: number;
    uniqueKeys: number;
    unresolvedDefaults: number;
    unresolvedSourceValueFamilies: Readonly<Record<string, number>>;
    unresolvedSourceValues: number;
  };
  definitions: readonly EngineOptionDefinition[];
  guiLayout: EngineGuiLayout;
  limitations: readonly string[];
  parser: { name: string; version: string };
  schemaVersion: typeof ENGINE_OPTION_SCHEMA_VERSION;
  source: {
    commit: typeof ENGINE_OPTION_SOURCE_COMMIT;
    files: readonly ({ blob: string; path: string } | { path: string; sha256: string })[];
    repository: string;
    tree: typeof ENGINE_OPTION_SOURCE_TREE;
  };
  status: 'foundation-partial';
}
