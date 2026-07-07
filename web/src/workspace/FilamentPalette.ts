/**
 * Filament palette — the set of filament slots the user prints with.
 *
 * Drives three things that were previously disconnected: the paint tool's
 * color choices, the colors a loaded multi-material 3MF is displayed in,
 * and the `filament_colour`/`filament_settings_id` overrides handed to the
 * slicer. Populated from a loaded 3MF's own filament list, or seeded from
 * the active profile, and editable in both shells.
 */
export interface FilamentSlot {
  /** '#rrggbb' — the display + paint color. */
  color: string;
  /** Filament type label, e.g. 'PLA'. Cosmetic + slicer hint. */
  type: string;
}

const DEFAULT_SLOTS: FilamentSlot[] = [
  { color: '#5F605F', type: 'PLA' },
  { color: '#E22B22', type: 'PLA' },
  { color: '#FEC134', type: 'PLA' },
  { color: '#FEFEFE', type: 'PLA' },
];

export class FilamentPalette {
  private slots: FilamentSlot[] = DEFAULT_SLOTS.map((s) => ({ ...s }));
  /** Fires whenever slots change (UIs re-render, paint swatches refresh). */
  onChanged: (() => void) | null = null;

  list(): FilamentSlot[] {
    return this.slots.map((s) => ({ ...s }));
  }

  count(): number {
    return this.slots.length;
  }

  colorAt(i: number): string {
    return this.slots[i]?.color ?? '#ffffff';
  }

  setColor(i: number, color: string) {
    if (this.slots[i]) {
      this.slots[i].color = color;
      this.emit();
    }
  }

  add(color = '#cccccc', type = 'PLA') {
    if (this.slots.length >= 16) return;
    this.slots.push({ color, type });
    this.emit();
  }

  remove(i: number) {
    if (this.slots.length <= 1) return;
    this.slots.splice(i, 1);
    this.emit();
  }

  /** Replace all slots (e.g. from a loaded 3MF's filament_colour). */
  setFrom(colors: string[], types?: string[]) {
    if (!colors.length) return;
    this.slots = colors.map((c, i) => ({
      color: c.startsWith('#') ? c : `#${c}`,
      type: types?.[i] ?? 'PLA',
    }));
    this.emit();
  }

  /** Slicer overrides for the filament slots. libslic3r's ConfigOptionStrings
   *  splits on ';' — a comma-joined list parses as ONE value, which silently
   *  shrank the engine's filament count (libslic3r gotcha #19). */
  toSlicerOverrides(): Record<string, string> {
    const colors = this.slots.map((s) => s.color).join(';');
    return {
      filament_colour: colors,
      extruder_colour: colors,
    };
  }

  private emit() {
    if (this.onChanged) this.onChanged();
  }
}
