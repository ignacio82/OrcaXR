/**
 * The colours the workspace draws paint in. Colour paint draws each stable
 * filament ID in its palette entry's display colour; support, seam and
 * fuzzy-skin paint draw each state in a fixed colour. An unpainted state (an
 * erasing preview) and a value no entry names draw white. The Rust core
 * resolves the same colours for native renderers
 * (`orcaxr_project::facets::paint_facets`).
 */
import type { FacetRegionState } from '../annotations/FacetRegionSelection';
import type { PaintChannel } from './PaintStrokeService';

/**
 * Non-colour channels have no filament colour, so each assigned state gets a
 * fixed, distinguishable overlay hue, keyed by `String(value)`. The panel always
 * labels the state too, so hue is never the only cue.
 */
export const CHANNEL_STATE_COLORS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  support: Object.freeze({ enforce: '#39d353', block: '#f85149' }),
  seam: Object.freeze({ prefer: '#58a6ff', avoid: '#ff9f43' }),
  fuzzySkin: Object.freeze({ true: '#bc8cff' }),
});

/** What a state draws in when nothing names its value. */
export const UNNAMED_PAINT_COLOR = '#ffffff';

/** The overlay colours of one channel: the palette's for colour, the channel's fixed table otherwise. */
export function channelOverlayColors(
  channel: PaintChannel | string,
  filamentColors: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (channel === 'color') return filamentColors;
  return new Map(Object.entries(CHANNEL_STATE_COLORS[channel] ?? {}));
}

/** The colour one paint state draws in under [colors] (from {@link channelOverlayColors}). */
export function paintStateColor(colors: ReadonlyMap<string, string>, state: FacetRegionState): string {
  return state.kind === 'assigned' ? (colors.get(String(state.value)) ?? UNNAMED_PAINT_COLOR) : UNNAMED_PAINT_COLOR;
}
