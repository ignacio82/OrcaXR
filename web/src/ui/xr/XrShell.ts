/**
 * XrShell — renders registry {@link Action}s as xrblocks uikit buttons, so the
 * immersive XR shell draws from the SAME catalogue as the DOM shell. Parity is
 * structural: an action can't exist on one shell and be missing on the other.
 *
 * The uikit constructors (`UIPanel`, `UIIcon`) are injected as an {@link XrUiFactory}
 * rather than imported, so this module has no dependency on xrblocks/three and
 * can be unit-tested in Node with fakes. `OrcaWorkspace` passes the real classes.
 *
 * Colours/radii come from the shared design {@link tokens} — the exact values the
 * hand-built XR cards used — so a registry-driven button renders identically.
 */
import type { Action } from '../../actions/ActionRegistry';
import { xrIcon } from '../icons';
import { tokens } from '../tokens';

/** Minimal shape of a uikit panel we depend on (fillColor + add). */
export interface XrPanel { fillColor: string; add(child: unknown): void; }
/** Minimal shape of a uikit icon we depend on (mutable color). */
export interface XrIcon { color: string; }

export interface XrUiFactory {
  Panel: new (opts: Record<string, unknown>) => XrPanel;
  Icon: new (name: string, opts: Record<string, unknown>) => XrIcon;
}

/** A rendered action button plus the pieces needed to restyle it (active state). */
export interface XrActionHandle {
  action: Action;
  btn: XrPanel;
  iconEl: XrIcon;
}

const C = tokens.color;
const IDLE_ICON = '#cccccc';

export interface XrButtonOpts {
  size?: number;
  iconSize?: number;
  danger?: boolean;
  /** Override hover-exit (tools restore active-aware colour via a refresh). */
  onHoverExit?: (btn: XrPanel) => void;
}

/** Build one uikit button for `action`; clicking it runs the action via `onRun`. */
export function renderXrActionButton(
  action: Action,
  onRun: (action: Action) => void,
  f: XrUiFactory,
  opts: XrButtonOpts = {},
): XrActionHandle {
  const size = opts.size ?? 80;
  const iconSize = opts.iconSize ?? 48;
  const stroke = opts.danger ? C.dangerSurface : C.stroke;
  const btn = new f.Panel({
    width: size,
    height: size,
    justifyContent: 'center',
    alignItems: 'center',
    cornerRadius: tokens.radius.sm,
    fillColor: C.surface,
    strokeWidth: 1,
    strokeColor: stroke,
    onClick: () => { onRun(action); return true; },
    onHoverEnter: () => { btn.fillColor = opts.danger ? '#ff525226' : C.surfaceHover; },
    onHoverExit: () => { (opts.onHoverExit ?? ((b: XrPanel) => { b.fillColor = C.surface; }))(btn); },
  });
  const iconEl = new f.Icon(xrIcon(action.icon), {
    color: opts.danger ? C.danger : IDLE_ICON,
    width: iconSize,
    height: iconSize,
  });
  btn.add(iconEl);
  return { action, btn, iconEl };
}

/**
 * Restyle tool buttons to reflect the active tool. Non-tool actions (e.g.
 * auto-orient, delete) carry no `tool` and are left untouched.
 */
export function refreshXrToolActive(handles: readonly XrActionHandle[], activeTool: string | null): void {
  for (const h of handles) {
    if (!h.action.tool) continue;
    const active = h.action.tool === activeTool;
    h.btn.fillColor = active ? C.surfaceActive : C.surface;
    h.iconEl.color = active ? C.text : IDLE_ICON;
  }
}
