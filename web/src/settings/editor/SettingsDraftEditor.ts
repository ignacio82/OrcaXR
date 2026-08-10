import { EngineOptionCatalog } from '../generated/loader';
import { SETTING_SCOPE_KEYS, type SettingScope } from '../generated/settingScopes';
import type { EngineGuiSurface, EngineOptionDefinition, EngineOptionValue } from '../generated/types';
import { parseSettingDraft, serializeSettingValue, validateSettingValue } from './codec';
import { assessFieldSupport, projectSettingsField, projectSettingsFields } from './fields';
import {
  SettingsDraftCommitError,
  type SettingsDraftChange,
  type SettingsDraftCommit,
  type SettingsDraftEditorOptions,
  type SettingsFieldComparison,
  type SettingsFieldQuery,
  type SettingsFieldState,
  type SettingsValidationIssue,
  type SettingsValueMap,
  type SettingsValueOrigin,
} from './types';

type DraftOperation = { kind: 'set'; raw: string } | { kind: 'remove' };

export class SettingsDraftEditor {
  private inherited: Record<string, EngineOptionValue>;
  private overrides: Record<string, EngineOptionValue>;
  private readonly drafts = new Map<string, DraftOperation>();
  private readonly definitionsById: ReadonlyMap<string, EngineOptionDefinition>;
  private revision = 0;
  readonly mode;
  readonly technology;
  readonly guiSurface: EngineGuiSurface | undefined;
  /** Override scope this draft edits; undefined means the whole project config. */
  readonly scope: SettingScope | undefined;
  private readonly scopeKeys: ReadonlySet<string> | undefined;

  constructor(
    readonly catalog: EngineOptionCatalog,
    options: SettingsDraftEditorOptions = {},
  ) {
    this.mode = options.mode ?? 'advanced';
    this.technology = options.technology ?? 'fff';
    this.guiSurface = options.guiSurface;
    this.scope = options.scope;
    this.scopeKeys = options.scope ? new Set(SETTING_SCOPE_KEYS[options.scope]) : undefined;
    this.inherited = cloneMap(options.inherited ?? {});
    this.overrides = cloneMap(options.overrides ?? {});
    this.definitionsById = new Map(catalog.definitions.map((definition) => [definition.id, definition]));
    this.assertKnownKeys(this.inherited, 'inherited');
    this.assertKnownKeys(this.overrides, 'overrides');
    // Inherited values legitimately come from wider scopes; the overrides are
    // this node's own, so one outside its scope would be stored where nothing
    // reads it.
    this.assertInScope(this.overrides);
  }

  query(query: Partial<SettingsFieldQuery> = {}) {
    return projectSettingsFields(this.catalog, {
      mode: query.mode ?? this.mode,
      technology: query.technology ?? this.technology,
      ...(query.guiSurface !== undefined || this.guiSurface !== undefined
        ? { guiSurface: query.guiSurface ?? this.guiSurface }
        : {}),
      ...((query.scope ?? this.scope) ? { scope: (query.scope ?? this.scope)! } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.includeNonApplicable !== undefined ? { includeNonApplicable: query.includeNonApplicable } : {}),
      ...(query.includeUnknownApplicability !== undefined
        ? { includeUnknownApplicability: query.includeUnknownApplicability }
        : {}),
      ...(query.includeUnavailable !== undefined ? { includeUnavailable: query.includeUnavailable } : {}),
    });
  }

  getRevision(): number {
    return this.revision;
  }

  getOverrides(): SettingsValueMap {
    return freezeMap(this.overrides);
  }

  getFieldState(fieldId: string): SettingsFieldState {
    const definition = this.definition(fieldId);
    const field = projectSettingsField(this.catalog, definition, this.technology, this.guiSurface);
    const base = this.baseValue(definition);
    const hasOverride = hasOwn(this.overrides, definition.key);
    const override = hasOverride ? cloneValue(this.overrides[definition.key]) : undefined;
    const effective = hasOverride ? override : base.value;
    const origin = valueOrigin(hasOverride, override, base.value, base.origin);
    const issues = effective === undefined ? [] : validateSettingValue(definition, effective);
    const draft = this.drafts.get(fieldId);
    let draftValue: EngineOptionValue | undefined;
    let draftSerialized: string | undefined;
    let draftIssues: SettingsValidationIssue[] = [];
    if (draft?.kind === 'remove') {
      draftValue = base.value;
      if (draftValue !== undefined) {
        draftIssues = validateSettingValue(definition, draftValue);
        if (draftIssues.length === 0) draftSerialized = serializeSettingValue(definition, draftValue);
      }
    } else if (draft?.kind === 'set') {
      const parsed = parseSettingDraft(definition, draft.raw);
      if (parsed.ok) {
        draftValue = parsed.value;
        draftSerialized = parsed.serialized;
      } else {
        draftIssues = [...parsed.issues];
      }
    }
    return freeze({
      field,
      ...(effective !== undefined ? { value: cloneValue(effective) } : {}),
      ...(issues.length === 0 && effective !== undefined
        ? { serializedValue: serializeSettingValue(definition, effective) }
        : {}),
      origin,
      hasLocalOverride: hasOverride,
      changed: origin === 'changed',
      draftChanged: draft !== undefined && (draft.kind === 'remove' ? hasOverride : !valuesEqual(draftValue, override)),
      ...(draft?.kind === 'set' ? { draftRaw: draft.raw } : {}),
      ...(draftValue !== undefined ? { draftValue: cloneValue(draftValue) } : {}),
      ...(draftSerialized !== undefined ? { draftSerialized } : {}),
      issues: [...issues, ...draftIssues],
    });
  }

  setDraft(fieldId: string, raw: string): void {
    const definition = this.definition(fieldId);
    this.assertEditable(definition);
    this.drafts.set(fieldId, { kind: 'set', raw });
  }

  clearDraft(fieldId: string): void {
    this.definition(fieldId);
    this.drafts.delete(fieldId);
  }

  resetToInherited(fieldId: string): void {
    const definition = this.definition(fieldId);
    this.assertEditable(definition);
    this.drafts.set(fieldId, { kind: 'remove' });
  }

  resetToDefault(fieldId: string): void {
    const definition = this.definition(fieldId);
    this.assertEditable(definition);
    if (!definition.default.provided) throw new Error(`Setting ${definition.key} has no generated default`);
    const issues = validateSettingValue(definition, definition.default.value);
    if (issues.length > 0) throw new SettingsDraftCommitError(issues);
    this.drafts.set(fieldId, {
      kind: 'set',
      raw: serializeSettingValue(definition, definition.default.value),
    });
  }

  compare(fieldId: string): SettingsFieldComparison {
    const definition = this.definition(fieldId);
    const state = this.getFieldState(fieldId);
    const defaultValue = definition.default.provided ? definition.default.value : undefined;
    const inheritedValue = hasOwn(this.inherited, definition.key) ? this.inherited[definition.key] : undefined;
    const overrideValue = hasOwn(this.overrides, definition.key) ? this.overrides[definition.key] : undefined;
    return freeze({
      fieldId,
      key: definition.key,
      ...(defaultValue !== undefined ? { defaultValue: cloneValue(defaultValue) } : {}),
      ...(inheritedValue !== undefined ? { inheritedValue: cloneValue(inheritedValue) } : {}),
      ...(overrideValue !== undefined ? { overrideValue: cloneValue(overrideValue) } : {}),
      ...(state.value !== undefined ? { effectiveValue: cloneValue(state.value) } : {}),
      ...(state.draftValue !== undefined ? { draftValue: cloneValue(state.draftValue) } : {}),
      effectiveEqualsDefault: valuesEqual(state.value, defaultValue),
      draftEqualsEffective: valuesEqual(state.draftValue ?? state.value, state.value),
    });
  }

  commit(): SettingsDraftCommit {
    const baseRevision = this.revision;
    const next = cloneMap(this.overrides);
    const changes: SettingsDraftChange[] = [];
    const issues: SettingsValidationIssue[] = [];
    const ordered = [...this.drafts.entries()].sort(([leftId], [rightId]) => {
      const left = this.definition(leftId);
      const right = this.definition(rightId);
      return (
        left.key.localeCompare(right.key, 'en') ||
        left.owner.localeCompare(right.owner, 'en') ||
        left.id.localeCompare(right.id, 'en')
      );
    });

    for (const [fieldId, draft] of ordered) {
      const definition = this.definition(fieldId);
      const support = assessFieldSupport(this.catalog, definition, this.guiSurface);
      if (support.status !== 'implemented') {
        issues.push({
          code: 'unavailable-setting',
          path: definition.key,
          message: `Setting is unavailable: ${support.reason}`,
        });
        continue;
      }
      const previous = hasOwn(next, definition.key) ? next[definition.key] : undefined;
      if (draft.kind === 'remove') {
        if (previous !== undefined) {
          delete next[definition.key];
          changes.push({
            fieldId,
            key: definition.key,
            owner: definition.owner,
            action: 'remove',
            previousValue: cloneValue(previous),
          });
        }
        continue;
      }
      const parsed = parseSettingDraft(definition, draft.raw);
      if (!parsed.ok) {
        issues.push(...parsed.issues.map((entry) => ({ ...entry, path: `${definition.key}${entry.path}` })));
        continue;
      }
      if (!valuesEqual(previous, parsed.value)) {
        next[definition.key] = cloneValue(parsed.value);
        changes.push({
          fieldId,
          key: definition.key,
          owner: definition.owner,
          action: 'set',
          ...(previous !== undefined ? { previousValue: cloneValue(previous) } : {}),
          value: cloneValue(parsed.value),
          serialized: parsed.serialized,
        });
      }
    }
    if (issues.length > 0) throw new SettingsDraftCommitError(issues);

    const revision = changes.length > 0 ? baseRevision + 1 : baseRevision;
    const result = freeze<SettingsDraftCommit>({
      baseRevision,
      revision,
      changes: changes.map((change) => ({ ...change })),
      nextOverrides: freezeMap(next),
    });
    this.overrides = next;
    this.revision = revision;
    this.drafts.clear();
    return result;
  }

  private baseValue(definition: EngineOptionDefinition): {
    value?: EngineOptionValue;
    origin: Exclude<SettingsValueOrigin, 'changed'>;
  } {
    if (hasOwn(this.inherited, definition.key)) {
      return { value: cloneValue(this.inherited[definition.key]), origin: 'inherited' };
    }
    if (definition.default.provided) {
      return { value: cloneValue(definition.default.value), origin: 'default' };
    }
    return { origin: 'unset' };
  }

  private definition(fieldId: string): EngineOptionDefinition {
    const definition = this.definitionsById.get(fieldId);
    if (!definition) throw new Error(`Unknown settings field ${JSON.stringify(fieldId)}`);
    return definition;
  }

  private assertEditable(definition: EngineOptionDefinition): void {
    if (this.scopeKeys && !this.scopeKeys.has(definition.key)) {
      throw new Error(`Setting ${definition.key} cannot be overridden at the ${this.scope} scope`);
    }
    const support = assessFieldSupport(this.catalog, definition, this.guiSurface);
    if (support.status !== 'implemented') {
      throw new Error(`Setting ${definition.key} is unavailable: ${support.reason}`);
    }
  }

  private assertKnownKeys(values: SettingsValueMap, layer: string): void {
    for (const key of Object.keys(values)) {
      if (!this.catalog.has(key)) throw new Error(`Unknown ${layer} setting ${JSON.stringify(key)}`);
    }
  }

  private assertInScope(values: SettingsValueMap): void {
    if (!this.scopeKeys) return;
    for (const key of Object.keys(values)) {
      if (!this.scopeKeys.has(key)) {
        throw new Error(`Setting ${JSON.stringify(key)} cannot be overridden at the ${this.scope} scope`);
      }
    }
  }
}

function valueOrigin(
  hasOverride: boolean,
  override: EngineOptionValue | undefined,
  base: EngineOptionValue | undefined,
  baseOrigin: Exclude<SettingsValueOrigin, 'changed'>,
): SettingsValueOrigin {
  if (!hasOverride || valuesEqual(override, base)) return baseOrigin;
  return 'changed';
}

function cloneMap(values: SettingsValueMap): Record<string, EngineOptionValue> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, cloneValue(value)]));
}

function freezeMap(values: SettingsValueMap): SettingsValueMap {
  return freeze(cloneMap(values));
}

function cloneValue(value: EngineOptionValue): EngineOptionValue {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as EngineOptionValue;
  if (value !== null && typeof value === 'object') return { ...value };
  return value;
}

function valuesEqual(left: EngineOptionValue | undefined, right: EngineOptionValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(values: SettingsValueMap, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
