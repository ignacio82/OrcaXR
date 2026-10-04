import { projectGcodePreview } from './GcodePreviewModel';
import { inspectGcode } from './GcodeInspectionModel';
import {
  indexRichGcodeLayers,
  parseRichGcodeLayerWindow,
  parseRichGcodeModel,
  type RichGcodeModel,
  type RichGcodeParseOptions,
} from './RichGcodeModel';
import {
  GcodePreviewController,
  GCODE_PREVIEW_WINDOW_RECORD_BUDGET,
  type GcodePreviewFrame,
  type GcodePreviewSessionSource,
} from './GcodePreviewController';
export * from './GcodePreviewController';

function frame(model: RichGcodeModel): GcodePreviewFrame {
  return {
    model,
    project: (request) => projectGcodePreview(model, request),
    inspect: (request) => inspectGcode(model, request),
  };
}
function wholeFrame(model: RichGcodeModel): () => GcodePreviewFrame {
  const cached = frame(model);
  return () => cached;
}

/** Independent TypeScript computation retained for qualification and rollback. */
export class GcodePreviewSession extends GcodePreviewController {
  static fromGcode(
    gcode: string,
    source: GcodePreviewSessionSource,
    options: RichGcodeParseOptions = {},
  ): GcodePreviewSession {
    const boundedOptions = {
      ...options,
      limits: {
        ...options.limits,
        records: Math.min(
          GCODE_PREVIEW_WINDOW_RECORD_BUDGET,
          options.limits?.records ?? GCODE_PREVIEW_WINDOW_RECORD_BUDGET,
        ),
      },
    };
    const index = indexRichGcodeLayers(gcode, boundedOptions);
    if (index.complete && index.recordCount <= index.limits.records && index.pathPointCount <= index.limits.pathPoints)
      return new GcodePreviewSession(index, wholeFrame(parseRichGcodeModel(gcode, boundedOptions)), source);
    return new GcodePreviewSession(
      index,
      (window) => {
        if (window.length !== 2) throw new Error('Expected a bounded preview window');
        return frame(parseRichGcodeLayerWindow(gcode, index, window[0], window[1], boundedOptions));
      },
      source,
    );
  }
}
