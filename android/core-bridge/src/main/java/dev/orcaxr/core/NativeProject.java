package dev.orcaxr.core;

/** Trusted JNI adapter. All handles have explicit, nonreused lifetimes. */
final class NativeProject {
    static { System.loadLibrary("orcaxr_android"); }
    private NativeProject() {}
    static native long uploadNew(int version, long documentBytes, double[] options, LocalTimestampResolver resolver, int integerMode);
    static native void uploadAppendDocument(long handle, long offset, byte[] bytes);
    static native void uploadSealDocument(long handle);
    static native long uploadAssetCount(long handle);
    static native long uploadBeginAsset(long handle, long position);
    static native void uploadAppendAsset(long handle, long offset, byte[] bytes);
    static native void uploadFinishAsset(long handle);
    static native void uploadCancelAsset(long handle);
    static native void uploadPrepare(long handle);
    static native long beginOpen(long handle);
    static native boolean isOpenCurrent(long handle, long ticket);
    static native boolean cancelOpen(long handle, long ticket);
    static native long finishOpen(long handle, long ticket, long document);
    static native long resetDocument(long handle, long guard, long document);
    static native void uploadOpen(long handle, long[] generation);
    static native long submit(long handle, String request);
    static native long runNext(long handle);
    static native long pendingCount(long handle);
    static native void dispose(long handle);
    static native boolean isDisposed(long handle);
    static native long snapshot(long handle);
    static native long captureExport(long handle, long guard);
    static native long exportProject(long handle);
    static native long exportAssetCount(long handle);
    static native long exportAsset(long handle, long position);
    // Archive Open stages exact bytes; prepare consumes the upload in place and
    // the slot then holds the completed import. Closing cancels native work.
    static native long archiveUploadNew(int version, long archiveBytes, double[] options, LocalTimestampResolver resolver, int integerMode);
    static native void archiveUploadAppend(long handle, long offset, byte[] bytes);
    static native void archiveUploadPrepare(long handle);
    static native int archiveFormat(long handle);
    // Consumes the import in place; the slot then holds the prepared document.
    static native void archiveDocument(long handle);
    // Archive Save packages an immutable export capture into an owned output.
    static native long exportArchive(long handle, int version, double[] options);
    static native long archiveLength(long handle);
    static native byte[] archiveRead(long handle, long start, long count);
    // Live slice preflight of an export capture from a contract PreflightRequest;
    // closing the capture cancels it. Replies are contract JSON, one item each.
    static native long exportPreflight(long handle, String request);
    static native String preflightSummary(long handle);
    static native String preflightIssue(long handle, long position);
    static native String preflightOmission(long handle, long position);
    static native String preflightInstance(long handle, long position);
    static native String preflightFilament(long handle, long position);
    // Profile catalog: stream catalog JSON under explicit limits (bytes, nodes,
    // text units, number bytes, depth); building consumes the upload in place.
    // A null collator uses the core's exact ASCII root order.
    static native long catalogUploadNew(long bytes, double[] limits);
    static native void catalogUploadAppend(long handle, long offset, byte[] bytes);
    static native void catalogBuild(long handle, PresetCollator collator);
    static native long catalogDiagnosticCount(long handle);
    static native String catalogDiagnostic(long handle, long position);
    static native long catalogPresetCount(long handle);
    static native String catalogPreset(long handle, long position);
    static native long catalogProfileCount(long handle);
    static native String catalogProfile(long handle, long position);
    static native String catalogProfileConfig(long handle, long position);
    static native String catalogReconcile(long handle, String request);
    static native String catalogTarget(long handle, String request, long maxTools);
    static native void libraryCreate(long handle, byte[] stored, double[] limits, PresetCollator collator, LocalTimestampResolver resolver, int integerMode);
    static native String libraryApply(long handle, String operation);
    static native String libraryImport(long handle, byte[] bundle, double[] limits);
    static native long libraryIssueCount(long handle);
    static native String libraryIssue(long handle, long position);
    static native byte[] libraryExport(long handle, String exportedAt, long maxBytes);
    static native byte[] libraryState(long handle, long maxBytes);
    static native String libraryView(long handle);
    static native String libraryCustomPreset(long handle, long position);
    static native String libraryInventory(long handle);
    static native String libraryBases(long handle, String request);
    static native long libraryCatalog(long handle);
    static native String libraryPlanUpdate(long handle, long upload);
    static native String libraryApplyUpdate(long handle, long upload);
    static native String libraryCoerce(String request);
    static native String libraryFormat(String request);
    static native long editorNew(String create, PresetCollator collator, SearchFolding folder);
    static native long editorQuery(long handle, String query);
    static native String editorField(long handle, long position);
    static native String editorState(long handle, String field);
    static native String editorCompare(long handle, String field);
    static native String editorEdit(long handle, String edit);
    static native String editorCommit(long handle);
    static native long editorRevision(long handle);
    static native String editorOverrides(long handle);
    static native long editorRows(long handle, String rows);
    static native long editorUnavailable(long handle);
    static native String editorRow(long handle, long position);
    static native String settingsStep(String step);
    static native String settingsRules(String rules);
    static native String projectSettingsTargets(long handle, String request);
    static native String projectSettingsSnapshot(long handle, String request);
    static native String projectSettingsExplain(long handle, String request);
    static native long projectSettingsEditor(long handle, String request, PresetCollator collator, SearchFolding folder);
    static native String editorIntent(long handle);
    static native String projectPaintPalette(long handle, String request);
    // Capabilities: a CapabilityRequest against a session's current state.
    static native String sessionCapabilities(long handle, String request);
    // Render deltas: a RenderRequest against the session's acknowledged state.
    static native String sessionRender(long handle, String request);
    // Facet regions: a FacetRegionRequest against a session's acknowledged state.
    static native String sessionFacetRegion(long handle, String request);
    // Paint strokes: open on a current guard, sample and page the overlay off
    // the session, then stage the one commit (0 when nothing was touched).
    static native long paintStrokeOpen(long handle, long guard, String request);
    static native String paintStrokeSample(long handle, String request);
    static native String paintStrokeOverlay(long handle, String request);
    static native long stagePaintStroke(long handle, long stroke, char[] label);
    // Paint overlays: a volume channel's canonical overlay or a stroke's live
    // preview, then its summary and 40-byte facet packets.
    static native long sessionPaintOverlay(long handle, String request);
    static native long paintStrokePreview(long handle);
    static native String paintOverlaySummary(long handle);
    static native byte[] paintOverlayPacket(long handle, long start, long count);
    // Picking: one plate captured for picking, then printer-space rays.
    static native long sessionPickScene(long handle, String request);
    static native String pickScenePick(long handle, String ray);
    // Placement: the transforms a mirror/reset/centre/fit/lay-flat/drop edit submits.
    static native String sessionPlacement(long handle, String request);
    // Arrangement and bed fill: one plate's layout, and copies in its free space.
    static native String sessionArrangement(long handle, String request);
    static native String sessionBedFill(long handle, String request);
    // Wipe tower: the plate's tower auto-placed against its printable parts.
    static native String sessionWipeTower(long handle, String request);
    // Volume splits: prepare one volume's components on a current guard, read
    // the parts or refusal, then stage them under host IDs as parts or objects.
    static native long volumeSplit(long handle, long guard, String request);
    static native String volumeSplitReply(long handle);
    static native long stageVolumeSplit(long handle, long split, String request);
    // Simplification: decimate one volume's mesh on a current guard, read the
    // summary or refusal and page the result's bytes, then stage it under a
    // host asset ID.
    static native long volumeSimplify(long handle, long guard, String request);
    static native String volumeSimplifyReply(long handle);
    static native byte[] volumeSimplifyMesh(long handle, long start, long count);
    static native long stageVolumeSimplify(long handle, long simplify, String request);
    // Measurement: capture one volume's features, resolve picks off the
    // session, and measure any two features.
    // Mesh renderer packets: one asset's display geometry, chunked to the
    // host's vertex limit; read the reply, then page the table and chunks.
    static native long sessionMeshPacket(long handle, String request);
    static native String meshPacketReply(long handle);
    static native byte[] meshPacketBytes(long handle, long start, long count);
    static native long sessionMeasureVolume(long handle, String request);
    static native String measureVolumeReply(long handle);
    static native String measureVolumeFeature(long handle, String request);
    static native String measureFeatures(String request);
    // Brim ears: an object's first-layer corners and its stranded ears.
    static native String sessionBrimEarDetect(long handle, String request);
    static native String sessionBrimEarStranded(long handle, String request);
    // Emboss: cut a recipe with the host's glyph outlines, read the summary
    // or refusal and page the mesh, then stage it as a text part or re-cut.
    static native long prepareEmboss(String request);
    static native String embossReply(long handle);
    static native byte[] embossMesh(long handle, long start, long count);
    static native long stageEmboss(long handle, long emboss, String request);
    // SVG parts: cut a drawing's file bytes with a recipe, read the summary or
    // refusal and page the mesh, then stage it as a new part or a re-cut.
    static native long prepareSvgPart(String request, byte[] drawing);
    static native String svgPartReply(long handle);
    static native byte[] svgPartMesh(long handle, long start, long count);
    static native long stageSvgPart(long handle, long svg, String request);
    // Model import: stage source bytes (-1 for open-ended), capture the base on
    // the authority, prepare the browser's preview privately (consuming the
    // upload in place), then commit with a JSON array of acknowledged notice IDs.
    static native long modelUploadNew(int version, long modelBytes, double[] options, LocalTimestampResolver resolver, int integerMode);
    static native void modelUploadAppend(long handle, long offset, byte[] bytes);
    static native long importBase(long handle);
    static native void importPrepareModel(long handle, long base, char[] filename, char[] importedAt, double[] bed, boolean dropToBed, long[] idSeed, String idNamespace);
    static native long importPreviewLength(long handle);
    static native byte[] importPreviewRead(long handle, long start, long count);
    static native boolean importPreviewBlocked(long handle);
    // A refused confirmation keeps the candidate; success consumes it.
    static native long commitImport(long handle, long preview, String acknowledged);
    // Import or output warnings: the browser's sorted, unique UTF-16 texts.
    static native long archiveWarningCount(long handle);
    static native long archiveWarningLength(long handle, long position);
    static native char[] archiveWarning(long handle, long position, long start, long count);
    static native long selection(long handle);
    static native long history(long handle);
    static native long historyRevision(long handle);
    static native String assetFingerprint(long handle);
    static native long asset(long handle, long position);
    static native long captureGuard(long handle);
    static native void configureStaging(long handle, int version, double[] options);
    static native double[] stagingUsage(long handle);
    static native long commandUploadNew(long handle, long guard, int version, long bytes, double[] options);
    static native long captureClipboard(long handle, long guard, long node, int version, double[] options);
    static native long clipboardInputNew(long handle, long guard, int version, double[] options);
    static native void clipboardInputCapture(long handle, long node);
    static native double[] clipboardInfo(long handle);
    static native long clipboardUploadNew(long handle, long guard, long clipboard, int version, long bytes, double[] options);
    static native void commandUploadAppend(long handle, long offset, byte[] bytes);
    static native void commandUploadSeal(long handle);
    static native long commandUploadUnits(long handle);
    static native long commandUploadCount(long handle);
    static native long commandUploadAssetBytes(long handle);
    static native long commandUploadAssetCount(long handle);
    static native long commandUploadBeginAsset(long handle, long position);
    static native void commandUploadAppendAsset(long handle, long offset, byte[] bytes);
    static native void commandUploadFinishAsset(long handle);
    static native void commandUploadCancelAsset(long handle);
    static native long stageCommands(long handle, long input);
    static native boolean releaseStaged(long handle, long id);
    static native boolean isCurrent(long handle, long guard, boolean export);
    static native long acknowledgeCheckpoint(long handle, long guard);
    static native long select(long handle, long guard, long input, long primary);
    static native long selectionInputNew();
    static native void selectionInputAdd(long handle, int kind, char[] id);
    static native String replyWire(long handle);
    // Consumes Reply; returned Effects occupies the same slot. Drop the old owner.
    static native long replyEffects(long handle);
    static native long effectsCount(long handle);
    static native int effectKind(long handle, long position);
    static native long effectCapture(long handle, long position, boolean previous);
    static native long effectReasonLength(long handle, long position);
    static native char[] effectReason(long handle, long position, long start, long count);
    static native String effectDirtyCategories(long handle, long position);
    static native long projectRevision(long handle);
    static native String projectHash(long handle);
    static native long projectIdLength(long handle);
    static native char[] projectId(long handle, long start, long count);
    static native long projectExport(long handle, long maxBytes);
    static native long projectWriteJson(long handle, long maxBytes, ProjectJsonSink sink);
    static native long queryRoot(long handle, int version);
    static native long queryProject(long handle);
    static native double[] queryMetadata(long handle);
    static native long queryTextLength(long handle, int field);
    static native char[] queryText(long handle, int field, long start, long count);
    static native long queryChildren(long handle, int relation, long maxSortEntries);
    static native long queryCount(long handle);
    static native long queryNode(long handle, long position);
    static native double[] queryPage(long handle, long start, long count);
    static native long bytesLength(long handle);
    static native byte[] bytesRead(long handle, long start, long count);
    static native long assetLength(long handle);
    static native long assetIdLength(long handle);
    static native char[] assetId(long handle, long start, long count);
    static native String assetDigest(long handle);
    static native byte[] assetRead(long handle, long start, long count);
    static native long assetMetadata(long handle, long maxBytes);
    static native long selectionCount(long handle);
    static native long selectionPrimary(long handle);
    static native int selectionKind(long handle, long position);
    static native long selectionIdLength(long handle, long position);
    static native char[] selectionId(long handle, long position, long start, long count);
    static native long historyCount(long handle, boolean undo);
    static native boolean historyHasLabel(long handle, boolean undo);
    static native long historyLabelLength(long handle, boolean undo);
    static native char[] historyLabel(long handle, boolean undo, long start, long count);
    static native String historyDirtyCategories(long handle);
    static native void close(long handle);
}
