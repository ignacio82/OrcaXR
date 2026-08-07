import type { FilamentId, MixedFilamentId, PhysicalFilamentId } from '../domain/ids';
import type { MixedFilament, PhysicalFilament, ProjectState } from '../domain/model';

export type PaintPaletteEntryKind = 'default' | 'physical' | 'mixed';

export interface PaintPaletteEntry {
  /** Stable canonical identity; `undefined` is the unpainted/inherit entry. */
  readonly filamentId?: FilamentId;
  readonly kind: PaintPaletteEntryKind;
  readonly name: string;
  /** Solid swatch colour, or the first stop of a gradient recipe. */
  readonly displayColor: string;
  /** Two or more stops when the recipe renders as a gradient. */
  readonly gradient?: readonly string[];
  /** Short non-colour cue, e.g. `T1` or `Ratio`. */
  readonly badge: string;
  /** Human-readable recipe, e.g. `60% T1 / 40% T2`. */
  readonly recipeSummary?: string;
  /** Upstream `1`–`9` shortcut, when this entry is in the first nine slots. */
  readonly keyboardNumber?: number;
  /**
   * Transient upstream engine numbering: physical rows in tool order, then
   * every enabled mixed row at `physicalCount + enabledOrdinal`. It is derived
   * for display only and is never stored on a facet.
   */
  readonly engineSlot?: number;
  readonly selectable: boolean;
  /** Present whenever `selectable` is false. */
  readonly unavailableReason?: string;
}

export interface PaintPalette {
  readonly entries: readonly PaintPaletteEntry[];
  readonly physicalCount: number;
  readonly enabledMixedCount: number;
}

export interface PaintPaletteOptions {
  /** Include disabled/tombstoned recipes as explicitly unselectable rows. */
  readonly includeUnavailable?: boolean;
}

const DEFAULT_COLOR = '#9aa0a6';

/**
 * Project the canonical filament library as the painting palette. Entries keep
 * stable IDs so a stroke never stores a transient palette index, and mixed
 * recipes keep their own badge, gradient, and summary instead of collapsing
 * into a predicted RGB swatch.
 */
export function projectPaintPalette(state: ProjectState, options: PaintPaletteOptions = {}): PaintPalette {
  const physical = [...state.filaments.physical].sort((left, right) => left.toolId - right.toolId);
  const mixed = state.filaments.mixed;
  const enabledMixed = mixed.filter((recipe) => recipe.enabled && recipe.fullSpectrum?.deleted !== true);
  const entries: PaintPaletteEntry[] = [
    {
      kind: 'default',
      name: 'Default (inherit)',
      displayColor: physical[0]?.color ?? DEFAULT_COLOR,
      badge: '0',
      keyboardNumber: undefined,
      selectable: true,
    },
  ];

  physical.forEach((filament, index) => {
    entries.push({
      filamentId: filament.id as PhysicalFilamentId,
      kind: 'physical',
      name: filament.name || `Filament ${filament.toolId}`,
      displayColor: normalizeColor(filament.color),
      badge: `T${filament.toolId}`,
      ...(filament.material ? { recipeSummary: filament.material } : {}),
      ...(index < 9 ? { keyboardNumber: index + 1 } : {}),
      engineSlot: index + 1,
      selectable: true,
    });
  });

  let enabledOrdinal = 0;
  for (const recipe of mixed) {
    if (recipe.fullSpectrum?.deleted === true) continue;
    const enabled = recipe.enabled;
    const componentIssue = describeMissingComponents(recipe, state.filaments.physical);
    const selectable = enabled && !componentIssue;
    if (!selectable && !options.includeUnavailable) continue;
    const stops = gradientStops(recipe, state.filaments.physical);
    const slot = enabled ? physical.length + 1 + enabledOrdinal : undefined;
    if (enabled) enabledOrdinal += 1;
    entries.push({
      filamentId: recipe.id as MixedFilamentId,
      kind: 'mixed',
      name: recipe.name || 'Virtual filament',
      displayColor: normalizeColor(recipe.displayColor || stops[0]),
      ...(stops.length > 1 ? { gradient: Object.freeze(stops) } : {}),
      badge: modeBadge(recipe),
      ...(summarizeRecipe(recipe, state.filaments.physical)
        ? { recipeSummary: summarizeRecipe(recipe, state.filaments.physical) }
        : {}),
      ...(slot !== undefined ? { engineSlot: slot } : {}),
      selectable,
      ...(selectable
        ? {}
        : { unavailableReason: componentIssue ?? 'This virtual filament is disabled and cannot be painted.' }),
    });
  }

  // Keyboard numbers follow displayed order across physical and mixed rows.
  let nextNumber = 1;
  const numbered = entries.map((entry) => {
    if (entry.kind === 'default' || !entry.selectable || nextNumber > 9) return entry;
    const numberedEntry = { ...entry, keyboardNumber: nextNumber };
    nextNumber += 1;
    return numberedEntry;
  });

  return Object.freeze({
    entries: Object.freeze(numbered.map((entry) => Object.freeze(entry))),
    physicalCount: physical.length,
    enabledMixedCount: enabledMixed.length,
  });
}

/** Resolve the palette entry a facet value refers to, including inherit. */
export function paintPaletteEntryFor(palette: PaintPalette, filamentId?: FilamentId): PaintPaletteEntry | undefined {
  if (!filamentId) return palette.entries.find((entry) => entry.kind === 'default');
  return palette.entries.find((entry) => entry.filamentId === filamentId);
}

/** Display colours by stable ID for derived paint overlays. */
export function paintPaletteColors(palette: PaintPalette): ReadonlyMap<FilamentId, string> {
  const colors = new Map<FilamentId, string>();
  for (const entry of palette.entries) {
    if (entry.filamentId) colors.set(entry.filamentId, entry.displayColor);
  }
  return colors;
}

function describeMissingComponents(recipe: MixedFilament, physical: readonly PhysicalFilament[]): string | undefined {
  const known = new Set(physical.map((filament) => filament.id as string));
  const missing = componentIds(recipe).filter((id) => !known.has(id));
  if (missing.length === 0) return undefined;
  return `This recipe references ${missing.length} filament${missing.length === 1 ? '' : 's'} that the project no longer has.`;
}

function componentIds(recipe: MixedFilament): string[] {
  const ids = (recipe.components ?? []).map((component) => component.filamentId as string);
  const gradient = (recipe.fullSpectrum?.gradientComponentIds ?? []).map((id) => id as string);
  return [...new Set([...ids, ...gradient])].filter(Boolean);
}

function gradientStops(recipe: MixedFilament, physical: readonly PhysicalFilament[]): string[] {
  const byId = new Map(physical.map((filament) => [filament.id as string, normalizeColor(filament.color)]));
  const stops = componentIds(recipe)
    .map((id) => byId.get(id))
    .filter((color): color is string => Boolean(color));
  return stops.length > 1 ? stops : [];
}

function modeBadge(recipe: MixedFilament): string {
  switch (recipe.distribution.mode) {
    case 'ratio':
      return 'Ratio';
    case 'cycle':
      return 'Cycle';
    case 'match':
      return 'Match';
    case 'gradient':
      return 'Gradient';
    default:
      return 'Virtual';
  }
}

function summarizeRecipe(recipe: MixedFilament, physical: readonly PhysicalFilament[]): string | undefined {
  const labels = new Map(physical.map((filament) => [filament.id as string, `T${filament.toolId}`]));
  const components = recipe.components ?? [];
  const mode = recipe.distribution.mode;
  if (mode === 'gradient') {
    const ids = recipe.fullSpectrum?.gradientComponentIds?.length
      ? recipe.fullSpectrum.gradientComponentIds
      : components.map((component) => component.filamentId);
    const named = ids.map((id) => labels.get(String(id)) ?? String(id));
    return named.length >= 2 ? `${named[0]} → ${named[1]}` : undefined;
  }
  if (mode === 'cycle') {
    const groups = recipe.fullSpectrum?.manualPatternGroups ?? [];
    const pattern = groups
      .map((group) => group.map((id) => labels.get(String(id)) ?? '?').join(' '))
      .filter(Boolean)
      .join(', ');
    if (pattern) return `Pattern ${pattern}`;
  }
  if (components.length === 0) return undefined;
  const total = components.reduce((sum, component) => sum + (component.weight ?? 0), 0);
  if (total <= 0) return components.map((component) => labels.get(String(component.filamentId)) ?? '?').join(' + ');
  return components
    .map((component) => {
      const share = Math.round(((component.weight ?? 0) / total) * 100);
      return `${share}% ${labels.get(String(component.filamentId)) ?? '?'}`;
    })
    .join(' / ');
}

function normalizeColor(color: string | undefined): string {
  if (!color) return DEFAULT_COLOR;
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed) as RegExpExecArray;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) return trimmed.slice(0, 7).toLowerCase();
  return DEFAULT_COLOR;
}
