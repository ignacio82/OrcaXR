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
  parseRichGcodeModel,
  type RichGcodeModel,
  type RichGcodeParseOptions,
} from './RichGcodeModel';

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

  private constructor(
    readonly model: RichGcodeModel,
    readonly source: GcodePreviewSessionSource,
  ) {
    const bounds = layerBounds(model);
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

  static fromGcode(
    gcode: string,
    source: GcodePreviewSessionSource,
    options: RichGcodeParseOptions = {},
  ): GcodePreviewSession {
    return new GcodePreviewSession(parseRichGcodeModel(gcode, options), source);
  }

  get layerBounds(): readonly [number, number] {
    return layerBounds(this.model);
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
    this.view = Object.freeze({
      mode,
      layerRange: Object.freeze([low, high]) as readonly [number, number],
      singleLayer,
      moveVisibility: Object.freeze({ ...this.view.moveVisibility, ...(patch.moveVisibility ?? {}) }),
    });
    return this.view;
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
