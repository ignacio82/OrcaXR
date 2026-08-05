import type { ParsedProjectImport, ProjectImportMode, ProjectImportSource } from './types';

export const BBS_IMPORT_WORKER_PROTOCOL_VERSION = 1 as const;

export interface BbsImportWorkerRequest {
  readonly protocolVersion: typeof BBS_IMPORT_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  /** Replace parsing never receives or clones the live/base project bundle. */
  readonly request: {
    readonly bytes: Uint8Array;
    readonly source: Readonly<ProjectImportSource>;
    readonly mode: ProjectImportMode;
  };
}

export type BbsImportWorkerResponse =
  | {
      readonly protocolVersion: typeof BBS_IMPORT_WORKER_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly type: 'parsed';
      readonly result: ParsedProjectImport;
    }
  | {
      readonly protocolVersion: typeof BBS_IMPORT_WORKER_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly type: 'error';
      readonly error: { readonly name: string; readonly message: string };
    };
