/// <reference lib="webworker" />

import { BbsProjectImportParser } from '../project/import/BbsProjectImportParser';
import {
  BBS_IMPORT_WORKER_PROTOCOL_VERSION,
  type BbsImportWorkerRequest,
  type BbsImportWorkerResponse,
} from '../project/import/BbsProjectImportProtocol';

const scope = self as DedicatedWorkerGlobalScope;
const parser = new BbsProjectImportParser();

scope.onmessage = async (event: MessageEvent<BbsImportWorkerRequest>) => {
  const message = event.data;
  if (message?.protocolVersion !== BBS_IMPORT_WORKER_PROTOCOL_VERSION || !message.requestId || !message.request) {
    return;
  }
  let response: BbsImportWorkerResponse;
  try {
    if (message.request.mode !== 'replace') {
      throw new Error('BBS project import worker currently supports replace mode only');
    }
    const result = await parser.parseArchive(message.request.bytes);
    response = {
      protocolVersion: BBS_IMPORT_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      type: 'parsed',
      result,
    };
  } catch (error) {
    response = {
      protocolVersion: BBS_IMPORT_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      type: 'error',
      error: boundedError(error),
    };
  }
  scope.postMessage(response);
};

function boundedError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : 'BbsImportWorkerError';
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: sanitize(name, 80),
    message: sanitize(message, 512),
  };
}

function sanitize(value: string, maxLength: number): string {
  return (
    String(value || 'unknown error')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, maxLength) || 'unknown error'
  );
}
