/**
 * UiState — the single reactive store the UI renders from.
 *
 * Both shells (DOM + XR) subscribe to this store and re-evaluate each
 * Action's `isEnabled` / `isVisible` whenever it changes. This replaces the
 * scattered, manual `btn.disabled = …` bookkeeping that today lives in
 * `main.ts` and drifts between the two shells.
 *
 * The store is intentionally tiny and framework-free: a plain object plus a
 * subscriber set. It is fed by the existing `OrcaWorkspace` callbacks
 * (`onStatusChanged`, `onDownloadReady`, selection, `palette.onChanged`).
 */

/** Which modal surface the workspace is in — drives the tool rail + inspector. */
export type WorkspaceMode = 'prepare' | 'preview';

export interface UiStateShape {
  /** Active modal surface. */
  mode: WorkspaceMode;
  /** Active modal tool ('move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint'). */
  activeTool: string;
  /** Number of models on the plate. */
  modelCount: number;
  /** Number of build plates. */
  plateCount: number;
  /** Whether any canonical Objects entity is currently selected. */
  hasSelection: boolean;
  /** Whether the primary selection is an independently transformable instance. */
  hasInstanceSelection: boolean;
  /** Canonical command-history availability. */
  canUndo: boolean;
  canRedo: boolean;
  /** Whether the canonical project differs from its last save/open checkpoint. */
  dirty: boolean;
  /** False when any attached project projection failed for the current revision. */
  projectionHealthy: boolean;
  /** Whether the Edit clipboard holds a copied/cut model (enables Paste). */
  hasClipboard: boolean;
  /** A slice is running. */
  isSlicing: boolean;
  /** A successful slice exists (Download / Send become available). */
  gcodeReady: boolean;
  /** Extruder count of the active profile (>1 shows multi-head rows). */
  extruderCount: number;
  /** More than one filament color is actually painted (enables painted slice). */
  hasMultiColorPaint: boolean;
  /** Latest status line. */
  status: string;
  /** Slice progress 0–100, or null when no slice is in flight. */
  progress: number | null;
  /** True when a blocking (error) pre-flight banner is active. */
  preflightBlocked: boolean;
}

const INITIAL: UiStateShape = {
  mode: 'prepare',
  // A selected model is directly draggable by default. Keep the detailed
  // transform controls quiet until the maker explicitly chooses Move/Rotate/
  // Scale, rather than covering the build plate immediately after import.
  activeTool: '',
  modelCount: 0,
  plateCount: 1,
  hasSelection: false,
  hasInstanceSelection: false,
  canUndo: false,
  canRedo: false,
  dirty: false,
  projectionHealthy: true,
  hasClipboard: false,
  isSlicing: false,
  gcodeReady: false,
  extruderCount: 1,
  hasMultiColorPaint: false,
  status: 'Ready. Load a model to begin.',
  progress: null,
  preflightBlocked: false,
};

export type UiStateListener = (s: Readonly<UiStateShape>) => void;

export class UiState {
  private state: UiStateShape = { ...INITIAL };
  private listeners = new Set<UiStateListener>();

  /** Read the current snapshot (do not mutate). */
  get(): Readonly<UiStateShape> {
    return this.state;
  }

  /** Merge a partial update and notify subscribers if anything changed. */
  update(patch: Partial<UiStateShape>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof UiStateShape)[]) {
      if (this.state[k] !== patch[k]) {
        // @ts-expect-error — index write across the union of value types.
        this.state[k] = patch[k];
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Subscribe; returns an unsubscribe function. Fires immediately with state. */
  subscribe(fn: UiStateListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }
}
