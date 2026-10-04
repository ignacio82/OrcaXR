/**
 * XrWaveOverhangsPanel — the Wave overhangs card, in the headset.
 *
 * The engine's wave-overhang options are not in the generated settings schema,
 * so the Settings panel cannot show them; this panel does. It draws from the
 * same table and the same guidance as the flat card (`settings/waveOverhangs`),
 * so an option, a warning or a suggested value cannot exist on one surface and
 * be missing on the other — and it commits through the same port, so a press
 * here is the same canonical project-settings command a click is there.
 *
 * Each row's editor is its option's kind: a switch for a boolean, a press that
 * cycles an enumeration, and arrows plus the keypad for a number. Arrows stop
 * at the engine's bounds and the keypad refuses a value outside them, so
 * nothing the engine would reject can be entered.
 */
import { t } from '../../l10n/t';
import {
  WAVE_MASTER_KEY,
  WAVE_OPTION_GROUPS,
  resolveWaveSettings,
  steppedWaveValue,
  waveChoiceLabel,
  waveGroupLabel,
  waveNotices,
  waveOptionNotes,
  waveOptionText,
  waveSourceLabel,
  withWaveNoticeFix,
  withWaveValue,
  withoutWaveOverrides,
  withoutWaveValue,
  type WaveOptionState,
  type WaveOptionValue,
  type WaveOverhangOption,
  type WaveOverhangsProjectSnapshot,
  type WaveSettingsState,
} from '../../settings/waveOverhangs';
import { tokens } from '../tokens';
import {
  XR_TYPE,
  createXrColumn,
  createXrHeading,
  createXrIconButton,
  createXrRow,
  createXrTag,
  createXrTextButton,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrWaveOverhangsPanelContext {
  /** `null` before a project exists. */
  readonly snapshot: WaveOverhangsProjectSnapshot | null;
  /** Commit one complete next override map, computed from `snapshot`. */
  onApply(next: Record<string, unknown>): void;
  /** Open the keypad for a numeric option, starting from its current value. */
  onEditValue(option: WaveOverhangOption, current: number): void;
}

export interface XrWaveOverhangsPanelRender<PanelNode> {
  readonly root: PanelNode;
  /** Option keys in draw order; the automation seam and what the tests read. */
  readonly keys: readonly string[];
}

export function renderXrWaveOverhangsPanel<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrWaveOverhangsPanelContext,
): XrWaveOverhangsPanelRender<PanelNode> {
  const body = createXrColumn(ui, { gap: tokens.space.sm, flexGrow: 1, flexShrink: 1 });
  ui.appendChild(root, body);
  const snapshot = ctx.snapshot;
  if (!snapshot) {
    ui.appendChild(
      body,
      ui.createText(t('ui.xrWaveOverhangs.noProject', 'No project open.'), {
        fontSize: XR_TYPE.dense,
        color: C.textMuted,
      }),
    );
    return { root: body, keys: [] };
  }

  const resolved = resolveWaveSettings(snapshot);
  const busy = snapshot.busy === true;
  const set = (key: string, value: WaveOptionValue) => {
    // Every value a control here can produce is in range by construction; a
    // refusal would mean the table and the control disagree, and committing
    // nothing is the safe answer to that.
    let next: Record<string, unknown>;
    try {
      next = withWaveValue(snapshot.overrides, key, value);
    } catch {
      return;
    }
    ctx.onApply(next);
  };

  // ---- Heading: what this is, and the way back to the profile -------------
  const head = createXrRow(ui, { gap: tokens.space.sm, flexShrink: 0 });
  ui.appendChild(head, createXrTag(ui, t('ui.xrWaveOverhangs.experimental', 'Experimental'), C.warn));
  ui.appendChild(head, ui.createPanel({ flexGrow: 1 }));
  if (resolved.hasOverrides) {
    ui.appendChild(
      head,
      createXrTextButton(ui, {
        label: t('ui.xrWaveOverhangs.reset', 'Reset'),
        icon: 'undo',
        fontSize: XR_TYPE.caption,
        height: 30,
        paddingX: 10,
        enabled: !busy,
        onClick: () => ctx.onApply(withoutWaveOverrides(snapshot.overrides)),
      }).root,
    );
  }
  ui.appendChild(body, head);

  const keys: string[] = [];
  const master = resolved.options.find((entry) => entry.option.key === WAVE_MASTER_KEY)!;
  ui.appendChild(body, optionRow(ui, master, resolved, snapshot, busy, set, ctx));
  keys.push(WAVE_MASTER_KEY);

  for (const notice of waveNotices(resolved, snapshot)) {
    const card = createXrColumn(ui, {
      gap: 4,
      flexShrink: 0,
      padding: tokens.space.sm,
      cornerRadius: tokens.radius.sm,
      fillColor: C.warnSurface,
    });
    ui.appendChild(card, ui.createText(notice.text, { fontSize: XR_TYPE.micro, color: C.text, flexShrink: 1 }));
    const fix = notice.fix;
    if (fix) {
      ui.appendChild(
        card,
        createXrTextButton(ui, {
          label: fix.label,
          fontSize: XR_TYPE.caption,
          height: 30,
          paddingX: 10,
          enabled: !busy,
          onClick: () => ctx.onApply(withWaveNoticeFix(snapshot.overrides, fix.id)),
        }).root,
      );
    }
    ui.appendChild(body, card);
  }

  if (!resolved.enabled) return { root: body, keys };

  const list = createXrColumn(ui, { gap: 4, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, list);
  for (const group of WAVE_OPTION_GROUPS) {
    const entries = resolved.options.filter(
      (entry) => entry.option.group === group && entry.option.key !== WAVE_MASTER_KEY && entry.applies,
    );
    if (entries.length === 0) continue;
    ui.appendChild(list, createXrHeading(ui, waveGroupLabel(group)));
    for (const entry of entries) {
      ui.appendChild(list, optionRow(ui, entry, resolved, snapshot, busy, set, ctx));
      keys.push(entry.option.key);
    }
  }
  return { root: body, keys };
}

/** One option: its label, where its value comes from, its guidance, and its editor. */
function optionRow<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  entry: WaveOptionState,
  resolved: WaveSettingsState,
  snapshot: WaveOverhangsProjectSnapshot,
  busy: boolean,
  set: (key: string, value: WaveOptionValue) => void,
  ctx: XrWaveOverhangsPanelContext,
): PanelNode {
  const { option, value } = entry;
  const overridden = entry.source === 'override';
  const editable = !busy && option.inert !== true;
  const line = createXrRow(ui, {
    minHeight: 40,
    gap: 6,
    flexShrink: 0,
    paddingLeft: tokens.space.sm,
    paddingRight: tokens.space.sm,
    paddingTop: 4,
    paddingBottom: 4,
    cornerRadius: tokens.radius.sm,
    fillColor: overridden ? C.warnSurface : C.surfaceDisabled,
  });

  const label = createXrColumn(ui, { gap: 1, flexGrow: 1, flexShrink: 1 });
  ui.appendChild(
    label,
    ui.createText(waveOptionText(option.key).label, {
      fontSize: XR_TYPE.caption,
      color: overridden ? C.text : C.textMuted,
    }),
  );
  ui.appendChild(label, ui.createText(waveSourceLabel(entry.source), { fontSize: XR_TYPE.tag, color: C.textMuted }));
  for (const note of waveOptionNotes(entry, resolved, snapshot.effectiveConfig)) {
    ui.appendChild(
      label,
      ui.createText(note.text, {
        fontSize: XR_TYPE.micro,
        color: note.tone === 'warn' ? C.warn : C.textMuted,
        flexShrink: 1,
      }),
    );
    const fix = note.fix;
    if (fix) {
      ui.appendChild(
        label,
        createXrTextButton(ui, {
          label: fix.label,
          fontSize: XR_TYPE.caption,
          height: 28,
          paddingX: 8,
          enabled: !busy,
          onClick: () => set(option.key, fix.value),
        }).root,
      );
    }
  }
  ui.appendChild(line, label);

  switch (option.kind) {
    case 'bool': {
      const on = value === true;
      const toggle = ui.createPanel({
        width: 52,
        height: 30,
        flexShrink: 0,
        cornerRadius: 15,
        padding: 3,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: on ? 'flex-end' : 'flex-start',
        fillColor: on ? C.accent : C.strokeStrong,
        opacity: editable ? 1 : 0.45,
        onClick: () => {
          if (editable) set(option.key, !on);
        },
      });
      ui.appendChild(toggle, ui.createPanel({ width: 24, height: 24, cornerRadius: 12, fillColor: C.text }));
      ui.appendChild(line, toggle);
      break;
    }
    case 'enum': {
      ui.appendChild(
        line,
        createXrTextButton(ui, {
          label: `${waveChoiceLabel(option.key, String(value))} ⌄`,
          fontSize: XR_TYPE.caption,
          height: 32,
          paddingX: 10,
          enabled: editable,
          // One press cycles, as the Settings panel's enumerations do.
          onClick: () => set(option.key, steppedWaveValue(entry, 1)),
        }).root,
      );
      break;
    }
    default: {
      const current = typeof value === 'number' ? value : Number(option.engineDefault);
      const unit = option.unit ? ` ${option.unit}` : '';
      const controls = createXrRow(ui, { width: 'auto', flexShrink: 0, gap: 5 });
      ui.appendChild(
        controls,
        createXrIconButton(ui, {
          icon: 'minus',
          size: 32,
          iconSize: 14,
          enabled: editable && (option.min === undefined || current > option.min),
          onClick: () => set(option.key, steppedWaveValue(entry, -1)),
        }).root,
      );
      const readout = createXrTextButton(ui, {
        label: `${current}${unit}`,
        fontSize: XR_TYPE.caption,
        height: 32,
        paddingX: 8,
        enabled: editable,
        onClick: () => ctx.onEditValue(option, current),
      });
      ui.setPanelProperties(readout.root, { minWidth: 74, fillColor: C.bgSunken });
      ui.appendChild(controls, readout.root);
      ui.appendChild(
        controls,
        createXrIconButton(ui, {
          icon: 'plus',
          size: 32,
          iconSize: 14,
          enabled: editable && (option.max === undefined || current < option.max),
          onClick: () => set(option.key, steppedWaveValue(entry, 1)),
        }).root,
      );
      ui.appendChild(line, controls);
      break;
    }
  }

  if (overridden) {
    ui.appendChild(
      line,
      createXrIconButton(ui, {
        icon: 'undo',
        size: 32,
        iconSize: 14,
        label: t('ui.xrWaveOverhangs.clear', 'Use the inherited value'),
        enabled: !busy,
        onClick: () => ctx.onApply(withoutWaveValue(snapshot.overrides, option.key)),
      }).root,
    );
  }
  return line;
}
