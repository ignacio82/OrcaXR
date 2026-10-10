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
  signatures.actorPreflightChecks = ["String", "byte[]", "String", "String"];
  signatures.catalogChecks = ["byte[]", "String"];
  signatures.libraryChecks = ["byte[]", "String"];
  signatures.editorChecks = ["String"];
  signatures.capabilityChecks = ["String", "byte[]", "String"];
  signatures.renderChecks = ["String", "byte[]", "String"];
  signatures.facetRegionChecks = ["String", "byte[]", "byte[]", "String"];
  signatures.paintStrokeChecks = ["String", "byte[]", "byte[]", "String"];
  signatures.pickChecks = ["String", "byte[]", "byte[]", "byte[]", "String"];
  signatures.placementChecks = ["String", "byte[]", "byte[]", "byte[]", "String"];
  signatures.arrangeChecks = ["String", "byte[]", "byte[]", "byte[]", "String"];
  signatures.wipeTowerChecks = ["String", "byte[]", "byte[]", "byte[]", "String"];
  signatures.volumeSplitChecks = ["String", ...Array(6).fill("byte[]"), "String"];
  signatures.simplifyChecks = ["String", ...Array(7).fill("byte[]"), "String"];
  signatures.measureChecks = ["String", ...Array(6).fill("byte[]"), "String"];
  signatures.brimEarChecks = ["String", ...Array(8).fill("byte[]"), "String"];
  signatures.embossChecks = ["String", "byte[]", "String"];
  signatures.svgPartChecks = ["String", "byte[]", "String"];
  signatures.meshPacketChecks = ["String", "byte[]", "String", "String"];
  signatures.assemblyChecks = ["String"];
  signatures.objectTreeChecks = ["String", "byte[]", "String"];
  signatures.printJobStatusChecks = ["String"];
  signatures.printerControlChecks = ["String"];
  signatures.printerToolsChecks = ["String"];
  signatures.printPreparationChecks = ["String"];
  signatures.printWorkflowChecks = ["String"];
  signatures.printerSessionChecks = ["String"];
  signatures.moonrakerPolicyChecks = ["String"];
  signatures.printerStorageChecks = ["String"];
  signatures.externalSlicerChecks = ["String"];
  signatures.plateProjectionChecks = ["String"];
  signatures.slicingConfigurationChecks = ["byte[]", "String", "String"];
  signatures.externalSlicerClientChecks = ["String", "String", "byte[]", "String"];
  signatures.printHistoryChecks = ["String"];
  signatures.printerConsoleChecks = ["String"];
  signatures.printerCameraChecks = ["String"];
  signatures.printerDirectoryChecks = ["String"];
  signatures.credentialsChecks = ["String"];
  signatures.localNetworkChecks = ["String"];
  signatures.deviceWorkspaceChecks = ["String"];
  signatures.deviceSendChecks = ["String"];
  signatures.newProjectCase = ["String", "double[]", "String", "String"];
  signatures.newProjectChecks = [];
  signatures.projectWorkspaceChecks = ["byte[]", "byte[]"];
  signatures.projectEditChecks = ["byte[]"];
  signatures.projectRecoveryChecks = ["byte[]"];
  signatures.documentOwnersChecks = ["byte[]"];
  signatures.slicingChoiceChecks = ["byte[]", "byte[]"];
  signatures.workspaceBedChecks = ["String"];
  signatures.transformFieldChecks = ["String"];
  signatures.placementEditChecks = ["String", "byte[]"];
  signatures.transformEditChecks = ["byte[]", "String"];
  signatures.primitiveChecks = ["String"];
  signatures.stagedRecordChecks = ["String"];
  signatures.stagedRecords = ["String"];
  signatures.createEditChecks = ["String", "byte[]"];
  signatures.projectSceneChecks = ["byte[]"];
  signatures.printerDiscoveryChecks = ["String", "String"];
  signatures.printerExchangesChecks = ["String"];
  signatures.credentialVaultChecks = [];
  signatures.moonrakerTransportChecks = ["String"];
  signatures.moonrakerClientChecks = ["String"];
  signatures.printerSessionClientChecks = ["String"];
  signatures.printWorkflowClientChecks = ["String"];
  signatures.lanPolicyChecks = ["String"];
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
    if (type === "double") {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(v);
      return b;
    }
    if (type === "boolean") return Buffer.from([v ? 1 : 0]);
    if (type === "String" && v === null) return i32(-1);
    if (type === "String" || type === "LocalTimestampResolver")
      return sized(Buffer.from(v, "utf8"));
    // A collator mode the harness maps to a Java object, or none.
    if (type === "PresetCollator" || type === "SearchFolding")
      return sized(Buffer.from(v ?? "none", "utf8"));
    if ((type === "byte[]" || type === "char[]") && v == null) return i32(-1);
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
    if (kind === 7) return read(8).readDoubleBE();
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
    capabilities(request) {
      return call("sessionCapabilities", this.handle, request);
    }
    render(request) {
      return call("sessionRender", this.handle, request);
    }
    facet_region(request) {
      return call("sessionFacetRegion", this.handle, request);
    }
    detect_brim_ears(request) {
      return call("sessionBrimEarDetect", this.handle, request);
    }
    stranded_brim_ears(request) {
      return call("sessionBrimEarStranded", this.handle, request);
    }
    plan_wipe_tower(request) {
      return call("sessionWipeTower", this.handle, request);
    }
    plan_arrangement(request) {
      return call("sessionArrangement", this.handle, request);
    }
    plan_bed_fill(request) {
      return call("sessionBedFill", this.handle, request);
    }
    plan_primitive_object(request) {
      return call("sessionPrimitiveObject", this.handle, request);
    }
    plan_helper_volume(request) {
      return call("sessionHelperVolume", this.handle, request);
    }
    plan_placement(request) {
      return call("sessionPlacement", this.handle, request);
    }
    pick_scene(request) {
      return wrap(ProjectPickScene, call("sessionPickScene", this.handle, request));
    }
    paint_overlay(request) {
      return wrap(
        ProjectPaintOverlay,
        call("sessionPaintOverlay", this.handle, request),
      );
    }
    paint_stroke(guard, request) {
      return wrap(
        ProjectPaintStroke,
        call("paintStrokeOpen", this.handle, guard.handle, request),
      );
    }
    volume_split(guard, request) {
      return wrap(
        ProjectVolumeSplit,
        call("volumeSplit", this.handle, guard.handle, request),
      );
    }
    stage_volume_split(split, request) {
      return call("stageVolumeSplit", this.handle, split.handle, request);
    }
    volume_simplify(guard, request) {
      return wrap(
        ProjectVolumeSimplify,
        call("volumeSimplify", this.handle, guard.handle, request),
      );
    }
    stage_emboss(emboss, request) {
      return call("stageEmboss", this.handle, emboss.handle, request);
    }
    stage_svg_part(svg, request) {
      return call("stageSvgPart", this.handle, svg.handle, request);
    }
    stage_slicing_configuration(catalog, request, words) {
      return call("stageSlicingConfiguration", this.handle, catalog.handle, request, Array.from(words));
    }
    mesh_packet(request) {
      return wrap(
        ProjectMeshPacket,
        call("sessionMeshPacket", this.handle, request),
      );
    }
    measure_volume(request) {
      return wrap(
        ProjectMeasureVolume,
        call("sessionMeasureVolume", this.handle, request),
      );
    }
    stage_volume_simplify(simplify, request) {
      return call("stageVolumeSimplify", this.handle, simplify.handle, request);
    }
    stage_paint_stroke(stroke, label) {
      return call(
        "stagePaintStroke",
        this.handle,
        stroke.handle,
        label === undefined ? null : Array.from(label),
      );
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
    capture_export(g) {
      return new ProjectExport(call("captureExport", this.handle, g.handle));
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
  class ProjectExport extends Handle {
    preflight(request) {
      return new ProjectPreflight(call("exportPreflight", this.handle, request));
    }
    project() {
      return new CapturedProject(call("exportProject", this.handle));
    }
    plate(plateId) {
      return new ProjectExport(call("exportPlate", this.handle, plateId, zone, profile));
    }
    // An export is never a save: its archive carries no checkpoint guard.
    write_archive(version, policy) {
      return new ProjectArchiveOutput(call("exportArchive", this.handle, version, policy));
    }
  }
  class ProjectPreflight extends Handle {
    summary() {
      return call("preflightSummary", this.handle);
    }
    issue(position) {
      return call("preflightIssue", this.handle, position);
    }
    omission(position) {
      return call("preflightOmission", this.handle, position);
    }
    printable_instance(position) {
      return call("preflightInstance", this.handle, position);
    }
    used_filament(position) {
      return call("preflightFilament", this.handle, position);
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
    asset_bytes() {
      return call("commandUploadAssetBytes", this.handle);
    }
    asset_count() {
      return call("commandUploadAssetCount", this.handle);
    }
    begin_asset(position) {
      return call("commandUploadBeginAsset", this.handle, position);
    }
    append_asset(offset, bytes) {
      call("commandUploadAppendAsset", this.handle, offset, bytes);
    }
    finish_asset() {
      call("commandUploadFinishAsset", this.handle);
    }
    cancel_asset() {
      call("commandUploadCancelAsset", this.handle);
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
    paint_palette(request) {
      return call("projectPaintPalette", this.handle, request);
    }
    object_tree(request, folder) {
      return call("projectObjectTree", this.handle, request, folder);
    }
    settings_targets(request) {
      return call("projectSettingsTargets", this.handle, request);
    }
    settings_snapshot(request) {
      return call("projectSettingsSnapshot", this.handle, request);
    }
    settings_explain(request) {
      return call("projectSettingsExplain", this.handle, request);
    }
    settings_editor(request, collator, folder) {
      return wrap(
        SettingsEditor,
        call("projectSettingsEditor", this.handle, request, collator, folder),
      );
    }
    revision() {
      return call("projectRevision", this.handle);
    }
    hash() {
      return call("projectHash", this.handle);
    }
    plate_print_overrides(plateId) {
      return call("projectPlateOverrides", this.handle, plateId);
    }
    workspace_bed(request) {
      return call("projectWorkspaceBed", this.handle, request);
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
  class ProjectPaintStroke extends Handle {
    sample(request) {
      return call("paintStrokeSample", this.handle, request);
    }
    overlay(request) {
      return call("paintStrokeOverlay", this.handle, request);
    }
    preview() {
      return wrap(ProjectPaintOverlay, call("paintStrokePreview", this.handle));
    }
  }
  class ProjectEmboss extends Handle {
    reply() {
      return call("embossReply", this.handle);
    }
    mesh(start, count) {
      return call("embossMesh", this.handle, start, count);
    }
  }
  class ProjectMeshPacket extends Handle {
    reply() {
      return call("meshPacketReply", this.handle);
    }
    bytes(start, count) {
      return call("meshPacketBytes", this.handle, start, count);
    }
  }
  class ProjectSvgPart extends Handle {
    reply() {
      return call("svgPartReply", this.handle);
    }
    mesh(start, count) {
      return call("svgPartMesh", this.handle, start, count);
    }
  }
  class ProjectMeasureVolume extends Handle {
    reply() {
      return call("measureVolumeReply", this.handle);
    }
    feature(request) {
      return call("measureVolumeFeature", this.handle, request);
    }
  }
  class ProjectVolumeSimplify extends Handle {
    reply() {
      return call("volumeSimplifyReply", this.handle);
    }
    mesh(start, count) {
      return call("volumeSimplifyMesh", this.handle, start, count);
    }
  }
  class ProjectVolumeSplit extends Handle {
    reply() {
      return call("volumeSplitReply", this.handle);
    }
  }
  class ProjectPickScene extends Handle {
    pick(ray) {
      return call("pickScenePick", this.handle, ray);
    }
  }
  class ProjectPaintOverlay extends Handle {
    summary() {
      return call("paintOverlaySummary", this.handle);
    }
    packet(start, count) {
      return call("paintOverlayPacket", this.handle, start, count);
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
  class ProfileCatalogUpload extends Handle {
    constructor(bytes, limits) {
      super(call("catalogUploadNew", bytes, Array.from(limits)));
    }
    append(offset, bytes) {
      call("catalogUploadAppend", this.handle, offset, bytes);
    }
    build(collator) {
      return consumed(this, (id) => {
        call("catalogBuild", id, collator);
        return new ProfileCatalog(id);
      });
    }
  }
  class ProfileCatalog extends Handle {
    diagnostic_count() {
      return call("catalogDiagnosticCount", this.handle);
    }
    diagnostic(i) {
      return call("catalogDiagnostic", this.handle, i);
    }
    preset_count() {
      return call("catalogPresetCount", this.handle);
    }
    preset(i) {
      return call("catalogPreset", this.handle, i);
    }
    profile_count() {
      return call("catalogProfileCount", this.handle);
    }
    profile(i) {
      return call("catalogProfile", this.handle, i);
    }
    profile_config(i) {
      return call("catalogProfileConfig", this.handle, i);
    }
    reconcile(request) {
      return call("catalogReconcile", this.handle, request);
    }
    preflight_target(request, maxTools) {
      return call("catalogTarget", this.handle, request, maxTools);
    }
    slicing_choices(request) {
      return call("catalogSlicingChoices", this.handle, request);
    }
    slicing_select(request) {
      return call("catalogSlicingSelect", this.handle, request);
    }
    slicing_select_by_names(request) {
      return call("catalogSlicingSelectByNames", this.handle, request);
    }
    slicing_default(request) {
      return call("catalogSlicingDefault", this.handle, request);
    }
    slicing_configuration(request) {
      return call("catalogSlicingConfiguration", this.handle, request, zone, profile);
    }
  }
  // The upload handle consumed by a native call that closes it itself.
  const spent = (upload) => {
    const id = upload.handle;
    upload.handle = 0;
    return id;
  };
  class PresetLibrary extends Handle {
    static create(upload, stored, limits, collator) {
      return consumed(upload, (id) => {
        call(
          "libraryCreate",
          id,
          stored ?? null,
          Array.from(limits),
          collator,
          zone,
          profile,
        );
        return new PresetLibrary(id);
      });
    }
    apply(operation) {
      return call("libraryApply", this.handle, operation);
    }
    import_bundle(bundle, limits) {
      return call("libraryImport", this.handle, bundle, Array.from(limits));
    }
    issue_count() {
      return call("libraryIssueCount", this.handle);
    }
    issue(i) {
      return call("libraryIssue", this.handle, i);
    }
    export_bundle(exportedAt, maxBytes) {
      return call("libraryExport", this.handle, exportedAt, maxBytes);
    }
    state(maxBytes) {
      return call("libraryState", this.handle, maxBytes);
    }
    view() {
      return call("libraryView", this.handle);
    }
    custom_preset(i) {
      return call("libraryCustomPreset", this.handle, i);
    }
    inventory() {
      return call("libraryInventory", this.handle);
    }
    bases(request) {
      return call("libraryBases", this.handle, request);
    }
    catalog() {
      return wrap(ProfileCatalog, call("libraryCatalog", this.handle));
    }
    plan_update(next) {
      return call("libraryPlanUpdate", this.handle, spent(next));
    }
    apply_update(next) {
      return call("libraryApplyUpdate", this.handle, spent(next));
    }
  }
  class SettingsEditor extends Handle {
    // A handle number wraps an editor opened on a project node.
    constructor(create, collator, folder) {
      super(
        typeof create === "number"
          ? create
          : call("editorNew", create, collator, folder),
      );
    }
    query(query) {
      return call("editorQuery", this.handle, query);
    }
    field(i) {
      return call("editorField", this.handle, i);
    }
    state(field) {
      return call("editorState", this.handle, field);
    }
    compare(field) {
      return call("editorCompare", this.handle, field);
    }
    edit(edit) {
      return call("editorEdit", this.handle, edit);
    }
    commit() {
      return call("editorCommit", this.handle);
    }
    revision() {
      return call("editorRevision", this.handle);
    }
    overrides() {
      return call("editorOverrides", this.handle);
    }
    rows(rows) {
      return call("editorRows", this.handle, rows);
    }
    unavailable() {
      return call("editorUnavailable", this.handle);
    }
    row(i) {
      return call("editorRow", this.handle, i);
    }
    intent() {
      return call("editorIntent", this.handle);
    }
  }
  class PrintJobStatus extends Handle {
    constructor() {
      super(call("printJobStatusNew"));
    }
    apply_query(text, nowMs) {
      return call("printJobStatusQuery", this.handle, text, nowMs);
    }
    apply_notification(text, nowMs) {
      return call("printJobStatusNotify", this.handle, text, nowMs);
    }
    reset() {
      return call("printJobStatusReset", this.handle);
    }
    snapshot() {
      return call("printJobStatusSnapshot", this.handle);
    }
  }
  class HoldToConfirm extends Handle {
    constructor() {
      super(call("holdNew"));
    }
    press(action, nowMs) {
      return call("holdPress", this.handle, action, nowMs);
    }
    poll(nowMs) {
      return call("holdPoll", this.handle, nowMs);
    }
    release(nowMs) {
      return call("holdRelease", this.handle, nowMs);
    }
    cancel() {
      return call("holdCancel", this.handle);
    }
  }
  class PrintWorkflow extends Handle {
    constructor() {
      super(call("printWorkflowNew"));
    }
    busy() {
      return call("printWorkflowBusy", this.handle);
    }
    run(intent) {
      return call("printWorkflowRun", this.handle, intent);
    }
    start_stored(path) {
      return call("printWorkflowStartStored", this.handle, path);
    }
    resolve(id, outcome) {
      return call("printWorkflowResolve", this.handle, id, outcome);
    }
    resolve_reply(id, text) {
      return call("printWorkflowReply", this.handle, id, text);
    }
    cancel() {
      return call("printWorkflowCancel", this.handle);
    }
    dispose() {
      return call("printWorkflowDispose", this.handle);
    }
  }
  class PrinterSession extends Handle {
    constructor() {
      super(call("printerSessionNew"));
    }
    select(selection) {
      return call("printerSessionSelect", this.handle, selection);
    }
    clear() {
      return call("printerSessionClear", this.handle);
    }
    dispose() {
      return call("printerSessionDispose", this.handle);
    }
    connect() {
      return call("printerSessionConnect", this.handle);
    }
    refresh() {
      return call("printerSessionRefresh", this.handle);
    }
    execute(request) {
      return call("printerSessionExecute", this.handle, request);
    }
    transport_state(transport, signal) {
      return call("printerSessionState", this.handle, transport, signal);
    }
    notification(transport, method, params, nowMs) {
      return call("printerSessionNotification", this.handle, transport, method, params, nowMs);
    }
    resolve(id, outcome) {
      return call("printerSessionResolve", this.handle, id, outcome);
    }
    resolve_reply(id, text, nowMs) {
      return call("printerSessionReply", this.handle, id, text, nowMs);
    }
    view() {
      return call("printerSessionView", this.handle);
    }
    capture_intent(command) {
      return call("printerSessionCaptureIntent", this.handle, command);
    }
    confirm(intent) {
      return call("printerSessionConfirm", this.handle, intent);
    }
    capture_lease() {
      return call("printerSessionCaptureLease", this.handle);
    }
    lease_current(lease) {
      return call("printerSessionLeaseCurrent", this.handle, lease);
    }
  }
  class MoonrakerTransport extends Handle {
    static configure(config) {
      return call("moonrakerTransportConfigure", config);
    }
    static max_text_units() {
      return call("moonrakerTransportTextUnits");
    }
    constructor(config) {
      super(call("moonrakerTransportNew", config));
    }
    take_result(task) {
      return call("moonrakerTransportTakeResult", this.handle, task);
    }
    take_params(id) {
      return call("moonrakerTransportTakeParams", this.handle, id);
    }
    state() {
      return call("moonrakerTransportState", this.handle);
    }
    has_api_key() {
      return call("moonrakerTransportHasApiKey", this.handle);
    }
    has_bearer_token() {
      return call("moonrakerTransportHasBearerToken", this.handle);
    }
    set_credentials(credentials, nowMs) {
      return call("moonrakerTransportCredentials", this.handle, credentials, nowMs);
    }
    clear_credentials(nowMs) {
      call("moonrakerTransportClearCredentials", this.handle, nowMs);
    }
    set_subscription(entries, nowMs) {
      return call("moonrakerTransportSubscription", this.handle, entries, nowMs);
    }
    clear_subscription(nowMs) {
      return call("moonrakerTransportClearSubscription", this.handle, nowMs);
    }
    connect(signal, nowMs) {
      return call("moonrakerTransportConnect", this.handle, signal, nowMs);
    }
    disconnect(reason, nowMs) {
      return call("moonrakerTransportDisconnect", this.handle, reason, nowMs);
    }
    dispose(nowMs) {
      return call("moonrakerTransportDispose", this.handle, nowMs);
    }
    request(request, nowMs) {
      return call("moonrakerTransportRequest", this.handle, request, nowMs);
    }
    upload(request, nowMs) {
      return call("moonrakerTransportUpload", this.handle, request, nowMs);
    }
    download(request, nowMs) {
      return call("moonrakerTransportDownload", this.handle, request, nowMs);
    }
    recovery(request, nowMs) {
      return call("moonrakerTransportRecovery", this.handle, request, nowMs);
    }
    abort(task, nowMs) {
      return call("moonrakerTransportAbort", this.handle, task, nowMs);
    }
    resolve(id, outcome, nowMs) {
      return call("moonrakerTransportResolve", this.handle, id, outcome, nowMs);
    }
    resolve_text(id, text, nowMs) {
      return call("moonrakerTransportText", this.handle, id, text, nowMs);
    }
    socket_open(socket, nowMs) {
      return call("moonrakerTransportSocketOpen", this.handle, socket, nowMs);
    }
    socket_error(socket, nowMs) {
      return call("moonrakerTransportSocketError", this.handle, socket, nowMs);
    }
    socket_close(socket, nowMs) {
      return call("moonrakerTransportSocketClose", this.handle, socket, nowMs);
    }
    socket_message(socket, text, nowMs) {
      return call("moonrakerTransportSocketMessage", this.handle, socket, text, nowMs);
    }
    timer(timer, nowMs) {
      return call("moonrakerTransportTimer", this.handle, timer, nowMs);
    }
  }
  class ToolUsageScanner extends Handle {
    constructor() {
      super(call("toolUsageNew"));
    }
    append(bytes) {
      call("toolUsageAppend", this.handle, bytes);
    }
    finish() {
      const id = this.handle;
      this.handle = 0;
      return call("toolUsageFinish", id);
    }
  }
  return {
    PrintJobStatus,
    HoldToConfirm,
    PrintWorkflow,
    PrinterSession,
    MoonrakerTransport,
    ToolUsageScanner,
    filament_slots: (text) => call("filamentSlots", text),
    printer_objects: (text) => call("printerObjects", text),
    server_components: (text) => call("serverComponents", text),
    gcode_commands: (text) => call("gcodeCommands", text),
    print_start_options: (request) => call("printStartOptions", request),
    moonraker_endpoint: (request) => call("moonrakerEndpoint", request),
    moonraker_path: (request) => call("moonrakerPath", request),
    moonraker_credentials: (request) => call("moonrakerCredentials", request),
    moonraker_error_response: (request) => call("moonrakerErrorResponse", request),
    moonraker_handshake: (request) => call("moonrakerHandshake", request),
    moonraker_reconnect_policy: (request) => call("moonrakerReconnectPolicy", request),
    moonraker_reconnect_delay: (request) => call("moonrakerReconnectDelay", request),
    moonraker_subscription: (request) => call("moonrakerSubscription", request),
    moonraker_method_check: (request) => call("moonrakerMethodCheck", request),
    printer_storage_plan: (operation) => call("printerStoragePlan", operation),
    printer_storage_finish: (request) => call("printerStorageFinish", request),
    printer_storage_read: (operation, reply) => call("printerStorageRead", operation, reply),
    printer_storage_size: (bytes) => call("printerStorageSize", bytes),
    external_slicer_endpoint: (request) => call("externalSlicerEndpoint", request),
    external_slicer_attestation_plan: (request) => call("externalSlicerAttestationPlan", request),
    external_slicer_attestation: (reply) => call("externalSlicerAttestation", reply),
    external_slicer_submit_plan: (request) => call("externalSlicerSubmitPlan", request),
    external_slicer_job_plan: (request) => call("externalSlicerJobPlan", request),
    external_slicer_submission: (read) => call("externalSlicerSubmission", read),
    external_slicer_poll: (read) => call("externalSlicerPoll", read),
    external_slicer_cancel: (read) => call("externalSlicerCancel", read),
    external_slicer_artifact: (read) => call("externalSlicerArtifact", read),
    external_slicer_supports: (engine, feature) => call("externalSlicerSupports", engine, feature),
    plate_projection: (state, plateId, omitted) => call("plateProjection", state, plateId, omitted, zone, profile),
    plate_print_overrides: (state, plateId) => call("platePrintOverridesJson", state, plateId),
    slicing_match: (request) => call("slicingMatch", request),
    workspace_bed: (request) => call("workspaceBed", request),
    transform_fields: (request) => call("transformFields", request),
    transform_field_edit: (request) => call("transformFieldEdit", request),
    transform_rotation: (request) => call("transformRotation", request),
    primitive_payload: (request) => call("primitivePayload", request),
    slicing_next_state: (request, words) => call("slicingNextState", request, Array.from(words), zone, profile),
    print_history_plan: (operation) => call("printHistoryPlan", operation),
    print_history_finish: (request) => call("printHistoryFinish", request),
    print_history_read: (operation, reply) => call("printHistoryRead", operation, reply),
    print_history_duration: (seconds) => call("printHistoryDuration", seconds),
    print_history_filament: (millimetres) => call("printHistoryFilament", millimetres),
    print_history_job_view: (job) => call("printHistoryJobView", job),
    print_history_totals_text: (totals) => call("printHistoryTotalsText", totals),
    print_history_page_view: (shape) => call("printHistoryPageView", shape),
    console_assess: (request) => call("consoleAssess", request),
    console_plan: (operation) => call("consolePlan", operation),
    console_finish: (request) => call("consoleFinish", request),
    console_read: (operation, reply) => call("consoleRead", operation, reply),
    console_invocation: (request) => call("consoleInvocation", request),
    console_line: (request) => call("consoleLine", request),
    console_notification: (request, params) => call("consoleNotification", request, params),
    console_recent: (request) => call("consoleRecent", request),
    camera_list_plan: () => call("cameraListPlan"),
    camera_list_finish: (request) => call("cameraListFinish", request),
    camera_list_read: (request, reply) => call("cameraListRead", request, reply),
    camera_snapshot_plan: (request) => call("cameraSnapshotPlan", request),
    camera_snapshot_failure: (request) => call("cameraSnapshotFailure", request),
    camera_mechanisms: (request) => call("cameraMechanisms", request),
    camera_describe: (request) => call("cameraDescribe", request),
    camera_poll_interval: (camera) => call("cameraPollInterval", camera),
    camera_frame_url: (request) => call("cameraFrameUrl", request),
    printer_directory_load: (stored) => call("printerDirectoryLoad", stored ?? null),
    printer_directory_save: (directory) => call("printerDirectorySave", directory),
    printer_directory_add: (request) => call("printerDirectoryAdd", request),
    printer_directory_update: (request) => call("printerDirectoryUpdate", request),
    printer_directory_remove: (request) => call("printerDirectoryRemove", request),
    printer_directory_set_default: (request) => call("printerDirectorySetDefault", request),
    printer_directory_adopt: (request) => call("printerDirectoryAdopt", request),
    credentials_load: (stored) => call("credentialsLoad", stored ?? null),
    credentials_save: (record) => call("credentialsSave", record),
    print_preparation_plan: (request) => call("printPreparationPlan", request),
    print_preparation_send: (request) => call("printPreparationSend", request),
    print_readiness: (text) => call("printReadiness", text),
    print_readiness_failure: (request) => call("printReadinessFailure", request),
    sanitize_gcode_filename: (request) => call("sanitizeGcodeFilename", request),
    describe_transport_failure: (request) => call("describeTransportFailure", request),
    print_file_identity: (text, filename) => call("printFileIdentity", text, filename),
    tool_mapping: (request) => call("toolMapping", request),
    print_job_availability: (request) => call("printJobAvailability", request),
    print_job_command_plan: (request) => call("printJobCommandPlan", request),
    print_job_command_failure: (request) => call("printJobCommandFailure", request),
    printer_status_summary: (request) => call("printerStatusSummary", request),
    guarded_printer_actions: (request) => call("guardedPrinterActions", request),
    ProjectUpload,
    ProjectSelectionInput,
    ProjectArchiveUpload,
    ProjectModelUpload,
    ProfileCatalogUpload,
    PresetLibrary,
    SettingsEditor,
    settings_step: (request) => call("settingsStep", request),
    settings_rules: (request) => call("settingsRules", request),
    coerce_override_value: (request) => call("libraryCoerce", request),
    format_override_value: (request) => call("libraryFormat", request),
    measure_features: (request) => call("measureFeatures", request),
    prepare_emboss: (request) => wrap(ProjectEmboss, call("prepareEmboss", request)),
    prepare_svg_part: (request, drawing) =>
      wrap(ProjectSvgPart, call("prepareSvgPart", request, drawing)),
    assembly_availability: (request) => call("assemblyAvailability", request),
    assembly_alignment: (request) => call("assemblyAlignment", request),
    assembly_explosion: (request) => call("assemblyExplosion", request),
  };
}
