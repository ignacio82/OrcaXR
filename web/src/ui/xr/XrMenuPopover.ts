/**
 * XrMenuPopover — what drops out of a menu-bar title, and the Panels directory.
 *
 * Two lists, one file, because they are the same control with different
 * contents: a column of registry rows drawn under the title that opened them.
 *
 * The rule that makes this worth its own module is the one about *withheld*
 * actions. On a screen, a disabled menu item explains itself in a tooltip when
 * the pointer rests on it. A headset has no pointer to rest, so a reason that
 * is only revealed on hover is a reason nobody reads — and this catalogue is
 * full of actions deliberately withheld with an exact sentence
 * (`availability().reason`, `capability.reason`, `xrUnsupportedReason`). Every
 * one of those sentences is printed **in the row**, unabbreviated. "Withheld
 * means stated, never absent" is the redesign's principle; this is where it is
 * either true or it is not.
 */
import type { Action, ActionRegistry, ActionSurface } from '../../actions/ActionRegistry';
import { XR_PANELS_SECTION_ID } from '../../actions/ActionRegistry';
import type { UiStateShape } from '../../actions/UiState';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import { XR_TYPE, createXrColumn, createXrListRow, createXrSurfaceBody } from './XrChrome';
import { xrInspectorPanels, type XrPanelId } from './XrPanels';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrMenuPopoverContext {
  readonly registry: ActionRegistry;
  readonly state: Readonly<UiStateShape>;
  /** A menu section id, or {@link XR_PANELS_SECTION_ID} for the directory. */
  readonly sectionId: string;
  readonly title: string;
  /** Panels currently open in the inspector, so the directory can mark them. */
  readonly openPanelIds?: ReadonlySet<XrPanelId>;
  onRun(action: Action, surface: ActionSurface): void;
  /** Only called for the Panels directory. */
  onOpenPanel?(id: XrPanelId): void;
}

export interface XrMenuPopoverRender<PanelNode> {
  readonly root: PanelNode;
  /** Rows in draw order, for automation and for the geometry-free tests. */
  readonly rows: readonly XrMenuPopoverRow[];
}

export interface XrMenuPopoverRow {
  readonly actionId: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Printed under the label when the row cannot run. */
  readonly reason?: string;
}

/**
 * One shortcut, in the spelling the operator's platform uses.
 *
 * The catalogue stores `mod+s`; a headset has no modifier key at all, but the
 * operator very likely also drives this project from a laptop, and the row is
 * where they learn the gesture exists.
 */
function shortcutLabel(action: Action): string {
  const first = action.shortcuts?.[0];
  if (!first) return '';
  return first
    .split('+')
    .map((part) =>
      part === 'mod'
        ? '⌘'
        : part === 'shift'
          ? '⇧'
          : part === 'alt'
            ? '⌥'
            : part.length === 1
              ? part.toUpperCase()
              : part,
    )
    .join('');
}

/** Draw one action as a row, gated exactly as every other shell gates it. */
function appendActionRow<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  parent: PanelNode,
  ctx: XrMenuPopoverContext,
  action: Action,
  surface: ActionSurface,
  rows: XrMenuPopoverRow[],
  opts: { readonly selected?: boolean } = {},
): void {
  const availability = ctx.registry.availability(action, surface, ctx.state);
  if (availability.state === 'hidden') return;
  const enabled = availability.state === 'enabled';
  const unavailable = action.capability.status === 'unavailable' || action.capability.status === 'blocked';
  const reason = availability.state === 'disabled' ? availability.reason : undefined;
  const row = createXrListRow(ui, {
    label: action.label,
    icon: action.icon,
    trailing: shortcutLabel(action),
    ...(unavailable ? { tag: t('ui.xrMenuPopover.unavailable', 'Unavailable') } : {}),
    ...(reason ? { reason } : action.hint ? { hint: action.hint } : {}),
    enabled,
    selected: opts.selected === true,
    onClick: () => ctx.onRun(action, surface),
  });
  ui.appendChild(parent, row.root);
  rows.push({ actionId: action.id, label: action.label, enabled, ...(reason ? { reason } : {}) });
}

export function renderXrMenuPopover<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrMenuPopoverContext,
): XrMenuPopoverRender<PanelNode> {
  const body = createXrSurfaceBody(ui, { elevation: 'elevated', padding: tokens.space.sm, gap: 2 });
  ui.appendChild(root, body);
  ui.appendChild(
    body,
    ui.createText(ctx.title, { fontSize: XR_TYPE.heading, fontWeight: 'bold', color: C.text, flexShrink: 0 }),
  );

  const list = createXrColumn(ui, { gap: 2, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, list);

  const rows: XrMenuPopoverRow[] = [];
  if (ctx.sectionId === XR_PANELS_SECTION_ID) {
    renderPanelsDirectory(ui, list, ctx, rows);
  } else {
    for (const action of ctx.registry.forSurface('xr-menu')) {
      if (String(action.menuSection) !== ctx.sectionId) continue;
      appendActionRow(ui, list, ctx, action, 'xr-menu', rows);
    }
    // The Tools menu also carries every tool that did not earn a place on the
    // rail, so the rail can stay finite without an action becoming unreachable.
    if (ctx.sectionId === 'tools') {
      for (const action of ctx.registry.forSurface('xr-toolbar')) {
        if (rows.some((row) => row.actionId === action.id)) continue;
        appendActionRow(ui, list, ctx, action, 'xr-toolbar', rows);
      }
    }
  }

  if (rows.length === 0) {
    ui.appendChild(
      list,
      ui.createText(t('ui.xrMenuPopover.nothingHere', 'Nothing here yet.'), {
        fontSize: XR_TYPE.body,
        color: C.textMuted,
      }),
    );
  }

  return { root: body, rows };
}

/**
 * Every panel the immersive inspector can open.
 *
 * `surfacesFor()` grants `xr-inspector` to every `dom-inspector` action
 * precisely so printer, preset, calibration and settings controls are not
 * silently absent from the headset. Nothing here decides which those are:
 * {@link xrInspectorPanels} derives the list from the registry, so a panel
 * added to the flat shell appears here without an XR change.
 */
function renderPanelsDirectory<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  list: PanelNode,
  ctx: XrMenuPopoverContext,
  rows: XrMenuPopoverRow[],
): void {
  ui.appendChild(
    list,
    ui.createText(
      t('ui.xrMenuPopover.panelsHint', 'Every panel the flat sidebar can show. Pinch to open it in the inspector.'),
      { fontSize: XR_TYPE.micro, color: C.textMuted, paddingBottom: 4 },
    ),
  );
  for (const panel of xrInspectorPanels(ctx.registry)) {
    const open = ctx.openPanelIds?.has(panel.id) === true;
    const row = createXrListRow(ui, {
      label: panel.label,
      icon: panel.icon,
      ...(panel.actionCount > 0
        ? {
            trailing: t('ui.xrMenuPopover.panelActions', '{count} controls').replace(
              '{count}',
              String(panel.actionCount),
            ),
          }
        : {}),
      selected: open,
      onClick: () => ctx.onOpenPanel?.(panel.id),
    });
    ui.appendChild(list, row.root);
    rows.push({ actionId: panel.id, label: panel.label, enabled: true });
  }
}
