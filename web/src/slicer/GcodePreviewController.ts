import {
  GCODE_PREVIEW_MODES,
  type GcodePreviewMode,
  type GcodePreviewProjection,
  type GcodePreviewRequest,
} from './GcodePreviewModel';
import type { GcodeInspectionRequest, GcodeInspectionState } from './GcodeInspectionModel';
import {
  GCODE_RECORD_KIND,
  GCODE_RECORD_KIND_NAMES,
  RICH_GCODE_HARD_CAPS,
  type GcodeLayerIndex,
  type RichGcodeModel,
} from './RichGcodeModel';

/** Hard input bound; whole/window selection is based on the lightweight index. */
export const GCODE_PREVIEW_WHOLE_PARSE_CEILING_CHARACTERS = RICH_GCODE_HARD_CAPS.inputCharacters;

/** Records one loaded window may hold — about 30 MB of columns. */
export const GCODE_PREVIEW_WINDOW_RECORD_BUDGET = 240_000;

export type GcodePreviewIndex = Omit<GcodeLayerIndex, 'entries' | 'warnings'> & {
  readonly entries: readonly Omit<GcodeLayerIndex['entries'][number], 'checkpoint'>[];
};
export type GcodePreviewWindow = readonly [] | readonly [number, number];
export interface GcodePreviewFrame {
  readonly model: RichGcodeModel;
  project(request: GcodePreviewRequest): GcodePreviewProjection;
  inspect(request: GcodeInspectionRequest): GcodeInspectionState;
}
interface StreamingSource {
  readonly index: GcodePreviewIndex;
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

export interface GcodePreviewWindowState {
  readonly firstRecord: number;
  readonly lastRecord: number;
  readonly totalRecords: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export interface GcodePreviewViewPatch {
  /** Visit adjacent bounded records, including further moves in one large layer. */
  readonly windowStep?: -1 | 1;
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

/** Shared browser/headless contract; parsing can complete asynchronously. */
export interface GcodePreviewSessionPort {
  readonly source: GcodePreviewSessionSource;
  readonly model: RichGcodeModel;
  readonly layerBounds: readonly [number, number];
  readonly windowState?: GcodePreviewWindowState;
  readonly summary?: import('./GcodeArtifactSummary').GcodeArtifactSummary;
  getView(): GcodePreviewViewState;
  updateView(patch: GcodePreviewViewPatch): GcodePreviewViewState | Promise<GcodePreviewViewState>;
  project(request?: Partial<GcodePreviewRequest>): GcodePreviewProjection;
  inspect(): GcodeInspectionState;
  windowNotice(): string | undefined;
  dispose?(): void;
}
export type GcodePreviewSessionFactory = (
  gcode: string,
  source: GcodePreviewSessionSource,
  signal: AbortSignal,
) => Promise<GcodePreviewSessionPort>;

/**
 * UI-independent viewer state for one G-code source: it owns the parsed rich
 * model, the current view (mode, layer window, move filters), and produces the
 * projection and inspection state the surfaces render. It never mutates the
 * canonical project — a preview is a read-only view of an artifact.
 */
export class GcodePreviewController {
  private view: GcodePreviewViewState;
  private loaded: GcodePreviewFrame | undefined;
  private selected: GcodePreviewWindow;
  private readonly wholeBounds: readonly [number, number];
  private disposed = false;
  private stream: StreamingSource | undefined;
  private openFrame: ((window: GcodePreviewWindow) => GcodePreviewFrame) | undefined;
  private closeSource: (() => void) | undefined;

  protected constructor(
    index: GcodePreviewIndex,
    openFrame: (window: GcodePreviewWindow) => GcodePreviewFrame,
    readonly source: GcodePreviewSessionSource,
    closeSource: () => void = () => {},
  ) {
    this.openFrame = openFrame;
    this.closeSource = closeSource;
    const recordBudget = index.limits.records;
    const whole =
      index.complete && index.recordCount <= recordBudget && index.pathPointCount <= index.limits.pathPoints;
    const last = whole ? 0 : windowEnd(index, 0, recordBudget);
    this.stream = whole ? undefined : { index, recordBudget, loadedFirst: 0, loadedLast: last };
    this.selected = whole ? [] : [0, last];
    this.loaded = openFrame(this.selected);
    this.wholeBounds = layerBounds(this.loaded.model);
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

  static fromComputation(
    index: GcodePreviewIndex,
    openFrame: (window: GcodePreviewWindow) => GcodePreviewFrame,
    source: GcodePreviewSessionSource,
    dispose: () => void,
  ): GcodePreviewController {
    try {
      return new GcodePreviewController(index, openFrame, source, dispose);
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private get frame(): GcodePreviewFrame {
    if (this.disposed) throw new Error('The G-code preview is closed.');
    if (!this.loaded || (this.loaded.model.columns.count > 0 && !this.loaded.model.columns.kind.byteLength))
      this.loaded = this.openFrame!(this.selected);
    return this.loaded;
  }

  /** The Rust worker transfers its frame and then releases host references.
   * The reference worker retains its frame and transfers an independent copy. */
  releaseFrame(): void {
    this.loaded = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loaded = undefined;
    this.stream = undefined;
    this.openFrame = undefined;
    const close = this.closeSource;
    this.closeSource = undefined;
    close?.();
  }

  get windowState(): GcodePreviewWindowState | undefined {
    const stream = this.stream;
    if (!stream) return undefined;
    const entries = stream.index.entries;
    return Object.freeze({
      firstRecord: entries[stream.loadedFirst].recordsBefore,
      lastRecord: Math.max(
        0,
        entries[stream.loadedLast].recordsBefore + recordsIn(stream.index, stream.loadedLast) - 1,
      ),
      totalRecords: stream.index.recordCount,
      hasPrevious: stream.loadedFirst > 0,
      hasNext: stream.loadedLast < entries.length - 1,
    });
  }

  /** The model behind the current window; whole-print when not streaming. */
  get model(): RichGcodeModel {
    return this.frame.model;
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
    return this.wholeBounds;
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
    if (this.disposed) throw new Error('The G-code preview is closed.');
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
    if (patch.windowStep !== undefined && patch.windowStep !== -1 && patch.windowStep !== 1)
      throw new Error('A preview window step must be -1 or 1');
    [low, high] =
      patch.windowStep && this.stream
        ? this.stepWindow(patch.windowStep, singleLayer)
        : patch.layerRange || patch.singleLayer !== undefined
          ? this.ensureWindow(low, high)
          : [low, high];
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
    const targetFirst = entryForLayer(stream.index, low, 'first');
    const targetLast = entryForLayer(stream.index, high, 'last');

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

    return this.loadWindow(first, last);
  }

  private loadWindow(first: number, last: number): [number, number] {
    const stream = this.stream!;
    const entries = stream.index.entries;
    if (
      first !== stream.loadedFirst ||
      last !== stream.loadedLast ||
      (this.loaded !== undefined &&
        this.loaded.model.columns.count > 0 &&
        this.loaded.model.columns.kind.byteLength === 0)
    ) {
      this.loaded = undefined;
      const next: GcodePreviewWindow = [first, last];
      this.loaded = this.openFrame!(next);
      this.selected = next;
      stream.loadedFirst = first;
      stream.loadedLast = last;
    }
    return [entries[first].layer, entries[last].layer];
  }

  private stepWindow(direction: -1 | 1, singleLayer: boolean): [number, number] {
    const stream = this.stream!;
    const entries = stream.index.entries;
    let first: number;
    let last: number;
    if (direction === 1) {
      if (stream.loadedLast >= entries.length - 1) return [...this.loadedLayerBounds];
      first = stream.loadedLast + 1;
      last = windowEnd(stream.index, first, stream.recordBudget);
      if (singleLayer) last = Math.min(last, entryForLayer(stream.index, entries[first].layer, 'last'));
    } else {
      if (stream.loadedFirst === 0) return [...this.loadedLayerBounds];
      last = stream.loadedFirst - 1;
      first = windowStart(stream.index, last, stream.recordBudget);
      if (singleLayer) first = Math.max(first, entryForLayer(stream.index, entries[last].layer, 'first'));
    }
    return this.loadWindow(first, last);
  }

  /** Current projection for the active view; `unsupported` stays explicit. */
  project(request: Partial<GcodePreviewRequest> = {}): GcodePreviewProjection {
    return this.frame.project({
      mode: this.view.mode,
      layerRange: this.view.layerRange,
      eventVisibility: this.eventMask(),
      ...request,
    });
  }

  /** Layer/record inspection state for sliders, ticks, and the tool marker. */
  inspect(): GcodeInspectionState {
    return this.frame.inspect({
      layerRange: this.view.layerRange,
      singleLayer: this.view.singleLayer,
      clampLayerRange: true,
    });
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
    const window = this.windowState!;
    const coverage = stream.index.complete
      ? 'The supplied G-code was fully indexed.'
      : `Only a prefix was indexed (${stream.index.terminationReason ?? 'unknown termination'}); later input has not been inspected.`;
    return (
      `Showing layers ${low}–${high} of ${top}, records ${window.firstRecord + 1}–${window.lastRecord + 1} of ${window.totalRecords}. ` +
      'Use the layer range or Previous/Next moves to inspect another bounded window. ' +
      coverage
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
 * Oversized layers have multiple checkpoints, each within the record budget.
 */
function windowEnd(index: GcodePreviewIndex, first: number, budget: number): number {
  const entries = index.entries;
  const startRecords = entries[first].recordsBefore;
  let last = first;
  for (let candidate = first + 1; candidate < entries.length; candidate += 1) {
    const through = entries[candidate].recordsBefore + recordsIn(index, candidate) - startRecords;
    if (through > budget || pathPointsThrough(index, first, candidate) > index.limits.pathPoints) break;
    last = candidate;
  }
  return last;
}

/**
 * The earliest index entry that fits in the record budget ending at `last`.
 *
 * Oversized layers have multiple checkpoints, each within the record budget.
 */
function windowStart(index: GcodePreviewIndex, last: number, budget: number): number {
  const entries = index.entries;
  const endRecords = entries[last].recordsBefore + recordsIn(index, last);
  let first = last;
  for (let candidate = last - 1; candidate >= 0; candidate -= 1) {
    const through = endRecords - entries[candidate].recordsBefore;
    if (through > budget || pathPointsThrough(index, candidate, last) > index.limits.pathPoints) break;
    first = candidate;
  }
  return first;
}

function pathPointsThrough(index: GcodePreviewIndex, first: number, last: number): number {
  return (index.entries[last + 1]?.pathPointsBefore ?? index.pathPointCount) - index.entries[first].pathPointsBefore;
}

function recordsIn(index: GcodePreviewIndex, entry: number): number {
  const next = index.entries[entry + 1];
  return (next ? next.recordsBefore : index.recordCount) - index.entries[entry].recordsBefore;
}

/** Index-entry position holding `layer`, clamped into range. */
function entryForLayer(index: GcodePreviewIndex, layer: number, edge: 'first' | 'last'): number {
  const entries = index.entries;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].layer < layer || (edge === 'last' && entries[middle].layer === layer)) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(entries.length - 1, edge === 'last' ? low - 1 : low));
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
