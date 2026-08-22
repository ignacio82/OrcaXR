/**
 * One settings panel, five scopes (P6.5).
 *
 * Orca gives a project, a plate, an object, a part, and a height range their
 * own settings tabs, and the tabs look almost identical because they are: the
 * same generated schema, the same controls, the same draft/commit state. What
 * differs is *where the value is stored*, and therefore which keys the engine
 * will read at all.
 *
 * So this is a target picker in front of the shared {@link GeneratedSettingsPanel}
 * rather than a second settings UI. Choosing a node rebuilds the panel bound to
 * that node's scope, which is what makes "the same schema at every scope" a
 * structural fact instead of a promise: there is only one field renderer, one
 * validator, and one commit path.
 *
 * The picker also states how many overrides each node already carries, because
 * the question a person actually arrives with is "where did I set that?".
 */

import type { ScopedOverrideTargetOption } from '../../project/scopedOverrides';
import type { SettingScope } from '../../settings/generated/settingScopes';
import {
  GeneratedSettingsPanel,
  type GeneratedSettingsPanelAdapter,
  type GeneratedSettingsPanelOptions,
} from './GeneratedSettingsPanel';

// One mapping, two shells: the XR stepper surface asks the same question of the
// same function, so a plate cannot read its controls from one tab here and
// another there.
import { guiSurfaceForScope } from '../../settings/editor/scopedStepper';
import { t } from '../../l10n/t';

export { guiSurfaceForScope };

const SCOPE_LABEL: Readonly<Record<SettingScope, string>> = {
  project: 'Project',
  plate: 'Plate',
  object: 'Object',
  part: 'Part',
  layerRange: 'Height range',
};

export interface ScopedSettingsPanelPort {
  /** Every addressable node, in containment order, from the current state. */
  listTargets(): readonly ScopedOverrideTargetOption[];
  /** Notify when the canonical project changed, so targets can be re-listed. */
  subscribe?(listener: () => void): () => void;
  /** Build the settings adapter that reads and writes one specific node. */
  adapterFor(option: ScopedOverrideTargetOption): GeneratedSettingsPanelAdapter;
  onError?(error: unknown): void;
}

export interface ScopedSettingsPanelOptions {
  /** Forwarded to each inner panel; `scope` and `guiSurface` are set per target. */
  readonly panel?: Omit<GeneratedSettingsPanelOptions, 'scope' | 'guiSurface' | 'heading'>;
  /** Target selected on first mount; defaults to the project. */
  readonly initialTargetId?: string;
}

let sequence = 0;

export class ScopedSettingsPanel {
  private readonly instanceId = ++sequence;
  private root?: HTMLElement;
  private select?: HTMLSelectElement;
  private summary?: HTMLElement;
  private panelHost?: HTMLElement;
  private panel?: GeneratedSettingsPanel;
  private targets: readonly ScopedOverrideTargetOption[] = [];
  private selectedId: string;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: ScopedSettingsPanelPort,
    private readonly options: ScopedSettingsPanelOptions = {},
  ) {
    this.selectedId = options.initialTargetId ?? 'project';
  }

  async mount(): Promise<void> {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('div');
    root.id = `scoped-settings-${this.instanceId}`;
    root.dataset.scopedSettingsPanel = 'true';
    root.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    const label = doc.createElement('label');
    label.htmlFor = `${root.id}-target`;
    label.textContent = t('ui.scopedSettingsPanel.settingsFor', 'Settings for');
    label.style.cssText = 'font-size:11px;letter-spacing:0.04em;text-transform:uppercase;opacity:0.7;';
    root.appendChild(label);

    const select = doc.createElement('select');
    select.id = `${root.id}-target`;
    select.dataset.scopedSettingsTarget = 'true';
    select.className = 'action-btn';
    select.style.cssText = 'text-align: start;';
    select.addEventListener('change', () => {
      this.selectedId = select.value;
      void this.rebuildPanel();
    });
    root.appendChild(select);

    const summary = doc.createElement('p');
    summary.id = `${root.id}-summary`;
    // Polite: the scope changes only when someone chooses it, so this reads as
    // confirmation rather than interrupting a running edit.
    summary.setAttribute('aria-live', 'polite');
    summary.style.cssText = 'margin:0;font-size:12px;opacity:0.75;';
    root.appendChild(summary);

    const panelHost = doc.createElement('div');
    panelHost.dataset.scopedSettingsHost = 'true';
    panelHost.style.cssText = 'display:flex;flex-direction:column;min-height:160px;';
    root.appendChild(panelHost);

    this.root = root;
    this.select = select;
    this.summary = summary;
    this.panelHost = panelHost;
    this.container.appendChild(root);

    this.refreshTargets();
    try {
      this.unsubscribe = this.port.subscribe?.(() => this.refreshTargets());
    } catch (error) {
      this.port.onError?.(error);
    }
    await this.rebuildPanel();
  }

  /** Re-read the node list; keeps the current selection when it still exists. */
  refreshTargets(): void {
    if (!this.select || this.disposed) return;
    let listed: readonly ScopedOverrideTargetOption[];
    try {
      listed = this.port.listTargets();
    } catch (error) {
      this.port.onError?.(error);
      return;
    }
    const signature = listed.map((option) => `${option.id}|${option.path}|${option.overrideCount}`).join('\n');
    if (signature === this.signature) return;
    this.signature = signature;
    this.targets = listed;

    const doc = this.select.ownerDocument;
    this.select.textContent = '';
    for (const option of listed) {
      const element = doc.createElement('option');
      element.value = option.id;
      // The scope is on the option so a caller can pick a target by kind — the
      // sidebar's Global / Objects switch chooses "the project" or "an object"
      // without having to parse the label it renders.
      element.dataset.scope = option.scope;
      const overrides =
        option.overrideCount === 0 ? '' : ` — ${option.overrideCount} override${option.overrideCount === 1 ? '' : 's'}`;
      element.textContent = `${SCOPE_LABEL[option.scope]}: ${option.path}${overrides}`;
      this.select.appendChild(element);
    }
    const stillPresent = listed.some((option) => option.id === this.selectedId);
    if (!stillPresent) this.selectedId = listed[0]?.id ?? 'project';
    this.select.value = this.selectedId;
    this.select.disabled = listed.length === 0;
    // A node that disappeared takes its panel with it rather than leaving an
    // editor pointed at something the project no longer contains.
    if (!stillPresent && this.panel) void this.rebuildPanel();
    else this.renderSummary();
  }

  private signature = '';

  private renderSummary(): void {
    const option = this.current();
    if (!this.summary || !option) return;
    this.summary.textContent =
      option.scope === 'project'
        ? 'Applies to every plate unless a narrower scope overrides it.'
        : `Overrides the ${SCOPE_LABEL[option.scope].toLowerCase()}'s inherited values. ` +
          (option.scope === 'part'
            ? 'A height range crossing this part wins over it, as it does in the engine.'
            : 'Only settings the engine reads at this scope are listed.');
  }

  private current(): ScopedOverrideTargetOption | undefined {
    return this.targets.find((option) => option.id === this.selectedId);
  }

  private async rebuildPanel(): Promise<void> {
    if (!this.panelHost || this.disposed) return;
    this.panel?.dispose();
    this.panel = undefined;
    this.panelHost.textContent = '';
    this.renderSummary();
    const option = this.current();
    if (!option) return;
    this.panelHost.dataset.scopedSettingsScope = option.scope;
    const panel = new GeneratedSettingsPanel(this.panelHost, this.port.adapterFor(option), {
      ...this.options.panel,
      heading: `${SCOPE_LABEL[option.scope]} settings — ${option.label}`,
      guiSurface: guiSurfaceForScope(option.scope),
      // The project's own overrides go through the project settings command,
      // which accepts reviewed keys that carry no literal placement; narrowing
      // it here would hide controls that do work today.
      ...(option.scope === 'project' ? {} : { scope: option.scope }),
    });
    this.panel = panel;
    try {
      await panel.mount();
    } catch (error) {
      this.port.onError?.(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.panel?.dispose();
    this.panel = undefined;
    this.root?.remove();
    this.root = undefined;
  }
}
