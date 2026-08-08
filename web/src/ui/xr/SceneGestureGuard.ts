/**
 * Sticky per-controller ownership for one XR select gesture. Once a gesture
 * touches spatial UI it cannot fall through to scene manipulation until that
 * same controller releases. Controllers remain independent.
 */
export interface SceneGestureSnapshot {
  readonly starts: number;
  readonly updates: number;
  readonly ends: number;
  readonly allowedTransitions: number;
  readonly suppressedTransitions: number;
  readonly activeControllers: number;
  readonly uiOwnedControllers: number;
  readonly disposed: boolean;
}

export class SceneGestureGuard<TController> {
  private readonly suppressed = new Set<TController>();
  private readonly active = new Set<TController>();
  private starts = 0;
  private updates = 0;
  private ends = 0;
  private allowedTransitions = 0;
  private suppressedTransitions = 0;
  private disposed = false;

  begin(controller: TController, hitsUi: boolean): boolean {
    if (this.disposed) return false;
    this.starts += 1;
    this.active.add(controller);
    this.suppressed.delete(controller);
    if (hitsUi) this.suppressed.add(controller);
    return this.recordDecision(!hitsUi);
  }

  allow(controller: TController, hitsUi: boolean): boolean {
    if (this.disposed) return false;
    this.updates += 1;
    if (this.suppressed.has(controller)) return this.recordDecision(false);
    if (hitsUi) {
      this.suppressed.add(controller);
      return this.recordDecision(false);
    }
    return this.recordDecision(true);
  }

  end(controller: TController): void {
    if (this.disposed) return;
    this.ends += 1;
    this.active.delete(controller);
    this.suppressed.delete(controller);
  }

  clear(): void {
    this.active.clear();
    this.suppressed.clear();
  }

  /** Stop all future scene transitions and release per-controller state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  snapshot(): SceneGestureSnapshot {
    return Object.freeze({
      starts: this.starts,
      updates: this.updates,
      ends: this.ends,
      allowedTransitions: this.allowedTransitions,
      suppressedTransitions: this.suppressedTransitions,
      activeControllers: this.active.size,
      uiOwnedControllers: this.suppressed.size,
      disposed: this.disposed,
    });
  }

  private recordDecision(allowed: boolean): boolean {
    if (allowed) this.allowedTransitions += 1;
    else this.suppressedTransitions += 1;
    return allowed;
  }
}
