/**
 * One semantic icon name → a glyph for each shell.
 *
 *  - `xr` is a Material Symbols name resolved to a checked-in SVG. XR never
 *    uses UIBlocks' CDN-backed `UIIcon`.
 *  - `dom` is a self-contained unicode/emoji glyph so the desktop shell needs no
 *    web-font download (the page loads no Material Symbols font).
 *
 * Keep this the single place icons are chosen so the two shells stay visually
 * aligned. Unknown keys fall back to a neutral dot.
 */
export interface IconGlyph {
  /** Material Symbols name for the bundled XR image. */
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
  palette: { xr: 'palette', dom: '🎨' },
  smart_paint: { xr: 'wand_stars', dom: '✦' },
  smart_paint_image: { xr: 'image_search', dom: '▧' },
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
  file: { xr: 'folder', dom: '🗀' },
  edit: { xr: 'edit', dom: '✎' },
  view: { xr: 'visibility', dom: '👁' },
  help: { xr: 'help', dom: '?' },

  // File menu
  new_project: { xr: 'note_add', dom: '🗋' },
  folder_open: { xr: 'folder_open', dom: '📁' },
  settings_import: { xr: 'input', dom: '⇥' },
  settings_export: { xr: 'output', dom: '⤴' },
  archive: { xr: 'folder_zip', dom: '🗜' },
  save: { xr: 'save', dom: '💾' },
  save_as: { xr: 'save_as', dom: '🖫' },
  file_stl: { xr: 'deployed_code', dom: '⬗' },
  file_3mf: { xr: 'view_in_ar', dom: '⬖' },
  file_obj: { xr: 'chair', dom: '⬔' },
  gcode: { xr: 'code', dom: '⌗' },
  logs: { xr: 'description', dom: '🗎' },

  // Edit menu
  undo: { xr: 'undo', dom: '↶' },
  redo: { xr: 'redo', dom: '↷' },
  cut: { xr: 'content_cut', dom: '✂' },
  copy: { xr: 'content_copy', dom: '⧉' },
  paste: { xr: 'content_paste', dom: '📋' },
  duplicate: { xr: 'content_copy', dom: '⧉' },
  select_all: { xr: 'select_all', dom: '▤' },
  deselect: { xr: 'deselect', dom: '▢' },

  // View menu
  view_default: { xr: 'home', dom: '⌂' },
  view_top: { xr: 'vertical_align_top', dom: '⤒' },
  view_bottom: { xr: 'vertical_align_bottom', dom: '⤓' },
  view_front: { xr: 'crop_square', dom: '◻' },
  view_rear: { xr: 'flip_to_back', dom: '▨' },
  view_left: { xr: 'chevron_left', dom: '◧' },
  view_right: { xr: 'chevron_right', dom: '◨' },
  perspective: { xr: 'view_in_ar', dom: '◹' },
  labels: { xr: 'label', dom: '🏷' },
  overhang: { xr: 'warning', dom: '⚠' },
  wireframe: { xr: 'grid_3x3', dom: '▦' },
  navigator: { xr: 'explore', dom: '🧭' },
  outline: { xr: 'crop_free', dom: '▱' },
  printable_box: { xr: 'view_in_ar', dom: '⧉' },

  // Calibration menu
  flow: { xr: 'water_drop', dom: '🌊' },
  pressure: { xr: 'speed', dom: '📈' },
  retraction: { xr: 'straighten', dom: '↔' },
  vfa: { xr: 'earthquake', dom: '〰' },
  tolerance: { xr: 'aspect_ratio', dom: '⊹' },

  // Help menu
  wizard: { xr: 'wand_stars', dom: '🪄' },
  keyboard: { xr: 'keyboard', dom: '⌨' },
  language: { xr: 'language', dom: '🌐' },
  school: { xr: 'school', dom: '🎓' },
  book: { xr: 'menu_book', dom: '📖' },
  bug: { xr: 'bug_report', dom: '🐛' },
  info: { xr: 'info', dom: 'ⓘ' },
  chevron_down: { xr: 'keyboard_arrow_down', dom: '▾' },
  theme_dark: { xr: 'dark_mode', dom: '◐' },
  tip: { xr: 'lightbulb', dom: '💡' },
  update: { xr: 'update', dom: '⟳' },
  logout: { xr: 'logout', dom: '⇥' },
  close: { xr: 'close', dom: '×' },
  chevron_right: { xr: 'chevron_right', dom: '›' },

  // Gizmos & mesh ops
  intersect: { xr: 'join_inner', dom: '⧩' },
  arrange: { xr: 'grid_on', dom: '▥' },
  split_objects: { xr: 'call_split', dom: '⑃' },
  split_parts: { xr: 'account_tree', dom: '⑂' },
  support_paint: { xr: 'foundation', dom: '⋔' },
  seam_paint: { xr: 'timeline', dom: '⌇' },
  fuzzy_skin: { xr: 'blur_on', dom: '⁙' },
  brim_ears: { xr: 'hearing', dom: '⊙' },
  measure: { xr: 'straighten', dom: '📏' },
  assembly: { xr: 'category', dom: '⊞' },
  face_detector: { xr: 'change_history', dom: '△' },
  svg: { xr: 'image', dom: '🖼' },
  hollow: { xr: 'donut_large', dom: '◍' },
  modifier: { xr: 'tune', dom: '❖' },
  support_enforcer: { xr: 'add_box', dom: '⊕' },
  support_blocker: { xr: 'disabled_by_default', dom: '⊗' },
  height_range: { xr: 'height', dom: '↕' },
  negative_part: { xr: 'do_not_disturb_on', dom: '⊖' },
  layers_edit: { xr: 'layers', dom: '≣' },
  printer_send: { xr: 'send', dom: '📤' },
  printer_pause: { xr: 'pause_circle', dom: '⏸' },
  printer_resume: { xr: 'play_circle', dom: '▶' },
  printer_cancel: { xr: 'stop_circle', dom: '⏹' },
  emergency_stop: { xr: 'e911_emergency', dom: '🛑' },

  // Advanced tools
  emboss: { xr: 'title', dom: '🅣' },
  magnet: { xr: 'commit', dom: '🧲' },
  wipe_tower: { xr: 'cleaning_services', dom: '🗼' },
  network: { xr: 'wifi', dom: '📶' },
  webcam: { xr: 'videocam', dom: '📷' },
};

const FALLBACK: IconGlyph = { xr: 'radio_button_unchecked', dom: '•' };

export function icon(name: string): IconGlyph {
  return ICONS[name] ?? FALLBACK;
}

/** True when `name` has an explicit glyph (not the neutral fallback). */
export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** URL for an offline, build-owned SVG suitable for UIBlocks `UIImage`. */
export function xrIcon(name: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base}icons/material/${icon(name).xr}.svg`;
}

/**
 * Unicode/emoji glyph for the DOM shell.
 *
 * Kept for the few places that need an icon inside a plain string — a `title`,
 * a text-only fallback — and for tests. Anything that renders an element should
 * use {@link applyIcon}: a masked SVG is monochrome, takes `currentColor`, and
 * looks like a desktop application's toolbar, which an emoji never does.
 */
export function domIcon(name: string): string {
  return icon(name).dom;
}

/**
 * Paint `name` onto an element as a masked SVG.
 *
 * Both shells draw the same checked-in file — the DOM shell masks it so the
 * glyph takes the element's own colour, which is what lets one icon serve a
 * default, hover, disabled and selected state without four assets.
 */
export function applyIcon(element: HTMLElement, name: string): void {
  element.classList.add('oxr-icon');
  element.style.setProperty('--oxr-icon-src', `url("${xrIcon(name)}")`);
}

/** A `<span>` carrying `name`, ready to drop into a button. */
export function iconElement(name: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  applyIcon(span, name);
  return span;
}

/**
 * Resolve every `data-icon` under `root`. Markup declares which icon it wants;
 * this turns that declaration into the vendored file's URL, so `index.html`
 * never has to know where the icons live or what the base path is.
 */
export function hydrateIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = element.dataset.icon;
    if (name) applyIcon(element, name);
  }
}
