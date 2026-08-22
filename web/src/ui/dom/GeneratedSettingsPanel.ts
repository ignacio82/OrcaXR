import { EngineOptionCatalog, loadEngineOptionCatalog } from '../../settings/generated/loader';
import type { SettingScope } from '../../settings/generated/settingScopes';
import type { EngineGuiSurface, EngineOptionValue } from '../../settings/generated/types';
import { t } from '../../l10n/t';
import {
  SettingsDraftCommitError,
  SettingsDraftEditor,
  type SettingsDraftCommit,
  type SettingsEditorMode,
  type SettingsFieldProjection,
  type SettingsFieldState,
  type SettingsTechnology,
  type SettingsValueMap,
} from '../../settings/editor';
import {
  expandFullSpectrumSettingsTransaction,
  FULL_SPECTRUM_KEYS,
  getFullSpectrumDependencyState,
  getFullSpectrumSpecialEditorRequirement,
  validateFullSpectrumCrossFields,
  type FullSpectrumDependencyState,
  type FullSpectrumSpecialEditorRequirement,
} from '../../settings/editor/fullSpectrumSemantics';

type MaybePromise<T> = T | Promise<T>;
type DraftOperation = { readonly kind: 'set'; readonly raw: string } | { readonly kind: 'remove' };
type GeneratedSettingsControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLOutputElement;

export interface GeneratedSettingsPanelSnapshot {
  /** Monotonic revision owned by the canonical settings adapter. */
  readonly revision: number;
  /** Canonical state hash paired with `revision`; both must guard apply. */
  readonly sourceHash: string;
  readonly inherited: SettingsValueMap;
  readonly overrides: SettingsValueMap;
}

export interface GeneratedSettingsPanelApplyRequest {
  /** The adapter must reject the whole request if this revision is stale. */
  readonly expectedRevision: number;
  readonly sourceHash: string;
  readonly mode: SettingsEditorMode;
  readonly technology: SettingsTechnology;
  /** One validated editor commit containing every draft change. */
  readonly commit: SettingsDraftCommit;
}

export interface GeneratedSettingsPanelCancelRequest {
  readonly expectedRevision: number;
  readonly sourceHash: string;
  readonly mode: SettingsEditorMode;
  readonly technology: SettingsTechnology;
  readonly draftFieldIds: readonly string[];
}

/**
 * The adapter is the only mutation seam. `apply` must compare
 * `expectedRevision` plus `sourceHash`, commit every change as one canonical operation, and
 * return the resulting authoritative snapshot; it must never partially apply.
 * `cancel` is a single notification after which this surface discards all
 * drafts together.
 */
export interface GeneratedSettingsPanelAdapter {
  load(): MaybePromise<GeneratedSettingsPanelSnapshot>;
  /** Notify when the authoritative settings revision/hash may have changed. */
  subscribe?(listener: () => void): () => void;
  apply(request: GeneratedSettingsPanelApplyRequest): MaybePromise<GeneratedSettingsPanelSnapshot>;
  cancel(request: GeneratedSettingsPanelCancelRequest): MaybePromise<void>;
  onError?(error: unknown): void;
}

export interface GeneratedSettingsPanelOptions {
  readonly heading?: string;
  readonly initialMode?: SettingsEditorMode;
  readonly initialSearch?: string;
  readonly technology?: SettingsTechnology;
  readonly loadCatalog?: () => Promise<EngineOptionCatalog>;
  /**
   * Which pinned GUI surface this panel edits. Defaults to the process tab —
   * the project's own settings. A plate or model scope reads its fields from
   * the corresponding upstream tab instead (P6.5).
   */
  readonly guiSurface?: EngineGuiSurface;
  /**
   * Override scope this panel writes to. Omitted means the project config;
   * anything narrower hides every key the engine would not read there, so the
   * panel cannot offer a control that does nothing.
   */
  readonly scope?: SettingScope;
}

const MODES: readonly { readonly id: SettingsEditorMode; readonly label: string }[] = [
  { id: 'simple', label: 'Simple' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'develop', label: 'Develop' },
];

/** The small per-row reset commands, sized to sit inside the row. */
const COMMAND_BUTTON_STYLE =
  'padding:1px 6px;font-size:10.5px;line-height:16px;color:var(--oxr-color-text-muted);' +
  'background:var(--oxr-color-bg-card);border:1px solid var(--oxr-color-stroke);' +
  'border-radius:var(--oxr-radius-sm);cursor:pointer;';

let panelSequence = 0;

/** Accessible DOM surface for the pinned, generated engine-settings schema. */
export class GeneratedSettingsPanel {
  private readonly instanceId = ++panelSequence;
  private readonly technology: SettingsTechnology;
  private readonly guiSurface: EngineGuiSurface;
  private readonly scope: SettingScope | undefined;
  private mode: SettingsEditorMode;
  private search: string;
  private root?: HTMLFormElement;
  private schemaStatus?: HTMLElement;
  private errorStatus?: HTMLElement;
  private conflictStatus?: HTMLElement;
  private conflictReloadButton?: HTMLButtonElement;
  private resultStatus?: HTMLElement;
  private operationStatus?: HTMLElement;
  private searchInput?: HTMLInputElement;
  private fieldsContainer?: HTMLElement;
  private applyButton?: HTMLButtonElement;
  private cancelButton?: HTMLButtonElement;
  private retryButton?: HTMLButtonElement;
  private readonly modeInputs = new Map<SettingsEditorMode, HTMLInputElement>();
  private catalog?: EngineOptionCatalog;
  private snapshot?: GeneratedSettingsPanelSnapshot;
  private editor?: SettingsDraftEditor;
  private readonly drafts = new Map<string, DraftOperation>();
  private loadPromise?: Promise<void>;
  private lifecycle = 0;
  private loading = false;
  private busy = false;
  private loadFailed = false;
  private authorityConflict = false;
  private authorityRefreshQueued = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: GeneratedSettingsPanelAdapter,
    private readonly options: GeneratedSettingsPanelOptions = {},
  ) {
    this.mode = options.initialMode ?? 'simple';
    this.search = options.initialSearch ?? '';
    this.technology = options.technology ?? 'fff';
    this.guiSurface = options.guiSurface ?? 'process';
    this.scope = options.scope;
  }

  mount(): Promise<void> {
    if (!this.root) {
      this.buildShell();
      try {
        this.unsubscribe = this.adapter.subscribe?.(() => this.handleAuthorityChanged());
      } catch (error) {
        this.showError(error, 'Watching project settings failed');
      }
    }
    if (this.editor) return Promise.resolve();
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  dispose(): void {
    this.lifecycle += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loadPromise = undefined;
    this.modeInputs.clear();
    this.drafts.clear();
    this.root?.remove();
    this.root = undefined;
    this.schemaStatus = undefined;
    this.errorStatus = undefined;
    this.conflictStatus = undefined;
    this.conflictReloadButton = undefined;
    this.resultStatus = undefined;
    this.operationStatus = undefined;
    this.searchInput = undefined;
    this.fieldsContainer = undefined;
    this.applyButton = undefined;
    this.cancelButton = undefined;
    this.retryButton = undefined;
    this.catalog = undefined;
    this.snapshot = undefined;
    this.editor = undefined;
    this.authorityConflict = false;
    this.authorityRefreshQueued = false;
  }

  private buildShell(): void {
    const document = this.container.ownerDocument;
    const form = document.createElement('form');
    form.dataset.generatedSettingsPanel = 'true';
    form.noValidate = true;
    form.setAttribute('aria-labelledby', `orcaxr-generated-settings-title-${this.instanceId}`);
    form.style.cssText =
      'display:flex;min-height:0;flex-direction:column;gap:8px;color:var(--oxr-color-text);' +
      'font:12.5px/1.4 var(--oxr-font-sans);';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.applyDrafts();
    });

    const heading = document.createElement('h2');
    heading.id = `orcaxr-generated-settings-title-${this.instanceId}`;
    heading.textContent = this.options.heading ?? 'Engine settings';
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:700;line-height:1.3;';
    form.appendChild(heading);

    const schemaStatus = document.createElement('p');
    schemaStatus.dataset.settingsSchemaStatus = 'true';
    schemaStatus.setAttribute('role', 'status');
    schemaStatus.setAttribute('aria-live', 'polite');
    schemaStatus.textContent = t(
      'ui.generatedSettingsPanel.loadingThePinnedEngineSettings',
      'Loading the pinned engine settings schema…',
    );
    // The provenance is a paragraph, and a paragraph belongs behind a
    // disclosure in a parameter sidebar: it is what the schema *is*, read once,
    // not something an operator re-reads while changing a layer height.
    schemaStatus.style.cssText = 'margin:6px 0 0;color:var(--oxr-color-text-muted);font-size:11px;';
    const schemaDetails = document.createElement('details');
    schemaDetails.style.cssText = 'margin:0;';
    const schemaSummary = document.createElement('summary');
    schemaSummary.textContent = t('ui.generatedSettingsPanel.schema', 'Schema');
    schemaSummary.style.cssText = 'cursor:pointer;font-size:11px;color:var(--oxr-color-text-muted);list-style:revert;';
    schemaDetails.append(schemaSummary, schemaStatus);
    form.appendChild(schemaDetails);

    const errorStatus = document.createElement('p');
    errorStatus.dataset.settingsError = 'true';
    errorStatus.setAttribute('role', 'alert');
    errorStatus.hidden = true;
    errorStatus.style.cssText = 'margin:0;color:var(--oxr-danger);';
    form.appendChild(errorStatus);

    const conflictStatus = document.createElement('section');
    conflictStatus.dataset.settingsConflict = 'true';
    conflictStatus.setAttribute('role', 'alert');
    conflictStatus.hidden = true;
    conflictStatus.style.cssText =
      'display:grid;gap:8px;margin:0;padding:10px;border:1px solid var(--oxr-warn);' +
      'border-radius:var(--oxr-radius-md);background:var(--oxr-warn-surface);color:var(--oxr-text);';
    const conflictCopy = document.createElement('p');
    conflictCopy.dataset.settingsConflictMessage = 'true';
    conflictCopy.style.cssText = 'margin:0;';
    conflictCopy.textContent = t(
      'ui.generatedSettingsPanel.projectSettingsChangedAfterThis',
      'Project settings changed after this draft began. The draft is preserved, but it cannot be applied to the stale revision.',
    );
    const conflictReload = document.createElement('button');
    conflictReload.type = 'button';
    conflictReload.dataset.settingsConflictReload = 'true';
    conflictReload.textContent = t(
      'ui.generatedSettingsPanel.discardDraftAndReloadCurrent',
      'Discard draft and reload current settings',
    );
    conflictReload.addEventListener('click', () => void this.discardConflictAndReload());
    conflictStatus.append(conflictCopy, conflictReload);
    form.appendChild(conflictStatus);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.settingsRetry = 'true';
    retry.textContent = t('ui.generatedSettingsPanel.retryLoadingSettings', 'Retry loading settings');
    retry.hidden = true;
    retry.addEventListener('click', () => {
      this.loadPromise = this.load();
    });
    form.appendChild(retry);

    const modeFieldset = document.createElement('fieldset');
    modeFieldset.dataset.settingsModes = 'true';
    modeFieldset.style.cssText =
      'display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:8px;border:1px solid ' +
      'var(--oxr-color-stroke,var(--oxr-stroke-strong));border-radius:8px;';
    const modeLegend = document.createElement('legend');
    modeLegend.textContent = t('ui.generatedSettingsPanel.detailLevel', 'Detail level');
    modeLegend.style.cssText = 'padding:0 4px;font-weight:600;font-size:11px;color:var(--oxr-color-text-muted);';
    modeFieldset.appendChild(modeLegend);
    for (const mode of MODES) {
      const label = document.createElement('label');
      label.style.cssText = 'display:inline-flex;align-items:center;gap:5px;cursor:pointer;';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `orcaxr-generated-settings-mode-${this.instanceId}`;
      input.value = mode.id;
      input.dataset.settingsMode = mode.id;
      input.checked = this.mode === mode.id;
      input.addEventListener('change', () => {
        if (!input.checked || this.busy || this.loading) return;
        this.mode = mode.id;
        this.renderFields();
      });
      label.append(input, mode.label);
      modeFieldset.appendChild(label);
      this.modeInputs.set(mode.id, input);
    }
    form.appendChild(modeFieldset);

    const searchLabel = document.createElement('label');
    searchLabel.htmlFor = `orcaxr-generated-settings-search-${this.instanceId}`;
    searchLabel.textContent = t('ui.generatedSettingsPanel.searchSettings', 'Search settings');
    searchLabel.style.cssText = 'font-weight:600;font-size:11px;color:var(--oxr-color-text-muted);';
    form.appendChild(searchLabel);

    const search = document.createElement('input');
    search.id = searchLabel.htmlFor;
    search.type = 'search';
    search.dataset.settingsSearch = 'true';
    search.value = this.search;
    search.placeholder = t(
      'ui.generatedSettingsPanel.nameKeyCategoryTooltipAlias',
      'Name, key, category, tooltip, alias, or enum value',
    );
    search.autocomplete = 'off';
    search.setAttribute('aria-controls', `orcaxr-generated-settings-fields-${this.instanceId}`);
    search.style.cssText =
      'box-sizing:border-box;width:100%;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:7px;background:var(--oxr-color-bg-sunken,#0006);color:inherit;padding:8px 10px;';
    search.addEventListener('input', () => {
      this.search = search.value;
      this.renderFields();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || search.value.length === 0) return;
      event.preventDefault();
      search.value = '';
      this.search = '';
      this.renderFields();
    });
    form.appendChild(search);

    const resultStatus = document.createElement('p');
    resultStatus.id = `orcaxr-generated-settings-results-${this.instanceId}`;
    resultStatus.dataset.settingsResults = 'true';
    resultStatus.setAttribute('role', 'status');
    resultStatus.setAttribute('aria-live', 'polite');
    resultStatus.style.cssText = 'min-height:1.4em;margin:0;color:var(--oxr-color-text-muted);';
    form.appendChild(resultStatus);

    const fields = document.createElement('div');
    fields.id = `orcaxr-generated-settings-fields-${this.instanceId}`;
    fields.dataset.settingsFields = 'true';
    fields.setAttribute('aria-describedby', resultStatus.id);
    fields.style.cssText = 'display:flex;min-height:80px;flex-direction:column;gap:12px;overflow:auto;';
    form.appendChild(fields);

    const operationStatus = document.createElement('p');
    operationStatus.dataset.settingsOperationStatus = 'true';
    operationStatus.setAttribute('role', 'status');
    operationStatus.setAttribute('aria-live', 'polite');
    operationStatus.style.cssText = 'min-height:1.4em;margin:0;color:var(--oxr-color-text-muted);';
    form.appendChild(operationStatus);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.settingsCancel = 'true';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => void this.cancelDrafts());
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.dataset.settingsApply = 'true';
    apply.textContent = 'Apply';
    actions.append(cancel, apply);
    form.appendChild(actions);

    this.container.replaceChildren(form);
    this.root = form;
    this.schemaStatus = schemaStatus;
    this.errorStatus = errorStatus;
    this.conflictStatus = conflictStatus;
    this.conflictReloadButton = conflictReload;
    this.resultStatus = resultStatus;
    this.operationStatus = operationStatus;
    this.searchInput = search;
    this.fieldsContainer = fields;
    this.applyButton = apply;
    this.cancelButton = cancel;
    this.retryButton = retry;
    this.syncControlState();
  }

  private async load(successMessage = ''): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.loading = true;
    this.loadFailed = false;
    this.clearError();
    this.setOperationMessage('');
    if (this.schemaStatus)
      this.schemaStatus.textContent = t(
        'ui.generatedSettingsPanel.loadingThePinnedEngineSettings2',
        'Loading the pinned engine settings schema…',
      );
    this.fieldsContainer?.replaceChildren();
    this.syncControlState();
    try {
      const loadCatalog = this.options.loadCatalog ?? (() => loadEngineOptionCatalog());
      const [catalog, rawSnapshot] = await Promise.all([loadCatalog(), this.adapter.load()]);
      if (lifecycle !== this.lifecycle || !this.root) return;
      const snapshot = validateSnapshot(rawSnapshot);
      const editor = this.createEditor(catalog, snapshot);
      this.catalog = catalog;
      this.snapshot = snapshot;
      this.editor = editor;
      this.drafts.clear();
      this.setAuthorityConflict(false);
      const coverage = catalog.schema.coverage;
      const guiCoverage = catalog.schema.guiLayout.coverage;
      if (this.schemaStatus) {
        this.schemaStatus.textContent =
          `${coverage.definitions} generated definitions / ${coverage.uniqueKeys} engine keys loaded from the ` +
          `pinned schema, with ${guiCoverage.tabs} tabs, ${guiCoverage.groups} groups, and ` +
          `${guiCoverage.literalPlacements} exact literal GUI placements. The schema is foundation-partial; ` +
          'dynamic placements, custom widgets, and unproven scopes stay disabled; dependency and per-control reset rules are not enforced yet.';
      }
      this.renderFields();
      if (successMessage) this.setOperationMessage(successMessage);
    } catch (error) {
      if (lifecycle !== this.lifecycle || !this.root) return;
      this.loadFailed = true;
      if (this.schemaStatus)
        this.schemaStatus.textContent = t(
          'ui.generatedSettingsPanel.engineSettingsCouldNotBe',
          'Engine settings could not be loaded.',
        );
      this.showError(error, 'Loading settings failed');
    } finally {
      if (lifecycle === this.lifecycle && this.root) {
        this.loading = false;
        this.loadPromise = undefined;
        this.syncControlState();
        const refreshQueued = this.authorityRefreshQueued;
        this.authorityRefreshQueued = false;
        if (refreshQueued) void Promise.resolve().then(() => this.handleAuthorityChanged());
      }
    }
  }

  private handleAuthorityChanged(): void {
    if (!this.root) return;
    if (this.loading || this.busy) {
      this.authorityRefreshQueued = true;
      return;
    }
    if (this.drafts.size > 0) {
      this.setAuthorityConflict(true);
      this.setOperationMessage(
        'The project changed while this draft was open. Review the preserved draft, then discard and reload before editing the current revision.',
      );
      this.syncControlState();
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.load('Project settings refreshed from the current canonical revision.');
    }
  }

  private async discardConflictAndReload(): Promise<void> {
    if (!this.authorityConflict || this.loading || this.busy || !this.root) return;
    this.drafts.clear();
    this.setAuthorityConflict(false);
    this.loadPromise = this.load('Discarded the stale draft and reloaded current project settings.');
    await this.loadPromise;
  }

  private setAuthorityConflict(conflict: boolean): void {
    this.authorityConflict = conflict;
    if (this.conflictStatus) this.conflictStatus.hidden = !conflict;
    if (this.conflictReloadButton) this.conflictReloadButton.disabled = !conflict || this.loading || this.busy;
  }

  private createEditor(catalog: EngineOptionCatalog, snapshot: GeneratedSettingsPanelSnapshot): SettingsDraftEditor {
    return new SettingsDraftEditor(catalog, {
      mode: this.mode,
      technology: this.technology,
      // Which upstream tab supplies the fields, and — when the adapter writes a
      // plate or model node — which keys the engine will actually read there.
      guiSurface: this.guiSurface,
      ...(this.scope ? { scope: this.scope } : {}),
      inherited: snapshot.inherited,
      overrides: snapshot.overrides,
    });
  }

  private renderFields(): void {
    const editor = this.editor;
    const container = this.fieldsContainer;
    const resultStatus = this.resultStatus;
    if (!editor || !container || !resultStatus) return;
    const fields = editor.query({
      mode: this.mode,
      technology: this.technology,
      guiSurface: this.guiSurface,
      ...(this.scope ? { scope: this.scope } : {}),
      search: this.search,
      includeUnavailable: true,
      includeUnknownApplicability: true,
    });
    const unavailable = fields.filter(
      (field) =>
        field.support.status === 'unavailable' || getFullSpectrumSpecialEditorRequirement(field.key) !== undefined,
    ).length;
    resultStatus.textContent = `${fields.length} setting${fields.length === 1 ? '' : 's'} shown; ${unavailable} unavailable.`;

    if (fields.length === 0) {
      const empty = container.ownerDocument.createElement('p');
      empty.textContent = t(
        'ui.generatedSettingsPanel.noSettingsMatchThisSearch',
        'No settings match this search and detail level.',
      );
      empty.style.cssText = 'margin:0;padding:12px;border:1px solid var(--oxr-color-stroke);border-radius:8px;';
      container.replaceChildren(empty);
      this.syncControlState();
      return;
    }

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
    const fullSpectrumValues = this.fullSpectrumEffectiveValues(editor);
    const sections = [...categories.values()].map((category, categoryIndex) =>
      this.buildCategory(category.label, category.fields, categoryIndex, fullSpectrumValues),
    );
    container.replaceChildren(...sections);
    this.syncControlState();
  }

  private buildCategory(
    category: string,
    fields: readonly SettingsFieldProjection[],
    categoryIndex: number,
    fullSpectrumValues: SettingsValueMap,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const section = document.createElement('section');
    const headingId = `orcaxr-settings-category-${this.instanceId}-${categoryIndex}`;
    section.setAttribute('aria-labelledby', headingId);
    section.dataset.settingsCategory = category;
    const location = fields[0]?.primaryGuiLocation;
    if (location) {
      section.dataset.settingsSurface = location.placement.surface;
      section.dataset.settingsPage = location.tab.label;
      section.dataset.settingsGroup = location.group.label;
    }
    section.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const heading = document.createElement('h3');
    heading.id = headingId;
    heading.textContent = category;
    // A settings group header, the way the desktop panel writes one: small,
    // bold, and separated from the rows by a hairline rather than a gap.
    heading.style.cssText =
      'margin:0 0 4px;padding-bottom:4px;border-bottom:1px solid var(--oxr-color-stroke);' +
      'font-size:12px;font-weight:700;';
    section.appendChild(heading);
    fields.forEach((field, fieldIndex) =>
      section.appendChild(this.buildField(field, `${categoryIndex}-${fieldIndex}`, fullSpectrumValues)),
    );
    return section;
  }

  private buildField(field: SettingsFieldProjection, index: string, fullSpectrumValues: SettingsValueMap): HTMLElement {
    const editor = this.editor!;
    const state = editor.getFieldState(field.id);
    const specialEditor = getFullSpectrumSpecialEditorRequirement(field.key);
    const dependency = getFullSpectrumDependencyState(field.key, fullSpectrumValues);
    const genericEditable = field.support.status === 'implemented' && specialEditor === undefined;
    const dependencyEnabled = dependency?.enabled !== false;
    const fieldIssues = this.fieldIssues(state, fullSpectrumValues);
    const document = this.container.ownerDocument;
    const row = document.createElement('div');
    row.dataset.settingsFieldId = field.id;
    row.dataset.settingsKey = field.key;
    row.dataset.settingsSupport = specialEditor?.kind ?? field.support.status;
    row.dataset.settingsApplicability = dependency
      ? dependency.applicable
        ? 'applicable'
        : 'not-applicable'
      : field.applicability;
    // One line per setting: name at the inline start, control after it. The
    // boxed card this replaced turned a page of thirty settings into a page of
    // thirty cards, which is not how a slicer's parameter panel reads.
    row.style.cssText =
      'display:grid;grid-template-columns:minmax(96px,1fr) minmax(110px,1fr);gap:2px 10px;' +
      'align-items:center;padding:3px 0;';

    const controlId = `orcaxr-settings-control-${this.instanceId}-${index}`;
    const labelBlock = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = controlId;
    label.textContent = field.label;
    label.style.cssText = 'display:block;font-size:12px;';
    const key = document.createElement('code');
    key.textContent = field.key;
    key.style.cssText =
      'display:block;color:var(--oxr-color-text-muted);font-size:10px;background:none;border:none;padding:0;';
    labelBlock.append(label, key);
    row.appendChild(labelBlock);

    const controlBlock = document.createElement('div');
    controlBlock.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0;';
    const control = this.buildControl(
      field,
      state,
      controlId,
      genericEditable,
      dependencyEnabled,
      specialEditor,
      fieldIssues.length > 0,
    );
    controlBlock.appendChild(control);
    if (field.unit) {
      const unit = document.createElement('span');
      unit.textContent = field.unit;
      unit.dataset.settingsUnit = 'true';
      unit.style.cssText = 'color:var(--oxr-color-text-muted);white-space:nowrap;';
      controlBlock.appendChild(unit);
    }
    row.appendChild(controlBlock);

    const indicators = document.createElement('div');
    indicators.dataset.settingsIndicators = 'true';
    indicators.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:5px;';
    this.renderIndicators(indicators, state, specialEditor, dependency);
    row.appendChild(indicators);

    const commands = document.createElement('div');
    commands.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;';
    if (genericEditable) {
      const inherit = document.createElement('button');
      inherit.type = 'button';
      inherit.dataset.settingsResetInherited = field.id;
      inherit.dataset.settingsEditable = 'true';
      inherit.dataset.settingsDependencyEnabled = String(dependencyEnabled);
      inherit.textContent = t('ui.generatedSettingsPanel.useInherited', 'Use inherited');
      inherit.style.cssText = COMMAND_BUTTON_STYLE;
      inherit.addEventListener('click', () => {
        editor.resetToInherited(field.id);
        this.drafts.set(field.id, { kind: 'remove' });
        this.expandFullSpectrumDrafts(editor, [field.key], true);
        this.renderFields();
      });
      commands.appendChild(inherit);
      if (field.definition.default.provided) {
        const resetDefault = document.createElement('button');
        resetDefault.type = 'button';
        resetDefault.dataset.settingsResetDefault = field.id;
        resetDefault.dataset.settingsEditable = 'true';
        resetDefault.dataset.settingsDependencyEnabled = String(dependencyEnabled);
        resetDefault.textContent = t('ui.generatedSettingsPanel.useDefault', 'Use default');
        resetDefault.style.cssText = COMMAND_BUTTON_STYLE;
        resetDefault.addEventListener('click', () => {
          editor.resetToDefault(field.id);
          const nextState = editor.getFieldState(field.id);
          if (nextState.draftSerialized === undefined) {
            this.showError(
              new Error(`Generated default for ${field.key} could not be serialized`),
              'Default reset failed',
            );
            return;
          }
          this.drafts.set(field.id, { kind: 'set', raw: nextState.draftSerialized });
          this.expandFullSpectrumDrafts(editor, [field.key], true);
          this.renderFields();
        });
        commands.appendChild(resetDefault);
      }
    }
    row.appendChild(commands);

    const describedBy: string[] = [];
    if (field.tooltip) {
      const help = document.createElement('p');
      help.id = `${controlId}-help`;
      help.textContent = field.tooltip;
      // Upstream shows a setting's explanation on hover, and a sidebar of forty
      // settings is unreadable with a paragraph under each one. The text stays
      // in the DOM — `aria-describedby` points at it, so a screen reader still
      // reads it — and the row carries it as a tooltip for the pointer.
      help.style.cssText =
        'position:absolute;width:1px;height:1px;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;';
      row.appendChild(help);
      row.title = field.tooltip;
      describedBy.push(help.id);
    }
    if (field.support.status === 'unavailable') {
      const unavailable = document.createElement('p');
      unavailable.id = `${controlId}-unavailable`;
      unavailable.dataset.settingsUnavailableReason = field.support.reason ?? 'unspecified';
      unavailable.textContent = `Unavailable: ${formatUnavailableReason(field.support.reason)}`;
      unavailable.style.cssText = 'grid-column:1/-1;margin:0;color:var(--oxr-warn);font-size:12px;';
      row.appendChild(unavailable);
      describedBy.push(unavailable.id);
    }
    if (specialEditor) {
      const special = document.createElement('p');
      special.id = `${controlId}-structured-editor`;
      special.dataset.settingsStructuredEditor = specialEditor.editorId;
      special.textContent = t(
        'ui.generatedSettingsPanel.managedByTheStructuredFullSpectrum',
        'Managed by the structured FullSpectrum recipe editor. Raw serialized definition editing is disabled here.',
      );
      special.style.cssText = 'grid-column:1/-1;margin:0;color:var(--oxr-warn);font-size:12px;';
      row.appendChild(special);
      describedBy.push(special.id);
    }
    if (dependency && !dependency.enabled) {
      const dependencyMessage = document.createElement('p');
      dependencyMessage.id = `${controlId}-dependency`;
      dependencyMessage.dataset.settingsDependencyState = 'disabled';
      dependencyMessage.dataset.settingsDependencyController = dependency.controllerKey;
      dependencyMessage.textContent = t(
        'ui.generatedSettingsPanel.notApplicableWhileSubdivideMix',
        'Not applicable while Subdivide Mix Layer is off. Enable it to edit this Local-Z option.',
      );
      dependencyMessage.style.cssText = 'grid-column:1/-1;margin:0;color:var(--oxr-color-text-muted);font-size:12px;';
      row.appendChild(dependencyMessage);
      describedBy.push(dependencyMessage.id);
    }
    const issues = document.createElement('ul');
    issues.id = `${controlId}-issues`;
    issues.dataset.settingsIssues = field.id;
    issues.setAttribute('role', 'alert');
    issues.style.cssText =
      'grid-column:1/-1;margin:0;padding-inline-start:20px;color:var(--oxr-danger);font-size:12px;';
    this.renderIssues(issues, fieldIssues);
    row.appendChild(issues);
    describedBy.push(issues.id);
    control.setAttribute('aria-describedby', describedBy.join(' '));

    if (genericEditable && dependencyEnabled && isDraftControl(control)) {
      const updateDraftFeedback = (raw: string) => {
        editor.setDraft(field.id, raw);
        this.drafts.set(field.id, { kind: 'set', raw });
        this.expandFullSpectrumDrafts(editor, [field.key], true);
        const nextState = editor.getFieldState(field.id);
        this.renderIndicators(indicators, nextState, specialEditor, dependency);
        const nextFullSpectrumValues = this.fullSpectrumEffectiveValues(editor);
        const nextIssues = this.fieldIssues(nextState, nextFullSpectrumValues);
        this.renderIssues(issues, nextIssues);
        control.setAttribute('aria-invalid', String(nextIssues.length > 0));
        this.clearError();
        this.setOperationMessage('Draft changes are not applied yet.');
        if (field.key === FULL_SPECTRUM_KEYS.localZMode) {
          this.renderFields();
          return;
        }
        if (field.key === FULL_SPECTRUM_KEYS.heightLowerBound || field.key === FULL_SPECTRUM_KEYS.heightUpperBound) {
          this.refreshFullSpectrumCrossFieldIssues(nextFullSpectrumValues);
        }
        this.syncControlState();
      };
      if (control instanceof document.defaultView!.HTMLInputElement && control.type === 'checkbox') {
        control.addEventListener('change', () => updateDraftFeedback(control.checked ? '1' : '0'));
      } else {
        control.addEventListener(control instanceof document.defaultView!.HTMLSelectElement ? 'change' : 'input', () =>
          updateDraftFeedback(control.value),
        );
      }
    }
    return row;
  }

  private buildControl(
    field: SettingsFieldProjection,
    state: SettingsFieldState,
    controlId: string,
    editable: boolean,
    dependencyEnabled: boolean,
    specialEditor: FullSpectrumSpecialEditorRequirement | undefined,
    invalid: boolean,
  ): GeneratedSettingsControl {
    const document = this.container.ownerDocument;
    const definition = field.definition;
    const rawValue = fieldRawValue(state);
    let control: GeneratedSettingsControl;

    if (specialEditor) {
      const output = document.createElement('output');
      output.value = 'Use the structured FullSpectrum recipe editor';
      output.dataset.settingsStructuredEditorTarget = specialEditor.editorId;
      control = output;
    } else if (!editable) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = rawValue;
      control = input;
    } else if (
      definition.storage.shape === 'scalar' &&
      definition.storage.valueType === 'bool' &&
      !definition.storage.nullable
    ) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.draftValue === true || (state.draftValue === undefined && state.value === true);
      control = input;
    } else if (definition.storage.shape === 'scalar' && definition.storage.valueType === 'enum') {
      const select = document.createElement('select');
      if (definition.storage.nullable) {
        const nil = document.createElement('option');
        nil.value = definition.storage.serialization.nilToken ?? 'nil';
        nil.textContent = t('ui.generatedSettingsPanel.notSet', 'Not set');
        select.appendChild(nil);
      }
      for (const choice of field.enumChoices) {
        const option = document.createElement('option');
        option.value = choice.serialized;
        option.textContent = choice.label;
        select.appendChild(option);
      }
      select.value = rawValue;
      control = select;
    } else if (definition.storage.valueType === 'string' && definition.presentation.multiline.value) {
      const textarea = document.createElement('textarea');
      textarea.value = rawValue;
      textarea.rows = multilineRows(definition.presentation.height.value);
      textarea.spellcheck = false;
      textarea.style.fontFamily = 'ui-monospace,SFMono-Regular,monospace';
      control = textarea;
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = rawValue;
      input.autocomplete = 'off';
      input.spellcheck = definition.storage.valueType === 'string';
      if (definition.storage.valueType === 'int') input.inputMode = 'numeric';
      if (definition.storage.valueType === 'float' || definition.storage.valueType === 'float-or-percent') {
        input.inputMode = 'decimal';
      }
      control = input;
    }

    control.id = controlId;
    control.dataset.settingsControl = field.id;
    control.dataset.settingsEditable = String(editable);
    control.dataset.settingsDependencyEnabled = String(dependencyEnabled);
    if ('disabled' in control) control.disabled = !editable || !dependencyEnabled || this.busy || this.loading;
    control.setAttribute('aria-invalid', String(invalid));
    control.style.cssText +=
      'box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--oxr-color-stroke);' +
      'border-radius:6px;background:var(--oxr-color-bg-sunken,#0006);color:inherit;padding:7px 8px;';
    if (control instanceof document.defaultView!.HTMLInputElement && control.type === 'checkbox') {
      control.style.width = 'auto';
      control.style.minWidth = '18px';
      control.style.height = '18px';
    }
    return control;
  }

  private renderIndicators(
    container: HTMLElement,
    state: SettingsFieldState,
    specialEditor?: FullSpectrumSpecialEditorRequirement,
    dependency?: FullSpectrumDependencyState,
  ): void {
    const document = container.ownerDocument;
    const badges: HTMLElement[] = [];
    const origin = document.createElement('span');
    origin.dataset.settingsOrigin = state.origin;
    origin.textContent = originLabel(state.origin);
    badges.push(origin);
    if (state.draftChanged) {
      const draft = document.createElement('span');
      draft.dataset.settingsDraft = 'changed';
      draft.textContent = t('ui.generatedSettingsPanel.draftChanged', 'Draft changed');
      badges.push(draft);
    }
    if (specialEditor) {
      const structured = document.createElement('span');
      structured.dataset.settingsAvailability = 'structured-editor';
      structured.textContent = t('ui.generatedSettingsPanel.structuredEditor', 'Structured editor');
      badges.push(structured);
    } else if (state.field.support.status === 'unavailable') {
      const unavailable = document.createElement('span');
      unavailable.dataset.settingsAvailability = 'unavailable';
      unavailable.textContent = 'Unavailable';
      badges.push(unavailable);
    }
    if (dependency && !dependency.enabled) {
      const notApplicable = document.createElement('span');
      notApplicable.dataset.settingsApplicability = 'not-applicable';
      notApplicable.textContent = t('ui.generatedSettingsPanel.notApplicable', 'Not applicable');
      badges.push(notApplicable);
    }
    for (const badge of badges) {
      badge.style.cssText =
        'display:inline-block;border:1px solid var(--oxr-color-stroke);border-radius:999px;' +
        'padding:2px 7px;color:var(--oxr-color-text-muted);font-size:11px;';
    }
    container.replaceChildren(...badges);
  }

  private renderIssues(
    container: HTMLElement,
    issues: readonly { readonly code: string; readonly message: string }[],
  ): void {
    const document = container.ownerDocument;
    const entries = issues.map((issue) => {
      const item = document.createElement('li');
      item.textContent = issue.message;
      item.dataset.settingsIssueCode = issue.code;
      return item;
    });
    container.replaceChildren(...entries);
    container.hidden = entries.length === 0;
  }

  private fullSpectrumEffectiveValues(editor: SettingsDraftEditor): SettingsValueMap {
    const catalog = this.catalog;
    if (!catalog) return {};
    const values: Record<string, EngineOptionValue> = {};
    for (const key of Object.values(FULL_SPECTRUM_KEYS)) {
      if (!catalog.has(key) || catalog.all(key).length !== 1) continue;
      const state = editor.getFieldState(catalog.get(key).id);
      const value = state.draftRaw !== undefined ? state.draftValue : (state.draftValue ?? state.value);
      if (value !== undefined) values[key] = value;
    }
    return values;
  }

  private expandFullSpectrumDrafts(
    editor: SettingsDraftEditor,
    changedKeys: readonly string[],
    recordDrafts: boolean,
  ): void {
    const catalog = this.catalog;
    if (!catalog) return;
    const expansion = expandFullSpectrumSettingsTransaction({
      changedKeys,
      effectiveValues: this.fullSpectrumEffectiveValues(editor),
    });
    for (const key of expansion.implicitKeys) {
      const value = expansion.implicitValues[key];
      if (value === undefined || !catalog.has(key) || catalog.all(key).length !== 1) continue;
      const fieldId = catalog.get(key).id;
      const raw = value ? '1' : '0';
      editor.setDraft(fieldId, raw);
      if (recordDrafts) this.drafts.set(fieldId, { kind: 'set', raw });
    }
  }

  private fieldIssues(
    state: SettingsFieldState,
    fullSpectrumValues: SettingsValueMap,
  ): readonly { readonly code: string; readonly message: string }[] {
    const crossFieldIssues = validateFullSpectrumCrossFields(fullSpectrumValues).filter((issue) =>
      issue.relatedKeys.includes(state.field.key as (typeof issue.relatedKeys)[number]),
    );
    return [...state.issues, ...crossFieldIssues];
  }

  private refreshFullSpectrumCrossFieldIssues(fullSpectrumValues: SettingsValueMap): void {
    const editor = this.editor;
    const catalog = this.catalog;
    const root = this.root;
    if (!editor || !catalog || !root) return;
    for (const key of [FULL_SPECTRUM_KEYS.heightLowerBound, FULL_SPECTRUM_KEYS.heightUpperBound]) {
      if (!catalog.has(key) || catalog.all(key).length !== 1) continue;
      const row = root.querySelector<HTMLElement>(`[data-settings-key="${key}"]`);
      if (!row) continue;
      const state = editor.getFieldState(catalog.get(key).id);
      const issues = this.fieldIssues(state, fullSpectrumValues);
      const issuesContainer = row.querySelector<HTMLElement>('[data-settings-issues]');
      if (issuesContainer) this.renderIssues(issuesContainer, issues);
      row
        .querySelector<GeneratedSettingsControl>('[data-settings-control]')
        ?.setAttribute('aria-invalid', String(issues.length > 0));
    }
  }

  private replayDrafts(editor: SettingsDraftEditor): void {
    for (const [fieldId, operation] of this.drafts) {
      if (operation.kind === 'set') editor.setDraft(fieldId, operation.raw);
      else editor.resetToInherited(fieldId);
    }
  }

  private async applyDrafts(): Promise<void> {
    const catalog = this.catalog;
    const snapshot = this.snapshot;
    if (!catalog || !snapshot || this.busy || this.loading || this.authorityConflict) return;
    const staging = this.createEditor(catalog, snapshot);
    this.replayDrafts(staging);
    let commit: SettingsDraftCommit;
    try {
      const changedKeys = [...this.drafts.keys()].map((fieldId) => staging.getFieldState(fieldId).field.key);
      this.expandFullSpectrumDrafts(staging, changedKeys, false);
      const crossFieldIssues = validateFullSpectrumCrossFields(this.fullSpectrumEffectiveValues(staging));
      if (crossFieldIssues.length > 0) throw new SettingsDraftCommitError(crossFieldIssues);
      commit = staging.commit();
    } catch (error) {
      if (error instanceof SettingsDraftCommitError) {
        this.showError(error, 'Fix the highlighted validation errors before applying');
        return;
      }
      this.showError(error, 'Settings could not be validated');
      return;
    }
    if (commit.changes.length === 0) {
      this.editor = this.createEditor(catalog, snapshot);
      this.drafts.clear();
      this.renderFields();
      this.setOperationMessage('No effective settings changes to apply.');
      return;
    }

    this.setBusy(true);
    this.clearError();
    this.setOperationMessage(
      `Applying ${commit.changes.length} setting change${commit.changes.length === 1 ? '' : 's'}…`,
    );
    let adapterApplied = false;
    try {
      const rawNextSnapshot = await this.adapter.apply({
        expectedRevision: snapshot.revision,
        sourceHash: snapshot.sourceHash,
        mode: this.mode,
        technology: this.technology,
        commit,
      });
      adapterApplied = true;
      const nextSnapshot = validateSnapshot(rawNextSnapshot);
      if (!this.root) return;
      this.snapshot = nextSnapshot;
      this.editor = this.createEditor(catalog, nextSnapshot);
      this.drafts.clear();
      this.authorityRefreshQueued = false;
      this.setAuthorityConflict(false);
      this.renderFields();
      this.setOperationMessage(
        `Applied ${commit.changes.length} setting change${commit.changes.length === 1 ? '' : 's'} atomically.`,
      );
    } catch (error) {
      if (!this.root) return;
      if (adapterApplied) {
        this.snapshot = undefined;
        this.editor = undefined;
        this.drafts.clear();
        this.loadFailed = true;
        if (this.schemaStatus) {
          this.schemaStatus.textContent = t(
            'ui.generatedSettingsPanel.theSettingsResultMustBe',
            'The settings result must be reloaded before editing can continue.',
          );
        }
        this.fieldsContainer?.replaceChildren();
      }
      this.showError(
        error,
        adapterApplied
          ? 'Settings applied, but the authoritative result could not be loaded'
          : 'No settings were applied',
      );
      this.setOperationMessage(
        adapterApplied
          ? 'Reload settings before making another change.'
          : 'Draft changes are still available for review.',
      );
    } finally {
      if (this.root) this.setBusy(false);
    }
  }

  private async cancelDrafts(): Promise<void> {
    const catalog = this.catalog;
    const snapshot = this.snapshot;
    if (!catalog || !snapshot || this.busy || this.loading) return;
    if (this.authorityConflict) {
      await this.discardConflictAndReload();
      return;
    }
    this.setBusy(true);
    this.clearError();
    try {
      await this.adapter.cancel({
        expectedRevision: snapshot.revision,
        sourceHash: snapshot.sourceHash,
        mode: this.mode,
        technology: this.technology,
        draftFieldIds: [...this.drafts.keys()].sort((left, right) => left.localeCompare(right, 'en')),
      });
      if (!this.root) return;
      this.editor = this.createEditor(catalog, snapshot);
      this.drafts.clear();
      this.renderFields();
      this.setOperationMessage('Draft settings changes cancelled.');
    } catch (error) {
      if (!this.root) return;
      this.showError(error, 'Settings cancellation failed');
      this.setOperationMessage('Draft changes are still available for review.');
    } finally {
      if (this.root) this.setBusy(false);
    }
  }

  private draftState(): { readonly changed: boolean; readonly invalid: boolean } {
    const editor = this.editor;
    if (!editor) return { changed: false, invalid: false };
    let changed = false;
    let invalid = false;
    for (const fieldId of this.drafts.keys()) {
      const state = editor.getFieldState(fieldId);
      changed ||= state.draftChanged;
      invalid ||= state.issues.length > 0;
    }
    invalid ||= validateFullSpectrumCrossFields(this.fullSpectrumEffectiveValues(editor)).length > 0;
    return { changed, invalid };
  }

  private setBusy(busy: boolean): void {
    const wasBusy = this.busy;
    this.busy = busy;
    this.syncControlState();
    if (wasBusy && !busy && this.authorityRefreshQueued && !this.loading) {
      this.authorityRefreshQueued = false;
      void Promise.resolve().then(() => this.handleAuthorityChanged());
    }
  }

  private syncControlState(): void {
    const ready = Boolean(this.editor) && !this.loading;
    const interactive = ready && !this.busy;
    this.root?.setAttribute('aria-busy', String(this.loading || this.busy));
    if (this.searchInput) this.searchInput.disabled = !interactive;
    for (const input of this.modeInputs.values()) input.disabled = !interactive;
    this.root
      ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-settings-control]')
      .forEach((control) => {
        control.disabled =
          !interactive ||
          control.dataset.settingsEditable !== 'true' ||
          control.dataset.settingsDependencyEnabled === 'false';
      });
    this.root?.querySelectorAll<HTMLButtonElement>('[data-settings-editable="true"]').forEach((button) => {
      button.disabled = !interactive || button.dataset.settingsDependencyEnabled === 'false';
    });
    const draft = this.draftState();
    if (this.applyButton) {
      this.applyButton.disabled = !interactive || !draft.changed || draft.invalid || this.authorityConflict;
    }
    if (this.cancelButton) this.cancelButton.disabled = !interactive;
    if (this.conflictReloadButton) {
      this.conflictReloadButton.disabled = !this.authorityConflict || this.loading || this.busy;
    }
    if (this.retryButton) {
      this.retryButton.hidden = !this.loadFailed;
      this.retryButton.disabled = this.loading || this.busy;
    }
  }

  private clearError(): void {
    if (!this.errorStatus) return;
    this.errorStatus.textContent = '';
    this.errorStatus.hidden = true;
  }

  private showError(error: unknown, prefix: string): void {
    if (this.errorStatus) {
      this.errorStatus.textContent = `${prefix}: ${errorMessage(error)}`;
      this.errorStatus.hidden = false;
    }
    try {
      this.adapter.onError?.(error);
    } catch {
      // Error reporting must not replace the original failure or mutate drafts.
    }
  }

  private setOperationMessage(message: string): void {
    if (this.operationStatus) this.operationStatus.textContent = message;
  }
}

function validateSnapshot(value: GeneratedSettingsPanelSnapshot): GeneratedSettingsPanelSnapshot {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('Settings snapshot revision must be a non-negative safe integer');
  }
  if (typeof value.sourceHash !== 'string' || value.sourceHash.length === 0) {
    throw new Error('Settings snapshot source hash must be a non-empty string');
  }
  if (!isRecord(value.inherited) || !isRecord(value.overrides)) {
    throw new Error('Settings snapshot inherited and override values must be records');
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, EngineOptionValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDraftControl(
  control: GeneratedSettingsControl,
): control is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const view = control.ownerDocument.defaultView;
  return Boolean(
    view &&
    (control instanceof view.HTMLInputElement ||
      control instanceof view.HTMLSelectElement ||
      control instanceof view.HTMLTextAreaElement),
  );
}

function fieldRawValue(state: SettingsFieldState): string {
  if (state.draftRaw !== undefined) return state.draftRaw;
  if (state.draftSerialized !== undefined) return state.draftSerialized;
  if (state.serializedValue !== undefined) return state.serializedValue;
  const value = state.draftValue ?? state.value;
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function multilineRows(heightHint: number | null): number {
  const rows = heightHint === null ? 4 : heightHint > 30 ? Math.round(heightHint / 20) : Math.round(heightHint);
  return Math.min(12, Math.max(3, rows));
}

function originLabel(origin: SettingsFieldState['origin']): string {
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

function guiSurfaceLabel(surface: string): string {
  const labels: Readonly<Record<string, string>> = {
    filament: 'Filament',
    object: 'Object',
    plate: 'Plate',
    printer: 'Printer',
    process: 'Process',
  };
  return labels[surface] ?? surface;
}

function formatUnavailableReason(reason: string | undefined): string {
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown settings error';
}
