/// <reference lib="webworker" />

import { Bbs3mfProjectSerializer } from './Bbs3mfProjectSerializer';
import {
  PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
  type SerializeWorkerRequest,
  type SerializeWorkerResponse,
} from './ProjectSerializerProtocol';

const scope = self as DedicatedWorkerGlobalScope;
const serializer = new Bbs3mfProjectSerializer();

scope.onmessage = async (event: MessageEvent<SerializeWorkerRequest>) => {
  const message = event.data;
  if (message?.protocolVersion !== PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION || !message.requestId) return;
  let response: SerializeWorkerResponse;
  const transfer: Transferable[] = [];
  try {
    const serialized = await serializer.serialize({
      state: message.snapshot.state,
      assets: message.snapshot.assets.map((asset) => ({ descriptor: asset.descriptor, bytes: asset.bytes })),
      sourceRevision: message.snapshot.sourceRevision,
      sourceHash: message.snapshot.sourceHash,
    });
    // The archive of a large project is tens of megabytes; handing over the
    // buffer costs nothing, while copying it back would give away part of what
    // moving this work off the main thread just bought.
    transfer.push(serialized.bytes.buffer as ArrayBuffer);
    response = {
      protocolVersion: PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      type: 'serialized',
      result: {
        bytes: serialized.bytes,
        mediaType: serialized.mediaType,
        suggestedFilename: serialized.suggestedFilename,
        sourceRevision: serialized.sourceRevision,
        sourceHash: serialized.sourceHash,
        warnings: serialized.warnings ?? [],
      },
    };
  } catch (error) {
    transfer.length = 0;
    response = {
      protocolVersion: PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      type: 'error',
      error: boundedError(error),
    };
  }
  scope.postMessage(response, transfer);
};

function boundedError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : 'ProjectSerializerWorkerError';
  const message = error instanceof Error ? error.message : String(error);
  return { name: sanitize(name, 80), message: sanitize(message, 512) };
}

function sanitize(value: string, maxLength: number): string {
  return (
    String(value || 'unknown error')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, maxLength) || 'unknown error'
  );
}
