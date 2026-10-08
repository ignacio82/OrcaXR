/**
 * The worker side of a project session hosted by the shared Rust core: opens
 * the session from an acknowledged checkpoint, runs each exchange to its
 * reply in order (consuming the commit's effects first), and captures the
 * current state as a checkpoint after every exchange sent before it. The
 * worker serves exactly one incarnation; any failure is reported once and
 * ends it.
 */
import type {
  SessionCheckpoint,
  SessionOpenLimits,
  SessionWorkerReply,
  SessionWorkerRequest,
} from './ProjectSessionWorker';

/** The parts of the project core's WASM module a host uses. */
export interface RustProjectCore {
  readonly ProjectUpload: new (version: number, documentBytes: number, options: Float64Array) => RustProjectUpload;
}
interface RustFreed {
  free(): void;
}
interface RustBytes extends RustFreed {
  length(): number;
  read(start: number, count: number): Uint8Array;
}
interface RustProjectUpload extends RustFreed {
  append_document(offset: number, bytes: Uint8Array): void;
  seal_document(): void;
  asset_count(): number;
  begin_asset(position: number): number;
  append_asset(offset: number, bytes: Uint8Array): void;
  finish_asset(): void;
  open(generation: Float64Array): RustProjectSession;
}
interface RustProjectSession extends RustFreed {
  submit(request: string): RustProjectReply | undefined;
  run_next(): RustProjectReply | undefined;
  snapshot(): RustCapturedProject;
  asset(position: number): RustBytes;
  asset_fingerprint(): string;
  dispose(): void;
}
interface RustProjectReply extends RustFreed {
  wire(): string;
  effects(): RustFreed;
}
interface RustCapturedProject extends RustFreed {
  export_json(maxBytes: number): RustBytes;
  revision(): number;
  hash(): string;
}

/** `contracts/project-host.json`. */
export interface RustHostLayout {
  readonly version: number;
  readonly maxChunkBytes: number;
  readonly options: readonly string[];
}

/** The most document bytes a checkpoint exports. */
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;

/**
 * Returns the worker's message handler. `post` delivers a reply, transferring
 * the listed buffers.
 */
export function hostRustProjectSession(
  core: RustProjectCore,
  layout: RustHostLayout,
  post: (reply: SessionWorkerReply, transfer: Transferable[]) => void,
): (request: SessionWorkerRequest) => void {
  let incarnation: number | undefined;
  let session: RustProjectSession | undefined;
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    try {
      session?.dispose();
      session?.free();
    } catch {
      // The failure is already being reported.
    }
    session = undefined;
    post({ kind: 'failed', incarnation: incarnation ?? -1, message }, []);
  };
  return (request) => {
    if (failed) return;
    try {
      if (request.kind === 'open') {
        if (session || incarnation !== undefined) return fail('the session is already open');
        incarnation = request.incarnation;
        session = open(core, layout, request.generation, request.limits, request.checkpoint);
        post({ kind: 'opened', incarnation, id: request.id }, []);
        return;
      }
      if (!session || request.incarnation !== incarnation) return fail('a request for another session');
      if (request.kind === 'exchange') {
        const reply = session.submit(request.text) ?? session.run_next();
        if (!reply) return fail('the session did not answer');
        let text: string;
        try {
          text = reply.wire();
        } catch (error) {
          reply.free();
          throw error;
        }
        // Effects are dispatched before the acknowledgement leaves; taking
        // them consumes the reply.
        reply.effects().free();
        post({ kind: 'exchange', incarnation, id: request.id, text }, []);
        return;
      }
      const checkpoint = capture(session, layout);
      post(
        { kind: 'checkpoint', incarnation, id: request.id, checkpoint },
        checkpoint.assets.map((bytes) => bytes.buffer),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };
}

function open(
  core: RustProjectCore,
  layout: RustHostLayout,
  generation: readonly number[],
  limits: SessionOpenLimits,
  checkpoint: SessionCheckpoint,
): RustProjectSession {
  const document = new TextEncoder().encode(checkpoint.stateJson);
  const options: Record<string, number> = {
    ...limits,
    documentBytes: document.length,
    assets: checkpoint.assets.length,
  };
  const upload = new core.ProjectUpload(
    layout.version,
    document.length,
    Float64Array.from(layout.options.map((name) => options[name])),
  );
  try {
    for (let offset = 0; offset < document.length; offset += layout.maxChunkBytes)
      upload.append_document(offset, document.subarray(offset, offset + layout.maxChunkBytes));
    upload.seal_document();
    if (upload.asset_count() !== checkpoint.assets.length)
      throw new Error('checkpoint assets differ from the document');
    for (const [position, bytes] of checkpoint.assets.entries()) {
      if (upload.begin_asset(position) !== bytes.length) throw new Error('checkpoint asset length differs');
      for (let offset = 0; offset < bytes.length; offset += layout.maxChunkBytes)
        upload.append_asset(offset, bytes.subarray(offset, offset + layout.maxChunkBytes));
      upload.finish_asset();
    }
  } catch (error) {
    upload.free();
    throw error;
  }
  // Opening consumes the upload, whether or not it succeeds.
  return upload.open(Float64Array.from(generation));
}

function capture(session: RustProjectSession, layout: RustHostLayout): SessionCheckpoint {
  const read = (bytes: RustBytes) => {
    const out = new Uint8Array(bytes.length());
    for (let offset = 0; offset < out.length; offset += layout.maxChunkBytes)
      out.set(bytes.read(offset, Math.min(layout.maxChunkBytes, out.length - offset)), offset);
    return out;
  };
  const snapshot = session.snapshot();
  try {
    const exported = snapshot.export_json(MAX_CHECKPOINT_BYTES);
    let stateJson: string;
    try {
      stateJson = new TextDecoder('utf-8', { fatal: true }).decode(read(exported));
    } finally {
      exported.free();
    }
    const declared = (JSON.parse(stateJson) as { sourceAssets: readonly unknown[] }).sourceAssets.length;
    const assets = Array.from({ length: declared }, (_, position) => {
      const asset = session.asset(position);
      try {
        return read(asset);
      } finally {
        asset.free();
      }
    });
    return {
      revision: snapshot.revision(),
      semanticHash: snapshot.hash(),
      assetFingerprint: session.asset_fingerprint(),
      stateJson,
      assets,
    };
  } finally {
    snapshot.free();
  }
}
