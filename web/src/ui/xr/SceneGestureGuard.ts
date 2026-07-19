/**
 * Sticky per-controller ownership for one XR select gesture. Once a gesture
 * touches spatial UI it cannot fall through to scene manipulation until that
 * same controller releases. Controllers remain independent.
 */
export class SceneGestureGuard<TController> {
  private readonly suppressed = new Set<TController>();

  begin(controller: TController, hitsUi: boolean): boolean {
    this.suppressed.delete(controller);
    if (hitsUi) this.suppressed.add(controller);
    return !hitsUi;
  }

  allow(controller: TController, hitsUi: boolean): boolean {
    if (this.suppressed.has(controller)) return false;
    if (hitsUi) {
      this.suppressed.add(controller);
      return false;
    }
    return true;
  }

  end(controller: TController): void {
    this.suppressed.delete(controller);
  }

  clear(): void {
    this.suppressed.clear();
  }
}
