/**
 * One semantic icon name → a glyph for each shell.
 *
 *  - `xr`  is a Material Symbols name consumed by uikit's `UIIcon` (the XR shell
 *    already renders these, e.g. `open_with`, `format_paint`, `play_circle`).
 *  - `dom` is a self-contained unicode/emoji glyph so the desktop shell needs no
 *    web-font download (the page loads no Material Symbols font).
 *
 * Keep this the single place icons are chosen so the two shells stay visually
 * aligned. Unknown keys fall back to a neutral dot.
 */
export interface IconGlyph {
  /** Material Symbols name for the XR `UIIcon`. */
  xr: string;
  /** Unicode/emoji glyph for the DOM shell. */
  dom: string;
}

const ICONS: Record<string, IconGlyph> = {
  // Tools
  move: { xr: 'open_with', dom: '✥' },
  rotate: { xr: 'rotate_right', dom: '⟳' },
  scale: { xr: 'open_in_full', dom: '⤢' },
  lay_on_face: { xr: 'flip_to_back', dom: '⬓' },
  paint: { xr: 'format_paint', dom: '🖌' },
  auto_orient: { xr: 'explore', dom: '🧭' },
  minus: { xr: 'remove', dom: '−' },
  plus: { xr: 'add', dom: '+' },
  // Primary
  load: { xr: 'upload_file', dom: '📂' },
  slice: { xr: 'play_circle', dom: '▶' },
  preview: { xr: 'visibility', dom: '👁' },
  download: { xr: 'download', dom: '⭳' },
  // Scene menu
  library: { xr: 'add_circle', dom: '＋' },
  cube: { xr: 'deployed_code', dom: '◻' },
  cylinder: { xr: 'database', dom: '⬢' },
  sphere: { xr: 'circle', dom: '⬤' },
  repair: { xr: 'healing', dom: '✚' },
  simplify: { xr: 'compress', dom: '⤡' },
  calibration: { xr: 'thermostat', dom: '🌡' },
  plate: { xr: 'grid_view', dom: '▦' },
  union: { xr: 'merge', dom: '⧉' },
  subtract: { xr: 'content_cut', dom: '✂' },
  delete: { xr: 'delete', dom: '🗑' },
  // Groups
  scene: { xr: 'view_in_ar', dom: '◈' },
  slice_group: { xr: 'layers', dom: '≡' },
  filament: { xr: 'water_drop', dom: '💧' },
  output: { xr: 'print', dom: '🖨' },
  advanced: { xr: 'tune', dom: '⚙' },
  system: { xr: 'settings', dom: '⋯' },
  search: { xr: 'search', dom: '⌕' },
};

const FALLBACK: IconGlyph = { xr: 'radio_button_unchecked', dom: '•' };

export function icon(name: string): IconGlyph {
  return ICONS[name] ?? FALLBACK;
}

/** True when `name` has an explicit glyph (not the neutral fallback). */
export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** Material Symbols name for the XR `UIIcon`. */
export function xrIcon(name: string): string {
  return icon(name).xr;
}

/** Unicode/emoji glyph for the DOM shell. */
export function domIcon(name: string): string {
  return icon(name).dom;
}
