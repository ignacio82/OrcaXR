import {
  GCODE_PREVIEW_MODES,
  projectGcodePreview,
  type GcodePreviewMode,
  type GcodePreviewProjection,
  type GcodePreviewRequest,
} from './GcodePreviewModel';
import { inspectGcode, type GcodeInspectionState } from './GcodeInspectionModel';
import {
  GCODE_RECORD_KIND,
  GCODE_RECORD_KIND_NAMES,
  RICH_GCODE_HARD_CAPS,
  indexRichGcodeLayers,
  parseRichGcodeLayerWindow,
  parseRichGcodeModel,
  type GcodeLayerIndex,
  type RichGcodeModel,
  type RichGcodeParseOptions,
} from './RichGcodeModel';

/**
 * Skip the whole-print attempt above this size.
 *
 * The decision to stream is made by *trying* to read the print whole and
 * checking whether it fit, which needs no estimate of characters per record and
 * cannot be wrong. This only avoids paying for an attempt that is certain to
 * fail: past the parser's own character budget there is nothing to try.
 */
export const GCODE_PREVIEW_WHOLE_PARSE_CEILING_CHARACTERS = RICH_GCODE_HARD_CAPS.inputCharacters;

/** Records one loaded window may hold — about 30 MB of columns. */
export const GCODE_PREVIEW_WINDOW_RECORD_BUDGET = 240_000;

interface StreamingSource {
  readonly gcode: string;
  readonly index: GcodeLayerIndex;
  readonly options: RichGcodeParseOptions;
  /** Records one window may hold; never more than a parse would retain. */
  readonly recordBudget: number;
  /** Inclusive index-entry bounds currently parsed into `model`. */
  loadedFirst: number;
  loadedLast: number;
}

/** Move classes a viewer can hide, in the order the panel lists them. */
export const GCODE_PREVIEW_MOVE_FILTERS = Object.freeze([
  { id: 'extrude', label: 'Extrusions', kind: GCODE_RECORD_KIND.EXTRUDE, defaultVisible: true },
  { id: 'travel', label: 'Travel', kind: GCODE_RECORD_KIND.TRAVEL, defaultVisible: false },
  { id: 'wipe', label: 'Wipe', kind: GCODE_RECORD_KIND.WIPE, defaultVisible: false },
  { id: 'retract', label: 'Retractions', kind: GCODE_RECORD_KIND.RETRACT, defaultVisible: false },
  { id: 'unretract', label: 'Unretractions', kind: GCODE_RECORD_KIND.UNRETRACT, defaultVisible: false },
] as const);

export type GcodePreviewMoveFilterId = (typeof GCODE_PREVIEW_MOVE_FILTERS)[number]['id'];

export interface GcodePreviewViewState {
  readonly mode: GcodePreviewMode;
  /** Inclusive layer IDs; the model's own range when untouched. */
  readonly layerRange: readonly [number, number];
  readonly singleLayer: boolean;
  readonly moveVisibility: Readonly<Record<GcodePreviewMoveFilterId, boolean>>;
}

export interface GcodePreviewViewPatch {
  readonly mode?: GcodePreviewMode;
  readonly layerRange?: readonly [number, number];
  readonly singleLayer?: boolean;
  readonly moveVisibility?: Partial<Record<GcodePreviewMoveFilterId, boolean>>;
}

export interface GcodePreviewSessionSource {
  /** Where these bytes came from, e.g. a slice job or an opened file. */
  readonly kind: 'slice' | 'file';
  readonly name: string;
}

/**
 * UI-independent viewer state for one G-code source: it owns the parsed rich
 * model, the current view (mode, layer window, move filters), and produces the
 * projection and inspection state the surfaces render. It never mutates the
 * canonical project — a preview is a read-only view of an artifact.
 */
export class GcodePreviewSession {
  private view: GcodePreviewViewState;
  private loaded: RichGcodeModel;
  private readonly stream: StreamingSource | undefined;

  private constructor(
    model: RichGcodeModel,
    readonly source: GcodePreviewSessionSource,
    stream?: StreamingSource,
  ) {
    this.loaded = model;
    this.stream = stream;
    // What is shown starts as what is loaded. For a whole print that is every
    // layer; for a streamed one it is the first window, and the slider still
    // spans the entire print so the rest is one drag away.
    const bounds = this.loadedLayerBounds;
    this.view = Object.freeze({
      mode: 'FeatureType' as GcodePreviewMode,
      layerRange: bounds,
      singleLayer: false,
      moveVisibility: Object.freeze(
        Object.fromEntries(GCODE_PREVIEW_MOVE_FILTERS.map((filter) => [filter.id, filter.defaultVisible])) as Record<
          GcodePreviewMoveFilterId,
          boolean
        >,
      ),
    });
  }

  /**
   * Read a print whole when it fits, and a window at a time when it does not.
   *
   * The choice is the file's size, not the caller's: a print large enough that
   * one parse would cost hundreds of megabytes cannot be shown all at once by
   * any budget, and reading it in windows is what keeps every layer reachable
   * instead of silently stopping partway up.
   */
  static fromGcode(
    gcode: string,
    source: GcodePreviewSessionSource,
    options: RichGcodeParseOptions = {},
  ): GcodePreviewSession {
    if (gcode.length <= GCODE_PREVIEW_WHOLE_PARSE_CEILING_CHARACTERS) {
      const whole = parseRichGcodeModel(gcode, options);
      // It fit, so show all of it. Asking the model whether it fit is exact,
      // where guessing from the file size would sometimes be wrong in the one
      // direction that matters — quietly dropping the top of a print.
      if (whole.complete) return new GcodePreviewSession(whole, source);
    }
    const index = indexRichGcodeLayers(gcode, options);
    // A window can never hold more than one parse would keep, so a caller that
    // lowers the record limit lowers the window with it.
    const recordBudget = Math.min(GCODE_PREVIEW_WINDOW_RECORD_BUDGET, index.limits.records);
    const stream: StreamingSource = { gcode, index, options, recordBudget, loadedFirst: 0, loadedLast: 0 };
    const last = windowEnd(index, 0, recordBudget);
    stream.loadedLast = last;
    const model = parseRichGcodeLayerWindow(gcode, index, 0, last, options);
    return new GcodePreviewSession(model, source, stream);
  }

  /** The model behind the current window; whole-print when not streaming. */
  get model(): RichGcodeModel {
    return this.loaded;
  }

  /** True when only part of the print is held at once. */
  get streaming(): boolean {
    return this.stream !== undefined;
  }

  /** Inclusive layer bounds of the whole print, not of what is loaded. */
  get layerBounds(): readonly [number, number] {
    if (this.stream) {
      const entries = this.stream.index.entries;
      return Object.freeze([entries[0].layer, entries[entries.length - 1].layer]) as readonly [number, number];
    }
    return layerBounds(this.loaded);
  }

  /** Inclusive layer bounds actually parsed right now. */
  get loadedLayerBounds(): readonly [number, number] {
    if (!this.stream) return this.layerBounds;
    const entries = this.stream.index.entries;
    return Object.freeze([entries[this.stream.loadedFirst].layer, entries[this.stream.loadedLast].layer]) as readonly [
      number,
      number,
    ];
  }

  getView(): GcodePreviewViewState {
    return this.view;
  }

  /** Apply a bounded view change; out-of-range values clamp to the model. */
  updateView(patch: GcodePreviewViewPatch): GcodePreviewViewState {
    const [minLayer, maxLayer] = this.layerBounds;
    const mode = patch.mode ?? this.view.mode;
    if (!GCODE_PREVIEW_MODES.some((definition) => definition.id === mode)) {
      throw new Error(`Unknown preview mode ${mode}`);
    }
    let [low, high] = patch.layerRange ?? this.view.layerRange;
    if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error('A layer range must be finite');
    low = Math.min(Math.max(Math.round(low), minLayer), maxLayer);
    high = Math.min(Math.max(Math.round(high), minLayer), maxLayer);
    if (low > high) [low, high] = [high, low];
    const singleLayer = patch.singleLayer ?? this.view.singleLayer;
    if (singleLayer) low = high;
    // Load before publishing the view, so a caller that projects immediately
    // never sees a range the loaded window cannot answer for.
    [low, high] = this.ensureWindow(low, high);
    this.view = Object.freeze({
      mode,
      layerRange: Object.freeze([low, high]) as readonly [number, number],
      singleLayer,
      moveVisibility: Object.freeze({ ...this.view.moveVisibility, ...(patch.moveVisibility ?? {}) }),
    });
    return this.view;
  }

  /**
   * Load whatever window covers `[low, high]`, and report the range that is
   * actually readable.
   *
   * A request wider than one window is narrowed rather than partially served:
   * the viewer is told which layers it is looking at instead of being shown a
   * subset dressed up as the whole range.
   */
  private ensureWindow(low: number, high: number): [number, number] {
    const stream = this.stream;
    if (!stream) return [low, high];
    const entries = stream.index.entries;
    const targetFirst = entryForLayer(stream.index, low);
    const targetLast = entryForLayer(stream.index, high);

    let first: number;
    let last: number;

    const previousLow = this.view ? this.view.layerRange[0] : entries[stream.loadedFirst].layer;
    const previousHigh = this.view ? this.view.layerRange[1] : entries[stream.loadedLast].layer;
    const highMoved = high !== previousHigh;
    const lowMoved = low !== previousLow;

    if (highMoved && !lowMoved) {
      last = targetLast;
      first = Math.max(targetFirst, windowStart(stream.index, last, stream.recordBudget));
    } else if (lowMoved && !highMoved) {
      first = targetFirst;
      last = Math.min(targetLast, windowEnd(stream.index, first, stream.recordBudget));
    } else {
      const fitFromFirst = windowEnd(stream.index, targetFirst, stream.recordBudget);
      if (fitFromFirst >= targetLast) {
        first = targetFirst;
        last = targetLast;
      } else {
        last = targetLast;
        first = Math.max(targetFirst, windowStart(stream.index, last, stream.recordBudget));
      }
    }

    if (first !== stream.loadedFirst || last !== stream.loadedLast) {
      this.loaded = parseRichGcodeLayerWindow(stream.gcode, stream.index, first, last, stream.options);
      stream.loadedFirst = first;
      stream.loadedLast = last;
    }
    return [entries[first].layer, entries[last].layer];
  }

  /** Current projection for the active view; `unsupported` stays explicit. */
  project(request: Partial<GcodePreviewRequest> = {}): GcodePreviewProjection {
    return projectGcodePreview(this.model, {
      mode: this.view.mode,
      layerRange: this.view.layerRange,
      eventVisibility: this.eventMask(),
      ...request,
    });
  }

  /** Layer/record inspection state for sliders, ticks, and the tool marker. */
  inspect(): GcodeInspectionState {
    return inspectGcode(this.model, { layerRange: this.view.layerRange, singleLayer: this.view.singleLayer });
  }

  /**
   * What to tell the viewer when only part of the print is loaded.
   *
   * A window is a deliberate choice, not a failure, but leaving it unsaid would
   * reproduce the bug it exists to solve: someone seeing a fraction of their
   * model and concluding the slice went wrong.
   */
  windowNotice(): string | undefined {
    const stream = this.stream;
    if (!stream) return undefined;
    const [low, high] = this.loadedLayerBounds;
    const [, top] = this.layerBounds;
    if (low <= this.layerBounds[0] && high >= top) return undefined;
    return (
      `Showing layers ${low}–${high} of ${top}. This print is too large to hold at once, ` +
      'so it is read a window at a time — move the layer range to see the rest. The sliced G-code is complete.'
    );
  }

  /** Rich record-kind mask derived from the visible move classes. */
  private eventMask(): Uint8Array {
    const mask = new Uint8Array(GCODE_RECORD_KIND_NAMES.length);
    // Markers stay visible so ticks, tool changes, and pauses remain locatable.
    mask.fill(1);
    for (const filter of GCODE_PREVIEW_MOVE_FILTERS) {
      mask[filter.kind] = this.view.moveVisibility[filter.id] ? 1 : 0;
    }
    return mask;
  }
}

/**
 * The last index entry that fits in the record budget starting at `first`.
 *
 * Always at least one layer: a single layer larger than the budget is still
 * shown, because refusing to draw a layer is worse than briefly exceeding a
 * self-imposed ceiling.
 */
function windowEnd(index: GcodeLayerIndex, first: number, budget: number): number {
  const entries = index.entries;
  const startRecords = entries[first].recordsBefore;
  let last = first;
  for (let candidate = first + 1; candidate < entries.length; candidate += 1) {
    const through = entries[candidate].recordsBefore + recordsIn(index, candidate) - startRecords;
    if (through > budget) break;
    last = candidate;
  }
  return last;
}

/**
 * The earliest index entry that fits in the record budget ending at `last`.
 *
 * Always at least one layer: a single layer larger than the budget is still
 * shown, because refusing to draw a layer is worse than briefly exceeding a
 * self-imposed ceiling.
 */
function windowStart(index: GcodeLayerIndex, last: number, budget: number): number {
  const entries = index.entries;
  const endRecords = entries[last].recordsBefore + recordsIn(index, last);
  let first = last;
  for (let candidate = last - 1; candidate >= 0; candidate -= 1) {
    const through = endRecords - entries[candidate].recordsBefore;
    if (through > budget) break;
    first = candidate;
  }
  return first;
}

function recordsIn(index: GcodeLayerIndex, entry: number): number {
  const next = index.entries[entry + 1];
  return (next ? next.recordsBefore : index.recordCount) - index.entries[entry].recordsBefore;
}

/** Index-entry position holding `layer`, clamped into range. */
function entryForLayer(index: GcodeLayerIndex, layer: number): number {
  const entries = index.entries;
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    if (entries[position].layer <= layer) return position;
  }
  return 0;
}

function layerBounds(model: RichGcodeModel): readonly [number, number] {
  const layers = model.columns.layer;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < model.columns.count; index += 1) {
    const layer = layers[index];
    if (layer < min) min = layer;
    if (layer > max) max = layer;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return Object.freeze([0, 0]) as readonly [number, number];
  return Object.freeze([min, max]) as readonly [number, number];
}
