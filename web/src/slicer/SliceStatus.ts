import { summarizeGcodeArtifact } from './GcodeArtifactSummary';

/**
 * What the status line says of a finished slice: its lines and layers.
 *
 * Shared with the native app through the core
 * (`orcaxr_gcode::artifact::SliceTally`, replayed against
 * `slice-status-vectors.json`), so both say the same of the same file.
 */
export interface SliceStatusFigures {
  /** `split('\n').length`: a final line break counts one empty line after it. */
  readonly lines: number;
  /**
   * The engine's own total when the artifact states one; otherwise its
   * layer-change markers. Counting markers misses the layers the engine
   * counts differently, and two disagreeing layer counts in one UI is worse
   * than either.
   */
  readonly layers: number;
}

const LAYER_MARKERS = /; CHANGE_LAYER|;LAYER_CHANGE/g;

export function sliceStatusFigures(gcode: string): SliceStatusFigures {
  return {
    lines: gcode.split('\n').length,
    layers: summarizeGcodeArtifact(gcode).layerCount ?? (gcode.match(LAYER_MARKERS) ?? []).length,
  };
}

export interface SliceStatusLine extends SliceStatusFigures {
  readonly elapsedMs: number;
  /** The artifact's length in bytes, as published. */
  readonly byteLength: number;
  readonly warnings: number;
}

/** `SLICED in … ms`, then the size, lines, layers and any warnings. */
export function describeSliceStatus({ elapsedMs, byteLength, lines, layers, warnings }: SliceStatusLine): string {
  const warningSuffix = warnings > 0 ? `, ${warnings} warning(s)` : '';
  return `SLICED in ${elapsedMs} ms\n${(byteLength / 1024).toFixed(0)} KB, ${lines} lines, ${layers} layers${warningSuffix}`;
}
