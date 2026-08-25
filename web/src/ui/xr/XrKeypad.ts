/**
 * XrKeypad — entering a value in a headset.
 *
 * This is the constraint the rest of the immersive shell was shaped by. With no
 * way to enter a value, a spatial settings surface can only offer what a pair
 * of `−`/`+` buttons can reach, which is why it showed six stepped rows and a
 * line reading "94 more are unavailable"; a rename had nowhere to type a name;
 * `calib_configure` could not be given a number; and a dozen actions carry an
 * `xrUnsupportedReason` that says, in so many words, that there is no in-headset
 * number entry.
 *
 * There are two layouts, because the two jobs are not the same shape:
 *
 *  - {@link renderXrKeypad} is the numeric pad — ten digits, a sign, a point
 *    and a backspace, with the field's own declared range printed above it and
 *    enforced on apply. It is small enough to open beside the field it edits.
 *  - {@link renderXrKeyboard} is a QWERTY layer for names, prompts and console
 *    commands. Ten 58 mm keys across is 0.64 m of headset whichever way it is
 *    arranged, which is why it is a wider surface rather than the same one.
 *
 * Both are built from OrcaXR's own {@link XrChrome} controls rather than from
 * `xrblocks/addons/virtualkeyboard`, whose keys draw Material Symbols from a
 * CDN: the app's CSP refuses that, and a keyboard that only works online is not
 * a keyboard a slicer can rely on.
 */
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_HIT,
  XR_TYPE,
  createXrColumn,
  createXrIconButton,
  createXrRow,
  createXrSurfaceBody,
  createXrTextButton,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrValueEntryRequest {
  /** What is being edited, in the operator's words. */
  readonly title: string;
  readonly initial: string;
  readonly unit?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  /** Numeric fields refuse a value outside their declared range on apply. */
  readonly integer?: boolean;
}

export interface XrValueEntryHandlers {
  onCommit(value: string): void;
  onCancel(): void;
}

export interface XrValueEntryRender<PanelNode> {
  readonly root: PanelNode;
  /** The draft as it currently reads; the automation seam. */
  value(): string;
  /** Type one key, exactly as pressing it would. */
  press(key: string): void;
}

/** Whether `draft` is a number this field would accept. */
export function xrValueAccepted(draft: string, request: XrValueEntryRequest): boolean {
  const trimmed = draft.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '.') return false;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return false;
  if (request.integer === true && !Number.isInteger(numeric)) return false;
  if (request.minimum !== undefined && numeric < request.minimum) return false;
  if (request.maximum !== undefined && numeric > request.maximum) return false;
  return true;
}

function rangeLabel(request: XrValueEntryRequest): string {
  const unit = request.unit ? ` ${request.unit}` : '';
  if (request.minimum === undefined && request.maximum === undefined) return unit.trim();
  const low = request.minimum === undefined ? '−∞' : String(request.minimum);
  const high = request.maximum === undefined ? '∞' : String(request.maximum);
  return `${low} – ${high}${unit}`;
}

/** The value display plus Cancel/Apply, shared by both layouts. */
function entryFrame<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  request: XrValueEntryRequest,
  handlers: XrValueEntryHandlers,
  state: { draft: string },
  accepted: (draft: string) => boolean,
): { body: PanelNode; keys: PanelNode; sync: () => void } {
  const body = createXrSurfaceBody(ui, { elevation: 'elevated', padding: tokens.space.md, gap: tokens.space.sm });
  ui.appendChild(root, body);

  const header = createXrRow(ui, { flexShrink: 0, justifyContent: 'space-between' });
  ui.appendChild(header, ui.createText(request.title, { fontSize: XR_TYPE.caption, color: C.textMuted }));
  const range = rangeLabel(request);
  if (range) ui.appendChild(header, ui.createText(range, { fontSize: XR_TYPE.micro, color: C.textMuted }));
  ui.appendChild(body, header);

  const display = ui.createPanel({
    width: '100%',
    flexShrink: 0,
    minHeight: 52,
    justifyContent: 'center',
    paddingLeft: tokens.space.md,
    paddingRight: tokens.space.md,
    cornerRadius: tokens.radius.md,
    fillColor: C.bgSunken,
    strokeWidth: 1,
    strokeColor: C.accent,
  });
  const draftText = ui.createText(state.draft, {
    fontSize: 24,
    fontWeight: 'bold',
    color: C.text,
    textAlign: 'right',
  });
  ui.appendChild(display, draftText);
  ui.appendChild(body, display);

  const keys = createXrColumn(ui, { gap: 6, flexGrow: 1, flexShrink: 1 });
  ui.appendChild(body, keys);

  const actions = createXrRow(ui, { gap: 6, flexShrink: 0 });
  const cancel = createXrTextButton(ui, {
    label: t('ui.xrKeypad.cancel', 'Cancel'),
    flexGrow: 1,
    fontSize: XR_TYPE.dense,
    onClick: () => handlers.onCancel(),
  });
  const apply = createXrTextButton(ui, {
    label: t('ui.xrKeypad.apply', 'Apply'),
    flexGrow: 2,
    fontSize: XR_TYPE.dense,
    primary: true,
    onClick: () => {
      if (accepted(state.draft)) handlers.onCommit(state.draft);
    },
  });
  ui.appendChild(actions, cancel.root);
  ui.appendChild(actions, apply.root);
  ui.appendChild(body, actions);

  const sync = () => {
    ui.setText(draftText, state.draft === '' ? '—' : state.draft);
    // A value the field would refuse cannot be applied, and says so by going
    // dim rather than by being accepted and rejected somewhere else.
    apply.setEnabled(accepted(state.draft));
  };
  sync();
  return { body, keys, sync };
}

const KEYPAD_ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['−', '0', '.'],
];

/** Numeric entry, opened beside the field it edits. */
export function renderXrKeypad<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  request: XrValueEntryRequest,
  handlers: XrValueEntryHandlers,
): XrValueEntryRender<PanelNode> {
  const state = { draft: request.initial };
  const accepted = (draft: string) => xrValueAccepted(draft, request);
  const frame = entryFrame(ui, root, request, handlers, state, accepted);

  const press = (key: string): void => {
    if (key === '⌫') state.draft = state.draft.slice(0, -1);
    else if (key === '−') state.draft = state.draft.startsWith('-') ? state.draft.slice(1) : `-${state.draft}`;
    else if (key === '.') state.draft = state.draft.includes('.') ? state.draft : `${state.draft || '0'}.`;
    else state.draft += key;
    frame.sync();
  };

  for (const row of KEYPAD_ROWS) {
    const line = createXrRow(ui, { gap: 6, flexGrow: 1, flexShrink: 1 });
    for (const key of row) {
      const button = createXrTextButton(ui, {
        label: key,
        fontSize: 18,
        height: XR_HIT.target,
        flexGrow: 1,
        onClick: () => press(key),
      });
      ui.appendChild(line, button.root);
    }
    // Backspace shares the last row rather than taking one of its own: a
    // 0.34 m surface has room for four rows of keys and no more.
    if (row === KEYPAD_ROWS[KEYPAD_ROWS.length - 1]) {
      ui.appendChild(
        line,
        createXrIconButton(ui, { icon: 'undo', size: XR_HIT.target, iconSize: 20, onClick: () => press('⌫') }).root,
      );
    }
    ui.appendChild(frame.keys, line);
  }

  return { root: frame.body, value: () => state.draft, press };
}

/**
 * Five rows, arranged so nothing is smaller than the 58 mm floor.
 *
 * The digits are their own row rather than a shift layer: a slicer's text is
 * mostly file names and console commands, and `M104 S210` should not need a
 * modifier. The space bar is the one key allowed to be shorter than the floor —
 * it is 400 mm wide and unmistakable, which is the property that floor exists
 * to guarantee.
 */
const KEYBOARD_ROWS: readonly (readonly string[])[] = [
  [...'1234567890'],
  [...'qwertyuiop'],
  [...'asdfghjkl', '⌫'],
  ['⇧', ...'zxcvbnm', '-', '.'],
];

/** Text entry: renames, prompts, console commands, palette queries. */
export function renderXrKeyboard<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  request: XrValueEntryRequest,
  handlers: XrValueEntryHandlers,
): XrValueEntryRender<PanelNode> {
  const state = { draft: request.initial };
  let shifted = false;
  // Text has no range to be outside of. The one refusal is a draft that would
  // clear a field which had something in it — a rename to nothing is a defect,
  // not an edit — so an empty draft applies only if the field started empty.
  const accepted = (draft: string) => draft.length > 0 || request.initial.length === 0;
  const frame = entryFrame(ui, root, request, handlers, state, accepted);

  const letters: { key: string; setLabel(label: string): void }[] = [];
  const press = (key: string): void => {
    if (key === '⌫') state.draft = state.draft.slice(0, -1);
    else if (key === '␣') state.draft += ' ';
    else if (key === '⇧') {
      shifted = !shifted;
      for (const letter of letters) letter.setLabel(shifted ? letter.key.toUpperCase() : letter.key);
      return;
    } else {
      state.draft += shifted ? key.toUpperCase() : key;
      if (shifted) {
        shifted = false;
        for (const letter of letters) letter.setLabel(letter.key);
      }
    }
    frame.sync();
  };

  for (const row of KEYBOARD_ROWS) {
    const line = createXrRow(ui, { gap: 5, flexGrow: 1, flexShrink: 1, justifyContent: 'center' });
    for (const key of row) {
      const button = createXrTextButton(ui, {
        label: key,
        fontSize: 18,
        height: XR_HIT.target,
        flexGrow: 1,
        flexShrink: 1,
        paddingX: 0,
        onClick: () => press(key),
      });
      if (/^[a-z]$/.test(key)) letters.push({ key, setLabel: button.setLabel });
      ui.appendChild(line, button.root);
    }
    ui.appendChild(frame.keys, line);
  }

  ui.appendChild(
    frame.keys,
    createXrTextButton(ui, {
      label: t('ui.xrKeypad.space', 'Space'),
      fontSize: XR_TYPE.dense,
      height: 46,
      flexGrow: 1,
      onClick: () => press('␣'),
    }).root,
  );

  return { root: frame.body, value: () => state.draft, press };
}
