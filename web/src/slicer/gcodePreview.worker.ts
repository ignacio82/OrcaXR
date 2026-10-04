/// <reference lib="webworker" />
import type { GcodePreviewController } from './GcodePreviewController';
import { createRustGcodePreview } from './core/RustGcodePreview';
import { GcodePreviewSession } from './GcodePreviewSession';
import { summarizeGcodeArtifact, type GcodeArtifactSummary } from './GcodeArtifactSummary';
import { RICH_GCODE_HARD_CAPS } from './RichGcodeModel';
import {
  previewTransferBuffers,
  type PreviewAdapter,
  type PreviewWorkerRequest,
  type PreviewWorkerResponse,
} from './GcodePreviewWorkerProtocol';

let session: GcodePreviewController | undefined;
let opening = false;
let adapter: PreviewAdapter;
let summary: GcodeArtifactSummary;
self.onmessage = async (event: MessageEvent<PreviewWorkerRequest>) => {
  const request = event.data;
  if (request?.version !== 2 || !Number.isSafeInteger(request.id)) return;
  try {
    if (request.type === 'open') {
      if (session || opening) throw new Error('A preview worker owns only one G-code source.');
      if (typeof request.gcode !== 'string' || request.gcode.length > RICH_GCODE_HARD_CAPS.inputCharacters)
        throw new Error('This G-code exceeds the bounded preview input size.');
      opening = true;
      adapter = request.adapter;
      if (adapter === 'rust') {
        session = await createRustGcodePreview(request.gcode, request.source, request.options);
      } else if (adapter === 'typescript') {
        session = GcodePreviewSession.fromGcode(request.gcode, request.source, request.options);
      } else throw new Error('Invalid preview adapter');
      summary = summarizeGcodeArtifact(request.gcode);
    } else if (request.type === 'view' && session) session.updateView(request.patch);
    else throw new Error('Open G-code before requesting a preview window.');
    // Rust owns its parsed window and returns independent packed host bytes.
    // The reference implementation retains its model and transfers a clone.
    const snapshot = {
      adapter,
      model: adapter === 'rust' ? session.model : structuredClone(session.model),
      view: session.getView(),
      layerBounds: session.layerBounds,
      window: session.windowState,
      notice: session.windowNotice(),
      summary,
      projection: session.project(),
      inspection: session.inspect(),
    };
    const response: PreviewWorkerResponse = { version: 2, id: request.id, type: 'ready', snapshot };
    self.postMessage(response, { transfer: previewTransferBuffers(snapshot) });
    if (adapter === 'rust') session.releaseFrame();
  } catch (error) {
    session?.dispose();
    const response: PreviewWorkerResponse = {
      version: 2,
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message.slice(0, 512) : 'G-code preview could not be read.',
    };
    self.postMessage(response);
  }
};
