/**
 * ActionRegistry — the ONE declaration of everything OrcaXR can do.
 *
 * Both shells render from this list, so an action can never exist in one shell
 * and be missing from the other: parity is structural, not maintained by hand.
 * Each entry declares the Android MCP tool it drives via `mcpTool` (many UI
 * actions may share one tool, e.g. the primitive buttons → `add_primitive`),
 * which lets the parity test assert the web action surface against the canonical
 * 163-tool set.
 *
 * Handlers receive only an {@link ActionContext} — they never touch the
 * workspace, palette, or slicer directly, so the same code path runs whether
 * the action was triggered from a DOM button, an XR uikit panel, or the
 * command palette.
 */
import type { ActionContext } from './ActionContext';
import type { UiStateShape } from './UiState';

/** Top-level taxonomy. Powers the Add/Tools menus, inspector, command palette. */
export type GroupId =
  | 'scene'
  | 'paint'
  | 'slice'
  | 'filament'
  | 'output'
  | 'advanced'
  | 'system';

/**
 * Where an action surfaces:
 *  - `primary`   — always-visible primary bar (Load / Slice / Preview / Download)
 *  - `toolbar`   — the left tool rail (modal gizmos, paint)
 *  - `menu`      — grouped `Add ▾` / `Tools ▾` popovers
 *  - `inspector` — contextual controls inside the right inspector panel
 * Every action is also reachable by name from the command palette.
 */
export type Disclosure = 'primary' | 'toolbar' | 'menu' | 'inspector';

export interface Action {
  /** Stable id; matches the MCP tool id where a 1:1 tool exists. */
  id: string;
  label: string;
  /** Semantic icon key resolved by `ui/icons.ts` for each shell. */
  icon: string;
  group: GroupId;
  disclosure: Disclosure;
  /** For `disclosure: 'menu'` actions: which header menu they live under. */
  menuSection?: 'add' | 'tools';
  /** One-line description for tooltips / the command palette. */
  hint?: string;
  /** For toolbar tools: the tool this action selects (drives active state). */
  tool?: string;
  /**
   * Canonical Android MCP tool this action drives, when one exists. Several UI
   * actions may map onto one tool (e.g. the three `add_primitive_*` buttons →
   * `add_primitive`). The parity test asserts every `mcpTool` is a real member
   * of the 163-tool MCP surface, tying the web UI to the canonical catalogue.
   */
  mcpTool?: string;
  /** Default true. Return false to render disabled for the given state. */
  isEnabled?(s: Readonly<UiStateShape>): boolean;
  /** Default true. Return false to hide entirely for the given state. */
  isVisible?(s: Readonly<UiStateShape>): boolean;
  run(ctx: ActionContext): void | Promise<void>;
}

export interface ActionGroup {
  id: GroupId;
  label: string;
  icon: string;
  /** Sort order in menus / group selectors. */
  order: number;
}

export const GROUPS: readonly ActionGroup[] = [
  { id: 'scene', label: 'Scene', icon: 'scene', order: 0 },
  { id: 'paint', label: 'Paint', icon: 'paint', order: 1 },
  { id: 'slice', label: 'Slice', icon: 'slice', order: 2 },
  { id: 'filament', label: 'Filament', icon: 'filament', order: 3 },
  { id: 'output', label: 'Output', icon: 'output', order: 4 },
  { id: 'advanced', label: 'Advanced', icon: 'advanced', order: 5 },
  { id: 'system', label: 'System', icon: 'system', order: 6 },
];

export class ActionRegistry {
  private actions: Action[] = [];
  private byId = new Map<string, Action>();

  /** Register one action (throws on duplicate id — a parity/wiring bug). */
  add(action: Action): this {
    if (this.byId.has(action.id)) {
      throw new Error(`ActionRegistry: duplicate action id "${action.id}"`);
    }
    this.byId.set(action.id, action);
    this.actions.push(action);
    return this;
  }

  addAll(actions: Iterable<Action>): this {
    for (const a of actions) this.add(a);
    return this;
  }

  get(id: string): Action | undefined {
    return this.byId.get(id);
  }

  all(): readonly Action[] {
    return this.actions;
  }

  /** Actions with a given disclosure, optionally filtered by group. */
  byDisclosure(disclosure: Disclosure, group?: GroupId): Action[] {
    return this.actions.filter(
      (a) => a.disclosure === disclosure && (group === undefined || a.group === group),
    );
  }

  byGroup(group: GroupId): Action[] {
    return this.actions.filter((a) => a.group === group);
  }

  /** Convenience wrappers so shells don't re-implement the default-true logic. */
  static enabled(a: Action, s: Readonly<UiStateShape>): boolean {
    return a.isEnabled ? a.isEnabled(s) : true;
  }
  static visible(a: Action, s: Readonly<UiStateShape>): boolean {
    return a.isVisible ? a.isVisible(s) : true;
  }
}
