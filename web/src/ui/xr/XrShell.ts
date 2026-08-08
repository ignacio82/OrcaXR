/**
 * XrShell — renders registry {@link Action}s as xrblocks uikit buttons, so the
 * immersive XR shell draws from the SAME catalogue as the DOM shell. Parity is
 * structural: an action can't exist on one shell and be missing on the other.
 *
 * The uikit constructors (`UIPanel`, local-SVG `UIImage`) are injected as an {@link XrUiFactory}
 * rather than imported, so this module has no dependency on xrblocks/three and
 * can be unit-tested in Node with fakes. `OrcaWorkspace` passes the real classes.
 *
 * Colours/radii come from the shared design {@link tokens} — the exact values the
 * hand-built XR cards used — so a registry-driven button renders identically.
 */
import type { Action } from '../../actions/ActionRegistry';
import { xrIcon } from '../icons';
import { tokens } from '../tokens';

/**
 * Small reactive surface used by this renderer. UIBlocks deliberately exposes
 * setters for live values; assigning construction properties later does not
 * update its signal graph.
 */
export interface XrPanel<Child = unknown> {
  add(child: Child): void;
  setFillColor(color: string): void;
  setProperties(props: { opacity?: number }): void;
}
export interface XrIcon {
  setColor(color: string): void;
}

export interface XrUiFactory<P extends XrPanel<I>, I extends XrIcon> {
  createPanel(opts: Record<string, unknown>): P;
  createIcon(name: string, opts: Record<string, unknown>): I;
}

/** A rendered action button plus the pieces needed to restyle it (active state). */
export interface XrActionHandle<P extends XrPanel<I> = XrPanel<XrIcon>, I extends XrIcon = XrIcon> {
  action: Action;
  btn: P;
  iconEl: I;
}

const C = tokens.color;
const IDLE_ICON = '#cccccc';

export interface XrButtonOpts {
  size?: number;
  iconSize?: number;
  danger?: boolean;
  /** Current registry availability; disabled buttons still route to the guard for explanation. */
  enabled?: boolean;
  /** Override hover-exit (tools restore active-aware colour via a refresh). */
  onHoverExit?: (btn: XrPanel<XrIcon>) => void;
}

/**
 * The rail is an explicit finite set, not "every action that owns a tool":
 * additional modal tools (support, seam, and fuzzy-skin painting) stay
 * reachable through the XR Tools overflow instead of growing the rail.
 */
const RAIL_ACTION_IDS = new Set([
  'tool_move',
  'tool_rotate',
  'tool_scale',
  'tool_lay_on_face',
  'tool_paint',
  'drop_to_bed',
  'delete_models',
]);

/** Keep the spatial rail finite while leaving every other action in menus. */
export function xrToolRailActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => RAIL_ACTION_IDS.has(action.id));
}

/** Build one uikit button for `action`; clicking it runs the action via `onRun`. */
export function renderXrActionButton<P extends XrPanel<I>, I extends XrIcon>(
  action: Action,
  onRun: (action: Action) => void,
  f: XrUiFactory<P, I>,
  opts: XrButtonOpts = {},
): XrActionHandle<P, I> {
  const size = opts.size ?? 80;
  const iconSize = opts.iconSize ?? 48;
  const stroke = opts.danger ? C.dangerSurface : C.stroke;
  const disabled =
    opts.enabled === false || action.capability.status === 'unavailable' || action.capability.status === 'blocked';
  const btn = f.createPanel({
    width: size,
    height: size,
    justifyContent: 'center',
    alignItems: 'center',
    cornerRadius: tokens.radius.sm,
    fillColor: disabled ? C.surfaceDisabled : C.surface,
    opacity: disabled ? 0.45 : 1,
    strokeWidth: 1,
    strokeColor: stroke,
    onClick: () => {
      onRun(action);
    },
    onHoverEnter: () => {
      if (!disabled) btn.setFillColor(opts.danger ? '#ff525226' : C.surfaceHover);
    },
    onHoverExit: () => {
      if (disabled) {
        btn.setFillColor(C.surfaceDisabled);
        return;
      }
      (
        opts.onHoverExit ??
        ((b: XrPanel<XrIcon>) => {
          b.setFillColor(C.surface);
        })
      )(btn);
    },
  });
  const iconEl = f.createIcon(xrIcon(action.icon), {
    color: disabled ? IDLE_ICON : opts.danger ? C.danger : IDLE_ICON,
    width: iconSize,
    height: iconSize,
  });
  btn.add(iconEl);
  return { action, btn, iconEl };
}

/**
 * Restyle tool buttons to reflect the active tool. Non-tool actions (drop to
 * bed and delete) carry no `tool` and are left untouched.
 */
export function refreshXrToolActive<P extends XrPanel<I>, I extends XrIcon>(
  handles: readonly XrActionHandle<P, I>[],
  activeTool: string | null,
): void {
  for (const h of handles) {
    if (!h.action.tool) continue;
    const active = h.action.tool === activeTool;
    h.btn.setFillColor(active ? C.surfaceActive : C.surface);
    h.iconEl.setColor(active ? C.text : IDLE_ICON);
  }
}
