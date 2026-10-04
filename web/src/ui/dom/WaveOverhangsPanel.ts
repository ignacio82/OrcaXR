import { t } from '../../l10n/t';
import { applyIcon } from '../icons';
import {
  WAVE_MASTER_KEY,
  WAVE_OPTION_GROUPS,
  WAVE_OVERHANGS_UPSTREAM,
  resolveWaveSettings,
  waveChoiceLabel,
  waveGroupLabel,
  waveNotices,
  waveOptionNotes,
  waveOptionText,
  waveSourceLabel,
  waveValueProblem,
  withWaveNoticeFix,
  withWaveValue,
  withoutWaveOverrides,
  withoutWaveValue,
  type WaveNote,
  type WaveOptionGroupId,
  type WaveOptionState,
  type WaveOptionValue,
  type WaveOverhangsPort,
  type WaveOverhangsProjectSnapshot,
  type WaveSettingsState,
} from '../../settings/waveOverhangs';

/**
 * The Wave overhangs card: every option the engine's wave-overhang port defines,
 * laid out as upstream's own page and drawn from the shared table in
 * `settings/waveOverhangs`.
 *
 * What it shows is what the slice will use. Each row says whether its value is
 * set by this project, inherited from the profile or an imported project, or the
 * engine's own default — the card this replaced filled unset keys with numbers
 * of its own (35 mm/s, three Hilbert floor layers) that the engine never saw.
 * It ships no presets: upstream deliberately has none yet, because what works
 * depends on printer, material and geometry, and its guidance is stated where it
 * applies instead (the speed range on the speed row, nozzle-matched flow on the
 * flow row). Settings outside this card that silently stop waves being generated
 * are named, with the one-press fix where there is one.
 */
export type WaveOverhangsPanelState = WaveOverhangsProjectSnapshot;
export type WaveOverhangsPanelAdapter = WaveOverhangsPort;

/** Groups open on first render; the operator's own choice is kept after that. */
const OPEN_BY_DEFAULT: ReadonlySet<WaveOptionGroupId> = new Set(['general', 'pattern', 'motion', 'cooling', 'floor']);

let panelSeq = 0;

const STYLE = {
  root: 'display:flex;min-width:0;flex-direction:column;gap:8px;color:var(--oxr-color-text);font:12.5px/1.4 var(--font-sans);',
  head: 'display:flex;align-items:center;justify-content:space-between;gap:8px;',
  title: 'margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;',
  badge:
    'font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:var(--oxr-radius-pill);' +
    'background:var(--oxr-color-warn-surface);color:var(--oxr-color-text);',
  textButton:
    'padding:2px 8px;font-size:11px;border-radius:var(--oxr-radius-sm);border:1px solid var(--oxr-color-stroke);' +
    'background:transparent;color:var(--oxr-color-text);cursor:pointer;',
  notice:
    'display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:6px 8px;font-size:11.5px;line-height:1.35;' +
    'border-radius:var(--oxr-radius-sm);background:var(--oxr-color-warn-surface);color:var(--oxr-color-text);' +
    'border-inline-start:3px solid var(--oxr-color-warn);',
  group: 'border-block-start:1px solid var(--oxr-color-stroke);padding-block-start:4px;',
  summary: 'cursor:pointer;font-weight:600;font-size:12px;padding:4px 0;',
  rows: 'display:flex;flex-direction:column;gap:6px;padding:4px 0 6px;',
  row: 'display:flex;flex-direction:column;gap:2px;',
  number: 'flex:0 1 90px;min-width:64px;text-align:end;',
  select: 'flex:1 1 120px;min-width:0;',
  source: 'flex:0 0 auto;font-size:10.5px;color:var(--oxr-color-text-muted);',
  note: 'margin:0;font-size:11px;line-height:1.35;color:var(--oxr-color-text-muted);',
  warnNote: 'margin:0;font-size:11px;line-height:1.35;color:var(--oxr-color-text);',
  error: 'margin:0;font-size:11px;line-height:1.35;color:var(--oxr-color-danger);',
  iconButton:
    'flex:0 0 auto;width:22px;height:22px;padding:0;border:none;border-radius:var(--oxr-radius-sm);' +
    'background:transparent;color:var(--oxr-color-text-muted);cursor:pointer;',
  about: 'font-size:11.5px;',
  list: 'margin:4px 0;padding-inline-start:18px;display:flex;flex-direction:column;gap:3px;',
} as const;

export class WaveOverhangsPanel {
  private readonly instanceId = ++panelSeq;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: WaveOverhangsPanelState;
  private readonly openGroups = new Set<WaveOptionGroupId>(OPEN_BY_DEFAULT);
  private aboutOpen = false;
  /** Per-key refusals from the last edit, shown until that key changes. */
  private readonly errors = new Map<string, string>();
  /** The text a refused number field held, kept so the operator can correct it rather than retype it. */
  private readonly drafts = new Map<string, string>();

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: WaveOverhangsPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const root = this.container.ownerDocument.createElement('section');
    root.dataset.waveOverhangsPanel = 'true';
    root.setAttribute('aria-labelledby', `oxr-wave-heading-${this.instanceId}`);
    root.style.cssText = STYLE.root;
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

  // ---- commits ----------------------------------------------------------------

  private commit(next: Record<string, unknown>, clearErrors: readonly string[] = []): void {
    const basis = this.state;
    if (!basis) return;
    for (const key of clearErrors) {
      this.errors.delete(key);
      this.drafts.delete(key);
    }
    try {
      const result = this.adapter.apply(next, basis);
      if (result instanceof Promise) result.catch((error: unknown) => this.adapter.onError?.(error));
    } catch (error) {
      this.adapter.onError?.(error);
    }
  }

  private setValue(key: string, value: WaveOptionValue): void {
    if (!this.state) return;
    try {
      this.commit(withWaveValue(this.state.overrides, key, value), [key]);
    } catch (error) {
      this.errors.set(key, error instanceof Error ? error.message : String(error));
      this.render();
    }
  }

  private clearValue(key: string): void {
    if (!this.state) return;
    this.commit(withoutWaveValue(this.state.overrides, key), [key]);
  }

  // ---- rendering --------------------------------------------------------------

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, css?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = this.container.ownerDocument.createElement(tag);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private render(): void {
    const root = this.root;
    const state = this.state;
    if (!root || !state) return;
    const resolved = resolveWaveSettings(state);
    root.replaceChildren();
    root.append(this.renderHead(resolved, state));
    root.append(this.renderMaster(resolved, state));
    for (const notice of this.renderNotices(resolved, state)) root.append(notice);
    if (resolved.enabled) {
      for (const group of WAVE_OPTION_GROUPS) {
        const section = this.renderGroup(group, resolved, state);
        if (section) root.append(section);
      }
    }
    root.append(this.renderAbout());
  }

  private renderHead(resolved: WaveSettingsState, state: WaveOverhangsPanelState): HTMLElement {
    const head = this.el('div', STYLE.head);
    const heading = this.el('h3', STYLE.title, t('ui.waveOverhangs.title', 'Wave overhangs'));
    heading.id = `oxr-wave-heading-${this.instanceId}`;
    heading.append(this.el('span', STYLE.badge, t('ui.waveOverhangs.experimental', 'Experimental')));
    head.append(heading);
    if (resolved.hasOverrides) {
      const reset = this.el('button', STYLE.textButton, t('ui.waveOverhangs.reset', 'Reset'));
      reset.type = 'button';
      reset.dataset.waveAction = 'reset';
      reset.title = t(
        'ui.waveOverhangs.resetHint',
        'Remove every wave-overhang setting this project sets, so the profile and engine defaults apply',
      );
      reset.disabled = !!state.busy;
      reset.onclick = () =>
        this.commit(withoutWaveOverrides(state.overrides), [...this.errors.keys(), ...this.drafts.keys()]);
      head.append(reset);
    }
    return head;
  }

  private renderMaster(resolved: WaveSettingsState, state: WaveOverhangsPanelState): HTMLElement {
    const master = resolved.options.find((entry) => entry.option.key === WAVE_MASTER_KEY)!;
    const text = waveOptionText(WAVE_MASTER_KEY);
    const wrap = this.el('div', STYLE.row);
    const label = this.el('label');
    label.className = 'check-row';
    const input = this.el('input');
    input.type = 'checkbox';
    input.dataset.waveEnable = 'true';
    input.checked = resolved.enabled;
    input.disabled = !!state.busy;
    input.onchange = () => this.setValue(WAVE_MASTER_KEY, input.checked);
    label.append(input, this.el('span', 'font-weight:500;', text.label));
    wrap.append(label);
    const description = this.el('p', STYLE.note, text.tooltip);
    description.id = `oxr-wave-desc-${this.instanceId}`;
    input.setAttribute('aria-describedby', description.id);
    wrap.append(description);
    if (master.source !== 'default') wrap.append(this.el('p', STYLE.note, waveSourceLabel(master.source)));
    return wrap;
  }

  private renderNotices(resolved: WaveSettingsState, state: WaveOverhangsPanelState): HTMLElement[] {
    return waveNotices(resolved, state).map((entry) => {
      const notice = this.el('div', STYLE.notice);
      notice.dataset.waveNotice = entry.kind;
      notice.setAttribute('role', 'note');
      notice.append(this.el('span', undefined, entry.text));
      const fix = entry.fix;
      if (fix) {
        const button = this.el('button', STYLE.textButton, fix.label);
        button.type = 'button';
        button.dataset.waveAction = fix.id;
        button.disabled = !!state.busy;
        button.onclick = () => this.commit(withWaveNoticeFix(state.overrides, fix.id));
        notice.append(button);
      }
      return notice;
    });
  }

  private renderGroup(
    group: WaveOptionGroupId,
    resolved: WaveSettingsState,
    state: WaveOverhangsPanelState,
  ): HTMLElement | null {
    const entries = resolved.options.filter(
      (entry) => entry.option.group === group && entry.option.key !== WAVE_MASTER_KEY && entry.applies,
    );
    if (entries.length === 0) return null;
    const details = this.el('details', STYLE.group);
    details.dataset.waveGroup = group;
    details.open = this.openGroups.has(group);
    details.addEventListener('toggle', () => {
      if (details.open) this.openGroups.add(group);
      else this.openGroups.delete(group);
    });
    details.append(this.el('summary', STYLE.summary, waveGroupLabel(group)));
    const rows = this.el('div', STYLE.rows);
    for (const entry of entries) rows.append(this.renderRow(entry, resolved, state));
    details.append(rows);
    return details;
  }

  private renderRow(entry: WaveOptionState, resolved: WaveSettingsState, state: WaveOverhangsPanelState): HTMLElement {
    const { option, value } = entry;
    const text = waveOptionText(option.key);
    const wrap = this.el('div', STYLE.row);
    wrap.dataset.waveKey = option.key;
    wrap.dataset.waveSource = entry.source;
    const row = this.el('div');
    row.className = 'field-row';
    const labelId = `oxr-wave-${option.key}-${this.instanceId}`;
    const label = this.el('span', undefined, text.label);
    label.className = 'field-label';
    label.id = labelId;
    label.title = text.tooltip;
    row.append(label);

    const disabled = !!state.busy || option.inert === true;
    if (option.kind === 'bool') {
      const input = this.el('input');
      input.type = 'checkbox';
      input.checked = value === true;
      input.disabled = disabled;
      input.setAttribute('aria-labelledby', labelId);
      input.onchange = () => this.setValue(option.key, input.checked);
      row.append(input);
    } else if (option.kind === 'enum') {
      const select = this.el('select', STYLE.select);
      select.className = 'field-control text-input';
      for (const choice of option.choices ?? []) {
        const item = this.el('option', undefined, waveChoiceLabel(option.key, choice));
        item.value = choice;
        select.append(item);
      }
      select.value = String(value);
      select.disabled = disabled;
      select.setAttribute('aria-labelledby', labelId);
      select.onchange = () => this.setValue(option.key, select.value);
      row.append(select);
    } else {
      const input = this.el('input', STYLE.number);
      input.type = 'number';
      input.className = 'field-control text-input';
      input.inputMode = option.kind === 'int' ? 'numeric' : 'decimal';
      if (option.min !== undefined) input.min = String(option.min);
      if (option.max !== undefined) input.max = String(option.max);
      input.step = String(option.step);
      input.value = this.drafts.get(option.key) ?? String(value);
      input.disabled = disabled;
      input.setAttribute('aria-labelledby', labelId);
      if (this.errors.has(option.key)) input.setAttribute('aria-invalid', 'true');
      input.onchange = () => {
        const raw = input.value.trim();
        const parsed = raw === '' ? NaN : Number(raw);
        const problem = waveValueProblem(option, parsed);
        if (problem) {
          this.errors.set(option.key, problem);
          this.drafts.set(option.key, input.value);
          this.render();
          return;
        }
        this.setValue(option.key, parsed);
      };
      row.append(input);
    }
    if (option.unit) row.append(this.unitElement(option.unit));
    const source = this.el('span', STYLE.source, waveSourceLabel(entry.source));
    source.dataset.waveSourceLabel = entry.source;
    row.append(source);
    if (entry.source === 'override') {
      const clear = this.el('button', STYLE.iconButton);
      clear.type = 'button';
      clear.dataset.waveClear = option.key;
      clear.title = t('ui.waveOverhangs.clear', 'Stop setting this here and use the inherited value');
      clear.setAttribute('aria-label', clear.title);
      clear.disabled = !!state.busy;
      const glyph = this.el('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.style.cssText = 'display:inline-block;width:14px;height:14px;';
      applyIcon(glyph, 'undo');
      clear.append(glyph);
      clear.onclick = () => this.clearValue(option.key);
      row.append(clear);
    }
    wrap.append(row);

    const notes = this.rowNotes(entry, resolved, state);
    if (notes.length > 0) {
      const ids: string[] = [];
      notes.forEach((note, index) => {
        note.id = `${labelId}-note-${index}`;
        ids.push(note.id);
        wrap.append(note);
      });
      wrap.querySelector('input, select')?.setAttribute('aria-describedby', ids.join(' '));
    }
    return wrap;
  }

  private unitElement(unit: string): HTMLElement {
    const span = this.el('span', undefined, unit);
    span.className = 'field-unit';
    return span;
  }

  /** The row's refusal from the last edit, then the shared guidance for its value. */
  private rowNotes(entry: WaveOptionState, resolved: WaveSettingsState, state: WaveOverhangsPanelState): HTMLElement[] {
    const notes: HTMLElement[] = [];
    const error = this.errors.get(entry.option.key);
    if (error) notes.push(this.el('p', STYLE.error, error));
    for (const note of waveOptionNotes(entry, resolved, state.effectiveConfig)) {
      notes.push(this.noteElement(entry.option.key, note, state));
    }
    return notes;
  }

  private noteElement(key: string, note: WaveNote, state: WaveOverhangsPanelState): HTMLElement {
    const line = this.el('p', note.tone === 'warn' ? STYLE.warnNote : STYLE.note, note.text);
    const fix = note.fix;
    if (fix) {
      const button = this.el('button', STYLE.textButton, fix.label);
      button.type = 'button';
      button.dataset.waveAction = fix.id;
      button.disabled = !!state.busy;
      button.style.marginInlineStart = '6px';
      button.onclick = () => this.setValue(key, fix.value);
      line.append(button);
    }
    return line;
  }

  private renderAbout(): HTMLElement {
    const details = this.el('details', STYLE.about);
    details.dataset.waveAbout = 'true';
    details.open = this.aboutOpen;
    details.addEventListener('toggle', () => {
      this.aboutOpen = details.open;
    });
    details.append(this.el('summary', STYLE.summary, t('ui.waveOverhangs.about', 'About wave overhangs')));
    const list = this.el('ul', STYLE.list);
    for (const line of [
      t(
        'ui.waveOverhangs.about.how',
        'Rings start at the supported edge and spread outward; each one hangs on the ring before it, so the overhang needs nothing underneath.',
      ),
      t(
        'ui.waveOverhangs.about.material',
        'PLA with full part cooling works best; PETG, ABS and PC are much more likely to warp or delaminate.',
      ),
      t(
        'ui.waveOverhangs.about.span',
        'Warping grows with span. Use waves for smaller, self-contained overhangs; spans beyond a few centimetres may still need supports.',
      ),
      t(
        'ui.waveOverhangs.about.floor',
        'The first one to three layers above the wave often do most of the pulling; slower speed, less flow or more cooling there can make a visible difference.',
      ),
      t(
        'ui.waveOverhangs.about.detection',
        'Which walls count as overhangs is decided by Detect overhang walls and Overhang reverse threshold; there is no angle setting.',
      ),
    ]) {
      list.append(this.el('li', undefined, line));
    }
    details.append(list);
    const credits = this.el(
      'p',
      STYLE.note,
      t(
        'ui.waveOverhangs.about.credits',
        'Engine port of OrcaSlicer-WaveOverhangs {release}. Algorithm: Janis A. Andersons; arc-overhang and PrusaSlicer integration: Steven McCulloch; OrcaSlicer port: Dennis Klappe.',
        { release: WAVE_OVERHANGS_UPSTREAM.release },
      ),
    );
    details.append(credits);
    const link = this.el('a', undefined, t('ui.waveOverhangs.about.link', 'Settings reference and limitations'));
    link.href = `${WAVE_OVERHANGS_UPSTREAM.repository}/blob/main/docs/WAVE_OVERHANG_SETTINGS.md`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const linkLine = this.el('p', STYLE.note);
    linkLine.append(link);
    details.append(linkLine);
    return details;
  }
}

export interface WaveOverhangsAdapterOptions {
  workspace: {
    getProjectSettingsOverrideSnapshot(): {
      effectiveConfig: Record<string, unknown>;
      overrides: Record<string, unknown>;
      inheritedConfig: Record<string, unknown>;
      sourceRevision: number;
      sourceHash: string;
    };
    subscribeCanonicalState(listener: () => void): () => void;
  };
  registry: {
    invoke(id: string, surface: string, ctx: unknown, state: unknown, payload: unknown): Promise<boolean>;
  };
  actionCtx: unknown;
  getUiState: () => unknown;
  onErrorMessage?: (message: string) => void;
}

/**
 * The project's wave settings as a {@link WaveOverhangsPort}, committing through
 * the canonical `settings_apply_project` action — the flat card and the headset
 * both use this one.
 */
export function createWaveOverhangsPort(options: WaveOverhangsAdapterOptions): WaveOverhangsPort {
  const { workspace, registry, actionCtx, getUiState, onErrorMessage } = options;
  return {
    getState: () => {
      const snapshot = workspace.getProjectSettingsOverrideSnapshot();
      return {
        inheritedConfig: snapshot.inheritedConfig,
        overrides: snapshot.overrides,
        effectiveConfig: snapshot.effectiveConfig,
        guard: { sourceRevision: snapshot.sourceRevision, sourceHash: snapshot.sourceHash },
      };
    },
    subscribe: (listener) => workspace.subscribeCanonicalState(listener),
    apply: async (next, basis) => {
      const guard = basis.guard ?? workspace.getProjectSettingsOverrideSnapshot();
      const invoked = await registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, getUiState(), {
        projectSettingsApply: {
          inheritedConfig: basis.inheritedConfig,
          overrides: next,
          sourceRevision: guard.sourceRevision,
          sourceHash: guard.sourceHash,
        },
      });
      if (!invoked) {
        throw new Error(
          t('ui.waveOverhangs.applyUnavailable', 'Project settings cannot be changed in the current workspace state.'),
        );
      }
    },
    onError: (error) => {
      onErrorMessage?.(
        t('app.main.waveOverhangsError', 'Wave overhangs: {reason}', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  };
}

export interface MountWaveOverhangsPanelOptions extends WaveOverhangsAdapterOptions {
  container: HTMLElement;
  /** Share an existing port (the headset's) instead of creating one. */
  port?: WaveOverhangsPort;
}

export function mountWaveOverhangsPanel(options: MountWaveOverhangsPanelOptions): () => void {
  const panel = new WaveOverhangsPanel(options.container, options.port ?? createWaveOverhangsPort(options));
  panel.mount();
  const dispose = () => panel.dispose();
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
