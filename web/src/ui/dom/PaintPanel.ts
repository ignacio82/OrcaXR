import type { FilamentId } from '../../project/domain/ids';
import type { PaintPalette, PaintPaletteEntry } from '../../project/painting/paintPalette';
import type { PaintToolKind, PaintToolSettings } from '../../project/painting/PaintStrokeService';

export interface PaintPanelState {
  readonly palette: PaintPalette;
  readonly settings: PaintToolSettings;
  readonly filamentId?: FilamentId;
  readonly mode: 'paint' | 'erase';
  readonly active: boolean;
}

export interface PaintConfigurationRequest {
  readonly filamentId?: FilamentId | null;
  readonly mode?: 'paint' | 'erase';
  readonly tool?: PaintToolKind;
  readonly radiusMm?: number;
  readonly smartFillAngleDegrees?: number;
  readonly heightRangeMm?: number;
  readonly gapAreaMm2?: number;
}

/** Command callbacks stay outside the reusable DOM surface. */
export interface PaintPanelAdapter {
  getState(): PaintPanelState;
  subscribe?(listener: () => void): () => void;
  onConfigure(request: PaintConfigurationRequest): void | Promise<void>;
  onEraseAll(): void | Promise<void>;
  onActivate(): void | Promise<void>;
  onError?(error: unknown): void;
}

const TOOLS: readonly { kind: PaintToolKind; label: string; hint: string }[] = [
  { kind: 'circle', label: 'Circle', hint: 'Paint a screen-facing disc that sweeps while you drag' },
  { kind: 'sphere', label: 'Sphere', hint: 'Paint everything inside a 3D radius' },
  { kind: 'triangle', label: 'Triangle', hint: 'Paint one facet at a time' },
  { kind: 'fill', label: 'Fill', hint: 'Flood the connected surface, bounded by the smart-fill angle' },
  { kind: 'heightRange', label: 'Height range', hint: 'Paint a horizontal band measured from the hit' },
  { kind: 'gapFill', label: 'Gap fill', hint: 'Close unpainted patches under the area threshold' },
];

let panelSequence = 0;

/**
 * Accessible colour-paint surface. Every choice is a registry invocation and
 * every swatch shows its stable identity, badge, and recipe so a colour is
 * never the only cue.
 */
export class PaintPanel {
  private readonly instanceId = ++panelSequence;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: PaintPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: PaintPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.paintPanel = 'true';
    root.setAttribute('aria-labelledby', `orcaxr-paint-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text,#fff);' +
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
    root.replaceChildren();

    const heading = document.createElement('h3');
    heading.id = `orcaxr-paint-heading-${this.instanceId}`;
    heading.textContent = 'Colour painting';
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';
    root.append(heading);

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.dataset.paintActivate = 'true';
    activate.textContent = state.active ? 'Painting active' : 'Start painting';
    activate.setAttribute('aria-pressed', String(state.active));
    activate.style.cssText = buttonStyle(state.active);
    activate.onclick = () => void this.run(() => this.adapter.onActivate());
    root.append(activate);

    const status = document.createElement('p');
    status.dataset.paintStatus = 'true';
    status.style.cssText = 'margin:0;opacity:0.75;';
    status.textContent = state.active
      ? 'Drag across a model to paint. Escape cancels the stroke; undo removes it.'
      : 'Start painting to assign filaments to individual facets.';
    root.append(status);

    root.append(this.renderPalette(state));
    root.append(this.renderTools(state));
    root.append(this.renderParameters(state));

    const eraseAll = document.createElement('button');
    eraseAll.type = 'button';
    eraseAll.dataset.paintEraseAll = 'true';
    eraseAll.textContent = 'Erase all painting on selection';
    eraseAll.style.cssText = buttonStyle(false);
    eraseAll.onclick = () => void this.run(() => this.adapter.onEraseAll());
    root.append(eraseAll);
  }

  private renderPalette(state: PaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('fieldset');
    group.dataset.paintPalette = 'true';
    group.style.cssText = 'border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;';
    const legend = document.createElement('legend');
    legend.textContent = 'Filament';
    legend.style.cssText = 'padding:0;font-size:12px;opacity:0.8;';
    group.append(legend);

    const list = document.createElement('div');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Paint filament');
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const entry of state.palette.entries) {
      list.append(this.renderSwatch(entry, state));
    }
    group.append(list);
    return group;
  }

  private renderSwatch(entry: PaintPaletteEntry, state: PaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const selected =
      entry.kind === 'default'
        ? state.mode === 'erase' || !state.filamentId
        : state.mode === 'paint' && state.filamentId === entry.filamentId;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(selected));
    button.dataset.paintSwatch = entry.filamentId ?? 'default';
    button.disabled = !entry.selectable;
    const label = [entry.name, entry.badge, entry.recipeSummary, entry.unavailableReason].filter(Boolean).join(' — ');
    button.title = label;
    button.setAttribute('aria-label', entry.keyboardNumber ? `${label} (key ${entry.keyboardNumber})` : label);
    button.style.cssText =
      'display:flex;align-items:center;gap:6px;min-height:44px;padding:6px 10px;border-radius:8px;cursor:pointer;' +
      `border:2px solid ${selected ? 'var(--oxr-color-accent,#4fc3f7)' : 'rgba(255,255,255,0.24)'};` +
      `background:rgba(255,255,255,${entry.selectable ? 0.06 : 0.02});color:inherit;` +
      `opacity:${entry.selectable ? 1 : 0.55};`;

    const swatch = document.createElement('span');
    swatch.setAttribute('aria-hidden', 'true');
    const stops = entry.gradient && entry.gradient.length > 1 ? entry.gradient.join(', ') : undefined;
    swatch.style.cssText =
      'width:18px;height:18px;border-radius:4px;border:1px solid rgba(0,0,0,0.5);flex:none;' +
      (stops ? `background:linear-gradient(90deg, ${stops});` : `background:${entry.displayColor};`);
    button.append(swatch);

    const text = document.createElement('span');
    text.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;';
    const name = document.createElement('span');
    name.textContent = entry.name;
    const badge = document.createElement('span');
    badge.textContent = entry.keyboardNumber ? `${entry.badge} · key ${entry.keyboardNumber}` : entry.badge;
    badge.style.cssText = 'font-size:11px;opacity:0.75;';
    text.append(name, badge);
    button.append(text);

    button.onclick = () =>
      void this.run(() =>
        this.adapter.onConfigure(
          entry.kind === 'default'
            ? { filamentId: null, mode: 'erase' }
            : { filamentId: entry.filamentId, mode: 'paint' },
        ),
      );
    return button;
  }

  private renderTools(state: PaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('fieldset');
    group.dataset.paintTools = 'true';
    group.style.cssText = 'border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;';
    const legend = document.createElement('legend');
    legend.textContent = 'Tool';
    legend.style.cssText = 'padding:0;font-size:12px;opacity:0.8;';
    group.append(legend);

    const list = document.createElement('div');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Paint tool');
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      const selected = state.settings.tool === tool.kind;
      button.setAttribute('aria-checked', String(selected));
      button.dataset.paintTool = tool.kind;
      button.textContent = tool.label;
      button.title = tool.hint;
      button.style.cssText = buttonStyle(selected);
      button.onclick = () => void this.run(() => this.adapter.onConfigure({ tool: tool.kind }));
      list.append(button);
    }
    group.append(list);
    return group;
  }

  private renderParameters(state: PaintPanelState): HTMLElement {
    const document = this.container.ownerDocument;
    const group = document.createElement('div');
    group.dataset.paintParameters = 'true';
    group.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const tool = state.settings.tool;
    if (tool === 'circle' || tool === 'sphere') {
      group.append(
        this.renderNumber('Brush radius (mm)', 'paint-radius', state.settings.radiusMm ?? 4, 0.4, 8, 0.1, (value) =>
          this.adapter.onConfigure({ radiusMm: value }),
        ),
      );
    }
    if (tool === 'fill' || tool === 'gapFill') {
      group.append(
        this.renderNumber(
          'Smart fill angle (°)',
          'paint-smart-fill-angle',
          state.settings.smartFillAngleDegrees ?? 30,
          0,
          90,
          1,
          (value) => this.adapter.onConfigure({ smartFillAngleDegrees: value }),
        ),
      );
    }
    if (tool === 'heightRange') {
      group.append(
        this.renderNumber(
          'Band height (mm)',
          'paint-height-range',
          state.settings.heightRangeMm ?? 1,
          0.1,
          8,
          0.1,
          (value) => this.adapter.onConfigure({ heightRangeMm: value }),
        ),
      );
    }
    if (tool === 'gapFill') {
      group.append(
        this.renderNumber('Max gap area (mm²)', 'paint-gap-area', state.settings.gapAreaMm2 ?? 2, 0, 5, 0.2, (value) =>
          this.adapter.onConfigure({ gapAreaMm2: value }),
        ),
      );
    }
    return group;
  }

  private renderNumber(
    label: string,
    id: string,
    value: number,
    min: number,
    max: number,
    step: number,
    apply: (value: number) => void | Promise<void>,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    wrapper.htmlFor = `orcaxr-${id}-${this.instanceId}`;
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.id = wrapper.htmlFor;
    input.dataset.paintParameter = id;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.cssText = 'width:96px;min-height:32px;padding:4px 6px;border-radius:6px;';
    input.onchange = () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) {
        input.value = String(value);
        return;
      }
      const clamped = Math.min(max, Math.max(min, parsed));
      input.value = String(clamped);
      void this.run(() => apply(clamped));
    };
    wrapper.append(text, input);
    return wrapper;
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

function buttonStyle(selected: boolean): string {
  return (
    'min-height:44px;padding:8px 12px;border-radius:8px;cursor:pointer;color:inherit;' +
    `border:2px solid ${selected ? 'var(--oxr-color-accent,#4fc3f7)' : 'rgba(255,255,255,0.24)'};` +
    `background:rgba(255,255,255,${selected ? 0.12 : 0.06});`
  );
}
