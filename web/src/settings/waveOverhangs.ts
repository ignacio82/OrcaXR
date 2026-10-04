/**
 * Wave overhangs — the settings the engine's wave-overhang port adds, described once.
 *
 * The engine carries a port of dennisklappe/OrcaSlicer-WaveOverhangs (release
 * {@link WAVE_OVERHANGS_UPSTREAM}). Its options are not in the pinned upstream
 * `Tab.cpp`/`PrintConfig.cpp`, so the generated settings schema cannot describe
 * them; this table does instead, and it is the only description. The flat panel
 * and the immersive panel both draw from it, so a setting cannot exist on one
 * surface and be missing on the other.
 *
 * Three rules keep it honest:
 *
 * - **A value is shown where it comes from.** A key the project sets is an
 *   override, a key the profile or an imported project carries is inherited,
 *   and a key nobody sets shows the engine's own default — the number the slice
 *   will actually use. The panel this replaced displayed invented "defaults"
 *   (35 mm/s, three Hilbert floor layers) for keys the engine never received.
 * - **The defaults are the engine's.** `engineDefault` mirrors the patched
 *   `PrintConfig.cpp`, and `wasm/test_slice_wave_overhang.mjs` slices with no
 *   wave keys set and compares every entry against the CONFIG_BLOCK the engine
 *   wrote, so the two cannot drift apart silently.
 * - **An option the engine ignores says so.** Upstream still lists three knobs
 *   no generator reads (`min_angle` by design; `seam_mode` and `spacing_mode`
 *   since the second generator was removed). They stay editable for profile
 *   compatibility and are marked inert rather than presented as working.
 *
 * Page order, grouping, and visibility follow upstream's own Wave overhangs page
 * (`Tab.cpp`) and its gating (`ConfigManipulation.cpp`).
 */
import { t } from '../l10n/t';
import { WAVE_MASTER_KEY, parseWaveBool } from './waveOverhangsProject';

export { WAVE_MASTER_KEY, projectUsesWaveOverhangs, type WaveProjectShape } from './waveOverhangsProject';

/** The upstream release the engine port reproduces. */
export const WAVE_OVERHANGS_UPSTREAM = Object.freeze({
  repository: 'https://github.com/dennisklappe/OrcaSlicer-WaveOverhangs',
  release: 'v0.4.0',
  commit: 'f6a901d57cd128c922c81591ceae4fd0b7cc5524',
});

export type WaveOptionKind = 'bool' | 'int' | 'float' | 'enum';
export type WaveOptionGroupId =
  'general' | 'detection' | 'pattern' | 'corner' | 'motion' | 'cooling' | 'floor' | 'debug';
export type WaveOptionValue = boolean | number | string;

export interface WaveOverhangOption {
  readonly key: string;
  readonly group: WaveOptionGroupId;
  readonly kind: WaveOptionKind;
  /** The patched engine's `set_default_value`, exactly. */
  readonly engineDefault: WaveOptionValue;
  readonly min?: number;
  readonly max?: number;
  /** Increment for arrow/stepper controls. */
  readonly step: number;
  readonly unit?: string;
  /** Enumeration values in the order the engine declares them. */
  readonly choices?: readonly string[];
  /** Boolean options that must be on for this one to matter (besides the master switch). */
  readonly requires?: readonly string[];
  /** The engine accepts and stores the value but no code path reads it. */
  readonly inert?: true;
  /** Upstream marks it developer-only (`comDevelop`). */
  readonly develop?: true;
  /** The value at which the engine stops overriding and uses the normal setting. */
  readonly passthrough?: number;
}

/**
 * Upstream page order (Tab.cpp), with engine defaults and bounds (PrintConfig.cpp).
 * One option per line so the table reads as one; `wasm/test_slice_wave_overhang.mjs`
 * parses the leading `key`/`group`/`kind`/`engineDefault` fields of each entry.
 */
// prettier-ignore
export const WAVE_OVERHANG_OPTIONS: readonly WaveOverhangOption[] = Object.freeze([
  // General
  { key: WAVE_MASTER_KEY, group: 'general', kind: 'bool', engineDefault: false, step: 1 },
  { key: 'wave_overhangs_instead_of_bridges', group: 'general', kind: 'bool', engineDefault: false, step: 1 },
  { key: 'support_remaining_areas_after_wave_overhangs', group: 'general', kind: 'bool', engineDefault: true, step: 1 },
  // Detection
  { key: 'wave_overhang_min_angle', group: 'detection', kind: 'float', engineDefault: 0, min: 0, max: 90, step: 1, unit: '°', inert: true },
  { key: 'wave_overhang_min_length', group: 'detection', kind: 'float', engineDefault: 0, min: 0, max: 50, step: 0.5, unit: 'mm', passthrough: 0 },
  { key: 'wave_overhang_max_iterations', group: 'detection', kind: 'int', engineDefault: 0, min: 0, max: 500, step: 10, passthrough: 0 },
  // Pattern
  { key: 'wave_overhang_pattern', group: 'pattern', kind: 'enum', engineDefault: 'smart', choices: ['monotonic', 'zigzag', 'smart'], step: 1 },
  { key: 'wave_overhang_seam_mode', group: 'pattern', kind: 'enum', engineDefault: 'alternating', choices: ['alternating', 'aligned', 'random'], step: 1, inert: true },
  { key: 'wave_overhang_outer_perimeters', group: 'pattern', kind: 'int', engineDefault: 1, min: 0, step: 1 },
  { key: 'wave_overhang_line_spacing', group: 'pattern', kind: 'float', engineDefault: 0.35, min: 0.01, step: 0.01, unit: 'mm' },
  { key: 'wave_overhang_spacing_mode', group: 'pattern', kind: 'enum', engineDefault: 'uniform', choices: ['uniform', 'progressive'], step: 1, inert: true },
  { key: 'wave_overhang_perimeter_overlap', group: 'pattern', kind: 'float', engineDefault: 0.1, min: 0, step: 0.05, unit: 'mm' },
  { key: 'wave_overhang_minimum_width', group: 'pattern', kind: 'float', engineDefault: 0.7, min: 0, step: 0.05, unit: 'mm' },
  { key: 'wave_overhang_min_new_area', group: 'pattern', kind: 'float', engineDefault: 0.01, min: 0, max: 100, step: 0.005, unit: 'mm²', develop: true },
  { key: 'wave_overhang_flow_mm3_per_mm', group: 'pattern', kind: 'float', engineDefault: 0.15, min: 0.02, max: 1.5, step: 0.01, unit: 'mm³/mm' },
  // Corner reinforcement
  { key: 'wave_overhang_corner_taper_enable', group: 'corner', kind: 'bool', engineDefault: false, step: 1 },
  { key: 'wave_overhang_line_spacing_corner', group: 'corner', kind: 'float', engineDefault: 0, min: 0, max: 2, step: 0.01, unit: 'mm', requires: ['wave_overhang_corner_taper_enable'], passthrough: 0 },
  { key: 'wave_overhang_corner_taper_distance', group: 'corner', kind: 'float', engineDefault: 0, min: 0, max: 20, step: 0.5, unit: 'mm', requires: ['wave_overhang_corner_taper_enable'], passthrough: 0 },
  { key: 'wave_overhang_corner_angle_threshold', group: 'corner', kind: 'float', engineDefault: 90, min: 10, max: 180, step: 5, unit: '°', requires: ['wave_overhang_corner_taper_enable'] },
  // Motion
  { key: 'wave_overhang_print_speed', group: 'motion', kind: 'float', engineDefault: 2, min: 0.1, step: 0.5, unit: 'mm/s' },
  { key: 'wave_overhang_perimeter_speed', group: 'motion', kind: 'float', engineDefault: 0, min: 0, max: 1000, step: 1, unit: 'mm/s', passthrough: 0 },
  { key: 'wave_overhang_travel_speed', group: 'motion', kind: 'float', engineDefault: 40, min: 1, step: 5, unit: 'mm/s' },
  { key: 'wave_overhang_end_retract_length', group: 'motion', kind: 'float', engineDefault: 0, min: 0, max: 10, step: 0.1, unit: 'mm', passthrough: 0 },
  // Cooling
  { key: 'wave_overhang_fan_speed', group: 'cooling', kind: 'int', engineDefault: 100, min: 0, max: 100, step: 5, unit: '%' },
  { key: 'wave_overhang_aux_fan_speed', group: 'cooling', kind: 'int', engineDefault: -1, min: -1, max: 100, step: 5, unit: '%', passthrough: -1 },
  { key: 'wave_overhang_nozzle_temp', group: 'cooling', kind: 'int', engineDefault: 0, min: 0, max: 350, step: 5, unit: '°C', passthrough: 0 },
  { key: 'wave_overhang_min_wave_time', group: 'cooling', kind: 'float', engineDefault: 0, min: 0, max: 60, step: 0.5, unit: 's', passthrough: 0 },
  { key: 'wave_overhang_min_layer_time', group: 'cooling', kind: 'float', engineDefault: 0, min: 0, max: 300, step: 1, unit: 's', passthrough: 0 },
  // Floor layers
  { key: 'wave_overhang_floor_layers', group: 'floor', kind: 'int', engineDefault: 2, min: 0, max: 20, step: 1 },
  { key: 'wave_overhang_floor_use_hilbert', group: 'floor', kind: 'bool', engineDefault: false, step: 1 },
  { key: 'wave_overhang_floor_hilbert_layers', group: 'floor', kind: 'int', engineDefault: 0, min: 0, max: 20, step: 1, requires: ['wave_overhang_floor_use_hilbert'], passthrough: 0 },
  { key: 'wave_overhang_floor_hilbert_density', group: 'floor', kind: 'int', engineDefault: 100, min: 1, max: 100, step: 5, unit: '%', requires: ['wave_overhang_floor_use_hilbert'] },
  { key: 'wave_overhang_floor_print_speed', group: 'floor', kind: 'float', engineDefault: 0, min: 0, max: 1000, step: 1, unit: 'mm/s', requires: ['wave_overhang_floor_use_hilbert'], passthrough: 0 },
  { key: 'wave_overhang_floor_perimeter_speed', group: 'floor', kind: 'float', engineDefault: 0, min: 0, max: 1000, step: 1, unit: 'mm/s', passthrough: 0 },
  { key: 'wave_overhang_floor_speed_ramp', group: 'floor', kind: 'int', engineDefault: 0, min: 0, max: 64, step: 1, passthrough: 0 },
  { key: 'wave_overhang_floor_fan_speed', group: 'floor', kind: 'int', engineDefault: -1, min: -1, max: 100, step: 5, unit: '%', requires: ['wave_overhang_floor_use_hilbert'], passthrough: -1 },
  { key: 'wave_overhang_floor_aux_fan_speed', group: 'floor', kind: 'int', engineDefault: -1, min: -1, max: 100, step: 5, unit: '%', requires: ['wave_overhang_floor_use_hilbert'], passthrough: -1 },
  // Debug
  { key: 'wave_overhang_debug_gcode', group: 'debug', kind: 'bool', engineDefault: true, step: 1 },
] satisfies WaveOverhangOption[]);

export const WAVE_OPTION_GROUPS: readonly WaveOptionGroupId[] = Object.freeze([
  'general',
  'detection',
  'pattern',
  'corner',
  'motion',
  'cooling',
  'floor',
  'debug',
]);

const OPTIONS_BY_KEY: ReadonlyMap<string, WaveOverhangOption> = new Map(
  WAVE_OVERHANG_OPTIONS.map((option) => [option.key, option]),
);

export function waveOption(key: string): WaveOverhangOption | undefined {
  return OPTIONS_BY_KEY.get(key);
}

/** Every key the wave-overhang feature owns, defined or not (retired generators, older ports). */
export function isWaveOverhangKey(key: string): boolean {
  return key.startsWith('wave_overhang') || key === 'support_remaining_areas_after_wave_overhangs';
}

// ---- values -----------------------------------------------------------------

/**
 * Read a stored config value as the engine would.
 *
 * Canonical config carries what an import or a panel wrote: JSON booleans and
 * numbers, or the engine's own strings (`"1"`, `"0.35"`, `"smart"`). Anything
 * the engine would refuse comes back `undefined`, never coerced into a guess.
 */
export function parseWaveValue(option: WaveOverhangOption, raw: unknown): WaveOptionValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  const scalar = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (scalar === undefined || scalar === null) return undefined;
  switch (option.kind) {
    case 'bool':
      return parseWaveBool(scalar);
    case 'int':
    case 'float': {
      const number = typeof scalar === 'number' ? scalar : typeof scalar === 'string' ? Number(scalar.trim()) : NaN;
      if (typeof scalar === 'string' && scalar.trim() === '') return undefined;
      if (!Number.isFinite(number)) return undefined;
      if (option.kind === 'int' && !Number.isInteger(number)) return undefined;
      return number;
    }
    case 'enum':
      return typeof scalar === 'string' && option.choices?.includes(scalar) ? scalar : undefined;
  }
}

/** The engine's wire form: `1`/`0`, a plain decimal, or the enum name. */
export function serializeWaveValue(option: WaveOverhangOption, value: WaveOptionValue): string {
  switch (option.kind) {
    case 'bool':
      return value === true ? '1' : '0';
    case 'int':
      return String(Math.trunc(Number(value)));
    case 'float':
      return String(Number(Number(value).toFixed(6)));
    case 'enum':
      return String(value);
  }
}

/** Why the engine would refuse `value`, or `undefined` when it is acceptable. */
export function waveValueProblem(option: WaveOverhangOption, value: WaveOptionValue): string | undefined {
  if (option.kind === 'bool') {
    return typeof value === 'boolean' ? undefined : t('settings.wave.problem.bool', 'Choose on or off.');
  }
  if (option.kind === 'enum') {
    return typeof value === 'string' && option.choices?.includes(value)
      ? undefined
      : t('settings.wave.problem.choice', 'Choose one of the listed values.');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return t('settings.wave.problem.number', 'Enter a number.');
  }
  if (option.kind === 'int' && !Number.isInteger(value)) {
    return t('settings.wave.problem.integer', 'Enter a whole number.');
  }
  if (option.min !== undefined && value < option.min) {
    return t('settings.wave.problem.min', 'The smallest value the engine accepts is {min}.', { min: option.min });
  }
  if (option.max !== undefined && value > option.max) {
    return t('settings.wave.problem.max', 'The largest value the engine accepts is {max}.', { max: option.max });
  }
  return undefined;
}

// ---- resolution -------------------------------------------------------------

export type WaveValueSource = 'override' | 'inherited' | 'default';

export interface WaveSettingsSnapshot {
  readonly inheritedConfig: Readonly<Record<string, unknown>>;
  readonly overrides: Readonly<Record<string, unknown>>;
}

export interface WaveOptionState {
  readonly option: WaveOverhangOption;
  /** What the engine will use for this slice. */
  readonly value: WaveOptionValue;
  readonly source: WaveValueSource;
  /** A stored value the engine would refuse; `value` is then the engine default. */
  readonly rejected?: string;
  /** False when the master switch or a parent option is off, so this one has no effect. */
  readonly applies: boolean;
}

export interface WaveSettingsState {
  readonly enabled: boolean;
  /** Every defined option, in upstream page order. */
  readonly options: readonly WaveOptionState[];
  /** The project explicitly sets at least one wave key (defined or not). */
  readonly hasOverrides: boolean;
  /** Wave keys this engine does not define — retired generators and older ports. */
  readonly unknownKeys: readonly string[];
}

function own(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function resolveOne(option: WaveOverhangOption, snapshot: WaveSettingsSnapshot) {
  for (const [source, record] of [
    ['override', snapshot.overrides],
    ['inherited', snapshot.inheritedConfig],
  ] as const) {
    if (!own(record, option.key)) continue;
    const raw = record[option.key];
    const value = parseWaveValue(option, raw);
    if (value !== undefined) return { value, source };
    return { value: option.engineDefault, source, rejected: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  }
  return { value: option.engineDefault, source: 'default' as const };
}

export function resolveWaveSettings(snapshot: WaveSettingsSnapshot): WaveSettingsState {
  const resolved = new Map<string, ReturnType<typeof resolveOne>>();
  for (const option of WAVE_OVERHANG_OPTIONS) resolved.set(option.key, resolveOne(option, snapshot));
  const on = (key: string) => resolved.get(key)?.value === true;
  const enabled = on(WAVE_MASTER_KEY);
  const options = WAVE_OVERHANG_OPTIONS.map((option): WaveOptionState => {
    const entry = resolved.get(option.key)!;
    const applies = option.key === WAVE_MASTER_KEY || (enabled && (option.requires ?? []).every(on));
    return { option, ...entry, applies };
  });
  const keys = new Set([...Object.keys(snapshot.inheritedConfig), ...Object.keys(snapshot.overrides)]);
  const unknownKeys = [...keys].filter((key) => isWaveOverhangKey(key) && !OPTIONS_BY_KEY.has(key)).sort();
  const hasOverrides = Object.keys(snapshot.overrides).some(isWaveOverhangKey);
  return { enabled, options, hasOverrides, unknownKeys };
}

// ---- edits ------------------------------------------------------------------

export class WaveValueError extends Error {
  override readonly name = 'WaveValueError';
}

/**
 * The next override map with one value set, or a {@link WaveValueError} naming why
 * the engine would refuse it. Out-of-range input is refused, never clamped: a
 * value the operator did not type must not reach the printer.
 */
export function withWaveValue(
  overrides: Readonly<Record<string, unknown>>,
  key: string,
  value: WaveOptionValue,
): Record<string, unknown> {
  const option = OPTIONS_BY_KEY.get(key);
  if (!option) throw new WaveValueError(`Unknown wave-overhang option: ${key}`);
  const problem = waveValueProblem(option, value);
  if (problem) throw new WaveValueError(problem);
  return { ...overrides, [key]: serializeWaveValue(option, value) };
}

/** The next override map with one step applied, staying inside the engine's bounds. */
export function steppedWaveValue(state: WaveOptionState, direction: 1 | -1): WaveOptionValue {
  const { option, value } = state;
  if (option.kind === 'bool') return !(value === true);
  if (option.kind === 'enum') {
    const choices = option.choices ?? [];
    const index = Math.max(0, choices.indexOf(String(value)));
    return choices[(index + direction + choices.length) % choices.length] ?? option.engineDefault;
  }
  const current = typeof value === 'number' ? value : Number(option.engineDefault);
  let next = Number((current + direction * option.step).toFixed(6));
  if (option.kind === 'int') next = Math.round(next);
  if (option.min !== undefined) next = Math.max(option.min, next);
  if (option.max !== undefined) next = Math.min(option.max, next);
  return next;
}

/** Drop every wave key the project sets, defined or retired, so the profile and engine defaults apply. */
export function withoutWaveOverrides(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => !isWaveOverhangKey(key)));
}

/** Drop only wave keys this engine does not define. */
export function withoutUnknownWaveKeys(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([key]) => !isWaveOverhangKey(key) || OPTIONS_BY_KEY.has(key)),
  );
}

// ---- guidance ---------------------------------------------------------------

/**
 * Upstream's starting point for wave flow at a given nozzle bore: the bead hangs
 * in air, so it scales with the bore's cross-section and not with layer height.
 * The engine's tooltip states it as `0.15 × (nozzle / 0.4)²` (0.15 is its
 * calibrated value for a 0.4 mm nozzle). Rounded to the step the field uses.
 */
export function waveFlowForNozzle(nozzleDiameterMm: number): number {
  const flow = 0.15 * (nozzleDiameterMm / 0.4) ** 2;
  return Number(Math.min(1.5, Math.max(0.02, flow)).toFixed(2));
}

function firstNumber(raw: unknown): number | undefined {
  const scalar = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw.split(/[;,]/)[0] : raw;
  const value = typeof scalar === 'number' ? scalar : typeof scalar === 'string' ? Number(scalar.trim()) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function strings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  if (typeof raw === 'string')
    return raw
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean);
  return [];
}

/** The first extruder's nozzle bore, when the effective config states one. */
export function waveNozzleDiameter(config: Readonly<Record<string, unknown>>): number | undefined {
  return firstNumber(config.nozzle_diameter);
}

/** What upstream's testing says about the project's filaments. */
export interface WaveMaterialAssessment {
  /** Families upstream reports as much more likely to delaminate or warp: PETG, ABS, PC. */
  readonly poor: readonly string[];
  /** Neither PLA nor a reported family; upstream has no results for them yet. */
  readonly untested: readonly string[];
}

const POOR_WAVE_FAMILIES: ReadonlySet<string> = new Set(['PETG', 'ABS', 'PC']);

/**
 * Sort the project's filament types by what upstream's testing found.
 *
 * Each ring has to cool rigid before the next one anchors to it. PLA under full
 * part cooling does; upstream reports PETG, ABS and PC much more likely to
 * delaminate or warp, and asks for results on anything else. A type is judged
 * by its family — the name before any `-CF`, `+` or similar suffix — so
 * `PETG-CF` is PETG and `PCTG` is not PC.
 */
export function waveMaterialAssessment(config: Readonly<Record<string, unknown>>): WaveMaterialAssessment {
  const poor = new Set<string>();
  const untested = new Set<string>();
  for (const type of strings(config.filament_type)) {
    const family = type.toUpperCase().split(/[-+\s/]/)[0] ?? '';
    if (family === 'PLA') continue;
    (POOR_WAVE_FAMILIES.has(family) ? poor : untested).add(type);
  }
  return { poor: [...poor], untested: [...untested] };
}

export type WaveGenerationBlocker = 'detect-overhang-wall-off' | 'no-walls' | 'spiral-vase';

function boolOf(raw: unknown, fallback: boolean): boolean {
  const scalar = Array.isArray(raw) ? raw[0] : raw;
  if (scalar === true || scalar === 1 || scalar === '1' || scalar === 'true') return true;
  if (scalar === false || scalar === 0 || scalar === '0' || scalar === 'false') return false;
  return fallback;
}

/**
 * Settings outside the wave page that stop the engine from generating waves at all.
 *
 * The engine only builds waves inside its extra-perimeters-over-overhangs pass,
 * which runs when overhang walls are detected, at least one wall is printed, and
 * spiral vase is off (`PerimeterGenerator::apply_extra_perimeters`). With any of
 * those off the master switch does nothing, and nothing else would say why.
 * Absent keys take the engine's defaults (detection on, two walls, no vase).
 */
export function waveGenerationBlockers(config: Readonly<Record<string, unknown>>): readonly WaveGenerationBlocker[] {
  const blockers: WaveGenerationBlocker[] = [];
  if (!boolOf(config.detect_overhang_wall, true)) blockers.push('detect-overhang-wall-off');
  const rawWalls = Array.isArray(config.wall_loops) ? config.wall_loops[0] : config.wall_loops;
  const walls = typeof rawWalls === 'number' ? rawWalls : typeof rawWalls === 'string' ? Number(rawWalls) : NaN;
  if (Number.isFinite(walls) && walls < 1) blockers.push('no-walls');
  if (boolOf(config.spiral_mode, false)) blockers.push('spiral-vase');
  return blockers;
}

/** Upstream's useful range for wave print speed, from its settings reference. */
export const WAVE_PRINT_SPEED_GUIDANCE = Object.freeze({ usualMin: 1.5, usualMax: 2.5, defeatsAbove: 5 });

// ---- what a panel says ----------------------------------------------------------

/** One project's wave settings, as a panel reads them and writes them back. */
export interface WaveOverhangsProjectSnapshot extends WaveSettingsSnapshot {
  /** Inherited plus overrides: what the engine receives. */
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  /** The canonical revision the override map was read at, echoed back on apply. */
  readonly guard?: { readonly sourceRevision: number; readonly sourceHash: string };
  readonly busy?: boolean;
}

/**
 * How a surface reads the project's wave settings and commits a change. One
 * implementation serves the flat card and the headset, so both write through
 * the same canonical project-settings command.
 */
export interface WaveOverhangsPort {
  getState(): WaveOverhangsProjectSnapshot;
  subscribe?(listener: () => void): () => void;
  /**
   * Commit one complete next override map as a single canonical command. `basis`
   * is the snapshot it was computed from, so a stale write is refused rather
   * than applied over someone else's change.
   */
  apply(next: Record<string, unknown>, basis: WaveOverhangsProjectSnapshot): void | Promise<void>;
  onError?(error: unknown): void;
}

export type WaveNoteTone = 'warn' | 'info';

/** A line a row shows under its value; `fix` is a one-press change the line suggests. */
export interface WaveNote {
  readonly tone: WaveNoteTone;
  readonly text: string;
  readonly fix?: { readonly id: 'use-nozzle-flow'; readonly label: string; readonly value: WaveOptionValue };
}

export type WaveNoticeKind =
  'detect-overhang-wall' | 'no-walls' | 'spiral-vase' | 'material' | 'material-untested' | 'unknown-keys';
export type WaveNoticeFix = 'enable-overhang-detection' | 'remove-unknown';

/** A card-level warning about something that stops waves working, with its fix where there is one. */
export interface WaveNotice {
  readonly kind: WaveNoticeKind;
  readonly text: string;
  readonly fix?: { readonly id: WaveNoticeFix; readonly label: string };
}

export function waveSourceLabel(source: WaveValueSource): string {
  switch (source) {
    case 'override':
      return t('settings.wave.source.override', 'set here');
    case 'inherited':
      return t('settings.wave.source.inherited', 'from profile');
    case 'default':
      return t('settings.wave.source.default', 'engine default');
  }
}

function auxiliaryFanFitted(config: Readonly<Record<string, unknown>>): boolean {
  return boolOf(config.auxiliary_fan, false);
}

/**
 * Everything a row needs to say beyond its value, in the order an operator needs
 * it. Both panels draw these, so guidance cannot exist on one surface only.
 */
export function waveOptionNotes(
  entry: WaveOptionState,
  state: WaveSettingsState,
  effectiveConfig: Readonly<Record<string, unknown>>,
): readonly WaveNote[] {
  const { option, value } = entry;
  const notes: WaveNote[] = [];
  const text = waveOptionText(option.key);
  if (entry.rejected !== undefined) {
    notes.push({
      tone: 'warn',
      text: t(
        'settings.wave.note.rejected',
        'The stored value “{value}” is not one the engine accepts, so it uses its default instead.',
        { value: entry.rejected },
      ),
    });
  }
  if (option.inert) {
    notes.push({
      tone: 'info',
      text: t('settings.wave.note.inert', 'Has no effect in this engine; kept so profiles that set it still load.'),
    });
  }
  if (option.develop) notes.push({ tone: 'info', text: t('settings.wave.note.develop', 'Developer setting.') });
  if (option.passthrough !== undefined && value === option.passthrough && text.passthroughHint) {
    notes.push({ tone: 'info', text: text.passthroughHint });
  }
  const number = typeof value === 'number' ? value : undefined;
  const valueOf = (key: string) => state.options.find((candidate) => candidate.option.key === key)?.value;
  switch (option.key) {
    case 'wave_overhang_print_speed':
      if (number !== undefined && number > WAVE_PRINT_SPEED_GUIDANCE.defeatsAbove) {
        notes.push({
          tone: 'warn',
          text: t(
            'settings.wave.note.speedTooFast',
            'Above about {limit} mm/s the rings have no time to set before the next one anchors; {min}–{max} mm/s is the useful range.',
            {
              limit: WAVE_PRINT_SPEED_GUIDANCE.defeatsAbove,
              min: WAVE_PRINT_SPEED_GUIDANCE.usualMin,
              max: WAVE_PRINT_SPEED_GUIDANCE.usualMax,
            },
          ),
        });
      }
      break;
    case 'wave_overhang_flow_mm3_per_mm': {
      const nozzle = waveNozzleDiameter(effectiveConfig);
      if (nozzle === undefined || number === undefined) break;
      const suggested = waveFlowForNozzle(nozzle);
      if (Math.abs(suggested - number) < 0.005) break;
      notes.push({
        tone: 'info',
        text: t('settings.wave.note.flowForNozzle', 'For this {nozzle} mm nozzle, start at {flow} mm³/mm.', {
          nozzle,
          flow: suggested,
        }),
        fix: {
          id: 'use-nozzle-flow',
          label: t('settings.wave.note.flowUse', 'Use {flow}', { flow: suggested }),
          value: suggested,
        },
      });
      break;
    }
    case 'wave_overhang_line_spacing_corner': {
      const spacing = valueOf('wave_overhang_line_spacing');
      if (number !== undefined && number > 0 && typeof spacing === 'number' && number >= spacing) {
        notes.push({
          tone: 'warn',
          text: t(
            'settings.wave.note.cornerSpacingTooWide',
            'Must be smaller than Line spacing ({spacing} mm) to take effect.',
            { spacing },
          ),
        });
      }
      break;
    }
    case 'wave_overhang_corner_taper_enable': {
      const spacing = valueOf('wave_overhang_line_spacing_corner');
      const distance = valueOf('wave_overhang_corner_taper_distance');
      if (value === true && (spacing === 0 || distance === 0)) {
        notes.push({
          tone: 'warn',
          text: t(
            'settings.wave.note.cornerIncomplete',
            'Corner reinforcement stays off until Corner line spacing and Corner taper distance are both above 0.',
          ),
        });
      }
      break;
    }
    case 'wave_overhang_floor_hilbert_layers':
    case 'wave_overhang_floor_speed_ramp': {
      const floors = valueOf('wave_overhang_floor_layers');
      if (number !== undefined && typeof floors === 'number' && number > floors) {
        notes.push({
          tone: 'info',
          text: t('settings.wave.note.cappedByFloors', 'Capped at Floor layers ({floors}).', { floors }),
        });
      }
      break;
    }
    case 'wave_overhang_floor_layers':
      if (number === 0) {
        notes.push({
          tone: 'info',
          text: t(
            'settings.wave.note.floorZero',
            'No solid layers: the layer above the wave goes straight to sparse infill.',
          ),
        });
      }
      break;
    case 'wave_overhang_aux_fan_speed':
    case 'wave_overhang_floor_aux_fan_speed':
      if (number !== undefined && number >= 0 && !auxiliaryFanFitted(effectiveConfig)) {
        notes.push({
          tone: 'warn',
          text: t(
            'settings.wave.note.noAuxFan',
            'This printer has no auxiliary fan enabled, so this setting has no effect.',
          ),
        });
      }
      break;
  }
  return notes;
}

/**
 * Card-level warnings: settings elsewhere that stop the engine generating waves,
 * a filament the technique fails with, and wave keys this engine does not define.
 * The first two only matter with waves on; the last is shown either way.
 */
export function waveNotices(state: WaveSettingsState, snapshot: WaveOverhangsProjectSnapshot): readonly WaveNotice[] {
  const notices: WaveNotice[] = [];
  if (state.enabled) {
    for (const blocker of waveGenerationBlockers(snapshot.effectiveConfig)) {
      switch (blocker) {
        case 'detect-overhang-wall-off':
          notices.push({
            kind: 'detect-overhang-wall',
            text: t(
              'settings.wave.notice.detectOverhangWall',
              'Detect overhang walls is off, so the engine generates no waves at all.',
            ),
            fix: { id: 'enable-overhang-detection', label: t('settings.wave.notice.turnOn', 'Turn it on') },
          });
          break;
        case 'no-walls':
          notices.push({
            kind: 'no-walls',
            text: t(
              'settings.wave.notice.noWalls',
              'Walls is set to 0. Waves are built in the wall pass, so none are generated.',
            ),
          });
          break;
        case 'spiral-vase':
          notices.push({
            kind: 'spiral-vase',
            text: t(
              'settings.wave.notice.spiralVase',
              'Spiral vase is on. It prints no overhang walls, so no waves are generated.',
            ),
          });
          break;
      }
    }
    const materials = waveMaterialAssessment(snapshot.effectiveConfig);
    if (materials.poor.length > 0) {
      notices.push({
        kind: 'material',
        text: t(
          'settings.wave.notice.materialPoor',
          'Upstream testing found {materials} much more likely to delaminate or warp with wave overhangs: each ring has to set rigid before the next one anchors to it. PLA with full part cooling works best.',
          { materials: materials.poor.join(', ') },
        ),
      });
    }
    if (materials.untested.length > 0) {
      notices.push({
        kind: 'material-untested',
        text: t(
          'settings.wave.notice.materialUntested',
          'Wave overhangs are proven with PLA; {materials} has no reported results yet.',
          { materials: materials.untested.join(', ') },
        ),
      });
    }
  }
  if (state.unknownKeys.length > 0) {
    const removable = state.unknownKeys.some((key) => own(snapshot.overrides, key));
    notices.push({
      kind: 'unknown-keys',
      text: t(
        'settings.wave.notice.unknownKeys',
        '{count, plural, one {# setting} other {# settings}} from another wave-overhang version have no effect in this engine: {keys}.',
        { count: state.unknownKeys.length, keys: state.unknownKeys.join(', ') },
      ),
      ...(removable
        ? { fix: { id: 'remove-unknown' as const, label: t('settings.wave.notice.removeUnknown', 'Remove them') } }
        : {}),
    });
  }
  return notices;
}

/** The next override map a notice's fix asks for. */
export function withWaveNoticeFix(
  overrides: Readonly<Record<string, unknown>>,
  fix: WaveNoticeFix,
): Record<string, unknown> {
  return fix === 'enable-overhang-detection'
    ? { ...overrides, detect_overhang_wall: '1' }
    : withoutUnknownWaveKeys(overrides);
}

/** The next override map with one key no longer set by the project. */
export function withoutWaveValue(overrides: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const next = { ...overrides };
  delete next[key];
  return next;
}

// ---- text -------------------------------------------------------------------

export interface WaveOptionText {
  readonly label: string;
  readonly tooltip: string;
  /** What `passthrough` means for this option, shown when the value equals it. */
  readonly passthroughHint?: string;
}

export function waveGroupLabel(group: WaveOptionGroupId): string {
  switch (group) {
    case 'general':
      return t('settings.wave.group.general', 'General');
    case 'detection':
      return t('settings.wave.group.detection', 'Detection');
    case 'pattern':
      return t('settings.wave.group.pattern', 'Pattern');
    case 'corner':
      return t('settings.wave.group.corner', 'Corner reinforcement');
    case 'motion':
      return t('settings.wave.group.motion', 'Motion');
    case 'cooling':
      return t('settings.wave.group.cooling', 'Cooling');
    case 'floor':
      return t('settings.wave.group.floor', 'Floor layers');
    case 'debug':
      return t('settings.wave.group.debug', 'Debug');
  }
}

export function waveChoiceLabel(key: string, value: string): string {
  switch (`${key}=${value}`) {
    case 'wave_overhang_pattern=monotonic':
      return t('settings.wave.choice.monotonic', 'Monotonic');
    case 'wave_overhang_pattern=zigzag':
      return t('settings.wave.choice.zigzag', 'Zigzag');
    case 'wave_overhang_pattern=smart':
      return t('settings.wave.choice.smart', 'Smart');
    case 'wave_overhang_seam_mode=alternating':
      return t('settings.wave.choice.alternating', 'Alternating');
    case 'wave_overhang_seam_mode=aligned':
      return t('settings.wave.choice.aligned', 'Aligned');
    case 'wave_overhang_seam_mode=random':
      return t('settings.wave.choice.random', 'Random');
    case 'wave_overhang_spacing_mode=uniform':
      return t('settings.wave.choice.uniform', 'Uniform');
    case 'wave_overhang_spacing_mode=progressive':
      return t('settings.wave.choice.progressive', 'Progressive');
    default:
      return value;
  }
}

/** Upstream's labels; tooltips describe what the ported engine actually does. */
export function waveOptionText(key: string): WaveOptionText {
  switch (key) {
    case 'wave_overhangs':
      return {
        label: t('settings.wave.wave_overhangs.label', 'Use wave overhangs (Experimental)'),
        tooltip: t(
          'settings.wave.wave_overhangs.tooltip',
          'Print overhangs as rings that ripple out from the supported edge, each one anchored sideways to the ring before it, so steep and even horizontal overhangs need no support.',
        ),
      };
    case 'wave_overhangs_instead_of_bridges':
      return {
        label: t('settings.wave.instead_of_bridges.label', 'Use wave overhangs instead of bridges'),
        tooltip: t(
          'settings.wave.instead_of_bridges.tooltip',
          'Off: simple flat spans stay ordinary bridges and only concave or holed overhangs get waves. On: every overhang gets waves, and any bridge left in the region (bottom or internal) prints as solid infill instead.',
        ),
      };
    case 'support_remaining_areas_after_wave_overhangs':
      return {
        label: t('settings.wave.support_remaining.label', 'Support unfilled wave overhang areas'),
        tooltip: t(
          'settings.wave.support_remaining.tooltip',
          'When supports are on, generate them only where the waves did not reach. Support enforcers still apply. Off: the support generator ignores wave coverage.',
        ),
      };
    case 'wave_overhang_min_angle':
      return {
        label: t('settings.wave.min_angle.label', 'Min angle'),
        tooltip: t(
          'settings.wave.min_angle.tooltip',
          'Not used by the engine. Which walls become wave candidates is decided by Detect overhang walls and Overhang reverse threshold; there is no angle setting. Kept for profile compatibility.',
        ),
      };
    case 'wave_overhang_min_length':
      return {
        label: t('settings.wave.min_length.label', 'Min length'),
        tooltip: t(
          'settings.wave.min_length.tooltip',
          'Skip overhangs whose outline is shorter than this, so tiny notches and curved corners print normally. 2–5 mm is a common choice.',
        ),
        passthroughHint: t('settings.wave.min_length.passthrough', '0 = wave every overhang'),
      };
    case 'wave_overhang_max_iterations':
      return {
        label: t('settings.wave.max_iterations.label', 'Max iterations'),
        tooltip: t(
          'settings.wave.max_iterations.tooltip',
          'Safety cap on wavefronts per overhang region. The generator stops by itself when it cannot grow further; this bounds print time on very large overhangs.',
        ),
        passthroughHint: t('settings.wave.max_iterations.passthrough', '0 = unlimited'),
      };
    case 'wave_overhang_pattern':
      return {
        label: t('settings.wave.pattern.label', 'Pattern'),
        tooltip: t(
          'settings.wave.pattern.tooltip',
          'Smart starts each line from its better-supported end (best default). Monotonic prints every line separately in one direction: steadiest flow, most travel. Zigzag joins lines into a meander: least travel, but some lines start on the unsupported side.',
        ),
      };
    case 'wave_overhang_seam_mode':
      return {
        label: t('settings.wave.seam_mode.label', 'Seam mode'),
        tooltip: t(
          'settings.wave.seam_mode.tooltip',
          'Not used by the engine: only the retired second generator read it. Ring direction comes from Pattern. Kept for profile compatibility.',
        ),
      };
    case 'wave_overhang_outer_perimeters':
      return {
        label: t('settings.wave.outer_perimeters.label', 'Perimeters'),
        tooltip: t(
          'settings.wave.outer_perimeters.tooltip',
          'Outer walls kept around the overhang; everything inside them becomes wave. Capped at the walls the layer actually prints. 1 is usually enough; 0 is pure wave from the model edge in.',
        ),
      };
    case 'wave_overhang_line_spacing':
      return {
        label: t('settings.wave.line_spacing.label', 'Line spacing'),
        tooltip: t(
          'settings.wave.line_spacing.tooltip',
          'Distance between neighbouring wave rings. Tighter (0.28–0.30) is denser and stronger but slower; wider (0.40–0.50) is faster with visible gaps.',
        ),
      };
    case 'wave_overhang_spacing_mode':
      return {
        label: t('settings.wave.spacing_mode.label', 'Spacing mode'),
        tooltip: t(
          'settings.wave.spacing_mode.tooltip',
          'Not used by the engine: rings are always evenly spaced by Line spacing. Kept for profile compatibility.',
        ),
      };
    case 'wave_overhang_perimeter_overlap':
      return {
        label: t('settings.wave.perimeter_overlap.label', 'Perimeter overlap'),
        tooltip: t(
          'settings.wave.perimeter_overlap.tooltip',
          'Lets the outermost ring reach toward the kept walls. Raise toward 0.2–0.3 if a gap shows between the last ring and the wall; too high prints rings into the wall.',
        ),
      };
    case 'wave_overhang_minimum_width':
      return {
        label: t('settings.wave.minimum_width.label', 'Minimum wave width'),
        tooltip: t(
          'settings.wave.minimum_width.tooltip',
          'Split the wave region at necks narrower than this so fragile branches do not form. 0 disables splitting.',
        ),
      };
    case 'wave_overhang_min_new_area':
      return {
        label: t('settings.wave.min_new_area.label', 'Min new area'),
        tooltip: t(
          'settings.wave.min_new_area.tooltip',
          'Stop propagating when a new wavefront adds less area than this. Lower keeps waving into tight regions; higher stops earlier. Developer setting.',
        ),
      };
    case 'wave_overhang_flow_mm3_per_mm':
      return {
        label: t('settings.wave.flow.label', 'Wave flow'),
        tooltip: t(
          'settings.wave.flow.tooltip',
          'Plastic per millimetre of wave line. The bead hangs in air, so layer height does not change it — only the nozzle bore does. 0.15 is calibrated for a 0.4 mm nozzle; scale by the square of the bore for others. Raise if lines look thin or broken, lower if they blob.',
        ),
      };
    case 'wave_overhang_corner_taper_enable':
      return {
        label: t('settings.wave.corner_enable.label', 'Enable corner-aware spacing taper'),
        tooltip: t(
          'settings.wave.corner_enable.tooltip',
          'Pack extra rings near sharp convex corners, where short cantilevered lines have little to fuse with and curl as they cool. Needs a corner spacing smaller than Line spacing and a taper distance above 0.',
        ),
      };
    case 'wave_overhang_line_spacing_corner':
      return {
        label: t('settings.wave.corner_spacing.label', 'Corner line spacing'),
        tooltip: t(
          'settings.wave.corner_spacing.tooltip',
          'Ring spacing inside the corner zone. Must be smaller than Line spacing for the taper to engage.',
        ),
        passthroughHint: t('settings.wave.corner_spacing.passthrough', '0 = taper off'),
      };
    case 'wave_overhang_corner_taper_distance':
      return {
        label: t('settings.wave.corner_distance.label', 'Corner taper distance'),
        tooltip: t(
          'settings.wave.corner_distance.tooltip',
          'Radius around each detected corner that gets the denser spacing. Larger reinforces more at the cost of print time.',
        ),
        passthroughHint: t('settings.wave.corner_distance.passthrough', '0 = taper off'),
      };
    case 'wave_overhang_corner_angle_threshold':
      return {
        label: t('settings.wave.corner_angle.label', 'Corner angle threshold'),
        tooltip: t(
          'settings.wave.corner_angle.tooltip',
          'A contour vertex counts as a corner when its interior angle is below this. Smaller catches only very sharp corners.',
        ),
      };
    case 'wave_overhang_print_speed':
      return {
        label: t('settings.wave.print_speed.label', 'Print speed'),
        tooltip: t(
          'settings.wave.print_speed.tooltip',
          'Speed of the wave lines. Slow is the point: each ring needs time to cool rigid before the next anchors to it. 1.5–2.5 mm/s is the useful range; above about 5 mm/s defeats the technique.',
        ),
      };
    case 'wave_overhang_perimeter_speed':
      return {
        label: t('settings.wave.perimeter_speed.label', 'Perimeter speed'),
        tooltip: t(
          'settings.wave.perimeter_speed.tooltip',
          'Wall speed on layers that carry wave lines. Walls there anchor onto the cantilevered rings, and full wall speed can pull them loose.',
        ),
        passthroughHint: t('settings.wave.perimeter_speed.passthrough', '0 = normal wall speed'),
      };
    case 'wave_overhang_travel_speed':
      return {
        label: t('settings.wave.travel_speed.label', 'Travel speed'),
        tooltip: t(
          'settings.wave.travel_speed.tooltip',
          'Travel speed between wave lines, including the move into each line.',
        ),
      };
    case 'wave_overhang_end_retract_length':
      return {
        label: t('settings.wave.end_retract.label', 'End-of-line retract'),
        tooltip: t(
          'settings.wave.end_retract.tooltip',
          'Retract this much at the end of every wave line. Lines end in mid-air, and the short hops between them rarely trigger normal retraction, so pressure dribbles a blob. 0.4–0.8 mm is a good start; above 1.5 mm risks under-extrusion on the next line.',
        ),
        passthroughHint: t('settings.wave.end_retract.passthrough', '0 = normal retraction rules'),
      };
    case 'wave_overhang_fan_speed':
      return {
        label: t('settings.wave.fan_speed.label', 'Fan speed'),
        tooltip: t(
          'settings.wave.fan_speed.tooltip',
          'Part-cooling fan forced while wave lines print. Rings benefit hugely from fast cooling; keep 100 % for PLA.',
        ),
      };
    case 'wave_overhang_aux_fan_speed':
      return {
        label: t('settings.wave.aux_fan_speed.label', 'Aux fan speed'),
        tooltip: t(
          'settings.wave.aux_fan_speed.tooltip',
          'Auxiliary (side or chamber) fan forced while wave lines print, for sideways airflow without raising the printhead fan. Needs the printer’s auxiliary fan.',
        ),
        passthroughHint: t('settings.wave.aux_fan_speed.passthrough', '−1 = normal aux fan'),
      };
    case 'wave_overhang_nozzle_temp':
      return {
        label: t('settings.wave.nozzle_temp.label', 'Nozzle temperature'),
        tooltip: t(
          'settings.wave.nozzle_temp.tooltip',
          'Hotend temperature for wave lines only, set at the start of each wave region and restored after. The lower end of the material’s range tends to reduce sagging and reheating.',
        ),
        passthroughHint: t('settings.wave.nozzle_temp.passthrough', '0 = filament temperature'),
      };
    case 'wave_overhang_min_wave_time':
      return {
        label: t('settings.wave.min_wave_time.label', 'Min wave time'),
        tooltip: t(
          'settings.wave.min_wave_time.tooltip',
          'Pad each wave line that would finish faster than this with a dwell, so it solidifies before the next one.',
        ),
        passthroughHint: t('settings.wave.min_wave_time.passthrough', '0 = no dwell'),
      };
    case 'wave_overhang_min_layer_time':
      return {
        label: t('settings.wave.min_layer_time.label', 'Min layer time'),
        tooltip: t(
          'settings.wave.min_layer_time.tooltip',
          'Pad a wave layer whose wave lines took less than this with a dwell, so the wave bed sets before solid infill lands on it. Targets warping.',
        ),
        passthroughHint: t('settings.wave.min_layer_time.passthrough', '0 = no dwell'),
      };
    case 'wave_overhang_floor_layers':
      return {
        label: t('settings.wave.floor_layers.label', 'Floor layers'),
        tooltip: t(
          'settings.wave.floor_layers.tooltip',
          'Exactly this many solid layers above each wave strip — it replaces bottom shell layers there instead of adding to them. 0 goes straight to sparse infill; 3 or more gives a stiffer cap.',
        ),
      };
    case 'wave_overhang_floor_use_hilbert':
      return {
        label: t('settings.wave.floor_hilbert.label', 'Hilbert curve floor'),
        tooltip: t(
          'settings.wave.floor_hilbert.tooltip',
          'Print the floor layers above the wave as a Hilbert curve. Fractal paths leave the least directional shrinkage, which reduces the warping that lifts long cantilevers as the layers above cool.',
        ),
      };
    case 'wave_overhang_floor_hilbert_layers':
      return {
        label: t('settings.wave.floor_hilbert_layers.label', 'Hilbert floor layer count'),
        tooltip: t(
          'settings.wave.floor_hilbert_layers.tooltip',
          'Use the Hilbert curve on only the lowest floor layers, which warp most; the rest keep the normal solid pattern.',
        ),
        passthroughHint: t('settings.wave.floor_hilbert_layers.passthrough', '0 = every floor layer'),
      };
    case 'wave_overhang_floor_hilbert_density':
      return {
        label: t('settings.wave.floor_hilbert_density.label', 'Hilbert floor density'),
        tooltip: t(
          'settings.wave.floor_hilbert_density.tooltip',
          'Density of the Hilbert floor. 100 % matches the research; lower is faster and lighter but backs the wave less. Experimental.',
        ),
      };
    case 'wave_overhang_floor_print_speed':
      return {
        label: t('settings.wave.floor_print_speed.label', 'Hilbert floor print speed'),
        tooltip: t(
          'settings.wave.floor_print_speed.tooltip',
          'Speed of the Hilbert floor lines. Slower lets each line shed heat before its neighbour lands, reducing the stress that drives warping.',
        ),
        passthroughHint: t('settings.wave.floor_print_speed.passthrough', '0 = normal solid infill speed'),
      };
    case 'wave_overhang_floor_perimeter_speed':
      return {
        label: t('settings.wave.floor_perimeter_speed.label', 'Floor perimeter speed'),
        tooltip: t(
          'settings.wave.floor_perimeter_speed.tooltip',
          'Wall speed on the floor layers above the wave. Fast walls landing on the fragile wave shadow make it warp.',
        ),
        passthroughHint: t('settings.wave.floor_perimeter_speed.passthrough', '0 = normal wall speed'),
      };
    case 'wave_overhang_floor_speed_ramp':
      return {
        label: t('settings.wave.floor_speed_ramp.label', 'Floor speed ramp'),
        tooltip: t(
          'settings.wave.floor_speed_ramp.tooltip',
          'Ramp the floor speed overrides back to normal over this many layers instead of snapping at one boundary, spreading the curl across the ramp. Ends at the top floor layer.',
        ),
        passthroughHint: t('settings.wave.floor_speed_ramp.passthrough', '0 = no ramp'),
      };
    case 'wave_overhang_floor_fan_speed':
      return {
        label: t('settings.wave.floor_fan_speed.label', 'Hilbert floor fan speed'),
        tooltip: t(
          'settings.wave.floor_fan_speed.tooltip',
          'Part-cooling fan on the Hilbert floor. Less fan keeps the layer warm longer so stress relaxes before it sets — counter-intuitive, but what the research found.',
        ),
        passthroughHint: t('settings.wave.floor_fan_speed.passthrough', '−1 = normal fan'),
      };
    case 'wave_overhang_floor_aux_fan_speed':
      return {
        label: t('settings.wave.floor_aux_fan_speed.label', 'Hilbert floor aux fan speed'),
        tooltip: t(
          'settings.wave.floor_aux_fan_speed.tooltip',
          'Auxiliary fan on the Hilbert floor; pair with a low printhead fan to keep the layer warm near the nozzle while moving chamber air. Needs the printer’s auxiliary fan.',
        ),
        passthroughHint: t('settings.wave.floor_aux_fan_speed.passthrough', '−1 = normal aux fan'),
      };
    case 'wave_overhang_debug_gcode':
      return {
        label: t('settings.wave.debug_gcode.label', 'Debug g-code'),
        tooltip: t(
          'settings.wave.debug_gcode.tooltip',
          'Mark wave lines with ; WAVE_OVERHANG_START/END comments and record the active settings after the header block. Comments only; no effect on the print.',
        ),
      };
    default:
      return { label: key, tooltip: '' };
  }
}
