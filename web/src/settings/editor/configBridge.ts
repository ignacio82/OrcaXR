import type { ConfigMap, JsonValue } from '../../project/domain/model';
import { EngineOptionCatalog } from '../generated/loader';
import type { EngineOptionDefinition, EngineOptionValue } from '../generated/types';
import { parseSettingDraft, serializeSettingValue, validateSettingValue } from './codec';
import type { SettingsDraftCommit, SettingsValueMap } from './types';

export interface SettingsConfigDecodeDiagnostic {
  readonly key: string;
  readonly code: 'invalid-wire-value' | 'ambiguous-definition';
  readonly message: string;
}

/**
 * Typed, caller-safe view of the generated subset of an engine ConfigMap.
 * Unknown/special values remain in the canonical ConfigMap; they are merely
 * omitted from the editor instead of being misrepresented as editable.
 */
export interface DecodedSettingsConfig {
  readonly values: SettingsValueMap;
  readonly diagnostics: readonly SettingsConfigDecodeDiagnostic[];
  readonly unknownKeys: readonly string[];
}

export function decodeSettingsConfig(catalog: EngineOptionCatalog, config: Readonly<ConfigMap>): DecodedSettingsConfig {
  const values: Record<string, EngineOptionValue> = {};
  const diagnostics: SettingsConfigDecodeDiagnostic[] = [];
  const unknownKeys: string[] = [];

  for (const key of Object.keys(config).sort((left, right) => left.localeCompare(right, 'en'))) {
    const definitions = catalog.all(key);
    if (definitions.length === 0) {
      unknownKeys.push(key);
      continue;
    }
    const decoded = definitions.flatMap((definition) => {
      const result = decodeValue(definition, config[key]);
      return result.ok ? [{ definition, value: result.value, serialized: result.serialized }] : [];
    });
    if (decoded.length === 0) {
      diagnostics.push({
        key,
        code: 'invalid-wire-value',
        message: `The stored value for ${key} does not satisfy any generated definition and remains read-only.`,
      });
      continue;
    }
    const signatures = new Set(decoded.map((entry) => JSON.stringify([entry.value, entry.serialized])));
    if (signatures.size > 1) {
      diagnostics.push({
        key,
        code: 'ambiguous-definition',
        message: `The generated definitions for ${key} decode the stored value differently; it remains read-only.`,
      });
      continue;
    }
    values[key] = cloneValue(decoded[0]!.value);
  }

  return deepFreeze({
    values,
    diagnostics,
    unknownKeys,
  });
}

/**
 * Apply one validated editor commit to the raw engine-wire override map.
 * Unknown extension keys and generated-but-uneditable values are preserved;
 * rebuilding from the editor's typed subset would otherwise delete them.
 */
export function applySettingsCommitToConfig(
  previousOverrides: Readonly<ConfigMap>,
  commit: SettingsDraftCommit,
): ConfigMap {
  const next = cloneConfig(previousOverrides);
  const seen = new Set<string>();
  for (const change of commit.changes) {
    if (!change.key.trim()) throw new Error('Settings commit contains an empty key');
    if (seen.has(change.key)) throw new Error(`Settings commit changes ${change.key} more than once`);
    seen.add(change.key);
    if (change.action === 'remove') {
      delete next[change.key];
      continue;
    }
    if (change.serialized === undefined) {
      throw new Error(`Settings commit has no serialized engine value for ${change.key}`);
    }
    next[change.key] = change.serialized;
  }
  return next;
}

function decodeValue(
  definition: EngineOptionDefinition,
  raw: JsonValue | undefined,
): { readonly ok: true; readonly value: EngineOptionValue; readonly serialized: string } | { readonly ok: false } {
  if (raw === undefined) return { ok: false };
  if (typeof raw === 'string') {
    const parsed = parseSettingDraft(definition, raw);
    return parsed.ok ? parsed : { ok: false };
  }
  if (!isEngineOptionValue(raw)) return { ok: false };
  const value = raw as EngineOptionValue;
  if (validateSettingValue(definition, value).length > 0) return { ok: false };
  try {
    return { ok: true, value: cloneValue(value), serialized: serializeSettingValue(definition, value) };
  } catch {
    return { ok: false };
  }
}

function isEngineOptionValue(value: JsonValue): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) return value.every(isEngineOptionValue);
  return (
    Object.keys(value).length === 2 &&
    typeof value.percent === 'boolean' &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value)
  );
}

function cloneValue(value: EngineOptionValue): EngineOptionValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === 'object') return { ...value };
  return value;
}

function cloneConfig(config: Readonly<ConfigMap>): ConfigMap {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, cloneJsonValue(value)]));
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]));
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
