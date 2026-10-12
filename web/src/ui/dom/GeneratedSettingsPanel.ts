import { EngineOptionCatalog, loadEngineOptionCatalog } from '../../settings/generated/loader';
import type { SettingScope } from '../../settings/generated/settingScopes';
import type { EngineGuiSurface, EngineOptionValue } from '../../settings/generated/types';
import { t } from '../../l10n/t';
import {
  SettingsDraftCommitError,
  type SettingsDraftCommit,
  type SettingsEditorMode,
  type SettingsTechnology,
  type SettingsValueMap,
} from '../../settings/editor';
import { FULL_SPECTRUM_KEYS } from '../../settings/editor/fullSpectrumSemantics';
import {
  SettingsPanelModel,
  type SettingsPanelIssue,
  type SettingsPanelRow,
  type SettingsPanelSection,
} from '../../settings/editor/settingsPanel';

type MaybePromise<T> = T | Promise<T>;
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
  /** The panel's fields, controls and drafts (`settingsPanel.ts`, shared with native hosts). */
  private model?: SettingsPanelModel;
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
    if (this.model) return Promise.resolve();
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  dispose(): void {
    this.lifecycle += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loadPromise = undefined;
    this.modeInputs.clear();
    this.model = undefined;
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
      const model = this.createModel(catalog, snapshot);
      this.catalog = catalog;
      this.snapshot = snapshot;
      this.model = model;
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
    if (this.model?.hasDrafts) {
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
    this.model?.discard();
    this.setAuthorityConflict(false);
    this.loadPromise = this.load('Discarded the stale draft and reloaded current project settings.');
    await this.loadPromise;
  }

  private setAuthorityConflict(conflict: boolean): void {
    this.authorityConflict = conflict;
    if (this.conflictStatus) this.conflictStatus.hidden = !conflict;
    if (this.conflictReloadButton) this.conflictReloadButton.disabled = !conflict || this.loading || this.busy;
  }

  private createModel(catalog: EngineOptionCatalog, snapshot: GeneratedSettingsPanelSnapshot): SettingsPanelModel {
    return new SettingsPanelModel(catalog, {
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
    const model = this.model;
    const container = this.fieldsContainer;
    const resultStatus = this.resultStatus;
    if (!model || !container || !resultStatus) return;
    const view = model.view(this.mode, this.search);
    resultStatus.textContent = view.summary;

    if (view.shown === 0) {
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

    container.replaceChildren(...view.sections.map((section, index) => this.buildCategory(section, index)));
    this.syncControlState();
  }

  private buildCategory(category: SettingsPanelSection, categoryIndex: number): HTMLElement {
    const document = this.container.ownerDocument;
    const section = document.createElement('section');
    const headingId = `orcaxr-settings-category-${this.instanceId}-${categoryIndex}`;
    section.setAttribute('aria-labelledby', headingId);
    section.dataset.settingsCategory = category.label;
    if (category.surface !== undefined) section.dataset.settingsSurface = category.surface;
    if (category.page !== undefined) section.dataset.settingsPage = category.page;
    if (category.group !== undefined) section.dataset.settingsGroup = category.group;
    section.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const heading = document.createElement('h3');
    heading.id = headingId;
    heading.textContent = category.label;
    // A settings group header, the way the desktop panel writes one: small,
    // bold, and separated from the rows by a hairline rather than a gap.
    heading.style.cssText =
      'margin:0 0 4px;padding-bottom:4px;border-bottom:1px solid var(--oxr-color-stroke);' +
      'font-size:12px;font-weight:700;';
    section.appendChild(heading);
    category.rows.forEach((row, fieldIndex) =>
      section.appendChild(this.buildField(row, `${categoryIndex}-${fieldIndex}`)),
    );
    return section;
  }

  private buildField(field: SettingsPanelRow, index: string): HTMLElement {
    const model = this.model!;
    const document = this.container.ownerDocument;
    const row = document.createElement('div');
    row.dataset.settingsFieldId = field.fieldId;
    row.dataset.settingsKey = field.key;
    row.dataset.settingsSupport = field.support;
    row.dataset.settingsApplicability = field.applicability;
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
    const control = this.buildControl(field, controlId);
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
    this.renderIndicators(indicators, field);
    row.appendChild(indicators);

    const commands = document.createElement('div');
    commands.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;';
    if (field.inherit) {
      const inherit = document.createElement('button');
      inherit.type = 'button';
      inherit.dataset.settingsResetInherited = field.fieldId;
      inherit.dataset.settingsEditable = 'true';
      inherit.dataset.settingsDependencyEnabled = String(field.dependencyEnabled);
      inherit.textContent = t('ui.generatedSettingsPanel.useInherited', 'Use inherited');
      inherit.style.cssText = COMMAND_BUTTON_STYLE;
      inherit.addEventListener('click', () => {
        model.inherit(field.fieldId);
        this.renderFields();
      });
      commands.appendChild(inherit);
    }
    if (field.useDefault) {
      const resetDefault = document.createElement('button');
      resetDefault.type = 'button';
      resetDefault.dataset.settingsResetDefault = field.fieldId;
      resetDefault.dataset.settingsEditable = 'true';
      resetDefault.dataset.settingsDependencyEnabled = String(field.dependencyEnabled);
      resetDefault.textContent = t('ui.generatedSettingsPanel.useDefault', 'Use default');
      resetDefault.style.cssText = COMMAND_BUTTON_STYLE;
      resetDefault.addEventListener('click', () => {
        const reset = model.useDefault(field.fieldId);
        if (!reset.ok) {
          this.showError(reset.error, 'Default reset failed');
          return;
        }
        this.renderFields();
      });
      commands.appendChild(resetDefault);
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
    if (field.unavailable) {
      const unavailable = document.createElement('p');
      unavailable.id = `${controlId}-unavailable`;
      unavailable.dataset.settingsUnavailableReason = field.unavailable.reason;
      unavailable.textContent = field.unavailable.message;
      unavailable.style.cssText = 'grid-column:1/-1;margin:0;color:var(--oxr-warn);font-size:12px;';
      row.appendChild(unavailable);
      describedBy.push(unavailable.id);
    }
    if (field.structuredEditor) {
      const special = document.createElement('p');
      special.id = `${controlId}-structured-editor`;
      special.dataset.settingsStructuredEditor = field.structuredEditor;
      special.textContent = t(
        'ui.generatedSettingsPanel.managedByTheStructuredFullSpectrum',
        'Managed by the structured FullSpectrum recipe editor. Raw serialized definition editing is disabled here.',
      );
      special.style.cssText = 'grid-column:1/-1;margin:0;color:var(--oxr-warn);font-size:12px;';
      row.appendChild(special);
      describedBy.push(special.id);
    }
    if (field.dependencyController) {
      const dependencyMessage = document.createElement('p');
      dependencyMessage.id = `${controlId}-dependency`;
      dependencyMessage.dataset.settingsDependencyState = 'disabled';
      dependencyMessage.dataset.settingsDependencyController = field.dependencyController;
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
    issues.dataset.settingsIssues = field.fieldId;
    issues.setAttribute('role', 'alert');
    issues.style.cssText =
      'grid-column:1/-1;margin:0;padding-inline-start:20px;color:var(--oxr-danger);font-size:12px;';
    this.renderIssues(issues, field.issues);
    row.appendChild(issues);
    describedBy.push(issues.id);
    control.setAttribute('aria-describedby', describedBy.join(' '));

    if (field.editable && field.dependencyEnabled && isDraftControl(control)) {
      const updateDraftFeedback = (raw: string) => {
        model.set(field.fieldId, raw);
        const next = model.row(field.fieldId);
        this.renderIndicators(indicators, next);
        this.renderIssues(issues, next.issues);
        control.setAttribute('aria-invalid', String(next.issues.length > 0));
        this.clearError();
        this.setOperationMessage('Draft changes are not applied yet.');
        if (field.key === FULL_SPECTRUM_KEYS.localZMode) {
          this.renderFields();
          return;
        }
        if (field.key === FULL_SPECTRUM_KEYS.heightLowerBound || field.key === FULL_SPECTRUM_KEYS.heightUpperBound) {
          this.refreshFullSpectrumCrossFieldIssues();
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

  private buildControl(field: SettingsPanelRow, controlId: string): GeneratedSettingsControl {
    const document = this.container.ownerDocument;
    const shown = field.control;
    let control: GeneratedSettingsControl;

    if (shown.kind === 'structured') {
      const output = document.createElement('output');
      output.value = shown.value;
      output.dataset.settingsStructuredEditorTarget = shown.editorId;
      control = output;
    } else if (shown.kind === 'locked') {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = shown.value;
      control = input;
    } else if (shown.kind === 'checkbox') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = shown.checked;
      control = input;
    } else if (shown.kind === 'select') {
      const select = document.createElement('select');
      if (shown.nil !== undefined) {
        const nil = document.createElement('option');
        nil.value = shown.nil;
        nil.textContent = t('ui.generatedSettingsPanel.notSet', 'Not set');
        select.appendChild(nil);
      }
      for (const choice of shown.choices) {
        const option = document.createElement('option');
        option.value = choice.value;
        option.textContent = choice.label;
        select.appendChild(option);
      }
      select.value = shown.value;
      control = select;
    } else if (shown.kind === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.value = shown.value;
      textarea.rows = shown.rows;
      textarea.spellcheck = false;
      textarea.style.fontFamily = 'ui-monospace,SFMono-Regular,monospace';
      control = textarea;
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = shown.value;
      input.autocomplete = 'off';
      input.spellcheck = shown.spellcheck;
      if (shown.inputMode) input.inputMode = shown.inputMode;
      control = input;
    }

    control.id = controlId;
    control.dataset.settingsControl = field.fieldId;
    control.dataset.settingsEditable = String(field.editable);
    control.dataset.settingsDependencyEnabled = String(field.dependencyEnabled);
    if ('disabled' in control) {
      control.disabled = !field.editable || !field.dependencyEnabled || this.busy || this.loading;
    }
    control.setAttribute('aria-invalid', String(field.issues.length > 0));
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

  private renderIndicators(container: HTMLElement, field: SettingsPanelRow): void {
    const document = container.ownerDocument;
    const badges: HTMLElement[] = [];
    const origin = document.createElement('span');
    origin.dataset.settingsOrigin = field.origin;
    origin.textContent = field.originLabel;
    badges.push(origin);
    if (field.draftChanged) {
      const draft = document.createElement('span');
      draft.dataset.settingsDraft = 'changed';
      draft.textContent = t('ui.generatedSettingsPanel.draftChanged', 'Draft changed');
      badges.push(draft);
    }
    if (field.availability === 'structured-editor') {
      const structured = document.createElement('span');
      structured.dataset.settingsAvailability = 'structured-editor';
      structured.textContent = t('ui.generatedSettingsPanel.structuredEditor', 'Structured editor');
      badges.push(structured);
    } else if (field.availability === 'unavailable') {
      const unavailable = document.createElement('span');
      unavailable.dataset.settingsAvailability = 'unavailable';
      unavailable.textContent = 'Unavailable';
      badges.push(unavailable);
    }
    if (field.dependencyController) {
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

  private renderIssues(container: HTMLElement, issues: readonly SettingsPanelIssue[]): void {
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

  private refreshFullSpectrumCrossFieldIssues(): void {
    const model = this.model;
    const catalog = this.catalog;
    const root = this.root;
    if (!model || !catalog || !root) return;
    for (const key of [FULL_SPECTRUM_KEYS.heightLowerBound, FULL_SPECTRUM_KEYS.heightUpperBound]) {
      if (!catalog.has(key) || catalog.all(key).length !== 1) continue;
      const row = root.querySelector<HTMLElement>(`[data-settings-key="${key}"]`);
      if (!row) continue;
      const issues = model.row(catalog.get(key).id).issues;
      const issuesContainer = row.querySelector<HTMLElement>('[data-settings-issues]');
      if (issuesContainer) this.renderIssues(issuesContainer, issues);
      row
        .querySelector<GeneratedSettingsControl>('[data-settings-control]')
        ?.setAttribute('aria-invalid', String(issues.length > 0));
    }
  }

  private async applyDrafts(): Promise<void> {
    const catalog = this.catalog;
    const snapshot = this.snapshot;
    const model = this.model;
    if (!catalog || !snapshot || !model || this.busy || this.loading || this.authorityConflict) return;
    let commit: SettingsDraftCommit;
    try {
      commit = model.prepare();
    } catch (error) {
      if (error instanceof SettingsDraftCommitError) {
        this.showError(error, 'Fix the highlighted validation errors before applying');
        return;
      }
      this.showError(error, 'Settings could not be validated');
      return;
    }
    if (commit.changes.length === 0) {
      model.discard();
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
      this.model = this.createModel(catalog, nextSnapshot);
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
        this.model = undefined;
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
    const snapshot = this.snapshot;
    const model = this.model;
    if (!snapshot || !model || this.busy || this.loading) return;
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
        draftFieldIds: [...model.draftFieldIds].sort((left, right) => left.localeCompare(right, 'en')),
      });
      if (!this.root) return;
      model.discard();
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
    const ready = Boolean(this.model) && !this.loading;
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
    const draft = this.model?.state() ?? { changed: false, invalid: false };
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown settings error';
}
