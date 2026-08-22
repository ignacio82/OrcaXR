import type { LayerEventType } from '../../project/domain/model';
import type {
  CanonicalLayerEventMutationRequest,
  CanonicalLayerEventSnapshot,
} from '../../workspace/CanonicalWorkspaceController';
import type { LayerEventCapability } from '../../workspace/OrcaWorkspace';
import { t } from '../../l10n/t';

type MaybePromise = void | Promise<void>;

export interface LayerEventPanelAdapter {
  getSnapshot(): CanonicalLayerEventSnapshot;
  getCapabilities(): readonly LayerEventCapability[];
  subscribe(listener: () => void): () => void;
  onMutate(request: CanonicalLayerEventMutationRequest): MaybePromise;
  onError?(error: unknown): void;
}

/**
 * Author what the printer does mid-print: a pause to insert a magnet, a colour
 * change, or arbitrary G-code, each bound to an exact height.
 *
 * The height is stored rather than a layer index because the engine resolves it
 * against the layers it actually produces — a later layer-height change must
 * move the event with the model, not leave it pointing at a different place.
 * Event kinds the selected profile cannot perform are shown disabled with the
 * missing setting named, instead of silently emitting a marker that does
 * nothing on the machine.
 */
export class LayerEventPanel {
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private typeSelect?: HTMLSelectElement;
  private heightInput?: HTMLInputElement;
  private detailInput?: HTMLInputElement;
  private detailLabel?: HTMLLabelElement;
  private addButton?: HTMLButtonElement;
  private status?: HTMLElement;
  private list?: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: LayerEventPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.layerEventPanel = 'true';
    root.setAttribute('aria-label', t('ui.layerEventPanel.layerEvents', 'Layer events'));
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;font:13px/1.45 system-ui,sans-serif;';

    const list = document.createElement('ul');
    list.dataset.layerEventList = 'true';
    list.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;';

    const form = document.createElement('div');
    form.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:6px;align-items:end;';

    const typeLabel = document.createElement('label');
    typeLabel.style.cssText = 'display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--oxr-text-muted);';
    typeLabel.textContent = 'Event';
    const typeSelect = document.createElement('select');
    typeSelect.dataset.layerEventType = 'true';
    typeSelect.style.cssText = FIELD_STYLE;
    typeSelect.onchange = () => this.render();
    typeLabel.appendChild(typeSelect);

    const heightLabel = document.createElement('label');
    heightLabel.style.cssText =
      'display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--oxr-text-muted);';
    heightLabel.textContent = t('ui.layerEventPanel.heightMm', 'Height (mm)');
    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.min = '0.05';
    heightInput.step = '0.05';
    heightInput.value = '1';
    heightInput.dataset.layerEventHeight = 'true';
    heightInput.style.cssText = FIELD_STYLE;
    heightLabel.appendChild(heightInput);

    const detailLabel = document.createElement('label');
    detailLabel.style.cssText =
      'display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--oxr-text-muted);';
    const detailText = document.createElement('span');
    detailText.textContent = t('ui.layerEventPanel.messageOptional', 'Message (optional)');
    const detailInput = document.createElement('input');
    detailInput.type = 'text';
    detailInput.dataset.layerEventDetail = 'true';
    detailInput.style.cssText = FIELD_STYLE;
    detailLabel.append(detailText, detailInput);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'action-btn';
    addButton.dataset.layerEventAdd = 'true';
    addButton.textContent = t('ui.layerEventPanel.addEvent', 'Add event');
    addButton.style.cssText = 'min-height:36px;';
    addButton.onclick = () => void this.add();

    const status = document.createElement('p');
    status.dataset.layerEventStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;min-height:1.3em;font-size:11px;color:var(--oxr-text-muted);';

    form.append(typeLabel, heightLabel, detailLabel, addButton);
    root.append(list, form, status);
    this.container.replaceChildren(root);
    this.root = root;
    this.list = list;
    this.typeSelect = typeSelect;
    this.heightInput = heightInput;
    this.detailInput = detailInput;
    this.detailLabel = detailLabel;
    this.addButton = addButton;
    this.status = status;
    this.unsubscribe = this.adapter.subscribe(() => this.render());
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }

  render(): void {
    if (!this.root || !this.list || !this.typeSelect || !this.detailLabel || !this.detailInput) return;
    const snapshot = this.adapter.getSnapshot();
    const capabilities = this.adapter.getCapabilities();

    if (this.typeSelect.options.length !== capabilities.length) {
      this.typeSelect.replaceChildren();
      for (const capability of capabilities) {
        const option = this.container.ownerDocument.createElement('option');
        option.value = capability.type;
        option.textContent = capability.supported
          ? capitalize(capability.label)
          : `${capitalize(capability.label)} — unavailable`;
        option.disabled = !capability.supported;
        option.dataset.layerEventOption = capability.type;
        this.typeSelect.appendChild(option);
      }
      const firstSupported = capabilities.find((capability) => capability.supported);
      if (firstSupported) this.typeSelect.value = firstSupported.type;
    }

    const selected = this.typeSelect.value as LayerEventType;
    const capability = capabilities.find((entry) => entry.type === selected);
    const detailTextNode = this.detailLabel.querySelector('span');
    if (detailTextNode) {
      detailTextNode.textContent = selected === 'custom' ? 'G-code' : 'Message (optional)';
    }
    this.detailInput.placeholder = selected === 'custom' ? 'M117 halfway' : 'Shown on the printer';
    this.detailInput.hidden = selected !== 'custom' && selected !== 'pause';
    this.detailLabel.hidden = this.detailInput.hidden;
    if (this.addButton) this.addButton.disabled = capability?.supported !== true;
    if (this.status && capability && !capability.supported) this.status.textContent = capability.reason ?? '';

    this.list.replaceChildren();
    if (snapshot.events.length === 0) {
      const empty = this.container.ownerDocument.createElement('li');
      empty.dataset.layerEventEmpty = 'true';
      empty.textContent = t('ui.layerEventPanel.noLayerEventsOnThis', 'No layer events on this plate.');
      empty.style.cssText = 'color:var(--oxr-text-muted);';
      this.list.appendChild(empty);
      return;
    }
    for (const row of snapshot.events) {
      const item = this.container.ownerDocument.createElement('li');
      item.dataset.layerEventRow = row.id;
      item.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;';
      const text = this.container.ownerDocument.createElement('span');
      text.textContent = describeEvent(row.event.type, row.event.topZMm, row.event.message ?? row.code);
      const remove = this.container.ownerDocument.createElement('button');
      remove.type = 'button';
      remove.dataset.layerEventDelete = row.id;
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${describeEvent(row.event.type, row.event.topZMm, '')}`);
      remove.style.cssText =
        'min-height:28px;padding:2px 8px;border-radius:6px;border:1px solid var(--oxr-stroke);' +
        'background:var(--oxr-surface);color:inherit;cursor:pointer;';
      remove.onclick = () =>
        void this.mutate({
          operation: 'delete',
          id: row.id,
          expectedRevision: snapshot.sourceRevision,
          sourceHash: snapshot.sourceHash,
        });
      item.append(text, remove);
      this.list.appendChild(item);
    }
  }

  private async add(): Promise<void> {
    const snapshot = this.adapter.getSnapshot();
    const type = (this.typeSelect?.value ?? 'pause') as LayerEventType;
    const topZMm = Number(this.heightInput?.value ?? '');
    if (!Number.isFinite(topZMm) || topZMm <= 0) {
      if (this.status)
        this.status.textContent = t('ui.layerEventPanel.enterAHeightAboveThe', 'Enter a height above the plate.');
      return;
    }
    const detail = this.detailInput?.value.trim() ?? '';
    await this.mutate({
      operation: 'add',
      type,
      topZMm,
      expectedRevision: snapshot.sourceRevision,
      sourceHash: snapshot.sourceHash,
      ...(type === 'custom' ? { code: detail } : {}),
      ...(type === 'pause' && detail ? { message: detail } : {}),
    });
  }

  private async mutate(request: CanonicalLayerEventMutationRequest): Promise<void> {
    try {
      await this.adapter.onMutate(request);
      if (this.status) this.status.textContent = '';
      if (request.operation === 'add' && this.detailInput) this.detailInput.value = '';
    } catch (error) {
      if (this.status) this.status.textContent = error instanceof Error ? error.message : String(error);
      this.adapter.onError?.(error);
    }
    this.render();
  }
}

const FIELD_STYLE =
  'background:var(--oxr-bg-sunken);color:var(--oxr-text);border:1px solid var(--oxr-stroke);border-radius:6px;padding:6px;font-size:12px;';

function describeEvent(type: LayerEventType, topZMm: number, detail: string): string {
  const label =
    type === 'pause'
      ? 'Pause'
      : type === 'color-change'
        ? 'Colour change'
        : type === 'tool-change'
          ? 'Tool change'
          : type === 'template'
            ? 'Template G-code'
            : 'Custom G-code';
  return `${label} at ${topZMm.toFixed(2)} mm${detail ? ` — ${detail}` : ''}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
