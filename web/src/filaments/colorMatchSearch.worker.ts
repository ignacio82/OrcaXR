/// <reference lib="webworker" />

import { searchSuppliedPaletteColorMatch } from '../project/filaments/colorMatchSearch';
import {
  COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
  type ColorMatchSearchWorkerRequest,
  type ColorMatchSearchWorkerResponse,
} from '../project/filaments/colorMatchSearchProtocol';

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<ColorMatchSearchWorkerRequest>) => {
  const message = event.data;
  if (
    message?.protocolVersion !== COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION ||
    message.type !== 'search' ||
    !message.requestId ||
    !message.input
  ) {
    return;
  }

  let response: ColorMatchSearchWorkerResponse;
  try {
    response = {
      protocolVersion: COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      type: 'result',
      result: searchSuppliedPaletteColorMatch(message.input),
    };
  } catch (error) {
    response = {
      protocolVersion: COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      type: 'error',
      error: boundedWorkerError(error),
    };
  }
  scope.postMessage(response);
};

function boundedWorkerError(error: unknown): { readonly name: string; readonly message: string } {
  return Object.freeze({
    name: sanitize(error instanceof Error ? error.name : 'ColorMatchSearchWorkerError', 80),
    message: sanitize(error instanceof Error ? error.message : String(error), 512),
  });
}

function sanitize(value: string, maximumLength: number): string {
  return (
    String(value || 'unknown error')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, maximumLength) || 'unknown error'
  );
}
