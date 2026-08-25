/**
 * XrPanelHost — the inspector: a grab bar, a strip of open panels, and one body.
 *
 * The flat shell's sidebar is a column of fold-away cards, which is the right
 * answer for a window that is 1600 px tall and the wrong one for a spatial
 * panel that is 720. So the same panels stack as **tabs** here, and the `+`
 * opens the Panels directory — the redesign's rule that every action is
 * reachable in three moves, with the third being the action itself.
 *
 * The host draws the chrome and nothing else: what a panel *is* is decided by
 * the caller's `renderBody`, so the Objects tree, the settings tree and a
 * group's action list all arrive here as the same kind of thing.
 */
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_TYPE,
  createXrColumn,
  createXrGrabBar,
  createXrIconButton,
  createXrRow,
  createXrSurfaceBody,
  createXrTextButton,
} from './XrChrome';
import type { XrPanelDescriptor, XrPanelId } from './XrPanels';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrPanelHostContext<PanelNode> {
  /** Panels the operator has opened, in the order they opened them. */
  readonly openPanels: readonly XrPanelDescriptor[];
  readonly activePanelId: XrPanelId | null;
  readonly pinned: boolean;
  onSelectPanel(id: XrPanelId): void;
  onClosePanel(id: XrPanelId): void;
  onOpenDirectory(): void;
  onTogglePin(): void;
  /** Fill `body` with the active panel. Called once per render. */
  renderBody(body: PanelNode, id: XrPanelId | null): void;
}

export interface XrPanelHostRender<PanelNode> {
  readonly root: PanelNode;
  /** The panel body, so a caller can rebuild it without redrawing the chrome. */
  readonly body: PanelNode;
}

export function renderXrPanelHost<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrPanelHostContext<PanelNode>,
): XrPanelHostRender<PanelNode> {
  const surface = createXrSurfaceBody(ui, { padding: tokens.space.sm, gap: 6 });
  ui.appendChild(root, surface);

  const grab = createXrGrabBar(ui, {
    title: t('ui.xrPanelHost.title', 'Panels'),
    hint: ctx.pinned
      ? t('ui.xrPanelHost.pinnedHint', 'Pinned — recentre leaves it here')
      : t('ui.xrPanelHost.hint', 'Drag to place, pin to keep it there'),
    pinned: ctx.pinned,
    onPin: () => ctx.onTogglePin(),
  });
  ui.appendChild(surface, grab.root);

  // ---- The open panels ---------------------------------------------------
  const tabs = createXrRow(ui, { gap: 3, flexShrink: 0 });
  ui.appendChild(surface, tabs);
  for (const panel of ctx.openPanels) {
    const active = panel.id === ctx.activePanelId;
    const tab = createXrTextButton(ui, {
      label: panel.label,
      fontSize: XR_TYPE.caption,
      height: 34,
      paddingX: 10,
      flexShrink: 1,
      selected: active,
      onClick: () => ctx.onSelectPanel(panel.id),
    });
    ui.setPanelProperties(tab.root, {
      fillColor: active ? C.bgChrome : C.surfaceDisabled,
      strokeColor: active ? C.strokeStrong : C.stroke,
    });
    ui.appendChild(tabs, tab.root);
    // Closing a tab is its own target beside it, not a long-press: a headset
    // has no hover state in which to reveal a close affordance.
    if (active && ctx.openPanels.length > 1) {
      ui.appendChild(
        tabs,
        createXrIconButton(ui, { icon: 'close', size: 28, iconSize: 12, onClick: () => ctx.onClosePanel(panel.id) })
          .root,
      );
    }
  }
  ui.appendChild(
    tabs,
    createXrIconButton(ui, { icon: 'plus', size: 30, iconSize: 16, onClick: () => ctx.onOpenDirectory() }).root,
  );

  // ---- The active panel --------------------------------------------------
  const body = createXrColumn(ui, {
    gap: tokens.space.sm,
    flexGrow: 1,
    flexShrink: 1,
    paddingTop: 6,
    overflow: 'hidden',
  });
  ui.appendChild(surface, body);

  if (ctx.openPanels.length === 0 || ctx.activePanelId === null) {
    ui.appendChild(
      body,
      ui.createText(t('ui.xrPanelHost.empty', 'No panel open. Pinch + to choose one, or use the Panels menu.'), {
        fontSize: XR_TYPE.dense,
        color: C.textMuted,
      }),
    );
  } else {
    ctx.renderBody(body, ctx.activePanelId);
  }

  return { root: surface, body };
}
