/**
 * Printer installation and operator-authored presets (P6.4).
 *
 * The panel answers three questions in order, because that is the order someone
 * setting up a browser asks them: which machines do I own, what have I changed
 * about them, and how do I move that to my other browser.
 *
 * Two rules shape it. Nothing here edits the library directly — every change is
 * one action invocation, so the same validated write path serves this panel, an
 * XR shell, and automation. And an override is authored against the value the
 * base actually holds: the field is seeded with the inherited value and read
 * back in the inherited shape, so a list stays a list.
 */

import type {
  CustomPresetRecord,
  PresetLibraryIssue,
  PresetLibraryOperation,
  PrinterInventory,
} from '../../settings/presets/PresetLibrary';
import {
  CUSTOM_PRESET_VENDOR,
  RESERVED_PRESET_KEYS,
  coerceOverrideValue,
  formatOverrideValue,
} from '../../settings/presets/PresetLibrary';
import type { PresetJsonValue, PresetKind, PresetNode } from '../../settings/presets/PresetGraph';
import { t } from '../../l10n/t';

export interface PresetLibraryPanelPort {
  getInventory(): PrinterInventory;
  getCustomPresets(): readonly CustomPresetRecord[];
  /**
   * Bases of one kind the operator can actually derive from, judged against
   * whatever printer and process are selected right now.
   */
  getBases(kind: PresetKind): readonly PresetNode[];
  getIssues(): readonly PresetLibraryIssue[];
  getStatus(): { readonly busy: boolean; readonly message?: string };
  subscribe(listener: () => void): () => void;
  run(operation: PresetLibraryOperation): void | Promise<void>;
  /** Read a bundle the operator picked; the shell owns the file dialog. */
  chooseBundle(): Promise<string | undefined>;
  /** Confirm a destructive change; resolves false when it is declined. */
  confirmDelete(name: string): Promise<boolean>;
}

const KIND_LABEL: Readonly<Record<PresetKind, string>> = Object.freeze({
  machine: 'Printer',
  process: 'Process',
  filament: 'Filament',
});

const FIELD_STYLE =
  'display:block;width:100%;padding:6px 8px;border-radius:6px;background:var(--oxr-color-bg);' +
  'color:var(--oxr-color-text);border:1px solid var(--oxr-color-stroke-strong);font-size:12px;';

interface DraftOverride {
  key: string;
  text: string;
}

export class PresetLibraryPanel {
  private root?: HTMLElement;
  private printers?: HTMLElement;
  private presets?: HTMLElement;
  private editor?: HTMLElement;
  private issueList?: HTMLElement;
  private status?: HTMLElement;
  private createButton?: HTMLButtonElement;
  private unsubscribe?: () => void;
  private disposed = false;

  private draftKind: PresetKind = 'filament';
  private draftBase = '';
  private draftName = '';
  private draftLicense = '';
  private draftVersion = '';
  private draftOverrides: DraftOverride[] = [];
  private draftHasBase = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: PresetLibraryPanelPort,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.presetLibraryPanel = 'true';
    root.setAttribute('aria-label', t('ui.presetLibraryPanel.printerAndPresetSetup', 'Printer and preset setup'));
    root.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

    root.appendChild(this.buildHeading(doc, 'Installed printers'));
    const printers = doc.createElement('div');
    printers.dataset.presetLibraryPrinters = 'true';
    printers.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    root.appendChild(printers);

    root.appendChild(this.buildHeading(doc, 'Your presets'));
    const presets = doc.createElement('div');
    presets.dataset.presetLibraryPresets = 'true';
    presets.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    root.appendChild(presets);

    const editor = doc.createElement('div');
    editor.dataset.presetLibraryEditor = 'true';
    editor.style.cssText =
      'display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;background:var(--oxr-surface);';
    root.appendChild(editor);

    root.appendChild(this.buildHeading(doc, 'Move this setup'));
    const bundle = doc.createElement('div');
    bundle.style.cssText = 'display:flex;gap:8px;';
    const exportButton = doc.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'action-btn';
    exportButton.dataset.presetLibraryExport = 'true';
    exportButton.textContent = t('ui.presetLibraryPanel.exportBundle', 'Export bundle');
    exportButton.style.cssText = 'margin:0;flex:1;';
    exportButton.addEventListener('click', () => void this.port.run({ kind: 'export' }));
    const importButton = doc.createElement('button');
    importButton.type = 'button';
    importButton.className = 'action-btn';
    importButton.dataset.presetLibraryImport = 'true';
    importButton.textContent = t('ui.presetLibraryPanel.importBundle', 'Import bundle');
    importButton.style.cssText = 'margin:0;flex:1;';
    importButton.addEventListener('click', () => {
      void (async () => {
        const text = await this.port.chooseBundle();
        if (text !== undefined) await this.port.run({ kind: 'import', bundle: text });
      })();
    });
    bundle.append(exportButton, importButton);
    root.appendChild(bundle);

    const issues = doc.createElement('ul');
    issues.dataset.presetLibraryIssues = 'true';
    issues.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;';
    root.appendChild(issues);

    const status = doc.createElement('p');
    status.dataset.presetLibraryStatus = 'true';
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;font-size:12px;opacity:0.8;min-height:1em;';
    root.appendChild(status);

    this.root = root;
    this.printers = printers;
    this.presets = presets;
    this.editor = editor;
    this.issueList = issues;
    this.status = status;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => this.render());
    this.render();
  }

  private buildHeading(doc: Document, text: string): HTMLElement {
    const heading = doc.createElement('h4');
    heading.textContent = text;
    heading.style.cssText = 'margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;opacity:0.7;';
    return heading;
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const state = this.port.getStatus();
    if (this.status) this.status.textContent = state.message ?? '';
    this.renderPrinters(state.busy);
    this.renderPresets(state.busy);
    this.renderEditor(state.busy);
    this.renderIssues();
  }

  private renderPrinters(busy: boolean): void {
    const host = this.printers;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;
    const inventory = this.port.getInventory();
    if (inventory.models.length === 0) {
      host.appendChild(this.buildNote(doc, 'The profile catalog has not loaded yet.'));
      return;
    }
    for (const model of inventory.models) {
      const row = doc.createElement('div');
      row.dataset.presetLibraryModel = `${model.vendor}/${model.model}`;
      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

      const name = doc.createElement('span');
      name.textContent = `${model.vendor} · ${model.model}`;
      name.style.cssText = `font-size:12px;${model.installed ? '' : 'opacity:0.7;'}`;
      row.appendChild(name);

      const nozzles = doc.createElement('div');
      nozzles.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      for (const variant of model.variants) {
        const label = doc.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;';
        const box = doc.createElement('input');
        box.type = 'checkbox';
        box.checked = variant.installed;
        box.disabled = busy;
        box.dataset.presetLibraryVariant = `${model.vendor}/${model.model}/${variant.variant}`;
        box.addEventListener('change', () => {
          const next = model.variants
            .filter((candidate) => (candidate.variant === variant.variant ? box.checked : candidate.installed))
            .map((candidate) => candidate.variant);
          void this.port.run({ kind: 'install', vendor: model.vendor, model: model.model, variants: next });
        });
        const text = doc.createElement('span');
        text.textContent = `${variant.variant} mm`;
        label.append(box, text);
        nozzles.appendChild(label);
      }
      row.appendChild(nozzles);
      host.appendChild(row);
    }
  }

  private renderPresets(busy: boolean): void {
    const host = this.presets;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;
    const presets = this.port.getCustomPresets();
    if (presets.length === 0) {
      host.appendChild(this.buildNote(doc, 'You have not authored any presets yet.'));
      return;
    }
    for (const preset of presets) {
      const row = doc.createElement('div');
      row.dataset.presetLibraryPreset = `${preset.kind}/${preset.name}`;
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:var(--oxr-surface);';

      const text = doc.createElement('div');
      text.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px;';
      const title = doc.createElement('span');
      title.textContent = `${KIND_LABEL[preset.kind]} · ${preset.name}`;
      title.style.cssText = 'font-size:12px;overflow-wrap:anywhere;';
      const facts = doc.createElement('span');
      facts.dataset.presetLibraryProvenance = 'true';
      facts.textContent = describeProvenance(preset);
      facts.style.cssText = 'font-size:11px;opacity:0.75;overflow-wrap:anywhere;';
      text.append(title, facts);

      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'action-btn';
      remove.dataset.presetLibraryDelete = `${preset.kind}/${preset.name}`;
      remove.textContent = 'Delete';
      remove.style.cssText = 'margin:0;';
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        void (async () => {
          if (!(await this.port.confirmDelete(preset.name))) return;
          await this.port.run({
            kind: 'delete',
            vendor: preset.vendor,
            presetKind: preset.kind,
            name: preset.name,
          });
        })();
      });

      row.append(text, remove);
      host.appendChild(row);
    }
  }

  private renderEditor(busy: boolean): void {
    const host = this.editor;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;

    const bases = this.port.getBases(this.draftKind);
    if (!bases.some((node) => node.name === this.draftBase)) this.draftBase = bases[0]?.name ?? '';
    const base = bases.find((node) => node.name === this.draftBase);

    const kindSelect = doc.createElement('select');
    kindSelect.dataset.presetLibraryDraftKind = 'true';
    kindSelect.style.cssText = FIELD_STYLE;
    for (const kind of ['machine', 'process', 'filament'] as const) {
      const option = doc.createElement('option');
      option.value = kind;
      option.textContent = KIND_LABEL[kind];
      option.selected = kind === this.draftKind;
      kindSelect.appendChild(option);
    }
    kindSelect.addEventListener('change', () => {
      this.draftKind = kindSelect.value as PresetKind;
      this.draftBase = '';
      this.draftOverrides = [];
      this.render();
    });
    host.appendChild(this.buildField(doc, 'New preset', kindSelect));

    const baseSelect = doc.createElement('select');
    baseSelect.dataset.presetLibraryDraftBase = 'true';
    baseSelect.style.cssText = FIELD_STYLE;
    for (const node of bases) {
      const option = doc.createElement('option');
      option.value = node.name;
      option.textContent = node.name;
      option.selected = node.name === this.draftBase;
      baseSelect.appendChild(option);
    }
    baseSelect.disabled = bases.length === 0;
    baseSelect.addEventListener('change', () => {
      this.draftBase = baseSelect.value;
      this.draftOverrides = [];
      this.render();
    });
    host.appendChild(this.buildField(doc, 'Based on', baseSelect));

    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.dataset.presetLibraryDraftName = 'true';
    nameInput.value = this.draftName;
    nameInput.placeholder = base ? `${base.name} (copy)` : 'Preset name';
    nameInput.style.cssText = FIELD_STYLE;
    nameInput.addEventListener('input', () => {
      this.draftName = nameInput.value;
      // Re-rendering on every keystroke would take the caret with it, so the
      // one control whose state depends on the name is updated in place.
      this.syncCreateEnabled();
    });
    host.appendChild(this.buildField(doc, 'Name', nameInput));

    const meta = doc.createElement('div');
    meta.style.cssText = 'display:flex;gap:6px;';
    const licenseInput = doc.createElement('input');
    licenseInput.type = 'text';
    licenseInput.dataset.presetLibraryDraftLicense = 'true';
    licenseInput.value = this.draftLicense;
    licenseInput.placeholder = t(
      'ui.presetLibraryPanel.allRightsReservedOperatorAuthored',
      'All rights reserved (operator-authored)',
    );
    licenseInput.style.cssText = FIELD_STYLE;
    licenseInput.addEventListener('input', () => {
      this.draftLicense = licenseInput.value;
    });
    const versionInput = doc.createElement('input');
    versionInput.type = 'text';
    versionInput.dataset.presetLibraryDraftVersion = 'true';
    versionInput.value = this.draftVersion;
    versionInput.placeholder = '1.0.0';
    versionInput.style.cssText = FIELD_STYLE;
    versionInput.addEventListener('input', () => {
      this.draftVersion = versionInput.value;
    });
    meta.append(this.buildField(doc, 'Licence', licenseInput), this.buildField(doc, 'Version', versionInput));
    host.appendChild(meta);

    const overrides = doc.createElement('div');
    overrides.dataset.presetLibraryDraftOverrides = 'true';
    overrides.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const keys = base ? overridableKeys(base) : [];
    for (const [index, override] of this.draftOverrides.entries()) {
      overrides.appendChild(this.buildOverrideRow(doc, index, override, keys, base));
    }
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'action-btn';
    add.dataset.presetLibraryAddOverride = 'true';
    add.textContent = t('ui.presetLibraryPanel.changeASetting', 'Change a setting');
    add.style.cssText = 'margin:0;';
    add.disabled = !base || keys.length === 0;
    add.addEventListener('click', () => {
      const used = new Set(this.draftOverrides.map((entry) => entry.key));
      const key = keys.find((candidate) => !used.has(candidate));
      if (!key || !base) return;
      this.draftOverrides = [...this.draftOverrides, { key, text: formatOverrideValue(base.effective[key]) }];
      this.render();
    });
    overrides.appendChild(add);
    host.appendChild(overrides);

    const create = doc.createElement('button');
    create.type = 'button';
    create.className = 'action-btn';
    create.dataset.presetLibraryCreate = 'true';
    create.textContent = t('ui.presetLibraryPanel.createPreset', 'Create preset');
    create.style.cssText = 'margin:0;';
    this.createButton = create;
    this.draftHasBase = base !== undefined;
    this.syncCreateEnabled(busy);
    create.addEventListener('click', () => {
      if (!base) return;
      const overrideMap: Record<string, PresetJsonValue> = {};
      for (const entry of this.draftOverrides) {
        overrideMap[entry.key] = coerceOverrideValue(base.effective[entry.key], entry.text);
      }
      void (async () => {
        await this.port.run({
          kind: 'create',
          draft: {
            kind: this.draftKind,
            name: this.draftName.trim(),
            inherits: base.name,
            overrides: overrideMap,
            ...(this.draftLicense.trim() ? { license: this.draftLicense.trim() } : {}),
            ...(this.draftVersion.trim() ? { version: this.draftVersion.trim() } : {}),
          },
        });
        // Only clear the form once the library accepted it: a rejected draft
        // that vanished would make the operator retype what was almost right.
        if (this.port.getCustomPresets().some((preset) => preset.name === this.draftName.trim())) {
          this.draftName = '';
          this.draftOverrides = [];
          this.render();
        }
      })();
    });
    host.appendChild(create);
  }

  private buildOverrideRow(
    doc: Document,
    index: number,
    override: DraftOverride,
    keys: readonly string[],
    base: PresetNode | undefined,
  ): HTMLElement {
    const row = doc.createElement('div');
    row.dataset.presetLibraryOverride = override.key;
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const keySelect = doc.createElement('select');
    keySelect.style.cssText = `${FIELD_STYLE}flex:2;`;
    for (const key of keys) {
      const option = doc.createElement('option');
      option.value = key;
      option.textContent = key;
      option.selected = key === override.key;
      keySelect.appendChild(option);
    }
    keySelect.addEventListener('change', () => {
      const next = [...this.draftOverrides];
      next[index] = { key: keySelect.value, text: formatOverrideValue(base?.effective[keySelect.value]) };
      this.draftOverrides = next;
      this.render();
    });

    const valueInput = doc.createElement('input');
    valueInput.type = 'text';
    valueInput.dataset.presetLibraryOverrideValue = override.key;
    valueInput.value = override.text;
    valueInput.style.cssText = `${FIELD_STYLE}flex:2;`;
    valueInput.addEventListener('input', () => {
      const next = [...this.draftOverrides];
      next[index] = { key: override.key, text: valueInput.value };
      this.draftOverrides = next;
    });

    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'action-btn';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Stop changing ${override.key}`);
    remove.style.cssText = 'margin:0;';
    remove.addEventListener('click', () => {
      this.draftOverrides = this.draftOverrides.filter((_, candidate) => candidate !== index);
      this.render();
    });

    row.append(keySelect, valueInput, remove);
    return row;
  }

  private syncCreateEnabled(busy = this.port.getStatus().busy): void {
    if (!this.createButton) return;
    this.createButton.disabled = busy || !this.draftHasBase || this.draftName.trim().length === 0;
  }

  private buildField(doc: Document, label: string, control: HTMLElement): HTMLElement {
    const wrap = doc.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;opacity:0.8;flex:1;';
    const text = doc.createElement('span');
    text.textContent = label;
    wrap.append(text, control);
    return wrap;
  }

  private buildNote(doc: Document, text: string): HTMLElement {
    const note = doc.createElement('p');
    note.style.cssText = 'margin:0;font-size:12px;opacity:0.7;';
    note.textContent = text;
    return note;
  }

  private renderIssues(): void {
    const host = this.issueList;
    if (!host) return;
    host.textContent = '';
    const doc = host.ownerDocument;
    for (const issue of this.port.getIssues()) {
      const row = doc.createElement('li');
      row.dataset.presetLibraryIssue = issue.code;
      row.textContent = issue.message;
      row.style.cssText = `font-size:11px;color:${issue.severity === 'error' ? 'var(--oxr-danger)' : 'var(--oxr-warn)'};`;
      host.appendChild(row);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }
}

/** Keys a base offers for overriding: everything it holds but its own identity. */
export function overridableKeys(base: PresetNode): readonly string[] {
  return Object.freeze(
    Object.keys(base.effective)
      .filter((key) => !RESERVED_PRESET_KEYS.includes(key))
      .sort((left, right) => left.localeCompare(right, 'en')),
  );
}

/** One line saying where a preset came from and under what terms. */
export function describeProvenance(preset: CustomPresetRecord): string {
  const parts = [
    `from ${preset.provenance.derivedFrom.name}`,
    `v${preset.provenance.version}`,
    preset.provenance.license,
  ];
  if (preset.provenance.source === 'imported') parts.push('imported');
  if (preset.vendor !== CUSTOM_PRESET_VENDOR) parts.push(preset.vendor);
  return parts.join(' · ');
}
