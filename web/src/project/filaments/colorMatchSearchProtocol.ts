import type { SuppliedPaletteMatchSearchInput, SuppliedPaletteMatchSearchResult } from './colorMatchSearch';

export const COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION = 1 as const;

export interface ColorMatchSearchWorkerRequest {
  readonly protocolVersion: typeof COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly type: 'search';
  readonly input: SuppliedPaletteMatchSearchInput;
}

export type ColorMatchSearchWorkerResponse =
  | {
      readonly protocolVersion: typeof COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly type: 'result';
      readonly result: SuppliedPaletteMatchSearchResult;
    }
  | {
      readonly protocolVersion: typeof COLOR_MATCH_SEARCH_WORKER_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly type: 'error';
      readonly error: {
        readonly name: string;
        readonly message: string;
      };
    };
