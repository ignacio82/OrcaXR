import type { GcodeArtifactSummary } from './GcodeArtifactSummary';
import type { GcodeInspectionState } from './GcodeInspectionModel';
import type { GcodePreviewProjection } from './GcodePreviewModel';
import type {
  GcodePreviewSessionSource,
  GcodePreviewViewPatch,
  GcodePreviewViewState,
  GcodePreviewWindowState,
} from './GcodePreviewSession';
import type { RichGcodeModel, RichGcodeParseOptions } from './RichGcodeModel';

export type PreviewWorkerRequest = {
  readonly version: 1;
  readonly id: number;
} & (
  | {
      readonly type: 'open';
      readonly gcode: string;
      readonly source: GcodePreviewSessionSource;
      readonly options?: RichGcodeParseOptions;
    }
  | { readonly type: 'view'; readonly patch: GcodePreviewViewPatch }
);

export interface PreviewWorkerSnapshot {
  readonly model: RichGcodeModel;
  readonly view: GcodePreviewViewState;
  readonly layerBounds: readonly [number, number];
  readonly window?: GcodePreviewWindowState;
  readonly notice?: string;
  readonly summary: GcodeArtifactSummary;
  readonly projection: GcodePreviewProjection;
  readonly inspection: GcodeInspectionState;
}
export type PreviewWorkerResponse = { readonly version: 1; readonly id: number } & (
  | { readonly type: 'ready'; readonly snapshot: PreviewWorkerSnapshot }
  | { readonly type: 'error'; readonly message: string }
);

/** Unique owned buffers, including subarray backing stores; never clone G-code text back. */
export function previewTransferBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    if (ArrayBuffer.isView(entry)) {
      if (entry.buffer instanceof ArrayBuffer) buffers.add(entry.buffer);
    } else if (Array.isArray(entry)) entry.forEach(visit);
    else Object.values(entry).forEach(visit);
  };
  visit(value);
  return [...buffers];
}
