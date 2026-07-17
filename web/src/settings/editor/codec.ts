import type { EngineOptionDefinition, EngineOptionValue, EngineOptionValueType } from '../generated/types';
import type { SettingsEnumChoice, SettingsValidationIssue } from './types';

const ASCII_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ASCII_INTEGER = /^[+-]?\d+$/;

export type SettingsDraftParseResult =
  | { ok: true; value: EngineOptionValue; serialized: string }
  | { ok: false; issues: readonly SettingsValidationIssue[] };

export class SettingsCodecError extends Error {
  constructor(readonly issues: readonly SettingsValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'SettingsCodecError';
  }
}

export function enumChoicesFor(definition: EngineOptionDefinition): SettingsEnumChoice[] {
  const values = definition.enum.values.map((entry) => entry.value);
  return values.map((serialized, index) => ({
    serialized,
    label: definition.enum.labels[index]?.value ?? serialized,
  }));
}

export function codecContractIssue(definition: EngineOptionDefinition): string | undefined {
  const { storage } = definition;
  if (storage.valueType === 'none' || storage.optionType === 'coNone') return 'unsupported-none-value';
  if (storage.nullable && storage.serialization.nilToken !== 'nil') return 'nullable-without-nil-token';

  if (storage.shape === 'scalar') {
    if (storage.serialization.collectionDelimiter !== null) return 'scalar-with-collection-delimiter';
    if (storage.valueType === 'point2' || storage.valueType === 'point3') {
      if (storage.serialization.componentDelimiter !== ',') return 'point-component-delimiter';
    } else if (storage.serialization.componentDelimiter !== null) {
      return 'scalar-with-component-delimiter';
    }
  } else if (storage.valueType === 'point2' || storage.valueType === 'point3') {
    if (storage.serialization.collectionDelimiter !== ',' || storage.serialization.componentDelimiter !== 'x') {
      return 'point-vector-delimiter';
    }
  } else {
    const expected = storage.valueType === 'string' ? ';' : ',';
    if (storage.serialization.collectionDelimiter !== expected) {
      return storage.valueType === 'string' ? 'string-vector-must-use-semicolon' : 'numeric-vector-must-use-comma';
    }
    if (storage.serialization.componentDelimiter !== null) return 'unexpected-component-delimiter';
  }

  if (storage.percentSemantics === 'none' && storage.serialization.percentSuffix !== null) {
    return 'unexpected-percent-suffix';
  }
  if (storage.percentSemantics !== 'none' && storage.serialization.percentSuffix !== '%') {
    return 'percent-without-percent-suffix';
  }
  if (storage.valueType === 'enum' && enumChoicesFor(definition).length === 0) {
    return 'enum-domain-missing';
  }
  return undefined;
}

export function parseSettingDraft(definition: EngineOptionDefinition, raw: string): SettingsDraftParseResult {
  const contract = codecContractIssue(definition);
  if (contract) {
    return {
      ok: false,
      issues: [issue(contract, '$', `Schema storage contract is unsupported: ${contract}`)],
    };
  }
  try {
    const value = parseValue(definition, raw);
    const issues = validateSettingValue(definition, value);
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value, serialized: serializeSettingValue(definition, value) };
  } catch (error) {
    return {
      ok: false,
      issues: [issue('invalid-draft', '$', error instanceof Error ? error.message : 'The draft value is invalid')],
    };
  }
}

export function validateSettingValue(
  definition: EngineOptionDefinition,
  value: EngineOptionValue,
): SettingsValidationIssue[] {
  const contract = codecContractIssue(definition);
  if (contract) return [issue(contract, '$', `Schema storage contract is unsupported: ${contract}`)];
  const issues: SettingsValidationIssue[] = [];
  const { storage } = definition;

  if (storage.shape === 'vector') {
    if (!Array.isArray(value)) {
      return [issue('expected-vector', '$', `Expected a ${storage.valueType} vector`)];
    }
    value.forEach((entry, index) => validateAtomic(definition, entry, `$[${index}]`, storage.valueType, issues));
  } else {
    validateAtomic(definition, value, '$', storage.valueType, issues);
  }
  return issues;
}

export function serializeSettingValue(definition: EngineOptionDefinition, value: EngineOptionValue): string {
  const issues = validateSettingValue(definition, value);
  if (issues.length > 0) throw new SettingsCodecError(issues);
  const { storage } = definition;
  if (storage.shape === 'vector') {
    const entries = value as readonly EngineOptionValue[];
    const delimiter = storage.serialization.collectionDelimiter!;
    return entries.map((entry) => serializeAtomic(definition, entry)).join(delimiter);
  }
  return serializeAtomic(definition, value);
}

function parseValue(definition: EngineOptionDefinition, raw: string): EngineOptionValue {
  const { storage } = definition;
  if (storage.shape === 'scalar') return parseAtomic(definition, raw, storage.valueType);
  if (raw === '') return [];
  const delimiter = storage.serialization.collectionDelimiter!;
  return raw.split(delimiter).map((entry) => parseAtomic(definition, entry, storage.valueType));
}

function parseAtomic(
  definition: EngineOptionDefinition,
  raw: string,
  valueType: EngineOptionValueType,
): EngineOptionValue {
  const { storage } = definition;
  if (storage.nullable && raw.trim() === storage.serialization.nilToken) return null;
  switch (valueType) {
    case 'bool': {
      const normalized = raw.trim().toLowerCase();
      if (normalized === '1' || normalized === 'true') return true;
      if (normalized === '0' || normalized === 'false') return false;
      throw new Error('Boolean values must be 1, 0, true, or false');
    }
    case 'int':
      return parseInteger(raw);
    case 'float': {
      const withoutPercent = stripRequiredPercent(definition, raw);
      return parseNumber(withoutPercent);
    }
    case 'float-or-percent': {
      const trimmed = raw.trim();
      const percent = trimmed.endsWith('%');
      return { percent, value: parseNumber(percent ? trimmed.slice(0, -1) : trimmed) };
    }
    case 'string':
      return raw;
    case 'enum': {
      const token = raw.trim();
      if (!enumChoicesFor(definition).some((choice) => choice.serialized === token)) {
        throw new Error(`Unknown enum token ${JSON.stringify(token)}`);
      }
      return token;
    }
    case 'point2':
      return parsePoint(raw, 2, storage.serialization.componentDelimiter!);
    case 'point3':
      return parsePoint(raw, 3, storage.serialization.componentDelimiter!);
    case 'none':
      throw new Error('Options without a value shape cannot be edited');
  }
}

function validateAtomic(
  definition: EngineOptionDefinition,
  value: EngineOptionValue,
  path: string,
  valueType: EngineOptionValueType,
  issues: SettingsValidationIssue[],
): void {
  if (value === null) {
    if (!definition.storage.nullable) issues.push(issue('not-nullable', path, 'This setting is not nullable'));
    return;
  }
  switch (valueType) {
    case 'bool':
      if (typeof value !== 'boolean') issues.push(issue('expected-bool', path, 'Expected a boolean'));
      return;
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        issues.push(issue('expected-int', path, 'Expected a safe integer'));
      } else {
        validateBounds(definition, value, path, issues);
      }
      return;
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(issue('expected-float', path, 'Expected a finite number'));
      } else {
        validateBounds(definition, value, path, issues);
      }
      return;
    case 'float-or-percent':
      if (!isFloatOrPercent(value)) {
        issues.push(issue('expected-float-or-percent', path, 'Expected an absolute or percent value'));
      } else {
        validateBounds(definition, value.value, path, issues);
      }
      return;
    case 'string':
      if (typeof value !== 'string') issues.push(issue('expected-string', path, 'Expected text'));
      return;
    case 'enum':
      if (typeof value !== 'string' || !enumChoicesFor(definition).some((choice) => choice.serialized === value)) {
        issues.push(issue('invalid-enum', path, 'Value is not in the generated enum domain'));
      }
      return;
    case 'point2':
      validatePoint(definition, value, 2, path, issues);
      return;
    case 'point3':
      validatePoint(definition, value, 3, path, issues);
      return;
    case 'none':
      issues.push(issue('unsupported-none-value', path, 'Options without a value shape cannot be edited'));
  }
}

function serializeAtomic(definition: EngineOptionDefinition, value: EngineOptionValue): string {
  const { storage } = definition;
  if (value === null) return storage.serialization.nilToken!;
  switch (storage.valueType) {
    case 'bool':
      return value ? '1' : '0';
    case 'int':
    case 'float': {
      const serialized = numberText(value as number);
      return storage.percentSemantics === 'percent'
        ? `${serialized}${storage.serialization.percentSuffix}`
        : serialized;
    }
    case 'float-or-percent': {
      const compound = value as { percent: boolean; value: number };
      return `${numberText(compound.value)}${compound.percent ? storage.serialization.percentSuffix : ''}`;
    }
    case 'string':
    case 'enum': {
      const text = value as string;
      const collectionDelimiter = storage.serialization.collectionDelimiter;
      if (storage.shape === 'vector' && collectionDelimiter && text.includes(collectionDelimiter)) {
        throw new SettingsCodecError([
          issue(
            'unrepresentable-delimiter',
            '$',
            `A vector item cannot contain its ${JSON.stringify(collectionDelimiter)} delimiter`,
          ),
        ]);
      }
      return text;
    }
    case 'point2':
    case 'point3':
      return (value as readonly number[]).map(numberText).join(storage.serialization.componentDelimiter!);
    case 'none':
      throw new SettingsCodecError([
        issue('unsupported-none-value', '$', 'Options without a value shape cannot be serialized'),
      ]);
  }
}

function validatePoint(
  definition: EngineOptionDefinition,
  value: EngineOptionValue,
  dimensions: number,
  path: string,
  issues: SettingsValidationIssue[],
): void {
  if (
    !Array.isArray(value) ||
    value.length !== dimensions ||
    value.some((component) => typeof component !== 'number' || !Number.isFinite(component))
  ) {
    issues.push(issue('invalid-point', path, `Expected a ${dimensions}-component finite point`));
    return;
  }
  value.forEach((component, index) => validateBounds(definition, component as number, `${path}[${index}]`, issues));
}

function validateBounds(
  definition: EngineOptionDefinition,
  value: number,
  path: string,
  issues: SettingsValidationIssue[],
): void {
  const minimum = definition.constraints.min.value;
  const maximum = definition.constraints.max.value;
  if (minimum !== null && value < minimum) {
    issues.push(issue('below-minimum', path, `Value must be at least ${minimum}`));
  }
  if (maximum !== null && value > maximum) {
    issues.push(issue('above-maximum', path, `Value must be at most ${maximum}`));
  }
}

function parsePoint(raw: string, dimensions: number, delimiter: string): EngineOptionValue {
  const components = raw.split(delimiter);
  if (components.length !== dimensions) throw new Error(`Expected ${dimensions} point components`);
  return components.map(parseNumber);
}

function stripRequiredPercent(definition: EngineOptionDefinition, raw: string): string {
  const trimmed = raw.trim();
  if (definition.storage.percentSemantics !== 'percent') return trimmed;
  const suffix = definition.storage.serialization.percentSuffix!;
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}

function parseInteger(raw: string): number {
  const trimmed = raw.trim();
  if (!ASCII_INTEGER.test(trimmed)) throw new Error('Expected an ASCII base-10 integer');
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error('Integer is outside the safe range');
  return value;
}

function parseNumber(raw: string): number {
  const trimmed = raw.trim();
  if (!ASCII_NUMBER.test(trimmed)) throw new Error('Expected an ASCII decimal number');
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error('Number must be finite');
  return value;
}

function numberText(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function isFloatOrPercent(value: EngineOptionValue): value is { percent: boolean; value: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { percent?: unknown; value?: unknown };
  return (
    typeof candidate.percent === 'boolean' && typeof candidate.value === 'number' && Number.isFinite(candidate.value)
  );
}

function issue(code: string, path: string, message: string): SettingsValidationIssue {
  return { code, path, message };
}
