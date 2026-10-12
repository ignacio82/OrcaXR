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
    // An export capture's plate projected for an external slicer, as a capture
    // of its own (plateId is JSON text), and a captured project's plate overrides.
    static native long exportPlate(long handle, String plateId, LocalTimestampResolver resolver, int integerMode);
    static native String projectPlateOverrides(long handle, String plateId);
    // The ID plan a duplicatePlate intent of a captured project's plate needs
    // (plateId is JSON text): its object count, each object's volume, instance
    // and layer-range counts, then the plate's custom G-code and thumbnail
    // counts; empty for an unknown plate.
    static native double[] projectPlateShape(long handle, String plateId);
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
    // Slicing configuration from catalog profiles: canonical JSON requests and
    // replies (the browser's CatalogSlicingConfigurationExchange). States and
    // configurations travel as JSON text; words are the random words new
    // FullSpectrum pair identities draw, sixteen each.
    static native String catalogSlicingChoices(long handle, String request);
    static native String catalogSlicingSelect(long handle, String request);
    static native String catalogSlicingSelectByNames(long handle, String request);
    static native String catalogSlicingDefault(long handle, String request);
    static native String catalogSlicingConfiguration(long handle, String request, LocalTimestampResolver resolver, int integerMode);
    static native String slicingMatch(String request);
    static native String slicingNextState(String request, double[] words, LocalTimestampResolver resolver, int integerMode);
    static native String stageSlicingConfiguration(long handle, long catalog, String request, double[] words);
    // Filament slots (the Filament tab's edits on a live choice, and the slots
    // a captured project's physical filaments describe) and filament
    // assignment over a captured project: canonical JSON requests and replies
    // (the browser's CatalogSlicingConfigurationExchange and
    // FilamentAssignmentExchange).
    static native String catalogSlicingSlots(long handle, String request);
    static native String projectFilamentSlots(long handle, String request);
    static native String projectFilamentAssignment(long handle, String request);
    static native String projectFilamentAssignmentChanges(long handle, String request);
    // The virtual filament library (the browser's VirtualFilamentExchange):
    // the library a captured project shows and a library edit's step over it;
    // the author dialog's opening fields, validations, triangle picker and
    // pinned Match search over a library document.
    static native String projectVirtualFilamentLibrary(long handle, String request);
    static native String projectVirtualFilamentMutation(long handle, String request);
    static native String virtualFilamentFormDefaults(String request);
    static native String virtualFilamentForm(String request);
    static native String virtualFilamentTriangle(String request);
    static native String virtualFilamentMatchSearch(String request);
    // The workspace's bed (a configuration's, or a captured project's for one
    // plate) and the transform inspector's fields: canonical JSON requests and
    // replies (the browser's WorkspaceBedExchange and TransformFieldsExchange).
    static native String workspaceBed(String request);
    static native String projectWorkspaceBed(long handle, String request);
    // What a split of a captured project would split (orcaxr_project::split::source,
    // the browser's SplitSourceExchange): canonical JSON request and reply.
    static native String projectSplitSource(long handle, String request);
    // A slice's outputs (orcaxr_project::slicing::{thumbnails, plate}, the
    // browser's GcodeThumbnailsExchange, PlateThumbnailExchange and
    // SlicePlanExchange): canonical JSON requests and replies; which plates a
    // captured project's slice slices; and an export capture's pictures,
    // drawn from its plate by the shared core (orcaxr_archive::thumbnail).
    static native String sliceThumbnailList(String request);
    static native String sliceThumbnailBlock(String request);
    static native String sliceThumbnailInject(String request);
    static native String sliceThumbnailView(String request);
    static native String slicePlan(String request);
    static native String projectSlicePlan(long handle, String scope);
    static native String exportThumbnails(long handle);
    // What binds a slice's output (orcaxr_project::slicing::sidecar, the
    // browser's SliceSidecarExchange): a plate's profile snapshot (of a state
    // document, or of a captured project with plateId as JSON text), an output
    // binding checked, this device's route, and the sidecar assembled.
    static native String sliceProfiles(String request);
    static native String projectSliceProfiles(long handle, String plateId);
    static native String sliceBinding(String request);
    static native String sliceNativeRoute(String request);
    static native String sliceSidecar(String request);
    static native String transformFields(String request);
    static native String transformFieldEdit(String request);
    static native String transformRotation(String request);
    // The transform gizmo (three's TransformControls): attach to a proxy pose,
    // step one pointer event, present the handles, the baked handle geometry,
    // and the instance transforms a drag submits, as canonical JSON.
    static native String transformGizmoAttach(String request);
    static native String transformGizmoStep(String request);
    static native String transformGizmoPresent(String request);
    static native String transformGizmoGeometry();
    static native String transformGizmoChanges(String request);
    // Where the gizmo's proxy stands for a selection, and the origins a drag
    // captures, in a session's project.
    static native String sessionTransformProxy(long handle, String request);
    // How the shells arrange catalogue actions (orcaxr_project::action_presentation,
    // the browser's ActionPresentationExchange): the command palette's search and a
    // context menu's sections or the model toolbar's runs, as canonical JSON.
    static native String commandPalette(String request);
    static native String actionGroups(String request);
    // New geometry (orcaxr_project::primitives): a primitive's or the helper
    // cube's mesh payload, and what a primitive or a helper volume becomes in
    // a session's project, as canonical JSON.
    static native byte[] primitivePayload(String request);
    static native String sessionPrimitiveObject(long handle, String request);
    static native String sessionHelperVolume(long handle, String request);
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
    // The generated settings panel over an editor (settings::editor::panel_exchange,
    // the browser's settingsPanelExchange) and the scoped panel's words for a
    // target: canonical JSON requests and replies.
    static native String editorPanelView(long handle, String request);
    static native String editorPanelRow(long handle, String request);
    static native String editorPanelEdit(long handle, String request);
    static native String editorPanelState(long handle);
    static native String editorPanelApply(long handle);
    static native void editorPanelCancel(long handle);
    static native String settingsTargetText(String request);
    // The semantic editor's height ranges (orcaxr_project::layer_range_editor,
    // the browser's layerRangeEditorExchange): canonical JSON requests and replies.
    static native String projectLayerRangeEditor(long handle, String request);
    static native String layerRangeBounds(String request);
    static native String layerRangeSplit(String request);
    static native String layerRangeMessages(String request);
    // The semantic editor's volume roles (orcaxr_project::volume_role_editor,
    // the browser's volumeRoleEditorExchange): a captured project's role choices
    // for one part and the conversion command's decision, and a conversion's words.
    static native String projectVolumeRoleEditor(long handle, String request);
    static native String projectVolumeRoleDecision(long handle, String request);
    static native String volumeRoleMessages(String request);
    static native String projectPaintPalette(long handle, String request);
    static native String projectObjectTree(long handle, String request, SearchFolding folder);
    static native long printJobStatusNew();
    static native String printJobStatusQuery(long handle, String text, double nowMs);
    static native String printJobStatusNotify(long handle, String text, double nowMs);
    static native String printJobStatusReset(long handle);
    static native String printJobStatusSnapshot(long handle);
    static native String printJobAvailability(String request);
    static native String printJobCommandPlan(String request);
    static native String printJobCommandFailure(String request);
    static native String printerStatusSummary(String request);
    static native String guardedPrinterActions(String request);
    static native long holdNew();
    static native String holdPress(long handle, String action, double nowMs);
    static native String holdPoll(long handle, double nowMs);
    static native String holdRelease(long handle, double nowMs);
    static native String holdCancel(long handle);
    static native String filamentSlots(String text);
    static native String toolMapping(String request);
    static native long toolUsageNew();
    static native void toolUsageAppend(long handle, byte[] bytes);
    static native String toolUsageFinish(long handle);
    static native String printerObjects(String text);
    static native String serverComponents(String text);
    static native String gcodeCommands(String text);
    static native String printStartOptions(String request);
    static native String printPreparationPlan(String request);
    static native String printPreparationSend(String request);
    static native String printReadiness(String text);
    static native String printReadinessFailure(String request);
    static native String sanitizeGcodeFilename(String request);
    static native String describeTransportFailure(String request);
    static native String printFileIdentity(String text, String filename);
    // The print submission workflow: each call answers a PrintWorkflowStep.
    static native long printWorkflowNew();
    static native boolean printWorkflowBusy(long handle);
    static native String printWorkflowRun(long handle, String intent);
    static native String printWorkflowStartStored(long handle, String path);
    static native String printWorkflowResolve(long handle, long id, String outcome);
    static native String printWorkflowReply(long handle, long id, String text);
    static native String printWorkflowCancel(long handle);
    static native String printWorkflowDispose(long handle);
    // The printer session: stepping calls answer a PrinterSessionStep.
    static native long printerSessionNew();
    static native String printerSessionSelect(long handle, String selection);
    static native String printerSessionClear(long handle);
    static native String printerSessionDispose(long handle);
    static native String printerSessionConnect(long handle);
    static native String printerSessionRefresh(long handle);
    static native String printerSessionExecute(long handle, String request);
    static native String printerSessionState(long handle, long transport, String signal);
    static native String printerSessionNotification(long handle, long transport, String method, String params, double nowMs);
    static native String printerSessionResolve(long handle, long id, String outcome);
    static native String printerSessionReply(long handle, long id, String text, double nowMs);
    static native String printerSessionView(long handle);
    static native String printerSessionCaptureIntent(long handle, String command);
    static native String printerSessionConfirm(long handle, long intent);
    static native String printerSessionCaptureLease(long handle);
    static native boolean printerSessionLeaseCurrent(long handle, String lease);
    // The Moonraker transport: stepping calls answer a MoonrakerTransportStep.
    static native String moonrakerTransportConfigure(String config);
    static native long moonrakerTransportNew(String config);
    static native long moonrakerTransportTextUnits();
    static native String moonrakerTransportTakeResult(long handle, long task);
    static native String moonrakerTransportTakeParams(long handle, long notification);
    static native String moonrakerTransportState(long handle);
    static native boolean moonrakerTransportHasApiKey(long handle);
    static native boolean moonrakerTransportHasBearerToken(long handle);
    static native String moonrakerTransportCredentials(long handle, String credentials, double nowMs);
    static native void moonrakerTransportClearCredentials(long handle, double nowMs);
    static native String moonrakerTransportSubscription(long handle, String entries, double nowMs);
    static native String moonrakerTransportClearSubscription(long handle, double nowMs);
    static native String moonrakerTransportConnect(long handle, String signal, double nowMs);
    static native String moonrakerTransportDisconnect(long handle, String reason, double nowMs);
    static native String moonrakerTransportDispose(long handle, double nowMs);
    static native String moonrakerTransportRequest(long handle, String request, double nowMs);
    static native String moonrakerTransportUpload(long handle, String request, double nowMs);
    static native String moonrakerTransportDownload(long handle, String request, double nowMs);
    static native String moonrakerTransportRecovery(long handle, String request, double nowMs);
    static native String moonrakerTransportAbort(long handle, long task, double nowMs);
    static native String moonrakerTransportResolve(long handle, long id, String outcome, double nowMs);
    static native String moonrakerTransportText(long handle, long id, String text, double nowMs);
    static native String moonrakerTransportSocketOpen(long handle, long socket, double nowMs);
    static native String moonrakerTransportSocketError(long handle, long socket, double nowMs);
    static native String moonrakerTransportSocketClose(long handle, long socket, double nowMs);
    static native String moonrakerTransportSocketMessage(long handle, long socket, String text, double nowMs);
    static native String moonrakerTransportTimer(long handle, long timer, double nowMs);
    // Moonraker transport policy: each request answers its reply.
    static native String moonrakerEndpoint(String request);
    static native String moonrakerPath(String request);
    static native String moonrakerCredentials(String request);
    static native String moonrakerErrorResponse(String request);
    static native String moonrakerHandshake(String request);
    static native String moonrakerReconnectPolicy(String request);
    static native double moonrakerReconnectDelay(String request);
    static native String moonrakerSubscription(String request);
    static native String moonrakerMethodCheck(String request);
    // Printer storage: an operation's request or refusal, the result its
    // exchange reads as, a listing or metadata reply read, and a size shown.
    static native String printerStoragePlan(String operation);
    static native String printerStorageFinish(String request);
    static native String printerStorageRead(String operation, String reply);
    static native String printerStorageSize(double bytes);
    // Print history: a page's or the totals' request or refusal, the result
    // its exchange reads as, a reply read, and what a panel shows.
    static native String printHistoryPlan(String operation);
    static native String printHistoryFinish(String request);
    static native String printHistoryRead(String operation, String reply);
    static native String printHistoryDuration(double seconds);
    static native String printHistoryFilament(double millimetres);
    static native String printHistoryJobView(String job);
    static native String printHistoryTotalsText(String totals);
    static native String printHistoryPageView(String shape);
    // Printer console: a script assessed, a send's or macro listing's request
    // or refusal, its result, a macro invocation, and transcript lines.
    static native String consoleAssess(String request);
    static native String consolePlan(String operation);
    static native String consoleFinish(String request);
    static native String consoleRead(String operation, String reply);
    static native String consoleInvocation(String request);
    static native String consoleLine(String request);
    static native String consoleNotification(String request, String params);
    static native String consoleRecent(String request);
    // Printer cameras: the listing's request, result and reply read, a
    // frame's route and failure, the routes worth trying, the description,
    // the poll interval and a frame URL.
    static native String cameraListPlan();
    static native String cameraListFinish(String request);
    static native String cameraListRead(String request, String reply);
    static native String cameraSnapshotPlan(String request);
    static native String cameraSnapshotFailure(String request);
    static native String cameraMechanisms(String request);
    static native String cameraDescribe(String request);
    static native double cameraPollInterval(String camera);
    static native String cameraFrameUrl(String request);
    // Printer directory: the stored text read (null: nothing stored) and
    // written, and each edit's directory or refusal.
    static native String printerDirectoryLoad(String stored);
    static native String printerDirectorySave(String directory);
    static native String printerDirectoryAdd(String request);
    static native String printerDirectoryUpdate(String request);
    static native String printerDirectoryRemove(String request);
    static native String printerDirectorySetDefault(String request);
    static native String printerDirectoryAdopt(String request);
    // Remembered credentials: the stored text read (null: nothing stored),
    // and a record's text to store (null: remove what is stored).
    static native String credentialsLoad(String stored);
    static native String credentialsSave(String record);
    // External slicer: a captured endpoint made canonical, what attesting and
    // submitting to it and each job step send, and how an attestation, a
    // submission, a poll, a cancellation and a streamed artifact read.
    static native String externalSlicerEndpoint(String request);
    static native String externalSlicerAttestationPlan(String request);
    static native String externalSlicerAttestation(String reply);
    static native String externalSlicerSubmitPlan(String request);
    static native String externalSlicerJobPlan(String request);
    static native String externalSlicerSubmission(String read);
    static native String externalSlicerPoll(String read);
    static native String externalSlicerCancel(String read);
    static native String externalSlicerArtifact(String read);
    static native String externalSlicerDownload(String read);
    static native String externalSlicerRoute(String request);
    static native boolean externalSlicerSupports(String engine, String feature);
    // One plate for an external slicer: a state document's plate projected and
    // its print overrides (IDs as JSON text, answers canonical JSON).
    static native String plateProjection(String state, String plateId, String omitted, LocalTimestampResolver resolver, int integerMode);
    static native String platePrintOverridesJson(String state, String plateId);
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
    // Paint facets: a volume channel's canonical facets or a stroke's live
    // preview, then its summary (with each state's colour), 12-byte runs of
    // whole facets and 44-byte leaves of subdivided ones.
    static native long sessionPaintFacets(long handle, String request);
    static native long paintStrokePreviewFacets(long handle);
    static native String paintFacetsSummary(long handle);
    static native byte[] paintFacetsRuns(long handle, long start, long count);
    static native byte[] paintFacetsLeaves(long handle, long start, long count);
    // The painter (orcaxr_project::facets::paint_tool): the sample a hit makes
    // with the paint tool's settings, alone or on a stroke, and the colours a
    // filament library paints states in, as canonical JSON.
    static native String paintToolSample(String request);
    static native String paintStrokeSampleWith(long handle, String request);
    static native String paintFacetColors(String request);
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
    // A copy of one instance on a current guard (both IDs are JSON text),
    // staged as the browser's clone: one "Create instance" for executeStaged.
    static native long stageInstanceCopy(long handle, long guard, String sourceInstanceId, String instanceId);
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
    // Assembly: the alignments two picked features allow, the transform one
    // produces, and view-only exploded offsets.
    static native String assemblyAvailability(String request);
    static native String assemblyAlignment(String request);
    static native String assemblyExplosion(String request);
    // Brim ears: an object's first-layer corners and its stranded ears.
    static native String sessionBrimEarDetect(long handle, String request);
    static native String sessionBrimEarStranded(long handle, String request);
    static native String sessionBrimEarView(long handle, String request);
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
    static native byte[] projectFresh(long handle, double[] words, String now);
    static native byte[] projectEmpty(double[] words, String now);
    static native char[] documentIdentity(long handle);
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
