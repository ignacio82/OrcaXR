/**
 * XrContextMenu — the right-click menu, for a shell with no right button.
 *
 * `xr-context` is a surface {@link ActionRegistry} has always declared and the
 * immersive shell never drew, so "what can I do with *this*" had no answer in a
 * headset except to go and find the action in a menu. The catalogue's context
 * targets are a placement rather than a second list: an action names the
 * targets it makes sense on, and every shell renders the same set with the same
 * availability.
 *
 * The addressing is what differs. A screen opens this menu on whatever the
 * pointer was over; a headset opens it where the operator long-pinched, and the
 * panel is drawn there — {@link anchoredTransform} points it at the fingertip
 * rather than at a fixed angle from the head.
 */
import type { Action, ActionRegistry, ContextTarget } from '../../actions/ActionRegistry';
import type { UiStateShape } from '../../actions/UiState';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_TYPE,
  createXrColumn,
  createXrIconButton,
  createXrListRow,
  createXrRow,
  createXrSurfaceBody,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrContextMenuContext {
  readonly registry: ActionRegistry;
  readonly state: Readonly<UiStateShape>;
  readonly target: ContextTarget;
  /** What was pinched, named the way the operator reads it in the scene. */
  readonly targetLabel: string;
  onRun(action: Action): void;
  onClose(): void;
}

export interface XrContextMenuRender<PanelNode> {
  readonly root: PanelNode;
  readonly actions: readonly Action[];
}

export function renderXrContextMenu<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrContextMenuContext,
): XrContextMenuRender<PanelNode> {
  const body = createXrSurfaceBody(ui, { elevation: 'elevated', padding: tokens.space.sm, gap: 2 });
  ui.appendChild(root, body);
  const header = createXrRow(ui, { flexShrink: 0, paddingLeft: 4, paddingBottom: 4 });
  ui.appendChild(
    header,
    ui.createText(ctx.targetLabel, { fontSize: XR_TYPE.caption, color: C.textMuted, flexGrow: 1, flexShrink: 1 }),
  );
  // Backing out of a menu opened by a gesture needs a control, not a second
  // gesture: a transient surface with no visible dismissal is a trap.
  ui.appendChild(header, createXrIconButton(ui, { icon: 'close', size: 28, iconSize: 12, onClick: ctx.onClose }).root);
  ui.appendChild(body, header);

  const list = createXrColumn(ui, { gap: 2, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, list);

  const actions = ctx.registry
    .forContext(ctx.target, 'xr-context')
    .filter((action) => ctx.registry.availability(action, 'xr-context', ctx.state).state !== 'hidden');

  if (actions.length === 0) {
    ui.appendChild(
      list,
      ui.createText(t('ui.xrContextMenu.nothing', 'Nothing applies to this yet.'), {
        fontSize: XR_TYPE.dense,
        color: C.textMuted,
      }),
    );
  }
  for (const action of actions) {
    const availability = ctx.registry.availability(action, 'xr-context', ctx.state);
    const enabled = availability.state === 'enabled';
    const row = createXrListRow(ui, {
      label: action.label,
      icon: action.icon,
      fontSize: XR_TYPE.dense,
      danger: action.id === 'delete_models',
      ...(availability.state === 'disabled' ? { reason: availability.reason } : {}),
      enabled,
      onClick: () => ctx.onRun(action),
    });
    ui.appendChild(list, row.root);
  }

  return { root: body, actions };
}
