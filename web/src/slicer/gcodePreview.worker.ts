/// <reference lib="webworker" />
import { GcodePreviewSession } from './GcodePreviewSession';
import { summarizeGcodeArtifact, type GcodeArtifactSummary } from './GcodeArtifactSummary';
import { RICH_GCODE_HARD_CAPS } from './RichGcodeModel';
import {
  previewTransferBuffers,
  type PreviewWorkerRequest,
  type PreviewWorkerResponse,
} from './GcodePreviewWorkerProtocol';

let session: GcodePreviewSession | undefined;
let summary: GcodeArtifactSummary;
self.onmessage = (event: MessageEvent<PreviewWorkerRequest>) => {
  const request = event.data;
  if (request?.version !== 1 || !Number.isSafeInteger(request.id)) return;
  try {
    if (request.type === 'open') {
      if (session) throw new Error('A preview worker owns only one G-code source.');
      if (typeof request.gcode !== 'string' || request.gcode.length > RICH_GCODE_HARD_CAPS.inputCharacters)
        throw new Error('This G-code exceeds the bounded preview input size.');
      session = GcodePreviewSession.fromGcode(request.gcode, request.source, request.options);
      summary = summarizeGcodeArtifact(request.gcode);
    } else if (request.type === 'view' && session) session.updateView(request.patch);
    else throw new Error('Open G-code before requesting a preview window.');
    // One bounded model is retained in the worker. Transfer an independent copy
    // so changing view never reparses detached columns or retains old responses.
    const snapshot = {
      model: structuredClone(session.model),
      view: session.getView(),
      layerBounds: session.layerBounds,
      window: session.windowState,
      notice: session.windowNotice(),
      summary,
      projection: session.project(),
      inspection: session.inspect(),
    };
    const response: PreviewWorkerResponse = { version: 1, id: request.id, type: 'ready', snapshot };
    self.postMessage(response, { transfer: previewTransferBuffers(snapshot) });
  } catch (error) {
    const response: PreviewWorkerResponse = {
      version: 1,
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message.slice(0, 512) : 'G-code preview could not be read.',
    };
    self.postMessage(response);
  }
};
