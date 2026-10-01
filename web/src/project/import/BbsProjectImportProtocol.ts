import type { ParsedProjectImport, ProjectImportMode, ProjectImportSource } from './types';
import type { ProjectRecoveryProof } from '../ports';

export const BBS_IMPORT_WORKER_PROTOCOL_VERSION = 2 as const;

export interface BbsImportWorkerRequest {
  readonly protocolVersion: typeof BBS_IMPORT_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  /** Replace parsing never receives or clones the live/base project bundle. */
  readonly request: {
    readonly bytes: Uint8Array;
    readonly source: Readonly<ProjectImportSource>;
    readonly mode: ProjectImportMode;
    readonly recoveryProof?: ProjectRecoveryProof;
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
