/** Per-render-display ownership for derived paint overlays. */
export class PaintOverlayRegistry<Display extends object, Identity, Overlay> {
  private readonly records = new Map<Display, { identity: Identity; overlay: Overlay }>();

  get(display: Display): Overlay | undefined {
    return this.records.get(display)?.overlay;
  }

  identityFor(display: Display): Identity | undefined {
    return this.records.get(display)?.identity;
  }

  set(display: Display, identity: Identity, overlay: Overlay): void {
    this.records.set(display, { identity, overlay });
  }

  delete(display: Display): boolean {
    return this.records.delete(display);
  }

  entries(): IterableIterator<[Display, { identity: Identity; overlay: Overlay }]> {
    return this.records.entries();
  }

  prune(liveDisplays: ReadonlySet<Display>, dispose: (overlay: Overlay) => void): number {
    let removed = 0;
    for (const [display, record] of [...this.records]) {
      if (liveDisplays.has(display)) continue;
      this.records.delete(display);
      dispose(record.overlay);
      removed += 1;
    }
    return removed;
  }

  clear(dispose: (overlay: Overlay) => void): void {
    for (const { overlay } of this.records.values()) dispose(overlay);
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
