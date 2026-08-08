/**
 * XrShell — renders registry {@link Action}s as xrblocks uikit buttons, so the
 * immersive XR shell draws from the SAME catalogue as the DOM shell. Parity is
 * structural: an action can't exist on one shell and be missing on the other.
 *
 * The exact UIBlocks constructors and signal-aware setters are isolated behind
 * a typed {@link XrUiAdapter}, so this component remains mockable without
 * replacing the pinned property types with `Record<string, unknown>`.
 *
 * Colours/radii come from the shared design {@link tokens} — the exact values the
 * hand-built XR cards used — so a registry-driven button renders identically.
 */
import type { Action } from '../../actions/ActionRegistry';
import { xrIcon } from '../icons';
import { tokens } from '../tokens';
import type { XrUiAdapter } from './XrUiAdapter';

/** A rendered action button plus the pieces needed to restyle it (active state). */
export interface XrActionHandle<P = unknown, I = unknown> {
  action: Action;
  btn: P;
  iconEl: I;
  /** Signal-aware state updates used by registry capability refreshes. */
  setEnabled(enabled: boolean): void;
  setSelected(selected: boolean): void;
  setBusy(busy: boolean): void;
  /** Invalidates the callback before the owning card recursively disposes its descendants. */
  dispose(): void;
  readonly disposed: boolean;
}

const C = tokens.color;
const IDLE_ICON = '#cccccc';

export interface XrButtonOpts {
  size?: number;
  iconSize?: number;
  danger?: boolean;
  /** Current registry availability; the guarded callback does not run while disabled. */
  enabled?: boolean;
  /** Override hover-exit (tools restore active-aware colour via a refresh). */
  onHoverExit?: () => void;
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
export function renderXrActionButton<P, I>(
  action: Action,
  onRun: (action: Action) => void,
  ui: XrUiAdapter<P, I>,
  opts: XrButtonOpts = {},
): XrActionHandle<P, I> {
  const size = opts.size ?? 80;
  const iconSize = opts.iconSize ?? 48;
  const stroke = opts.danger ? C.dangerSurface : C.stroke;
  const capabilityBlocked = action.capability.status === 'unavailable' || action.capability.status === 'blocked';
  let enabled = opts.enabled !== false && !capabilityBlocked;
  let selected = false;
  let busy = false;
  let hovered = false;
  let disposed = false;

  const btn = ui.createPanel({
    width: size,
    height: size,
    justifyContent: 'center',
    alignItems: 'center',
    cornerRadius: tokens.radius.sm,
    fillColor: enabled ? C.surface : C.surfaceDisabled,
    opacity: enabled ? 1 : 0.45,
    strokeWidth: 1,
    strokeColor: stroke,
    onClick: () => {
      if (!enabled || busy || disposed) return;
      onRun(action);
    },
    onHoverEnter: () => {
      if (!enabled || busy || disposed) return;
      hovered = true;
      ui.setPanelFill(btn, opts.danger ? '#ff525226' : C.surfaceHover);
    },
    onHoverExit: () => {
      hovered = false;
      applyVisualState();
      opts.onHoverExit?.();
    },
  });
  const iconEl = ui.createImage(xrIcon(action.icon), {
    color: enabled ? (opts.danger ? C.danger : IDLE_ICON) : IDLE_ICON,
    width: iconSize,
    height: iconSize,
  });
  ui.appendImage(btn, iconEl);

  function applyVisualState(): void {
    const interactive = enabled && !busy && !disposed;
    ui.setPanelOpacity(btn, interactive ? 1 : 0.45);
    ui.setPanelFill(
      btn,
      !interactive
        ? C.surfaceDisabled
        : hovered
          ? opts.danger
            ? '#ff525226'
            : C.surfaceHover
          : selected
            ? C.surfaceActive
            : C.surface,
    );
    ui.setImageColor(iconEl, !interactive ? IDLE_ICON : selected ? C.text : opts.danger ? C.danger : IDLE_ICON);
  }

  return {
    action,
    btn,
    iconEl,
    setEnabled(next) {
      enabled = next && !capabilityBlocked;
      applyVisualState();
    },
    setSelected(next) {
      selected = next;
      applyVisualState();
    },
    setBusy(next) {
      busy = next;
      applyVisualState();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      applyVisualState();
    },
    get disposed() {
      return disposed;
    },
  };
}

/**
 * Restyle tool buttons to reflect the active tool. Non-tool actions (drop to
 * bed and delete) carry no `tool` and are left untouched.
 */
export function refreshXrToolActive<P, I>(handles: readonly XrActionHandle<P, I>[], activeTool: string | null): void {
  for (const h of handles) {
    if (!h.action.tool) continue;
    h.setSelected(h.action.tool === activeTool);
  }
}
