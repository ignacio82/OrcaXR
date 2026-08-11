import type { AssetPayload } from '../assets';
import type { ProjectState } from '../domain/model';

export const PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION = 1;

export interface SerializeWorkerRequest {
  readonly protocolVersion: typeof PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly snapshot: {
    readonly state: ProjectState;
    readonly assets: readonly AssetPayload[];
    readonly sourceRevision: number;
    readonly sourceHash: string;
  };
}

export type SerializeWorkerResponse =
  | {
      readonly protocolVersion: typeof PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly type: 'serialized';
      readonly result: {
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly suggestedFilename: string;
        readonly sourceRevision: number;
        readonly sourceHash: string;
        readonly warnings: readonly string[];
      };
    }
  | {
      readonly protocolVersion: typeof PROJECT_SERIALIZER_WORKER_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly type: 'error';
      readonly error: { readonly name: string; readonly message: string };
    };
