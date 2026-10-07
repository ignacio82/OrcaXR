// Synchronous test-only transport to one owned JVM. Production uses the Kotlin
// owner directly. This lets both bindings execute the identical JS corpus reader.
import { spawn } from "node:child_process";
import { readFileSync, readSync, writeSync } from "node:fs";
const root = new URL("../../", import.meta.url);
export function startProjectJni(profile = "debug") {
  if (!["debug", "release"].includes(profile))
    throw Error("Unsupported JNI build profile");
  const source = readFileSync(
    new URL(
      "android/core-bridge/src/main/java/dev/orcaxr/core/NativeProject.java",
      root,
    ),
    "utf8",
  );
  const signatures = Object.fromEntries(
    [...source.matchAll(/static native [\w\[\]]+ (\w+)\(([^)]*)\);/g)].map(
      ([, name, args]) => [
        name,
        args ? args.split(", ").map((v) => v.split(" ")[0]) : [],
      ],
    ),
  );
  signatures.actorPreparationChecks = ["String"];
  signatures.actorExportChecks = ["String", "String", "byte[]", "byte[]", "String", "String", "String"];
  signatures.actorClipboardChecks = ["String", "String", "byte[]", "byte[]"];
  signatures.actorClipboardReplay = ["String", "String", "byte[]", "byte[]", "long", "String", "long[]"];
  signatures.actorCapturedChecks = ["String", "String", "byte[]", "String", "long[]"];
  signatures.actorChecks = ["String"];
  signatures.actorArchiveChecks = ["String", "byte[]", "long"];
  signatures.providerDocumentChecks = ["String", "byte[]", "long"];
  signatures.actorImportChecks = ["String", "byte[]", "byte[]", "byte[]"];
  signatures.intentCodec = ["String", "String"];
  signatures.resolveLocal = ["String", "long"];
  signatures.ownerChecks = ["String", "String"];
  signatures.stagingChecks = ["String", "String"];
  signatures.documentChecks = ["String"];
  signatures.clipboardChecks = ["String", "String", "byte[]", "byte[]"];
  signatures.queryCodec = ["double[]", "boolean"];
  signatures.intentNumbers = ["double[]", "boolean"];
  signatures.intentLifecycle = ["int", "boolean"];
  signatures.stagedReference = ["long", "boolean"];
  const child = spawn(
    "java",
    [
      `-Djava.library.path=${new URL(`core/target/${profile}`, root).pathname}`,
      "-cp",
      readFileSync(
        new URL("tools/cross-platform/results/project-jvm/classpath.txt", root),
        "utf8",
      ),
      "dev.orcaxr.core.ProjectJniHarness",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  let closing;
  const stdin = child.stdin._handle.fd,
    stdout = child.stdout._handle.fd;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 900_000;
  function io(fn, data) {
    let offset = 0;
    while (offset < data.length) {
      if (Date.now() > deadline) throw Error("JNI replay deadline exceeded");
      try {
        const n = fn(data, offset, data.length - offset);
        if (n === 0) throw Error("JNI test process closed");
        offset += n;
      } catch (e) {
        if (e.code !== "EAGAIN") throw e;
        Atomics.wait(sleep, 0, 0, 0.1);
      }
    }
    return data;
  }
  const read = (n) =>
    io((b, o, n) => readSync(stdout, b, o, n, null), Buffer.alloc(n));
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    return b;
  };
  const sized = (b) => Buffer.concat([i32(b.length), b]);
  const encode = (type, v) => {
    if (type === "int") return i32(v);
    if (type === "long") {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(v));
      return b;
    }
    if (type === "boolean") return Buffer.from([v ? 1 : 0]);
    if (type === "String" && v === null) return i32(-1);
    if (type === "String" || type === "LocalTimestampResolver")
      return sized(Buffer.from(v, "utf8"));
    if (type === "byte[]") return sized(Buffer.from(v));
    const width = type === "char[]" ? 2 : 8,
      b = Buffer.alloc(v.length * width);
    for (let i = 0; i < v.length; i++) {
      if (type === "char[]") b.writeUInt16BE(v[i], i * 2);
      else if (type === "long[]") b.writeBigInt64BE(BigInt(v[i]), i * 8);
      else if (type === "double[]") b.writeDoubleBE(v[i], i * 8);
      else throw Error("Unsupported JNI test input");
    }
    return Buffer.concat([i32(v.length), b]);
  };
  const call = (name, ...args) => {
    const types = signatures[name];
    if (!types || types.length !== args.length) throw Error("Unknown JNI call");
    const message = Buffer.concat([
      sized(Buffer.from(name)),
      ...types.map((t, i) => encode(t, args[i])),
    ]);
    io((b, o, n) => writeSync(stdin, b, o, n), message);
    if (read(1)[0] !== 0) throw read(read(4).readInt32BE()).toString("utf8");
    const kind = read(1)[0];
    if (kind === 0) return undefined;
    if (kind === 1) return Number(read(8).readBigInt64BE());
    if (kind === 2) return read(1)[0] !== 0;
    const length = read(4).readInt32BE();
    if (length < 0 || length > 16 * 1024 * 1024)
      throw Error("JNI test response limit");
    if (kind === 3) return read(length).toString("utf8");
    if (kind === 4) return Uint8Array.from(read(length));
    if (kind === 5) {
      const b = read(length * 2);
      return Uint16Array.from({ length }, (_, i) => b.readUInt16BE(i * 2));
    }
    if (kind === 6) {
      const b = read(length * 8);
      return Float64Array.from({ length }, (_, i) => b.readDoubleBE(i * 8));
    }
    throw Error("Unknown JNI test response");
  };
  return {
    call,
    close() {
      return (closing ??= (async () => {
        child.stdin.destroy();
        child.stdout.destroy();
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await exited;
      })());
    },
  };
}

export function projectJniCore(call, zone = "UTC", profile = 32) {
  class Handle {
    constructor(id) {
      this.handle = id;
    }
    free() {
      if (this.handle) {
        call("close", this.handle);
        this.handle = 0;
      }
    }
  }
  const wrap = (Type, id) => (id ? new Type(id) : undefined);
  const consumed = (object, operation) => {
    const id = object.handle;
    object.handle = 0;
    try {
      return operation(id);
    } catch (e) {
      call("close", id);
      throw e;
    }
  };
  class ProjectUpload extends Handle {
    constructor(version, bytes, options) {
      super(call("uploadNew", version, bytes, options, zone, profile));
    }
    append_document(offset, bytes) {
      call("uploadAppendDocument", this.handle, offset, bytes);
    }
    seal_document() {
      call("uploadSealDocument", this.handle);
    }
    asset_count() {
      return call("uploadAssetCount", this.handle);
    }
    begin_asset(index) {
      return call("uploadBeginAsset", this.handle, index);
    }
    append_asset(offset, bytes) {
      call("uploadAppendAsset", this.handle, offset, bytes);
    }
    finish_asset() {
      call("uploadFinishAsset", this.handle);
    }
    cancel_asset() {
      call("uploadCancelAsset", this.handle);
    }
    prepare() {
      return consumed(this, (id) => {
        call("uploadPrepare", id);
        return new Handle(id);
      });
    }
    open(nonce) {
      return consumed(this, (id) => {
        call("uploadOpen", id, nonce);
        return new ProjectSession(id);
      });
    }
  }
  class ProjectSession extends Handle {
    begin_open() {
      return wrap(Handle, call("beginOpen", this.handle));
    }
    is_open_current(ticket) {
      return call("isOpenCurrent", this.handle, ticket.handle);
    }
    cancel_open(ticket) {
      return call("cancelOpen", this.handle, ticket.handle);
    }
    finish_open(ticket, document) {
      return consumed(document, (id) =>
        wrap(
          ProjectEffects,
          call("finishOpen", this.handle, ticket.handle, id),
        ),
      );
    }
    reset_document(guard, document) {
      return consumed(document, (id) =>
        wrap(
          ProjectEffects,
          call("resetDocument", this.handle, guard.handle, id),
        ),
      );
    }
    configure_staging(version, options) {
      call("configureStaging", this.handle, version, options);
    }
    staging_usage() {
      return call("stagingUsage", this.handle);
    }
    command_upload(guard, version, bytes, options) {
      return wrap(
        ProjectCommandUpload,
        call(
          "commandUploadNew",
          this.handle,
          guard.handle,
          version,
          bytes,
          options,
        ),
      );
    }
    capture_clipboard(guard, node, version, options) {
      return wrap(
        ProjectClipboard,
        call(
          "captureClipboard",
          this.handle,
          guard.handle,
          node.handle,
          version,
          options,
        ),
      );
    }
    clipboard_upload(guard, clipboard, version, bytes, options) {
      return wrap(
        ProjectCommandUpload,
        call(
          "clipboardUploadNew",
          this.handle,
          guard.handle,
          clipboard.handle,
          version,
          bytes,
          options,
        ),
      );
    }
    stage_commands(input) {
      return consumed(input, (id) => call("stageCommands", this.handle, id));
    }
    release_staged(id) {
      return call("releaseStaged", this.handle, id);
    }
    submit(request) {
      return wrap(ProjectReply, call("submit", this.handle, request));
    }
    run_next() {
      return wrap(ProjectReply, call("runNext", this.handle));
    }
    pending_count() {
      return call("pendingCount", this.handle);
    }
    dispose() {
      call("dispose", this.handle);
    }
    is_disposed() {
      return call("isDisposed", this.handle);
    }
    snapshot() {
      return wrap(CapturedProject, call("snapshot", this.handle));
    }
    selection() {
      return wrap(CapturedSelection, call("selection", this.handle));
    }
    history() {
      return wrap(CapturedHistory, call("history", this.handle));
    }
    history_revision() {
      return call("historyRevision", this.handle);
    }
    asset_fingerprint() {
      return call("assetFingerprint", this.handle);
    }
    asset(position) {
      return wrap(ProjectAsset, call("asset", this.handle, position));
    }
    capture_guard() {
      return wrap(Handle, call("captureGuard", this.handle));
    }
    is_current(g) {
      return call("isCurrent", this.handle, g.handle, false);
    }
    is_export_current(g) {
      return call("isCurrent", this.handle, g.handle, true);
    }
    acknowledge_checkpoint(g) {
      return wrap(
        ProjectEffects,
        call("acknowledgeCheckpoint", this.handle, g.handle),
      );
    }
    select(g, input, primary) {
      return consumed(input, (id) =>
        wrap(
          ProjectEffects,
          call("select", this.handle, g.handle, id, primary),
        ),
      );
    }
    capture_import_base() {
      return new ProjectImportBase(call("importBase", this.handle));
    }
    commit_import(preview, acknowledged) {
      return wrap(ProjectEffects, call("commitImport", this.handle, preview.handle, JSON.stringify(acknowledged)));
    }
    // The Kotlin export path: guard, immutable capture, then package the capture.
    write_archive(version, policy) {
      const guard = this.capture_guard();
      try {
        const capture = new Handle(call("captureExport", this.handle, guard.handle));
        try {
          return new ProjectArchiveOutput(
            call("exportArchive", capture.handle, version, policy),
            guard,
          );
        } finally {
          capture.free();
        }
      } catch (e) {
        guard.free();
        throw e;
      }
    }
  }
  class ProjectModelUpload extends Handle {
    constructor(version, bytes, options) {
      super(call("modelUploadNew", version, bytes ?? -1, options, zone, profile));
    }
    append(offset, bytes) {
      call("modelUploadAppend", this.handle, offset, bytes);
    }
  }
  class ProjectImportBase extends Handle {
    // Consumes the upload; its slot becomes the preview.
    prepare_model(upload, filename, importedAt, bed, dropToBed, idSeed, namespace) {
      const seed = [];
      for (let i = 0; i < idSeed.length; i += 8)
        seed.push(Buffer.from(idSeed.subarray(i, i + 8)).readBigInt64LE());
      return consumed(upload, (id) => {
        call("importPrepareModel", id, this.handle, Array.from(filename), Array.from(importedAt), Array.from(bed), dropToBed, seed, namespace ?? null);
        return new ProjectImportPreview(id);
      });
    }
  }
  class ProjectImportPreview extends Handle {
    length() {
      return call("importPreviewLength", this.handle);
    }
    read(start, count) {
      return call("importPreviewRead", this.handle, start, count);
    }
    blocked() {
      return call("importPreviewBlocked", this.handle);
    }
  }
  class ProjectArchiveUpload extends Handle {
    constructor(version, bytes, policy) {
      super(call("archiveUploadNew", version, bytes ?? -1, policy, zone, profile));
    }
    append(offset, bytes) {
      call("archiveUploadAppend", this.handle, offset, bytes);
    }
    prepare() {
      return consumed(this, (id) => {
        call("archiveUploadPrepare", id);
        return new ProjectArchiveImport(id);
      });
    }
  }
  class ArchiveWarnings extends Handle {
    warning_count() {
      return call("archiveWarningCount", this.handle);
    }
    warning_length(position) {
      return call("archiveWarningLength", this.handle, position);
    }
    warning(position, start, count) {
      return call("archiveWarning", this.handle, position, start, count);
    }
  }
  class ProjectArchiveImport extends ArchiveWarnings {
    format() {
      return call("archiveFormat", this.handle);
    }
    // Consumed in place: the same native slot becomes the prepared document.
    document() {
      return consumed(this, (id) => {
        call("archiveDocument", id);
        return new Handle(id);
      });
    }
  }
  class ProjectArchiveOutput extends ArchiveWarnings {
    constructor(id, guard) {
      super(id);
      this.owned = guard;
    }
    length() {
      return call("archiveLength", this.handle);
    }
    read(start, count) {
      return call("archiveRead", this.handle, start, count);
    }
    guard() {
      const guard = this.owned;
      if (!guard) throw Error("invalid_state");
      this.owned = undefined;
      return guard;
    }
    free() {
      this.owned?.free();
      this.owned = undefined;
      super.free();
    }
  }
  class ProjectSelectionInput extends Handle {
    constructor() {
      super(call("selectionInputNew"));
    }
    add(kind, id) {
      call("selectionInputAdd", this.handle, kind, id);
    }
  }
  class ProjectClipboard extends Handle {
    info() {
      return call("clipboardInfo", this.handle);
    }
  }
  class ProjectCommandUpload extends Handle {
    append(offset, bytes) {
      call("commandUploadAppend", this.handle, offset, bytes);
    }
    seal() {
      call("commandUploadSeal", this.handle);
    }
    units() {
      return call("commandUploadUnits", this.handle);
    }
    command_count() {
      return call("commandUploadCount", this.handle);
    }
    cancel() {
      this.free();
    }
  }
  class ProjectReply extends Handle {
    wire() {
      return call("replyWire", this.handle);
    }
    effects() {
      return consumed(this, (id) =>
        wrap(ProjectEffects, call("replyEffects", id)),
      );
    }
  }
  class ProjectEffects extends Handle {
    count() {
      return call("effectsCount", this.handle);
    }
    kind(p) {
      return call("effectKind", this.handle, p);
    }
    project(p, previous) {
      return wrap(
        CapturedProject,
        call("effectCapture", this.handle, p, previous),
      );
    }
    selection(p, previous) {
      return wrap(
        CapturedSelection,
        call("effectCapture", this.handle, p, previous),
      );
    }
    history(p, previous) {
      return wrap(
        CapturedHistory,
        call("effectCapture", this.handle, p, previous),
      );
    }
    reason_length(p) {
      return call("effectReasonLength", this.handle, p);
    }
    reason(p, start, count) {
      return call("effectReason", this.handle, p, start, count);
    }
    dirty_categories(p) {
      return call("effectDirtyCategories", this.handle, p);
    }
  }
  class CapturedProject extends Handle {
    query(version) {
      return wrap(ProjectQueryNode, call("queryRoot", this.handle, version));
    }
    revision() {
      return call("projectRevision", this.handle);
    }
    hash() {
      return call("projectHash", this.handle);
    }
    id_length() {
      return call("projectIdLength", this.handle);
    }
    id(start, count) {
      return call("projectId", this.handle, start, count);
    }
    export_json(max) {
      return wrap(ProjectBytes, call("projectExport", this.handle, max));
    }
  }
  class ProjectQueryNode extends Handle {
    snapshot() {
      return wrap(CapturedProject, call("queryProject", this.handle));
    }
    metadata() {
      return call("queryMetadata", this.handle);
    }
    text_length(field) {
      return call("queryTextLength", this.handle, field);
    }
    text(field, start, count) {
      return call("queryText", this.handle, field, start, count);
    }
    children(relation, max) {
      return wrap(
        ProjectQueryList,
        call("queryChildren", this.handle, relation, max),
      );
    }
  }
  class ProjectQueryList extends Handle {
    snapshot() {
      return wrap(CapturedProject, call("queryProject", this.handle));
    }
    count() {
      return call("queryCount", this.handle);
    }
    node(position) {
      return wrap(ProjectQueryNode, call("queryNode", this.handle, position));
    }
    page(start, count) {
      return call("queryPage", this.handle, start, count);
    }
  }
  class ProjectBytes extends Handle {
    length() {
      return call("bytesLength", this.handle);
    }
    read(start, count) {
      return call("bytesRead", this.handle, start, count);
    }
  }
  class ProjectAsset extends Handle {
    length() {
      return call("assetLength", this.handle);
    }
    digest() {
      return call("assetDigest", this.handle);
    }
    read(start, count) {
      return call("assetRead", this.handle, start, count);
    }
    metadata(max) {
      return wrap(ProjectBytes, call("assetMetadata", this.handle, max));
    }
  }
  class CapturedSelection extends Handle {
    count() {
      return call("selectionCount", this.handle);
    }
    primary_index() {
      return call("selectionPrimary", this.handle);
    }
    kind(p) {
      return call("selectionKind", this.handle, p);
    }
    id_length(p) {
      return call("selectionIdLength", this.handle, p);
    }
    id(p, start, count) {
      return call("selectionId", this.handle, p, start, count);
    }
  }
  class CapturedHistory extends Handle {
    undo_count() {
      return call("historyCount", this.handle, true);
    }
    redo_count() {
      return call("historyCount", this.handle, false);
    }
    has_label(undo) {
      return call("historyHasLabel", this.handle, undo);
    }
    label_length(undo) {
      return call("historyLabelLength", this.handle, undo);
    }
    label_text(undo, start, count) {
      return call("historyLabel", this.handle, undo, start, count);
    }
    dirty_categories() {
      return call("historyDirtyCategories", this.handle);
    }
  }
  return { ProjectUpload, ProjectSelectionInput, ProjectArchiveUpload, ProjectModelUpload };
}
