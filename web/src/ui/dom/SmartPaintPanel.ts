import type { PaintPalette } from '../../project/painting/paintPalette';
import type { PaintChannel } from '../../project/painting/PaintStrokeService';
import { t } from '../../l10n/t';

export interface SmartPaintRegionView {
  readonly id: string;
  readonly label: string;
  /** Provider confidence in `[0, 1]`. */
  readonly confidence: number;
  /** Share of the model's facets, in `[0, 1]`. */
  readonly coverage: number;
  readonly facetCount: number;
  /** Chosen destination for this region, or null while unassigned. */
  readonly value: string | boolean | null;
}

export interface SmartPaintPreviewView {
  readonly channel: PaintChannel;
  readonly coverage: number;
  readonly confidence: number;
  readonly unassignedFacetCount: number;
  readonly regions: readonly SmartPaintRegionView[];
  readonly assignable: boolean;
}

export interface SmartPaintPanelState {
  readonly providerId: string;
  /** Human-readable reason the flow cannot run right now, if any. */
  readonly unavailableReason?: string;
  readonly channel: PaintChannel;
  readonly palette: PaintPalette;
  readonly consent: { readonly geometry: boolean; readonly image: boolean };
  readonly prompt: string;
  readonly imageAttached: boolean;
  readonly busy: boolean;
  readonly preview?: SmartPaintPreviewView;
  readonly error?: string;
}

export interface SmartPaintPanelAdapter {
  getState(): SmartPaintPanelState;
  subscribe?(listener: () => void): () => void;
  onSetConsent(next: { geometry?: boolean; image?: boolean }): void | Promise<void>;
  onSetPrompt(prompt: string): void | Promise<void>;
  onRequest(): void | Promise<void>;
  onCancel(): void | Promise<void>;
  onAssignRegion(regionId: string, value: string | boolean | null): void | Promise<void>;
  onApply(): void | Promise<void>;
  onError?(error: unknown): void;
}

/** Assigned states per non-colour channel, matching the manual paint panel. */
const CHANNEL_STATES: Readonly<
  Record<Exclude<PaintChannel, 'color'>, readonly { value: string | boolean; label: string }[]>
> = {
  support: [
    { value: 'enforce', label: 'Enforce support' },
    { value: 'block', label: 'Block support' },
  ],
  seam: [
    { value: 'prefer', label: 'Prefer seam' },
    { value: 'avoid', label: 'Avoid seam' },
  ],
  fuzzySkin: [{ value: true, label: 'Fuzzy surface' }],
};

let panelSequence = 0;

/**
 * Accessible Smart Paint surface. It never paints: it collects explicit
 * consent, sends one request, shows the returned mask with its coverage and
 * confidence, lets the operator correct each region's destination, and only
 * then invokes the apply action. Every number shown comes from the canonical
 * projection — nothing here estimates or rounds a coverage into existence.
 */
export class SmartPaintPanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: SmartPaintPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SmartPaintPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.smartPaintPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-smart-paint-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text);' +
      'font:13px/1.4 system-ui,sans-serif;';
    this.container.replaceChildren(root);
    this.root = root;
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    this.state = this.adapter.getState();
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }

  private render(): void {
    const root = this.root;
    const state = this.state;
    if (!root || !state) return;
    const document = root.ownerDocument;

    const heading = document.createElement('h3');
    heading.id = `orcaxr-smart-paint-heading-${this.instanceId}`;
    heading.textContent = t('ui.smartPaintPanel.smartPaint', 'Smart Paint');
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';

    const provider = document.createElement('p');
    provider.dataset.smartPaintProvider = state.providerId;
    provider.style.cssText = 'margin:0;opacity:0.75;';
    provider.textContent = `Assistant: ${state.providerId}. Nothing is sent until you allow it, and nothing is painted until you apply.`;

    const children: HTMLElement[] = [heading, provider];

    if (state.unavailableReason) {
      const notice = document.createElement('p');
      notice.dataset.smartPaintUnavailable = 'true';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'margin:0;opacity:0.85;';
      notice.textContent = state.unavailableReason;
      children.push(notice);
    }

    children.push(this.renderConsent(state), this.renderPrompt(state), this.renderRequestControls(state));
    if (state.preview) children.push(this.renderPreview(state, state.preview));
    if (state.error) {
      const error = document.createElement('p');
      error.dataset.smartPaintError = 'true';
      error.setAttribute('role', 'alert');
      error.style.cssText = 'margin:0;color:var(--oxr-color-danger);';
      error.textContent = state.error;
      children.push(error);
    }

    root.replaceChildren(...children);
  }

  private renderConsent(state: SmartPaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('fieldset');
    group.dataset.smartPaintConsent = 'true';
    group.style.cssText = 'margin:0;padding:8px;border:1px solid var(--oxr-stroke);border-radius:8px;';
    const legend = document.createElement('legend');
    legend.textContent = t('ui.smartPaintPanel.whatMayBeSent', 'What may be sent');
    legend.style.cssText = 'padding:0 4px;font-weight:600;';
    group.appendChild(legend);

    group.appendChild(
      this.renderConsentToggle(
        'geometry',
        'Model size and facet count',
        'Sends the selected model’s triangle count and bounding-box size. Vertices, names, and IDs are never sent.',
        state.consent.geometry,
        state.busy,
      ),
    );
    group.appendChild(
      this.renderConsentToggle(
        'image',
        'Reference image',
        'Sends the image you attached. Leave this off to describe the result in words only.',
        state.consent.image,
        state.busy,
      ),
    );
    return group;
  }

  private renderConsentToggle(
    key: 'geometry' | 'image',
    label: string,
    description: string,
    checked: boolean,
    busy: boolean,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-top:6px;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `orcaxr-smart-paint-consent-${key}-${this.instanceId}`;
    input.dataset.smartPaintConsentKey = key;
    input.checked = checked;
    input.disabled = busy;
    input.style.cssText = 'min-width:20px;min-height:20px;margin-top:1px;';
    input.addEventListener('change', () => {
      void this.run(() => this.adapter.onSetConsent({ [key]: input.checked }));
    });
    const text = document.createElement('label');
    text.htmlFor = input.id;
    text.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const title = document.createElement('span');
    title.textContent = label;
    const hint = document.createElement('span');
    hint.textContent = description;
    hint.style.cssText = 'opacity:0.75;';
    text.append(title, hint);
    wrapper.append(input, text);
    return wrapper;
  }

  private renderPrompt(state: SmartPaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const label = document.createElement('label');
    label.htmlFor = `orcaxr-smart-paint-prompt-${this.instanceId}`;
    label.textContent = t('ui.smartPaintPanel.describeTheRegionsYouWant', 'Describe the regions you want');
    const input = document.createElement('textarea');
    input.id = label.htmlFor;
    input.dataset.smartPaintPrompt = 'true';
    input.rows = 3;
    input.value = state.prompt;
    input.disabled = state.busy;
    input.placeholder = t(
      'ui.smartPaintPanel.forExampleTheTopSurface',
      'For example: the top surface and the downward-facing overhangs',
    );
    input.style.cssText =
      'min-height:60px;padding:6px;border-radius:6px;border:1px solid var(--oxr-stroke);' +
      'background:var(--oxr-color-surface);color:inherit;font:inherit;resize:vertical;';
    input.addEventListener('change', () => {
      void this.run(() => this.adapter.onSetPrompt(input.value));
    });
    wrapper.append(label, input);
    if (state.imageAttached) {
      const attached = document.createElement('p');
      attached.dataset.smartPaintImageAttached = 'true';
      attached.style.cssText = 'margin:0;opacity:0.75;';
      attached.textContent = t('ui.smartPaintPanel.aReferenceImageIsAttached', 'A reference image is attached.');
      wrapper.appendChild(attached);
    }
    return wrapper;
  }

  private renderRequestControls(state: SmartPaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    const blocked = Boolean(state.unavailableReason) || !state.consent.geometry || !state.prompt.trim();

    row.appendChild(
      this.button('smart-paint-request', state.preview ? 'Ask again' : 'Ask assistant', state.busy || blocked, () =>
        this.adapter.onRequest(),
      ),
    );
    row.appendChild(
      this.button('smart-paint-cancel', 'Cancel', !state.busy && !state.preview, () => this.adapter.onCancel()),
    );
    if (state.busy) {
      const busy = document.createElement('p');
      busy.setAttribute('role', 'status');
      busy.dataset.smartPaintBusy = 'true';
      busy.style.cssText = 'margin:0;flex-basis:100%;opacity:0.75;';
      busy.textContent = t(
        'ui.smartPaintPanel.waitingForTheAssistantNothing',
        'Waiting for the assistant. Nothing has changed in the project.',
      );
      row.appendChild(busy);
    }
    return row;
  }

  private renderPreview(state: SmartPaintPanelState, preview: SmartPaintPreviewView): HTMLElement {
    const document = this.container.ownerDocument;
    const section = document.createElement('div');
    section.dataset.smartPaintPreview = 'true';
    section.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const summary = document.createElement('p');
    summary.dataset.smartPaintSummary = 'true';
    summary.style.cssText = 'margin:0;';
    summary.textContent =
      `${preview.regions.length} proposed region${preview.regions.length === 1 ? '' : 's'} · ` +
      `${percent(preview.coverage)} of the surface · mean confidence ${percent(preview.confidence)} · ` +
      `${preview.unassignedFacetCount} facet${preview.unassignedFacetCount === 1 ? '' : 's'} untouched`;
    section.appendChild(summary);

    const list = document.createElement('ul');
    list.dataset.smartPaintRegions = 'true';
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;';
    for (const region of preview.regions) {
      list.appendChild(this.renderRegion(state, preview, region));
    }
    section.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    actions.appendChild(
      this.button('smart-paint-apply', 'Apply to model', state.busy || !preview.assignable, () =>
        this.adapter.onApply(),
      ),
    );
    actions.appendChild(this.button('smart-paint-discard', 'Discard mask', state.busy, () => this.adapter.onCancel()));
    section.appendChild(actions);

    if (!preview.assignable) {
      const hint = document.createElement('p');
      hint.dataset.smartPaintApplyHint = 'true';
      hint.style.cssText = 'margin:0;opacity:0.75;';
      hint.textContent = t(
        'ui.smartPaintPanel.chooseADestinationForAt',
        'Choose a destination for at least one region before applying.',
      );
      section.appendChild(hint);
    }
    return section;
  }

  private renderRegion(
    state: SmartPaintPanelState,
    preview: SmartPaintPreviewView,
    region: SmartPaintRegionView,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const item = document.createElement('li');
    item.dataset.smartPaintRegion = region.id;
    item.style.cssText =
      'display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:8px;' +
      'border:1px solid var(--oxr-stroke);';

    const title = document.createElement('span');
    title.style.cssText = 'font-weight:600;';
    title.textContent = region.label;

    const facts = document.createElement('span');
    facts.dataset.smartPaintRegionFacts = 'true';
    facts.style.cssText = 'opacity:0.75;';
    facts.textContent =
      `${region.facetCount} facet${region.facetCount === 1 ? '' : 's'} · ` +
      `${percent(region.coverage)} of the surface · confidence ${percent(region.confidence)}`;

    const select = document.createElement('select');
    select.dataset.smartPaintRegionDestination = region.id;
    select.id = `orcaxr-smart-paint-destination-${this.instanceId}-${region.id}`;
    select.disabled = state.busy;
    select.style.cssText =
      'padding:6px;min-height:36px;border-radius:6px;border:1px solid var(--oxr-stroke);' +
      'background:var(--oxr-color-surface);color:inherit;font:inherit;';
    const label = document.createElement('label');
    label.htmlFor = select.id;
    label.textContent = 'Destination';
    label.style.cssText = 'opacity:0.75;';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('ui.smartPaintPanel.leaveUnpainted', 'Leave unpainted');
    select.appendChild(none);
    for (const option of this.destinations(state, preview.channel)) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = region.value === null ? '' : String(region.value);
    select.addEventListener('change', () => {
      const raw = select.value;
      const value = raw === '' ? null : preview.channel === 'fuzzySkin' ? true : raw;
      void this.run(() => this.adapter.onAssignRegion(region.id, value));
    });

    item.append(title, facts, label, select);
    return item;
  }

  private destinations(
    state: SmartPaintPanelState,
    channel: PaintChannel,
  ): readonly { value: string; label: string }[] {
    if (channel !== 'color') {
      return CHANNEL_STATES[channel].map((entry) => ({ value: String(entry.value), label: entry.label }));
    }
    return state.palette.entries
      .filter((entry) => entry.kind !== 'default' && entry.filamentId)
      .map((entry) => ({
        value: String(entry.filamentId),
        label: entry.badge ? `${entry.name} (${entry.badge})` : entry.name,
      }));
  }

  private button(id: string, label: string, disabled: boolean, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.smartPaintAction = id;
    button.textContent = label;
    button.disabled = disabled;
    button.style.cssText =
      'min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid currentColor;' +
      'background:transparent;color:inherit;cursor:pointer;';
    button.addEventListener('click', () => void this.run(run));
    return button;
  }

  private async run(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.adapter.onError?.(error);
    } finally {
      this.refresh();
    }
  }
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
