import {
  ENGINE_OPTION_CONFIG_HEADER_BLOB,
  ENGINE_OPTION_PRINT_CONFIG_BLOB,
  ENGINE_OPTION_SCHEMA_VERSION,
  ENGINE_OPTION_SOURCE_COMMIT,
  ENGINE_OPTION_SOURCE_TREE,
  type EngineOptionDefinition,
  type EngineOptionSchema,
  type EngineOptionType,
} from './types';

const SOURCE_REPOSITORY = 'https://github.com/Snapmaker/OrcaSlicer.git';
const PARSER_VERSION = '0.1.0';

type JsonRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`Invalid engine-option schema at ${path}: ${message}`);
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value as JsonRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function literal<T extends string | number | boolean | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
  return expected;
}

function keys(value: JsonRecord, allowed: readonly string[], required: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'missing field');
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : number(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
}

function resolvedSourceValue(
  value: unknown,
  path: string,
  validateValue: (candidate: unknown, valuePath: string) => unknown,
): void {
  const sourceValue = record(value, path);
  keys(
    sourceValue,
    ['expression', 'inference', 'provided', 'resolved', 'value'],
    ['provided', 'resolved', 'value'],
    path,
  );
  boolean(sourceValue.provided, `${path}.provided`);
  literal(sourceValue.resolved, true, `${path}.resolved`);
  if (sourceValue.expression !== undefined) string(sourceValue.expression, `${path}.expression`);
  if (sourceValue.inference !== undefined) string(sourceValue.inference, `${path}.inference`);
  validateValue(sourceValue.value, `${path}.value`);
}

function resolvedExpressionValue(value: unknown, path: string): void {
  const expressionValue = record(value, path);
  keys(expressionValue, ['expression', 'inference', 'resolved', 'value'], ['expression', 'resolved', 'value'], path);
  string(expressionValue.expression, `${path}.expression`);
  if (expressionValue.inference !== undefined) string(expressionValue.inference, `${path}.inference`);
  literal(expressionValue.resolved, true, `${path}.resolved`);
  string(expressionValue.value, `${path}.value`);
}

const STORAGE_SPECS: Record<
  EngineOptionType,
  {
    collection: ',' | ';' | null;
    component: ',' | 'x' | null;
    percent: 'none' | 'percent' | 'float-or-percent';
    shape: 'scalar' | 'vector';
    valueType: string;
  }
> = {
  coNone: { collection: null, component: null, percent: 'none', shape: 'scalar', valueType: 'none' },
  coFloat: { collection: null, component: null, percent: 'none', shape: 'scalar', valueType: 'float' },
  coFloats: { collection: ',', component: null, percent: 'none', shape: 'vector', valueType: 'float' },
  coInt: { collection: null, component: null, percent: 'none', shape: 'scalar', valueType: 'int' },
  coInts: { collection: ',', component: null, percent: 'none', shape: 'vector', valueType: 'int' },
  coString: { collection: null, component: null, percent: 'none', shape: 'scalar', valueType: 'string' },
  coStrings: { collection: ';', component: null, percent: 'none', shape: 'vector', valueType: 'string' },
  coPercent: { collection: null, component: null, percent: 'percent', shape: 'scalar', valueType: 'float' },
  coPercents: { collection: ',', component: null, percent: 'percent', shape: 'vector', valueType: 'float' },
  coFloatOrPercent: {
    collection: null,
    component: null,
    percent: 'float-or-percent',
    shape: 'scalar',
    valueType: 'float-or-percent',
  },
  coFloatsOrPercents: {
    collection: ',',
    component: null,
    percent: 'float-or-percent',
    shape: 'vector',
    valueType: 'float-or-percent',
  },
  coPoint: { collection: null, component: ',', percent: 'none', shape: 'scalar', valueType: 'point2' },
  coPoints: { collection: ',', component: 'x', percent: 'none', shape: 'vector', valueType: 'point2' },
  coPoint3: { collection: null, component: ',', percent: 'none', shape: 'scalar', valueType: 'point3' },
  coBool: { collection: null, component: null, percent: 'none', shape: 'scalar', valueType: 'bool' },
  coBools: { collection: ',', component: null, percent: 'none', shape: 'vector', valueType: 'bool' },
  coEnum: { collection: null, component: null, percent: 'none', shape: 'scalar', valueType: 'enum' },
  coEnums: { collection: ',', component: null, percent: 'none', shape: 'vector', valueType: 'enum' },
};

function validateStorage(value: unknown, path: string): void {
  const storage = record(value, path);
  keys(
    storage,
    ['nullable', 'optionType', 'percentSemantics', 'serialization', 'shape', 'valueType'],
    ['nullable', 'optionType', 'percentSemantics', 'serialization', 'shape', 'valueType'],
    path,
  );
  const optionType = string(storage.optionType, `${path}.optionType`) as EngineOptionType;
  const spec = STORAGE_SPECS[optionType];
  if (!spec) fail(`${path}.optionType`, `unsupported option type ${optionType}`);
  literal(storage.shape, spec.shape, `${path}.shape`);
  literal(storage.valueType, spec.valueType, `${path}.valueType`);
  literal(storage.percentSemantics, spec.percent, `${path}.percentSemantics`);
  const nullable = boolean(storage.nullable, `${path}.nullable`);
  const serialization = record(storage.serialization, `${path}.serialization`);
  keys(
    serialization,
    ['collectionDelimiter', 'componentDelimiter', 'nilToken', 'percentSuffix'],
    ['collectionDelimiter', 'componentDelimiter', 'nilToken', 'percentSuffix'],
    `${path}.serialization`,
  );
  literal(serialization.collectionDelimiter, spec.collection, `${path}.serialization.collectionDelimiter`);
  literal(serialization.componentDelimiter, spec.component, `${path}.serialization.componentDelimiter`);
  literal(serialization.nilToken, nullable ? 'nil' : null, `${path}.serialization.nilToken`);
  literal(serialization.percentSuffix, spec.percent === 'none' ? null : '%', `${path}.serialization.percentSuffix`);
}

function validateDefault(value: unknown, path: string): void {
  const engineDefault = record(value, path);
  if (engineDefault.provided === false) {
    keys(engineDefault, ['provided', 'resolved'], ['provided', 'resolved'], path);
    literal(engineDefault.resolved, false, `${path}.resolved`);
    return;
  }
  keys(
    engineDefault,
    ['className', 'expression', 'inference', 'kind', 'provided', 'resolved', 'symbol', 'symbols', 'value'],
    ['className', 'expression', 'kind', 'provided', 'resolved', 'value'],
    path,
  );
  literal(engineDefault.provided, true, `${path}.provided`);
  literal(engineDefault.resolved, true, `${path}.resolved`);
  if (engineDefault.className !== null) string(engineDefault.className, `${path}.className`);
  string(engineDefault.expression, `${path}.expression`);
  const kind = string(engineDefault.kind, `${path}.kind`);
  if (!['scalar', 'vector', 'point', 'float-or-percent', 'enum', 'enum-vector', 'cpp-expression'].includes(kind)) {
    fail(`${path}.kind`, `unsupported default kind ${kind}`);
  }
  if (engineDefault.inference !== undefined) string(engineDefault.inference, `${path}.inference`);
  if (engineDefault.symbol !== undefined) string(engineDefault.symbol, `${path}.symbol`);
  if (engineDefault.symbols !== undefined) stringArray(engineDefault.symbols, `${path}.symbols`);
  validateEngineValue(engineDefault.value, `${path}.value`);
}

function validateEngineValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    number(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEngineValue(entry, `${path}[${index}]`));
    return;
  }
  const floatOrPercent = record(value, path);
  keys(floatOrPercent, ['percent', 'value'], ['percent', 'value'], path);
  boolean(floatOrPercent.percent, `${path}.percent`);
  number(floatOrPercent.value, `${path}.value`);
}

function validateEnum(value: unknown, path: string): void {
  const metadata = record(value, path);
  keys(
    metadata,
    ['keyMapExpression', 'labels', 'labelsExtended', 'labelsU1', 'storageMap', 'values', 'valuesExtended', 'valuesU1'],
    ['keyMapExpression', 'labels', 'labelsExtended', 'labelsU1', 'storageMap', 'values', 'valuesExtended', 'valuesU1'],
    path,
  );
  resolvedSourceValue(metadata.keyMapExpression, `${path}.keyMapExpression`, nullableString);
  for (const field of ['labels', 'labelsExtended', 'labelsU1', 'values', 'valuesExtended', 'valuesU1'] as const) {
    array(metadata[field], `${path}.${field}`).forEach((entry, index) =>
      resolvedExpressionValue(entry, `${path}.${field}[${index}]`),
    );
  }
  if (metadata.storageMap === null) return;
  const storageMap = record(metadata.storageMap, `${path}.storageMap`);
  keys(storageMap, ['entries', 'line', 'name'], ['entries', 'line', 'name'], `${path}.storageMap`);
  string(storageMap.name, `${path}.storageMap.name`);
  number(storageMap.line, `${path}.storageMap.line`);
  array(storageMap.entries, `${path}.storageMap.entries`).forEach((entry, index) => {
    const enumEntry = record(entry, `${path}.storageMap.entries[${index}]`);
    keys(
      enumEntry,
      ['serialized', 'valueExpression'],
      ['serialized', 'valueExpression'],
      `${path}.storageMap.entries[${index}]`,
    );
    string(enumEntry.serialized, `${path}.storageMap.entries[${index}].serialized`);
    string(enumEntry.valueExpression, `${path}.storageMap.entries[${index}].valueExpression`);
  });
}

function validateDefinition(value: unknown, index: number): void {
  const path = `$.definitions[${index}]`;
  const definition = record(value, path);
  keys(
    definition,
    [
      'applicability',
      'behavior',
      'constraints',
      'default',
      'enum',
      'id',
      'key',
      'owner',
      'presentation',
      'provenance',
      'registrationKind',
      'sourceAssignments',
      'storage',
    ],
    [
      'applicability',
      'behavior',
      'constraints',
      'default',
      'enum',
      'id',
      'key',
      'owner',
      'presentation',
      'provenance',
      'registrationKind',
      'sourceAssignments',
      'storage',
    ],
    path,
  );
  string(definition.id, `${path}.id`);
  string(definition.key, `${path}.key`);
  string(definition.owner, `${path}.owner`);
  const registrationKind = string(definition.registrationKind, `${path}.registrationKind`);
  if (!['literal', 'macro', 'derived-axis', 'derived-nullable'].includes(registrationKind)) {
    fail(`${path}.registrationKind`, `unsupported registration kind ${registrationKind}`);
  }
  validateStorage(definition.storage, `${path}.storage`);

  const constraints = record(definition.constraints, `${path}.constraints`);
  keys(constraints, ['max', 'maxLiteral', 'min'], ['max', 'maxLiteral', 'min'], `${path}.constraints`);
  resolvedSourceValue(constraints.min, `${path}.constraints.min`, nullableNumber);
  resolvedSourceValue(constraints.max, `${path}.constraints.max`, nullableNumber);
  resolvedSourceValue(constraints.maxLiteral, `${path}.constraints.maxLiteral`, number);

  const presentation = record(definition.presentation, `${path}.presentation`);
  const presentationFields = [
    'category',
    'fullLabel',
    'fullWidth',
    'guiFlags',
    'guiType',
    'height',
    'label',
    'multiline',
    'readonly',
    'tooltip',
    'unit',
    'width',
  ] as const;
  keys(presentation, presentationFields, presentationFields, `${path}.presentation`);
  for (const field of ['category', 'fullLabel', 'label', 'tooltip', 'unit'] as const) {
    resolvedSourceValue(presentation[field], `${path}.presentation.${field}`, nullableString);
  }
  for (const field of ['fullWidth', 'multiline', 'readonly'] as const) {
    resolvedSourceValue(presentation[field], `${path}.presentation.${field}`, boolean);
  }
  for (const field of ['height', 'width'] as const) {
    resolvedSourceValue(presentation[field], `${path}.presentation.${field}`, nullableNumber);
  }
  for (const field of ['guiFlags', 'guiType'] as const) {
    resolvedSourceValue(presentation[field], `${path}.presentation.${field}`, string);
  }

  const applicability = record(definition.applicability, `${path}.applicability`);
  keys(applicability, ['mode', 'technology'], ['mode', 'technology'], `${path}.applicability`);
  resolvedSourceValue(applicability.mode, `${path}.applicability.mode`, (candidate, valuePath) => {
    const value = string(candidate, valuePath);
    if (!['simple', 'advanced', 'develop'].includes(value)) fail(valuePath, `unsupported mode ${value}`);
  });
  resolvedSourceValue(applicability.technology, `${path}.applicability.technology`, (candidate, valuePath) => {
    const value = string(candidate, valuePath);
    if (!['unknown', 'any', 'fff', 'sla'].includes(value)) fail(valuePath, `unsupported technology ${value}`);
  });

  const behavior = record(definition.behavior, `${path}.behavior`);
  keys(
    behavior,
    ['aliases', 'cli', 'cliParams', 'ratioOver'],
    ['aliases', 'cli', 'cliParams', 'ratioOver'],
    `${path}.behavior`,
  );
  resolvedSourceValue(behavior.aliases, `${path}.behavior.aliases`, stringArray);
  for (const field of ['cli', 'cliParams', 'ratioOver'] as const) {
    resolvedSourceValue(behavior[field], `${path}.behavior.${field}`, nullableString);
  }

  validateEnum(definition.enum, `${path}.enum`);
  validateDefault(definition.default, `${path}.default`);

  const provenance = record(definition.provenance, `${path}.provenance`);
  keys(
    provenance,
    ['anchor', 'blob', 'commit', 'derivedFrom', 'line', 'path', 'repository', 'symbol', 'tree'],
    ['anchor', 'blob', 'commit', 'line', 'path', 'repository', 'symbol', 'tree'],
    `${path}.provenance`,
  );
  string(provenance.anchor, `${path}.provenance.anchor`);
  literal(provenance.blob, ENGINE_OPTION_PRINT_CONFIG_BLOB, `${path}.provenance.blob`);
  literal(provenance.commit, ENGINE_OPTION_SOURCE_COMMIT, `${path}.provenance.commit`);
  number(provenance.line, `${path}.provenance.line`);
  literal(provenance.path, 'src/libslic3r/PrintConfig.cpp', `${path}.provenance.path`);
  literal(provenance.repository, SOURCE_REPOSITORY, `${path}.provenance.repository`);
  string(provenance.symbol, `${path}.provenance.symbol`);
  literal(provenance.tree, ENGINE_OPTION_SOURCE_TREE, `${path}.provenance.tree`);

  array(definition.sourceAssignments, `${path}.sourceAssignments`).forEach((entry, assignmentIndex) => {
    const assignmentPath = `${path}.sourceAssignments[${assignmentIndex}]`;
    const assignment = record(entry, assignmentPath);
    keys(
      assignment,
      ['expression', 'field', 'line', 'operation', 'sourceVariable'],
      ['expression', 'field', 'line', 'operation'],
      assignmentPath,
    );
    string(assignment.expression, `${assignmentPath}.expression`);
    string(assignment.field, `${assignmentPath}.field`);
    number(assignment.line, `${assignmentPath}.line`);
    string(assignment.operation, `${assignmentPath}.operation`);
    if (assignment.sourceVariable !== undefined) string(assignment.sourceVariable, `${assignmentPath}.sourceVariable`);
  });
}

function validateSource(value: unknown): void {
  const source = record(value, '$.source');
  keys(source, ['commit', 'files', 'repository', 'tree'], ['commit', 'files', 'repository', 'tree'], '$.source');
  literal(source.commit, ENGINE_OPTION_SOURCE_COMMIT, '$.source.commit');
  literal(source.repository, SOURCE_REPOSITORY, '$.source.repository');
  literal(source.tree, ENGINE_OPTION_SOURCE_TREE, '$.source.tree');
  const files = array(source.files, '$.source.files');
  if (files.length !== 3) fail('$.source.files', 'expected exactly three provenance records');
  const byPath = new Map<string, JsonRecord>();
  files.forEach((entry, index) => {
    const file = record(entry, `$.source.files[${index}]`);
    string(file.path, `$.source.files[${index}].path`);
    if (byPath.has(file.path as string)) fail(`$.source.files[${index}].path`, 'duplicate path');
    byPath.set(file.path as string, file);
  });
  const printConfig = byPath.get('src/libslic3r/PrintConfig.cpp') ?? fail('$.source.files', 'missing PrintConfig.cpp');
  keys(printConfig, ['blob', 'path'], ['blob', 'path'], '$.source.files.PrintConfig.cpp');
  literal(printConfig.blob, ENGINE_OPTION_PRINT_CONFIG_BLOB, '$.source.files.PrintConfig.cpp.blob');
  const configHeader = byPath.get('src/libslic3r/Config.hpp') ?? fail('$.source.files', 'missing Config.hpp');
  keys(configHeader, ['blob', 'path'], ['blob', 'path'], '$.source.files.Config.hpp');
  literal(configHeader.blob, ENGINE_OPTION_CONFIG_HEADER_BLOB, '$.source.files.Config.hpp.blob');
  const manifest = byPath.get('docs/parity/snapmaker-v2.3.4.json') ?? fail('$.source.files', 'missing parity manifest');
  keys(manifest, ['path', 'sha256'], ['path', 'sha256'], '$.source.files.manifest');
  if (!/^[0-9a-f]{64}$/.test(string(manifest.sha256, '$.source.files.manifest.sha256'))) {
    fail('$.source.files.manifest.sha256', 'expected a SHA-256 digest');
  }
}

function validateCoverage(value: unknown, definitions: readonly EngineOptionDefinition[]): void {
  const coverage = record(value, '$.coverage');
  const coverageFields = [
    'definitions',
    'definitionsWithoutExplicitDefault',
    'derivedAxisDefinitions',
    'derivedNullableDefinitions',
    'duplicateKeys',
    'enumWithoutStorageMap',
    'missingDefaults',
    'printConfigDefinitions',
    'uniqueKeys',
    'unresolvedDefaults',
    'unresolvedSourceValueFamilies',
    'unresolvedSourceValues',
  ] as const;
  keys(coverage, coverageFields, coverageFields, '$.coverage');
  literal(coverage.definitions, definitions.length, '$.coverage.definitions');
  literal(coverage.uniqueKeys, new Set(definitions.map((definition) => definition.key)).size, '$.coverage.uniqueKeys');
  literal(
    coverage.derivedAxisDefinitions,
    definitions.filter((definition) => definition.registrationKind === 'derived-axis').length,
    '$.coverage.derivedAxisDefinitions',
  );
  literal(
    coverage.derivedNullableDefinitions,
    definitions.filter((definition) => definition.registrationKind === 'derived-nullable').length,
    '$.coverage.derivedNullableDefinitions',
  );
  literal(
    coverage.printConfigDefinitions,
    definitions.filter((definition) => definition.owner.startsWith('PrintConfigDef::')).length,
    '$.coverage.printConfigDefinitions',
  );
  const missing = definitions.filter((definition) => !definition.default.provided);
  literal(coverage.missingDefaults, missing.length, '$.coverage.missingDefaults');
  literal(coverage.unresolvedDefaults, 0, '$.coverage.unresolvedDefaults');
  literal(coverage.unresolvedSourceValues, 0, '$.coverage.unresolvedSourceValues');
  const unresolvedFamilies = record(coverage.unresolvedSourceValueFamilies, '$.coverage.unresolvedSourceValueFamilies');
  if (Object.keys(unresolvedFamilies).length !== 0) fail('$.coverage.unresolvedSourceValueFamilies', 'must be empty');
  const missingRecords = array(
    coverage.definitionsWithoutExplicitDefault,
    '$.coverage.definitionsWithoutExplicitDefault',
  );
  if (missingRecords.length !== missing.length) fail('$.coverage.definitionsWithoutExplicitDefault', 'count mismatch');
  missingRecords.forEach((entry, index) => {
    const item = record(entry, `$.coverage.definitionsWithoutExplicitDefault[${index}]`);
    keys(
      item,
      ['id', 'key', 'owner'],
      ['id', 'key', 'owner'],
      `$.coverage.definitionsWithoutExplicitDefault[${index}]`,
    );
    const expected = missing[index];
    literal(item.id, expected.id, `$.coverage.definitionsWithoutExplicitDefault[${index}].id`);
    literal(item.key, expected.key, `$.coverage.definitionsWithoutExplicitDefault[${index}].key`);
    literal(item.owner, expected.owner, `$.coverage.definitionsWithoutExplicitDefault[${index}].owner`);
  });
  const enumWithoutMap = definitions.filter(
    (definition) => definition.storage.valueType === 'enum' && definition.enum.storageMap === null,
  ).length;
  literal(coverage.enumWithoutStorageMap, enumWithoutMap, '$.coverage.enumWithoutStorageMap');
  literal(coverage.enumWithoutStorageMap, 0, '$.coverage.enumWithoutStorageMap');

  const byKey = new Map<string, EngineOptionDefinition[]>();
  for (const definition of definitions) {
    const entries = byKey.get(definition.key) ?? [];
    entries.push(definition);
    byKey.set(definition.key, entries);
  }
  const expectedDuplicates = [...byKey.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  const duplicates = array(coverage.duplicateKeys, '$.coverage.duplicateKeys');
  if (duplicates.length !== expectedDuplicates.length) fail('$.coverage.duplicateKeys', 'count mismatch');
  duplicates.forEach((entry, index) => {
    const item = record(entry, `$.coverage.duplicateKeys[${index}]`);
    keys(item, ['count', 'key', 'owners'], ['count', 'key', 'owners'], `$.coverage.duplicateKeys[${index}]`);
    const [expectedKey, expectedDefinitions] = expectedDuplicates[index];
    literal(item.key, expectedKey, `$.coverage.duplicateKeys[${index}].key`);
    literal(item.count, expectedDefinitions.length, `$.coverage.duplicateKeys[${index}].count`);
    const owners = stringArray(item.owners, `$.coverage.duplicateKeys[${index}].owners`);
    if (owners.join('\0') !== expectedDefinitions.map((definition) => definition.owner).join('\0')) {
      fail(`$.coverage.duplicateKeys[${index}].owners`, 'owner list mismatch');
    }
  });
}

export function validateEngineOptionSchema(value: unknown): EngineOptionSchema {
  const schema = record(value, '$');
  keys(
    schema,
    ['coverage', 'definitions', 'limitations', 'parser', 'schemaVersion', 'source', 'status'],
    ['coverage', 'definitions', 'limitations', 'parser', 'schemaVersion', 'source', 'status'],
    '$',
  );
  literal(schema.schemaVersion, ENGINE_OPTION_SCHEMA_VERSION, '$.schemaVersion');
  literal(schema.status, 'foundation-partial', '$.status');
  const parser = record(schema.parser, '$.parser');
  keys(parser, ['name', 'version'], ['name', 'version'], '$.parser');
  literal(parser.name, 'OrcaXR source-backed settings schema extractor', '$.parser.name');
  literal(parser.version, PARSER_VERSION, '$.parser.version');
  validateSource(schema.source);
  stringArray(schema.limitations, '$.limitations');
  const rawDefinitions = array(schema.definitions, '$.definitions');
  rawDefinitions.forEach(validateDefinition);
  const definitions = rawDefinitions as unknown as EngineOptionDefinition[];
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) fail('$.definitions', `duplicate id ${definition.id}`);
    ids.add(definition.id);
  }
  validateCoverage(schema.coverage, definitions);
  return schema as unknown as EngineOptionSchema;
}

export function parseEngineOptionSchema(json: string): EngineOptionSchema {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Engine-option schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return validateEngineOptionSchema(value);
}

export class EngineOptionCatalog {
  readonly schema: EngineOptionSchema;
  readonly definitions: readonly EngineOptionDefinition[];
  readonly #byKey: ReadonlyMap<string, readonly EngineOptionDefinition[]>;

  constructor(schema: EngineOptionSchema) {
    this.schema = schema;
    this.definitions = schema.definitions;
    const byKey = new Map<string, EngineOptionDefinition[]>();
    for (const definition of schema.definitions) {
      const entries = byKey.get(definition.key) ?? [];
      entries.push(definition);
      byKey.set(definition.key, entries);
    }
    this.#byKey = byKey;
  }

  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  all(key: string): readonly EngineOptionDefinition[] {
    return this.#byKey.get(key) ?? [];
  }

  get(key: string, owner?: string): EngineOptionDefinition {
    const matches =
      owner === undefined ? this.all(key) : this.all(key).filter((definition) => definition.owner === owner);
    if (matches.length === 0) {
      throw new Error(
        `Unknown engine option ${JSON.stringify(key)}${owner ? ` owned by ${JSON.stringify(owner)}` : ''}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous engine option ${JSON.stringify(key)}; specify owner (${matches.map((definition) => definition.owner).join(', ')})`,
      );
    }
    return matches[0];
  }
}

export function createEngineOptionCatalog(value: unknown): EngineOptionCatalog {
  return new EngineOptionCatalog(validateEngineOptionSchema(value));
}

export type EngineOptionSchemaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadEngineOptionSchema(
  url: string | URL = new URL('./engine-options.schema.json', import.meta.url),
  fetchSchema: EngineOptionSchemaFetch = globalThis.fetch.bind(globalThis),
): Promise<EngineOptionSchema> {
  const response = await fetchSchema(url, { cache: 'no-store' });
  if (!response.ok)
    throw new Error(`Failed to load engine-option schema: HTTP ${response.status} ${response.statusText}`);
  return parseEngineOptionSchema(await response.text());
}

export async function loadEngineOptionCatalog(
  url?: string | URL,
  fetchSchema?: EngineOptionSchemaFetch,
): Promise<EngineOptionCatalog> {
  return new EngineOptionCatalog(await loadEngineOptionSchema(url, fetchSchema));
}
