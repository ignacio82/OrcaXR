/**
 * The generated settings panel's model, without a DOM.
 *
 * `GeneratedSettingsPanel` draws this: which fields a query shows and how they
 * are grouped, what control each one needs and what it holds, its badges, notes
 * and issues, and the panel's drafts — set, inherited, reset to the generated
 * default, each widened by the reviewed FullSpectrum rules — up to the one
 * validated commit Apply hands its adapter. Native hosts run the same model in
 * the shared core (`settings::panel`), replaying this file's answers.
 *
 * Words the panel translates (`t()` keys) are left to the surface: a row names
 * them by code. Words it writes in English are part of the model.
 */
import type { EngineOptionCatalog } from '../generated/loader';
import type { SettingScope } from '../generated/settingScopes';
import type { EngineGuiSurface, EngineOptionValue } from '../generated/types';
import { SettingsDraftEditor } from './SettingsDraftEditor';
import {
  expandFullSpectrumSettingsTransaction,
  FULL_SPECTRUM_KEYS,
  getFullSpectrumDependencyState,
  getFullSpectrumSpecialEditorRequirement,
  validateFullSpectrumCrossFields,
} from './fullSpectrumSemantics';
import {
  SettingsDraftCommitError,
  type SettingsDraftCommit,
  type SettingsEditorMode,
  type SettingsFieldProjection,
  type SettingsFieldState,
  type SettingsTechnology,
  type SettingsValueMap,
  type SettingsValueOrigin,
} from './types';

/** One field's pending change: a typed value, or back to the inherited one. */
export type SettingsPanelDraft = { readonly kind: 'set'; readonly raw: string } | { readonly kind: 'remove' };

export interface SettingsPanelOptions {
  readonly technology: SettingsTechnology;
  /** Which pinned GUI surface supplies the fields. */
  readonly guiSurface: EngineGuiSurface;
  /** The override scope written; omitted for the project configuration. */
  readonly scope?: SettingScope;
  readonly inherited: SettingsValueMap;
  readonly overrides: SettingsValueMap;
}

export interface SettingsPanelIssue {
  readonly code: string;
  readonly message: string;
}

/** The control a row draws, holding what the field shows. */
export type SettingsPanelControl =
  /** FullSpectrum recipes: an output pointing at their structured editor. */
  | { readonly kind: 'structured'; readonly editorId: string; readonly value: string }
  /** A field this panel cannot edit, shown as disabled text. */
  | { readonly kind: 'locked'; readonly value: string }
  | { readonly kind: 'checkbox'; readonly checked: boolean }
  /** `nil` is the leading "Not set" choice's value, when the option is nullable. */
  | {
      readonly kind: 'select';
      readonly value: string;
      readonly nil?: string;
      readonly choices: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'textarea'; readonly value: string; readonly rows: number }
  | {
      readonly kind: 'text';
      readonly value: string;
      readonly inputMode?: 'numeric' | 'decimal';
      readonly spellcheck: boolean;
    };

export interface SettingsPanelRow {
  readonly fieldId: string;
  readonly key: string;
  readonly label: string;
  readonly unit?: string;
  readonly tooltip?: string;
  /** The structured-editor requirement, or the field's support status. */
  readonly support: string;
  readonly applicability: string;
  /** Drawn by the generic editor at all (support implemented, no structured editor). */
  readonly editable: boolean;
  /** False while a FullSpectrum controller turns the field off. */
  readonly dependencyEnabled: boolean;
  readonly control: SettingsPanelControl;
  readonly origin: SettingsValueOrigin;
  /** "Changed", "Inherited", "Default" or "Unset". */
  readonly originLabel: string;
  readonly draftChanged: boolean;
  /** The availability badge: the structured editor's, or "Unavailable". */
  readonly availability?: 'structured-editor' | 'unavailable';
  /** "Use inherited" is offered. */
  readonly inherit: boolean;
  /** "Use default" is offered: an editable field with a generated default. */
  readonly useDefault: boolean;
  /** Why the schema cannot support the field, and the sentence the panel shows. */
  readonly unavailable?: { readonly reason: string; readonly message: string };
  /** The structured editor that owns the field. */
  readonly structuredEditor?: string;
  /** The FullSpectrum controller that turns the field off. */
  readonly dependencyController?: string;
  readonly issues: readonly SettingsPanelIssue[];
}

export interface SettingsPanelSection {
  /** The GUI group, or `metadata:<category>` for a field without a placement. */
  readonly id: string;
  /** "Surface · Tab · Group", or the category. */
  readonly label: string;
  readonly surface?: string;
  readonly page?: string;
  readonly group?: string;
  readonly rows: readonly SettingsPanelRow[];
}

export interface SettingsPanelView {
  readonly shown: number;
  readonly unavailable: number;
  /** "n settings shown; m unavailable." */
  readonly summary: string;
  readonly sections: readonly SettingsPanelSection[];
}

export interface SettingsPanelDraftState {
  /** Some draft differs from what the node holds. */
  readonly changed: boolean;
  /** Some drafted field, or the FullSpectrum bounds, has an issue. */
  readonly invalid: boolean;
}

/** A default the panel could not turn into a draft. */
export interface SettingsPanelDefaultFailure {
  readonly ok: false;
  readonly error: Error;
}

/**
 * One node's settings as the panel edits them: the draft editor over the
 * node's inherited and override values, and the drafts Apply commits.
 */
export class SettingsPanelModel {
  private editor: SettingsDraftEditor;
  private readonly drafts = new Map<string, SettingsPanelDraft>();

  constructor(
    readonly catalog: EngineOptionCatalog,
    private readonly options: SettingsPanelOptions,
  ) {
    this.editor = this.create();
  }

  /** The live draft editor (read only: edit through the model). */
  get draftEditor(): SettingsDraftEditor {
    return this.editor;
  }

  /** Field IDs with a draft, in the order they were first drafted. */
  get draftFieldIds(): readonly string[] {
    return [...this.drafts.keys()];
  }

  get hasDrafts(): boolean {
    return this.drafts.size > 0;
  }

  /** What the panel shows for a detail level and a search. */
  view(mode: SettingsEditorMode, search: string): SettingsPanelView {
    const fields = this.editor.query({
      mode,
      technology: this.options.technology,
      guiSurface: this.options.guiSurface,
      ...(this.options.scope ? { scope: this.options.scope } : {}),
      search,
      includeUnavailable: true,
      includeUnknownApplicability: true,
    });
    const unavailable = fields.filter(
      (field) =>
        field.support.status === 'unavailable' || getFullSpectrumSpecialEditorRequirement(field.key) !== undefined,
    ).length;
    const categories = new Map<string, { label: string; fields: SettingsFieldProjection[] }>();
    for (const field of fields) {
      const location = field.primaryGuiLocation;
      const key = location?.group.id ?? `metadata:${field.category}`;
      const label = location
        ? [guiSurfaceLabel(location.placement.surface), location.tab.label, location.group.label]
            .filter((part) => part.length > 0)
            .join(' · ')
        : field.category;
      const category = categories.get(key) ?? { label, fields: [] };
      category.fields.push(field);
      categories.set(key, category);
    }
    const fullSpectrum = this.fullSpectrumValues(this.editor);
    const sections = [...categories.entries()].map(([id, category]): SettingsPanelSection => {
      const location = category.fields[0]?.primaryGuiLocation;
      return {
        id,
        label: category.label,
        ...(location
          ? { surface: location.placement.surface, page: location.tab.label, group: location.group.label }
          : {}),
        rows: category.fields.map((field) => this.rowOf(field.id, fullSpectrum)),
      };
    });
    return {
      shown: fields.length,
      unavailable,
      summary: `${fields.length} setting${fields.length === 1 ? '' : 's'} shown; ${unavailable} unavailable.`,
      sections,
    };
  }

  /** One field's row as it stands now. */
  row(fieldId: string): SettingsPanelRow {
    return this.rowOf(fieldId, this.fullSpectrumValues(this.editor));
  }

  /** A typed value: drafted, with the FullSpectrum values it implies. */
  set(fieldId: string, raw: string): void {
    this.editor.setDraft(fieldId, raw);
    this.drafts.set(fieldId, { kind: 'set', raw });
    this.expand(this.editor, [this.editor.getFieldState(fieldId).field.key], true);
  }

  /** "Use inherited": the node stops holding the field. */
  inherit(fieldId: string): void {
    this.editor.resetToInherited(fieldId);
    this.drafts.set(fieldId, { kind: 'remove' });
    this.expand(this.editor, [this.editor.getFieldState(fieldId).field.key], true);
  }

  /**
   * "Use default": the generated default drafted as a value. A default the
   * codec cannot write is reported, not drafted (the editor keeps its draft).
   */
  useDefault(fieldId: string): { readonly ok: true } | SettingsPanelDefaultFailure {
    this.editor.resetToDefault(fieldId);
    const state = this.editor.getFieldState(fieldId);
    if (state.draftSerialized === undefined) {
      return { ok: false, error: new Error(`Generated default for ${state.field.key} could not be serialized`) };
    }
    this.drafts.set(fieldId, { kind: 'set', raw: state.draftSerialized });
    this.expand(this.editor, [state.field.key], true);
    return { ok: true };
  }

  /** Whether Apply has something valid to apply. */
  state(): SettingsPanelDraftState {
    let changed = false;
    let invalid = false;
    for (const fieldId of this.drafts.keys()) {
      const state = this.editor.getFieldState(fieldId);
      changed ||= state.draftChanged;
      invalid ||= state.issues.length > 0;
    }
    invalid ||= validateFullSpectrumCrossFields(this.fullSpectrumValues(this.editor)).length > 0;
    return { changed, invalid };
  }

  /**
   * The one commit Apply submits: the drafts replayed over the node's values,
   * widened by the FullSpectrum rules and checked across fields. Throws
   * `SettingsDraftCommitError` for issues; a commit without changes is the
   * panel's "No effective settings changes to apply."
   */
  prepare(): SettingsDraftCommit {
    const staging = this.create();
    for (const [fieldId, draft] of this.drafts) {
      if (draft.kind === 'set') staging.setDraft(fieldId, draft.raw);
      else staging.resetToInherited(fieldId);
    }
    const changedKeys = [...this.drafts.keys()].map((fieldId) => staging.getFieldState(fieldId).field.key);
    this.expand(staging, changedKeys, false);
    const crossField = validateFullSpectrumCrossFields(this.fullSpectrumValues(staging));
    if (crossField.length > 0) throw new SettingsDraftCommitError(crossField);
    return staging.commit();
  }

  /** Every draft dropped: the node's values as they were opened. */
  discard(): void {
    this.editor = this.create();
    this.drafts.clear();
  }

  private create(): SettingsDraftEditor {
    return new SettingsDraftEditor(this.catalog, {
      technology: this.options.technology,
      guiSurface: this.options.guiSurface,
      ...(this.options.scope ? { scope: this.options.scope } : {}),
      inherited: this.options.inherited,
      overrides: this.options.overrides,
    });
  }

  private rowOf(fieldId: string, fullSpectrum: SettingsValueMap): SettingsPanelRow {
    const state = this.editor.getFieldState(fieldId);
    const field = state.field;
    const specialEditor = getFullSpectrumSpecialEditorRequirement(field.key);
    const dependency = getFullSpectrumDependencyState(field.key, fullSpectrum);
    const editable = field.support.status === 'implemented' && specialEditor === undefined;
    const crossField = validateFullSpectrumCrossFields(fullSpectrum).filter((issue) =>
      issue.relatedKeys.includes(field.key as (typeof issue.relatedKeys)[number]),
    );
    return {
      fieldId: field.id,
      key: field.key,
      label: field.label,
      ...(field.unit ? { unit: field.unit } : {}),
      ...(field.tooltip ? { tooltip: field.tooltip } : {}),
      support: specialEditor?.kind ?? field.support.status,
      applicability: dependency ? (dependency.applicable ? 'applicable' : 'not-applicable') : field.applicability,
      editable,
      dependencyEnabled: dependency?.enabled !== false,
      control: settingsPanelControl(field, state, editable),
      origin: state.origin,
      originLabel: settingsOriginLabel(state.origin),
      draftChanged: state.draftChanged,
      ...(specialEditor
        ? { availability: 'structured-editor' as const }
        : field.support.status === 'unavailable'
          ? { availability: 'unavailable' as const }
          : {}),
      inherit: editable,
      useDefault: editable && field.definition.default.provided,
      ...(field.support.status === 'unavailable'
        ? {
            unavailable: {
              reason: field.support.reason ?? 'unspecified',
              message: `Unavailable: ${formatUnavailableReason(field.support.reason)}`,
            },
          }
        : {}),
      ...(specialEditor ? { structuredEditor: specialEditor.editorId } : {}),
      ...(dependency && !dependency.enabled ? { dependencyController: dependency.controllerKey } : {}),
      issues: [...state.issues, ...crossField].map((issue) => ({ code: issue.code, message: issue.message })),
    };
  }

  /** The FullSpectrum keys' values as the editor would apply them now. */
  private fullSpectrumValues(editor: SettingsDraftEditor): SettingsValueMap {
    const values: Record<string, EngineOptionValue> = {};
    for (const key of Object.values(FULL_SPECTRUM_KEYS)) {
      if (!this.catalog.has(key) || this.catalog.all(key).length !== 1) continue;
      const state = editor.getFieldState(this.catalog.get(key).id);
      const value = state.draftRaw !== undefined ? state.draftValue : (state.draftValue ?? state.value);
      if (value !== undefined) values[key] = value;
    }
    return values;
  }

  /** The values the FullSpectrum rules add to a change of [changedKeys]. */
  private expand(editor: SettingsDraftEditor, changedKeys: readonly string[], record: boolean): void {
    const expansion = expandFullSpectrumSettingsTransaction({
      changedKeys,
      effectiveValues: this.fullSpectrumValues(editor),
    });
    for (const key of expansion.implicitKeys) {
      const value = expansion.implicitValues[key];
      if (value === undefined || !this.catalog.has(key) || this.catalog.all(key).length !== 1) continue;
      const fieldId = this.catalog.get(key).id;
      const raw = value ? '1' : '0';
      editor.setDraft(fieldId, raw);
      if (record) this.drafts.set(fieldId, { kind: 'set', raw });
    }
  }
}

const SCOPE_LABEL: Readonly<Record<SettingScope, string>> = {
  project: 'Project',
  plate: 'Plate',
  object: 'Object',
  part: 'Part',
  layerRange: 'Height range',
};

/** The scoped panel's name for a scope ("Height range" for a layer range). */
export function scopedSettingsScopeLabel(scope: SettingScope): string {
  return SCOPE_LABEL[scope];
}

/** A target as the scoped panel's picker lists it: `Object: Plate 1 › Cube — 2 overrides`. */
export function scopedSettingsOptionText(scope: SettingScope, path: string, overrideCount: number): string {
  const overrides = overrideCount === 0 ? '' : ` — ${overrideCount} override${overrideCount === 1 ? '' : 's'}`;
  return `${SCOPE_LABEL[scope]}: ${path}${overrides}`;
}

/** What the scoped panel says a scope's values do. */
export function scopedSettingsSummary(scope: SettingScope): string {
  return scope === 'project'
    ? 'Applies to every plate unless a narrower scope overrides it.'
    : `Overrides the ${SCOPE_LABEL[scope].toLowerCase()}'s inherited values. ` +
        (scope === 'part'
          ? 'A height range crossing this part wins over it, as it does in the engine.'
          : 'Only settings the engine reads at this scope are listed.');
}

/** The heading of a target's settings: `Object settings — Cube`. */
export function scopedSettingsHeading(scope: SettingScope, label: string): string {
  return `${SCOPE_LABEL[scope]} settings — ${label}`;
}

/** The control [field] needs and what it holds for [state]. */
export function settingsPanelControl(
  field: SettingsFieldProjection,
  state: SettingsFieldState,
  editable: boolean,
): SettingsPanelControl {
  const definition = field.definition;
  const specialEditor = getFullSpectrumSpecialEditorRequirement(field.key);
  const value = settingsFieldRawValue(state);
  if (specialEditor) {
    return {
      kind: 'structured',
      editorId: specialEditor.editorId,
      value: 'Use the structured FullSpectrum recipe editor',
    };
  }
  if (!editable) return { kind: 'locked', value };
  const storage = definition.storage;
  if (storage.shape === 'scalar' && storage.valueType === 'bool' && !storage.nullable) {
    return {
      kind: 'checkbox',
      checked: state.draftValue === true || (state.draftValue === undefined && state.value === true),
    };
  }
  if (storage.shape === 'scalar' && storage.valueType === 'enum') {
    return {
      kind: 'select',
      value,
      ...(storage.nullable ? { nil: storage.serialization.nilToken ?? 'nil' } : {}),
      choices: field.enumChoices.map((choice) => ({ value: choice.serialized, label: choice.label })),
    };
  }
  if (storage.valueType === 'string' && definition.presentation.multiline.value) {
    return { kind: 'textarea', value, rows: settingsMultilineRows(definition.presentation.height.value) };
  }
  return {
    kind: 'text',
    value,
    ...(storage.valueType === 'int'
      ? { inputMode: 'numeric' as const }
      : storage.valueType === 'float' || storage.valueType === 'float-or-percent'
        ? { inputMode: 'decimal' as const }
        : {}),
    spellcheck: storage.valueType === 'string',
  };
}

/** What a field's control holds: the typed draft, else the value written as the codec writes it. */
export function settingsFieldRawValue(state: SettingsFieldState): string {
  if (state.draftRaw !== undefined) return state.draftRaw;
  if (state.draftSerialized !== undefined) return state.draftSerialized;
  if (state.serializedValue !== undefined) return state.serializedValue;
  const value = state.draftValue ?? state.value;
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** A multiline text's rows from the GUI height hint (pixels above 30, else rows). */
export function settingsMultilineRows(heightHint: number | null): number {
  const rows = heightHint === null ? 4 : heightHint > 30 ? Math.round(heightHint / 20) : Math.round(heightHint);
  return Math.min(12, Math.max(3, rows));
}

export function settingsOriginLabel(origin: SettingsValueOrigin): string {
  switch (origin) {
    case 'changed':
      return 'Changed';
    case 'inherited':
      return 'Inherited';
    case 'default':
      return 'Default';
    case 'unset':
      return 'Unset';
  }
}

export function guiSurfaceLabel(surface: string): string {
  const labels: Readonly<Record<string, string>> = {
    filament: 'Filament',
    object: 'Object',
    plate: 'Plate',
    printer: 'Printer',
    process: 'Process',
  };
  return labels[surface] ?? surface;
}

/** Why the schema cannot support a field, as the panel says it. */
export function formatUnavailableReason(reason: string | undefined): string {
  if (!reason) return 'the generated schema does not provide a safe editable contract';
  if (reason.startsWith('special-widget:')) {
    return `requires the unimplemented ${reason.slice('special-widget:'.length)} generated widget`;
  }
  if (reason.startsWith('gui-surface-unavailable:')) {
    const surface = reason.slice('gui-surface-unavailable:'.length);
    return `belongs to another settings scope; this panel may edit only the ${guiSurfaceLabel(surface)} surface`;
  }
  const descriptions: Readonly<Record<string, string>> = {
    'ambiguous-key-owners': 'the engine key has multiple owners and cannot be selected safely',
    'conditional-enum-domain': 'the enum domain depends on runtime state that is not generated yet',
    'custom-tab-widget': 'the pinned Tab.cpp uses a custom widget whose behavior is not generated yet',
    'no-literal-gui-placement': 'the pinned GUI inventory has no unambiguous literal placement for this field',
    readonly: 'the engine marks this field read-only',
    'unknown-technology-applicability': 'the generated schema cannot prove this field applies to this technology',
  };
  return descriptions[reason] ?? reason.replaceAll('-', ' ');
}
