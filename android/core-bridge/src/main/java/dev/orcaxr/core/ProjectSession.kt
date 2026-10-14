package dev.orcaxr.core

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong

/** Shared lifetime rule for native project captures. Calls run on an owned
 * background executor. close() may run concurrently, never waits for work,
 * and discards a late result after releasing any newly returned native handle.
 * An edit racing with close may have committed: never retry that operation. */
abstract class ProjectHandle internal constructor(handle: Long) : AutoCloseable {
    private val handle = AtomicLong(handle.also { require(it > 0) })
    private val gate = Any()
    internal fun reference(): Long = handle.get().also { check(it != 0L) { "closed" } }
    protected fun <T> read(operation: (Long) -> T): T = synchronized(gate) {
        val current = reference()
        val result = operation(current)
        if (handle.get() != current) {
            (result as? AutoCloseable)?.close()
            error("closed")
        }
        result
    }
    /** Move the result's ownership only once the operation succeeds. Retain the
     * old handle while work runs so concurrent close can still invalidate it. */
    internal fun <T> move(operation: (Long) -> T): T = synchronized(gate) {
        val current = reference()
        try {
            val result = operation(current)
            if (!handle.compareAndSet(current, 0)) {
                (result as? AutoCloseable)?.close()
                error("closed")
            }
            result
        } catch (failure: Throwable) {
            if (handle.compareAndSet(current, 0)) NativeProject.close(current)
            throw failure
        }
    }
    override fun close() {
        val current = handle.getAndSet(0)
        if (current != 0L) NativeProject.close(current)
    }
    internal companion object {
        fun <T : ProjectHandle> own(handle: Long, create: (Long) -> T): T = try {
            create(handle)
        } catch (failure: Throwable) {
            if (handle != 0L) NativeProject.close(handle)
            throw failure
        }
    }
}

enum class ProjectIntegerProfile(internal val bits: Int) { CHROMIUM(31), NODE(32) }

/** Staged input is separate from live authority. JSON admission, digest checks
 * and opening are synchronous and belong to an owned import task. */
class ProjectUpload(
    documentBytes: Long,
    options: ProjectHostOptions,
    resolver: LocalTimestampResolver,
    profile: ProjectIntegerProfile,
) : ProjectHandle(NativeProject.uploadNew(ProjectHost.VERSION, documentBytes, options.encode(), resolver, profile.bits)) {
    fun appendDocument(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.uploadAppendDocument(it, offset, bytes)
    }
    fun sealDocument() = read { NativeProject.uploadSealDocument(it) }
    fun assetCount(): Long = read { NativeProject.uploadAssetCount(it) }
    fun beginAsset(position: Long): Long = read { NativeProject.uploadBeginAsset(it, position) }
    fun appendAsset(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.uploadAppendAsset(it, offset, bytes)
    }
    fun finishAsset() = read { NativeProject.uploadFinishAsset(it) }
    fun cancelAsset() = read { NativeProject.uploadCancelAsset(it) }
    /** Consumes this upload and prepares an immutable bundle without publication. */
    fun prepare(): ProjectDocument = move {
        NativeProject.uploadPrepare(it)
        own(it, ::ProjectDocument)
    }
    /** Consumes this upload on success or failure. Production nonces are
     * independent host entropy; explicit nonces support deterministic replay. */
    fun open(generation: LongArray = nonce()): ProjectSession = move {
        require(generation.size == 4 && generation.all { word -> word in 0..0xffffffffL }) { "invalid_generation" }
        NativeProject.uploadOpen(it, generation.copyOf())
        own(it, ::ProjectSession)
    }
    private companion object {
        fun nonce(): LongArray {
            val random = SecureRandom()
            return LongArray(4) { random.nextInt().toLong() and 0xffffffffL }
        }
    }
}

/** Prepared immutable bundle; must be consumed or closed by its import task. */
/** The identities a session guard reports for a project: what a recovery copy is checked against. */
data class ProjectIdentity(val projectId: String, val semanticHash: String, val assetFingerprint: String)

class ProjectDocument internal constructor(handle: Long) : ProjectHandle(handle) {
    /** What a session guard will report once this document is adopted. */
    fun identity(): ProjectIdentity = read {
        val lines = String(NativeProject.documentIdentity(it)).split('\n')
        ProjectIdentity(lines[0], lines[1], lines[2])
    }
}
/** Dropping this ticket invalidates the open; newer tickets supersede older ones. */
class ProjectOpen internal constructor(handle: Long) : ProjectHandle(handle)

class ProjectSession internal constructor(handle: Long) : ProjectHandle(handle) {
    fun beginOpen(): ProjectOpen = read { own(NativeProject.beginOpen(it), ::ProjectOpen) }
    fun isOpenCurrent(ticket: ProjectOpen): Boolean = read { NativeProject.isOpenCurrent(it, ticket.reference()) }
    fun cancelOpen(ticket: ProjectOpen): Boolean = read { NativeProject.cancelOpen(it, ticket.reference()) }
    /** Consume prepared input, then dispatch all effects before acknowledging.
     * A close racing commit can hide a completed replacement; never retry it. */
    fun finishOpen(ticket: ProjectOpen, document: ProjectDocument): ProjectEffects = document.move { input ->
        read { own(NativeProject.finishOpen(it, ticket.reference(), input), ::ProjectEffects) }
    }
    fun resetDocument(guard: ProjectGuard, document: ProjectDocument): ProjectEffects = document.move { input ->
        read { own(NativeProject.resetDocument(it, guard.reference(), input), ::ProjectEffects) }
    }
    fun configureStaging(options: ProjectStagingPoolOptions) = read { NativeProject.configureStaging(it, ProjectStaging.VERSION, options.encode()) }
    fun stagingUsage(): ProjectStagingUsage = read {
        val values = NativeProject.stagingUsage(it)
        check(values.size == 4 && values.all { n -> n.isFinite() && n >= 0 && n <= ProjectHost.MAX_BUDGET && n == n.toLong().toDouble() }) { "invalid_staging_usage" }
        ProjectStagingUsage(values[0].toLong(), values[1].toLong(), values[2].toLong(), values[3].toLong())
    }
    /** Capture the guard before preparation begins. Each upload owns a separate
     * bounded task; closing/disposal makes its eventual admission invalid. */
    fun commandUpload(guard: ProjectGuard, bytes: Long, options: ProjectStagingInputOptions): ProjectCommandUpload = read {
        own(NativeProject.commandUploadNew(it, guard.reference(), ProjectStaging.VERSION, bytes, options.encode()), ::ProjectCommandUpload)
    }
    /** The object query must belong to the current graph revision. Capture is
     * synchronous and belongs to an owned background task. */
    fun captureClipboard(guard: ProjectGuard, objectNode: ProjectQueryNode, options: ProjectStagingClipboardOptions): ProjectClipboard = read {
        own(NativeProject.captureClipboard(it, guard.reference(), objectNode.reference(), ProjectStaging.VERSION, options.encode()), ::ProjectClipboard)
    }
    /** Capture immutable source ownership only. Object/asset traversal belongs to
     * the preparation worker; publication must still recheck the original guard. */
    fun clipboardInput(guard: ProjectGuard, options: ProjectStagingClipboardOptions): ProjectClipboardInput = read {
        own(NativeProject.clipboardInputNew(it, guard.reference(), ProjectStaging.VERSION, options.encode()), ::ProjectClipboardInput)
    }
    /** Each paste captures a fresh destination guard. Source edits do not change
     * this immutable clipboard, and foreign repository ownership is refused. */
    fun clipboardUpload(guard: ProjectGuard, clipboard: ProjectClipboard, bytes: Long, options: ProjectStagingInputOptions): ProjectCommandUpload = read {
        own(NativeProject.clipboardUploadNew(it, guard.reference(), clipboard.reference(), ProjectStaging.VERSION, bytes, options.encode()), ::ProjectCommandUpload)
    }
    /** Consumes input on every outcome. The returned ready input must be closed
     * after submission/failure; closing never cancels or undoes accepted work. */
    fun stageCommands(input: ProjectCommandUpload): ProjectStagedInput = try {
        // Waiting for a preparation call must never hold the session call gate.
        input.move { upload -> read { session -> ProjectStagedInput.own(this, NativeProject.stageCommands(session, upload)) } }
    } finally { input.close() }
    internal fun releaseInput(id: Long) {
        try { read { NativeProject.releaseStaged(it, id) } }
        catch (failure: IllegalStateException) { if (failure.message != "closed") throw failure }
    }
    /** null means queued. Run one commit at a time; dispatch all response
     * effects before delivering the corresponding wire acknowledgement. */
    fun submit(request: String): ProjectReply? = read {
        require(request.length <= ProjectIntents.MAX_BYTES) { "input_limit" }
        val reply = NativeProject.submit(it, request)
        if (reply == 0L) null else own(reply, ::ProjectReply)
    }
    fun runNext(): ProjectReply? = read {
        val reply = NativeProject.runNext(it)
        if (reply == 0L) null else own(reply, ::ProjectReply)
    }
    fun pendingCount(): Long = read { NativeProject.pendingCount(it) }
    fun dispose() = read { NativeProject.dispose(it) }
    fun isDisposed(): Boolean = read { NativeProject.isDisposed(it) }
    fun snapshot(): ProjectSnapshot = read { own(NativeProject.snapshot(it), ::ProjectSnapshot) }
    fun captureExport(guard: ProjectGuard): ProjectExportCapture = read {
        own(NativeProject.captureExport(it, guard.reference()), ::ProjectExportCapture)
    }
    fun selection(): ProjectSelection = read { own(NativeProject.selection(it), ::ProjectSelection) }
    fun history(): ProjectHistory = read { own(NativeProject.history(it), ::ProjectHistory) }
    fun historyRevision(): Long = read { NativeProject.historyRevision(it) }
    /** Which actions a surface offers and whether the workspace enables them:
     * the session decides its own facts, the request carries the host's. */
    fun capabilities(request: ProjectIntents.CapabilityRequest): ProjectIntents.CapabilityPage = read {
        ProjectIntents.decodeCapabilityPage(NativeProject.sessionCapabilities(it, ProjectIntents.encodeCapabilityRequest(request)))
    }
    /** A page of renderer deltas from the snapshot the host shows
     * ([ProjectIntents.RenderRequest.base]) to the session's acknowledged one.
     * Apply every page of a target before showing it; a page without a base
     * starts from empty, and `stale` means restart from the current target. */
    fun render(request: ProjectIntents.RenderRequest): ProjectIntents.RenderPage = read {
        ProjectIntents.decodeRenderPage(NativeProject.sessionRender(it, ProjectIntents.encodeRenderRequest(request)))
    }
    /** Select facets of one volume with a painter tool over the session's
     * acknowledged state: a page of ranges and the [ProjectIntents.FacetGuard]
     * a `facetStroke` commits them under, or the selector's issues. */
    fun facetRegion(request: ProjectIntents.FacetRegionRequest): ProjectIntents.FacetRegionReply = read {
        ProjectIntents.decodeFacetRegionReply(NativeProject.sessionFacetRegion(it, ProjectIntents.encodeFacetRegionRequest(request)))
    }
    /** Open a paint stroke on the state [guard] captured, which must still be
     * current. The stroke owns its mesh: samples and overlay pages run on it,
     * off this session's call gate. */
    fun paintStroke(guard: ProjectGuard, request: ProjectIntents.PaintStrokeOpen): ProjectPaintStroke = read {
        own(NativeProject.paintStrokeOpen(it, guard.reference(), ProjectIntents.encodePaintStrokeOpen(request)), ::ProjectPaintStroke)
    }
    /** Prepare one volume's split on the state [guard] captured, which must
     * still be current: [ProjectVolumeSplit.reply] gives its parts and
     * geometries, or why the workspace would not split it. */
    fun volumeSplit(guard: ProjectGuard, request: ProjectIntents.VolumeSplitRequest): ProjectVolumeSplit = read {
        own(NativeProject.volumeSplit(it, guard.reference(), ProjectIntents.encodeVolumeSplitRequest(request)), ::ProjectVolumeSplit)
    }
    /** A prepared split as one staged edit for `executeStaged`, named by the
     * host: one volume ID per part and one asset ID per distinct geometry,
     * with object identities to split into objects. A split whose state
     * changed refuses `stale`; a refused split or bad names, `invalid_request`. */
    fun stageVolumeSplit(split: ProjectVolumeSplit, request: ProjectIntents.VolumeSplitStage): ProjectStagedInput = read {
        ProjectStagedInput.own(this, NativeProject.stageVolumeSplit(it, split.reference(), ProjectIntents.encodeVolumeSplitStage(request)))
    }
    /** Decimate one volume's mesh on the state [guard] captured, which must
     * still be current: [ProjectVolumeSimplify.reply] gives its summary,
     * unchanged, or why the workspace would not simplify it, and
     * [ProjectVolumeSimplify.mesh] pages the result for a preview. */
    fun volumeSimplify(guard: ProjectGuard, request: ProjectIntents.VolumeSimplifyRequest): ProjectVolumeSimplify = read {
        own(NativeProject.volumeSimplify(it, guard.reference(), ProjectIntents.encodeVolumeSimplifyRequest(request)), ::ProjectVolumeSimplify)
    }
    /** A prepared decimation as one staged mesh replacement under the host's
     * asset ID. A run whose state changed refuses `stale`; a refused or
     * unchanged run, or an unstable ID, `invalid_request`. */
    fun stageVolumeSimplify(simplify: ProjectVolumeSimplify, request: ProjectIntents.VolumeSimplifyStage): ProjectStagedInput = read {
        ProjectStagedInput.own(this, NativeProject.stageVolumeSimplify(it, simplify.reference(), ProjectIntents.encodeVolumeSimplifyStage(request)))
    }
    /** The renderer packet for one of the session's mesh assets: the
     * geometry the workspace draws (three.js's smooth normals included),
     * chunked to the request's vertex limit, in the asset's millimetres. */
    fun meshPacket(request: ProjectIntents.MeshPacketRequest): ProjectMeshPacket = read {
        own(NativeProject.sessionMeshPacket(it, ProjectIntents.encodeMeshPacketRequest(request)), ::ProjectMeshPacket)
    }
    /** One volume's features captured for the Measure tool: the capture owns
     * its mesh, so [ProjectMeasureVolume.feature] picks run off this
     * session's call gate. Capture again when the volume's mesh changes. */
    fun measureVolume(request: ProjectIntents.MeasureVolumeRequest): ProjectMeasureVolume = read {
        own(NativeProject.sessionMeasureVolume(it, ProjectIntents.encodeMeasureVolumeRequest(request)), ::ProjectMeasureVolume)
    }
    /** The corners of one object's first layer that would lift, in object
     * space, as ears an `addBrimEars` intent places; or why there are none. */
    fun detectBrimEars(request: ProjectIntents.BrimEarDetectRequest): ProjectIntents.BrimEarDetectReply = read {
        ProjectIntents.decodeBrimEarDetectReply(NativeProject.sessionBrimEarDetect(it, ProjectIntents.encodeBrimEarDetectRequest(request)))
    }
    /** One object's placed ears whose discs reach neither its first layer
     * nor an anchored ear: the ones to draw red. */
    fun strandedBrimEars(request: ProjectIntents.BrimEarStrandedRequest): ProjectIntents.BrimEarStrandedReply = read {
        ProjectIntents.decodeBrimEarStrandedReply(NativeProject.sessionBrimEarStranded(it, ProjectIntents.encodeBrimEarStrandedRequest(request)))
    }
    /** One object's ears, the stranded ones and the base a placed ear sits
     * on: what the brim-ear tool shows and places with. */
    fun brimEarView(request: ProjectIntents.BrimEarViewRequest): ProjectIntents.BrimEarViewReply = read {
        ProjectIntents.decodeBrimEarViewReply(NativeProject.sessionBrimEarView(it, ProjectIntents.encodeBrimEarViewRequest(request)))
    }
    /** Whether a part is embossed text, an SVG part, either or neither: what
     * the Emboss and SVG part tools ask of the selected part before re-cutting
     * it. An unknown part is refused. */
    fun drawnPart(request: ProjectIntents.DrawnPartRequest): ProjectIntents.DrawnPartReply = read {
        ProjectIntents.decodeDrawnPartReply(NativeProject.sessionDrawnPart(it, ProjectIntents.encodeDrawnPartRequest(request)))
    }
    /** A prepared emboss cut as one staged edit for `executeStaged`: a new
     * text part under the host's IDs, or a re-cut of an existing one. A
     * refused cut or an unstable ID refuses `invalid_request`. */
    fun stageEmboss(emboss: ProjectEmboss, request: ProjectIntents.EmbossStage): ProjectStagedInput = read {
        ProjectStagedInput.own(this, NativeProject.stageEmboss(it, emboss.reference(), ProjectIntents.encodeEmbossStage(request)))
    }
    /** A prepared SVG cut as one staged edit for `executeStaged`: a new
     * part of an object under the host's IDs, or a re-cut of an SVG part. */
    fun stageSvgPart(svg: ProjectSvgPart, request: ProjectIntents.SvgPartStage): ProjectStagedInput = read {
        ProjectStagedInput.own(this, NativeProject.stageSvgPart(it, svg.reference(), ProjectIntents.encodeSvgPartStage(request)))
    }
    /** The plate's wipe tower auto-placed: the winning candidate and the tower
     * one `setPlateWipeTower` intent sets. */
    fun planWipeTower(request: ProjectIntents.WipeTowerRequest): ProjectIntents.WipeTowerReply = read {
        ProjectIntents.decodeWipeTowerReply(NativeProject.sessionWipeTower(it, ProjectIntents.encodeWipeTowerRequest(request)))
    }
    /** The ghost the workspace draws for a plate's wipe tower: its box, height
     * and printed margin, nothing without an enabled tower. */
    fun wipeTowerGhost(request: ProjectIntents.WipeTowerGhostRequest): ProjectIntents.WipeTowerGhostReply = read {
        ProjectIntents.decodeWipeTowerGhostReply(NativeProject.sessionWipeTowerGhost(it, ProjectIntents.encodeWipeTowerGhostRequest(request)))
    }
    /** One plate's arrangement: the moves as one `setInstanceTransforms`
     * intent's changes, with what did not fit and what stayed locked. */
    fun planArrangement(request: ProjectIntents.ArrangeRequest): ProjectIntents.ArrangeReply = read {
        ProjectIntents.decodeArrangeReply(NativeProject.sessionArrangement(it, ProjectIntents.encodeArrangeRequest(request)))
    }
    /** Transforms for copies of one instance in a plate's free space. */
    fun planBedFill(request: ProjectIntents.BedFillRequest): ProjectIntents.BedFillReply = read {
        ProjectIntents.decodeBedFillReply(NativeProject.sessionBedFill(it, ProjectIntents.encodeBedFillRequest(request)))
    }
    /** The transforms one placement edit submits, as one `setInstanceTransforms`
     * intent's changes, or the operation's refusal. */
    /** A primitive as a new object of the acknowledged state ([Primitives.primitiveRequest]). */
    fun planPrimitiveObject(request: String): PrimitivePlan<PrimitiveObjectPlan> = read {
        Primitives.primitiveReply(NativeProject.sessionPrimitiveObject(it, request))
    }
    /** A helper volume for the object a selection names ([Primitives.helperRequest]). */
    fun planHelperVolume(request: String): PrimitivePlan<HelperVolumePlan> = read {
        Primitives.helperReply(NativeProject.sessionHelperVolume(it, request))
    }
    /** Where the transform gizmo's proxy stands for a selection, and the origins a
     * drag captures ([TransformGizmo.proxy]); the core's canonical reply. */
    internal fun planTransformProxy(request: String): String = read {
        NativeProject.sessionTransformProxy(it, request)
    }
    fun planPlacement(request: ProjectIntents.PlacementRequest): ProjectIntents.PlacementReply = read {
        ProjectIntents.decodePlacementReply(NativeProject.sessionPlacement(it, ProjectIntents.encodePlacementRequest(request)))
    }
    /** One plate captured for picking; the scene owns its meshes, so picks run
     * off this session's call gate. Capture again when the project changes. */
    fun pickScene(request: ProjectIntents.PickSceneRequest): ProjectPickScene = read {
        own(NativeProject.sessionPickScene(it, ProjectIntents.encodePickSceneRequest(request)), ::ProjectPickScene)
    }
    /** The canonical paint overlay of one volume's channel; the capture owns
     * its facets, so packets can be read off this session's call gate. */
    fun paintOverlay(request: ProjectIntents.PaintOverlayRequest): ProjectPaintOverlay = read {
        own(NativeProject.sessionPaintOverlay(it, ProjectIntents.encodePaintOverlayRequest(request)), ::ProjectPaintOverlay)
    }
    /** The paint facets of one volume's channel, with each state's colour;
     * the capture owns its runs and leaves, read off this session's call gate. */
    fun paintFacets(request: ProjectIntents.PaintOverlayRequest): ProjectPaintFacets = read {
        own(NativeProject.sessionPaintFacets(it, ProjectIntents.encodePaintOverlayRequest(request)), ::ProjectPaintFacets)
    }
    /** The stroke's whole gesture as one staged edit for `executeStaged`, or
     * null when it touched no facet. A stroke whose state changed refuses
     * `stale`; do not sample the stroke while it stages. */
    fun stagePaintStroke(stroke: ProjectPaintStroke, label: String? = null): ProjectStagedInput? = read {
        val id = NativeProject.stagePaintStroke(it, stroke.reference(), label?.toCharArray())
        if (id == 0L) null else ProjectStagedInput.own(this, id)
    }
    /** The slicing configuration [live] describes against this session's
     * current project, staged as one "Update slicing configuration"
     * replacement for `executeStaged` (validated when it executes); [words]
     * supply new FullSpectrum pair identities, sixteen each. */
    fun stageSlicingConfiguration(
        catalog: ProfileCatalog,
        live: LiveSlicingChoice,
        policy: AutoPairPolicy,
        words: DoubleArray,
    ): SlicingStage = read {
        val reply = CanonicalJson.read(
            NativeProject.stageSlicingConfiguration(
                it, catalog.reference(), SlicingConfigurations.Json.stageRequest(live, policy), words,
            ),
        ) as ProjectJsonObject
        val keys = reply.keys().asSequence().toSet()
        when {
            "staged" in keys -> SlicingStage.Staged(ProjectStagedInput.own(this, (reply.get("staged") as Double).toLong()))
            "error" in keys -> SlicingStage.Refused(reply.get("error") as String, reply.get("message") as String)
            else -> SlicingStage.Unchanged
        }
    }
    fun assetFingerprint(): String = read { NativeProject.assetFingerprint(it) }
    fun asset(position: Long): ProjectAsset = read { own(NativeProject.asset(it, position), ::ProjectAsset) }
    fun captureGuard(): ProjectGuard = read { own(NativeProject.captureGuard(it), ::ProjectGuard) }
    fun isCurrent(guard: ProjectGuard): Boolean = read { NativeProject.isCurrent(it, guard.reference(), false) }
    fun isExportCurrent(guard: ProjectGuard): Boolean = read { NativeProject.isCurrent(it, guard.reference(), true) }
    /** Capture the base a model import is prepared against (guard, snapshot and
     * asset copies). Preparation then runs off the authority. */
    fun importBase(): ProjectImportBase = read { own(NativeProject.importBase(it), ::ProjectImportBase) }
    /** Commit a previewed import as one undoable `Import <filename>`. A refused
     * confirmation (`import_blocked`, `missing_acknowledgements`, `stale`) keeps
     * the candidate; dispatch the effects before reporting success. */
    fun commitImport(preview: ProjectImportPreview, acknowledged: List<String>): ProjectEffects = read {
        own(NativeProject.commitImport(it, preview.reference(), jsonStrings(acknowledged)), ::ProjectEffects)
    }
    /** Invoke only after successful save handoff for this captured identity. */
    fun acknowledgeCheckpoint(guard: ProjectGuard): ProjectEffects = read {
        own(NativeProject.acknowledgeCheckpoint(it, guard.reference()), ::ProjectEffects)
    }
    fun select(guard: ProjectGuard, input: ProjectSelectionInput, primary: Long = -1): ProjectEffects = read { session ->
        input.move { selection -> own(NativeProject.select(session, guard.reference(), selection, primary), ::ProjectEffects) }
    }
    /** A copy of instance [sourceInstanceId] on the state [guard] captured,
     * which must still be current, as the browser clones one ("Clone
     * Selected", "Add Instance"): instance [instanceId] of the same object,
     * last among its instances, with the source's name (when it has one),
     * transform, printability and extension data, staged as one undoable
     * "Create instance" for `executeStaged` that selects the copy. An unknown
     * source refuses `invalid_request`; a changed state, `stale`. */
    fun stageInstanceCopy(guard: ProjectGuard, sourceInstanceId: String, instanceId: String): ProjectStagedInput = read {
        ProjectStagedInput.own(this, NativeProject.stageInstanceCopy(it, guard.reference(), CanonicalJson.quote(sourceInstanceId), CanonicalJson.quote(instanceId)))
    }
}

/** The IDs a `duplicatePlate` intent of one plate carries, as counts ([ProjectSnapshot.plateShape]). */
data class ProjectPlateShape(val objects: List<Objects>, val customGcode: Int, val thumbnails: Int) {
    /** One object of the plate, in order: how many volume, instance and layer-range IDs its copy takes. */
    data class Objects(val volumes: Int, val instances: Int, val layerRanges: Int)
}
class ProjectGuard internal constructor(handle: Long) : ProjectHandle(handle)

/** One emboss cut from a recipe and the host's glyph outlines (flattened
 * to contours in font units): its summary and mesh bytes, the very payload
 * [ProjectSession.stageEmboss] installs. */
class ProjectEmboss private constructor(handle: Long) : ProjectHandle(handle) {
    fun reply(): ProjectIntents.EmbossReply = read {
        ProjectIntents.decodeEmbossReply(NativeProject.embossReply(it))
    }
    /** Bytes [start] until [start] + [count], at most [MAX_PAGE]. */
    fun mesh(start: Long, count: Long): ByteArray = read { NativeProject.embossMesh(it, start, count) }
    companion object {
        const val MAX_PAGE = 16L * 1024 * 1024
        fun prepare(request: ProjectIntents.EmbossRequest): ProjectEmboss =
            ProjectEmboss(NativeProject.prepareEmboss(ProjectIntents.encodeEmbossRequest(request)))
        /** A recipe cut with [font] ([ProjectEmbossFont.prepare]). */
        internal fun own(handle: Long): ProjectEmboss = ProjectEmboss(handle)
    }
}
/** A font file the operator picked, read as the browser's Emboss tool reads
 * it (`readTrueTypeOutlines`, `embossFontExchange.ts`): its summary or
 * refusal, a text's outlines, and recipes cut with it. Session-free; one
 * font serves any number of cuts until closed. */
class ProjectEmbossFont private constructor(handle: Long) : ProjectHandle(handle) {
    fun reply(): ProjectIntents.EmbossFontReply = read {
        ProjectIntents.decodeEmbossFontReply(NativeProject.embossFontReply(it))
    }
    /** The outlines a cut of the request's text reads, the characters the
     * font lacks left out, or the first glyph that cannot be read. A refused
     * font has none ([IllegalStateException]). */
    fun glyphs(request: ProjectIntents.EmbossGlyphsRequest): ProjectIntents.EmbossGlyphsReply = read {
        ProjectIntents.decodeEmbossGlyphsReply(NativeProject.embossFontGlyphs(it, ProjectIntents.encodeEmbossGlyphsRequest(request)))
    }
    /** The request's recipe cut with this font: its summary and mesh, the
     * payload [ProjectSession.stageEmboss] installs. A refused font cuts
     * nothing ([IllegalStateException]). */
    fun prepare(request: ProjectIntents.EmbossTextRequest): ProjectEmboss = read {
        ProjectEmboss.own(NativeProject.prepareEmbossText(it, ProjectIntents.encodeEmbossTextRequest(request)))
    }
    companion object {
        /** The largest font file [read] accepts, in bytes. */
        const val MAX_FONT_BYTES = 64 * 1024 * 1024
        /** A font file's bytes, read at the request's collection index (ignored unless the file is a collection). */
        fun read(request: ProjectIntents.EmbossFontRequest, bytes: ByteArray): ProjectEmbossFont =
            ProjectEmbossFont(NativeProject.readEmbossFont(ProjectIntents.encodeEmbossFontRequest(request), bytes))
    }
}
/** One SVG cut from a drawing's file bytes and a recipe: its summary and
 * mesh bytes, the very payload [ProjectSession.stageSvgPart] installs. The
 * drawing is read as UTF-8 (a byte-order mark dropped, malformed sequences
 * replaced), and that text is what the part stores. */
class ProjectSvgPart private constructor(handle: Long) : ProjectHandle(handle) {
    fun reply(): ProjectIntents.SvgPartReply = read {
        ProjectIntents.decodeSvgPartReply(NativeProject.svgPartReply(it))
    }
    /** Bytes [start] until [start] + [count], at most [MAX_PAGE]. */
    fun mesh(start: Long, count: Long): ByteArray = read { NativeProject.svgPartMesh(it, start, count) }
    companion object {
        const val MAX_PAGE = 16L * 1024 * 1024
        /** The largest drawing [prepare] accepts, in bytes. */
        const val MAX_DRAWING_BYTES = 16 * 1024 * 1024
        fun prepare(request: ProjectIntents.SvgPartRequest, drawing: ByteArray): ProjectSvgPart =
            ProjectSvgPart(NativeProject.prepareSvgPart(ProjectIntents.encodeSvgPartRequest(request), drawing))
        /** A drawing's file bytes read as the SVG part tool reads a picked
         * file (`readSvgDrawing`): its size and notes, or its refusal. */
        fun readDrawing(drawing: ByteArray): ProjectIntents.SvgDrawingReply =
            ProjectIntents.decodeSvgDrawingReply(NativeProject.readSvgDrawing(drawing))
    }
}
/** One volume's features, captured by [ProjectSession.measureVolume]. */
/** One mesh asset's renderer packet: a table of [Chunk]s, then each chunk's
 * float32 xyz positions, float32 xyz normals and indices (16-bit when the
 * reply's `indexBytes` is 2), little-endian, at 4-byte-aligned offsets. */
class ProjectMeshPacket internal constructor(handle: Long) : ProjectHandle(handle) {
    /** One chunk: triangles `firstTriangle` until `firstTriangle +
     * triangleCount` of the mesh, drawn from its own `vertexCount` vertices
     * starting at `byteOffset`. */
    data class Chunk(val firstTriangle: Long, val triangleCount: Long, val vertexCount: Long, val byteOffset: Long)

    fun reply(): ProjectIntents.MeshPacketReply = read {
        ProjectIntents.decodeMeshPacketReply(NativeProject.meshPacketReply(it))
    }
    /** Bytes [start] until [start] + [count], at most [MAX_PAGE]. */
    fun bytes(start: Long, count: Long): ByteArray = read { NativeProject.meshPacketBytes(it, start, count) }
    /** The chunk table of a prepared packet with [chunkCount] chunks. */
    fun chunks(chunkCount: Long): List<Chunk> {
        if (chunkCount == 0L) return emptyList()
        val table = java.nio.ByteBuffer.wrap(bytes(0, chunkCount * TABLE_ENTRY_BYTES)).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        return List(chunkCount.toInt()) { index ->
            val at = index * TABLE_ENTRY_BYTES.toInt()
            fun word(offset: Int) = table.getInt(at + offset).toLong() and 0xffff_ffffL
            Chunk(word(0), word(4), word(8), word(12))
        }
    }
    companion object {
        const val MAX_PAGE = 16L * 1024 * 1024
        const val TABLE_ENTRY_BYTES = 16L
    }
}
class ProjectMeasureVolume internal constructor(handle: Long) : ProjectHandle(handle) {
    fun reply(): ProjectIntents.MeasureVolumeReply = read {
        ProjectIntents.decodeMeasureVolumeReply(NativeProject.measureVolumeReply(it))
    }
    /** The feature a pick claims at a volume-local point on a facet, moved
     * by the request's row-major transform when it has one. */
    fun feature(request: ProjectIntents.MeasureFeatureRequest): ProjectIntents.MeasureFeatureReply = read {
        ProjectIntents.decodeMeasureFeatureReply(NativeProject.measureVolumeFeature(it, ProjectIntents.encodeMeasureFeatureRequest(request)))
    }
    companion object {
        /** The Measure tool's distances and angle between two features. */
        fun measure(request: ProjectIntents.MeasureRequest): ProjectIntents.MeasureReply =
            ProjectIntents.decodeMeasureReply(NativeProject.measureFeatures(ProjectIntents.encodeMeasureRequest(request)))
    }
}
/** One volume's decimation, prepared by [ProjectSession.volumeSimplify]:
 * its summary and the result's indexed-mesh bytes (float32 positions, then
 * uint32 indices), the very payload staging installs. */
class ProjectVolumeSimplify internal constructor(handle: Long) : ProjectHandle(handle) {
    fun reply(): ProjectIntents.VolumeSimplifyReply = read {
        ProjectIntents.decodeVolumeSimplifyReply(NativeProject.volumeSimplifyReply(it))
    }
    /** Bytes [start] until [start] + [count], at most [MAX_PAGE]. */
    fun mesh(start: Long, count: Long): ByteArray = read { NativeProject.volumeSimplifyMesh(it, start, count) }
    companion object {
        const val MAX_PAGE = 16L * 1024 * 1024
    }
}
/** One volume's split, prepared by [ProjectSession.volumeSplit]: its parts
 * in the pinned order and its distinct geometries, or the refusal. */
class ProjectVolumeSplit internal constructor(handle: Long) : ProjectHandle(handle) {
    fun reply(): ProjectIntents.VolumeSplitReply = read {
        ProjectIntents.decodeVolumeSplitReply(NativeProject.volumeSplitReply(it))
    }
}
/** One paint gesture, opened by [ProjectSession.paintStroke]. Samples
 * accumulate the facets and refined tree the commit stages; nothing reaches
 * the project before [ProjectSession.stagePaintStroke]. */
class ProjectPaintStroke internal constructor(handle: Long) : ProjectHandle(handle) {
    fun sample(request: ProjectIntents.PaintStrokeSample): ProjectIntents.PaintStrokeSampleReply = read {
        ProjectIntents.decodePaintStrokeSampleReply(NativeProject.paintStrokeSample(it, ProjectIntents.encodePaintStrokeSample(request)))
    }
    fun overlay(request: ProjectIntents.PaintStrokeOverlayRequest): ProjectIntents.PaintStrokeOverlay = read {
        ProjectIntents.decodePaintStrokeOverlay(NativeProject.paintStrokeOverlay(it, ProjectIntents.encodePaintStrokeOverlayRequest(request)))
    }
    /** The live preview as the canonical overlay would draw it. */
    fun preview(): ProjectPaintOverlay = read { own(NativeProject.paintStrokePreview(it), ::ProjectPaintOverlay) }
    /** The live preview as paint facets, each state in the colour the workspace previews it in. */
    fun previewFacets(): ProjectPaintFacets = read { own(NativeProject.paintStrokePreviewFacets(it), ::ProjectPaintFacets) }
    /** One sample made with the painter's [settings] where the pointer [hit]
     * (the browser's `paintSelectionInputs` for this stroke's channel, Gap
     * Fill ordered by the opened palette): the sample and its reply, or the
     * painter's refusal with the stroke left as it was. */
    fun sampleWith(hit: PaintHit, settings: PaintToolSettings): PaintStrokeStep = read {
        PaintTools.step(NativeProject.paintStrokeSampleWith(it, PaintTools.strokeRequest(hit, settings)))
    }
}

/** One volume's paint facets ([ProjectSession.paintFacets] or a stroke's
 * preview): a summary with each state's colour, then packets of whole-facet
 * runs ([PaintFacetPackets.RUN_BYTES] each) and leaves of subdivided facets
 * ([PaintFacetPackets.LEAF_BYTES] each), at most [MAX_PAGE] per packet. */
class ProjectPaintFacets internal constructor(handle: Long) : ProjectHandle(handle) {
    fun summary(): PaintFacetsSummary = PaintFacetsSummary.read(summaryJson())
    fun summaryJson(): String = read { NativeProject.paintFacetsSummary(it) }
    fun runs(start: Long, count: Long): ByteArray = read { NativeProject.paintFacetsRuns(it, start, count) }
    fun leaves(start: Long, count: Long): ByteArray = read { NativeProject.paintFacetsLeaves(it, start, count) }
    companion object {
        const val MAX_PAGE = 16384L
    }
}

/** One plate captured for picking: the nearest front-facing facet a
 * printer-space ray meets, as the workspace's raycast meets it. */
class ProjectPickScene internal constructor(handle: Long) : ProjectHandle(handle) {
    fun pick(ray: ProjectIntents.PickRay): ProjectIntents.PickReply = read {
        ProjectIntents.decodePickReply(NativeProject.pickScenePick(it, ProjectIntents.encodePickRay(ray)))
    }
}

/** One paint overlay's facets: a summary of their states, then packets of
 * [FACET_BYTES]-byte facets (nine little-endian float32 corners and a uint32
 * state index), at most [MAX_PAGE] per packet. */
class ProjectPaintOverlay internal constructor(handle: Long) : ProjectHandle(handle) {
    fun summary(): ProjectIntents.PaintOverlaySummary = read {
        ProjectIntents.decodePaintOverlaySummary(NativeProject.paintOverlaySummary(it))
    }
    fun packet(start: Long, count: Long): ByteArray = read { NativeProject.paintOverlayPacket(it, start, count) }
    companion object {
        const val FACET_BYTES = 40
        const val MAX_PAGE = 16384L
    }
}
/** Immutable complete bundle; declaration positions match its project snapshot. */
class ProjectExportCapture internal constructor(handle: Long) : ProjectHandle(handle) {
    fun project(): ProjectSnapshot = read { own(NativeProject.exportProject(it), ::ProjectSnapshot) }
    fun assetCount(): Long = read { NativeProject.exportAssetCount(it) }
    fun asset(position: Long): ProjectAsset = read { own(NativeProject.exportAsset(it, position), ::ProjectAsset) }
    /** Package this frozen bundle as a complete 3MF archive. Synchronous; run it
     * on the export worker. Closing this capture cancels the native write. */
    fun writeArchive(options: ProjectArchiveOptions): ProjectArchiveOutput = read {
        own(NativeProject.exportArchive(it, ProjectArchive.VERSION, options.encode()), ::ProjectArchiveOutput)
    }
    /** The one-plate slice capture of [plateId] (the browser's
     * `projectPlateArchiveForSlice`): this frozen bundle reduced to that plate
     * as plate zero and the active plate, with only its custom G-code,
     * thumbnails and source assets, admitted under [resolver] and [profile].
     * [writeArchive] packages it as the archive an external slicer loads; its
     * [project]'s hash is that archive's `sourceHash`. Refused with
     * `plate_projection_unknown_plate` or `plate_projection_not_printable`
     * (the browser's "Unknown plate …", "Plate … is not printable"). */
    fun plate(plateId: String, resolver: LocalTimestampResolver, profile: ProjectIntegerProfile): ProjectExportCapture = read {
        own(NativeProject.exportPlate(it, CanonicalJson.quote(plateId), resolver, profile.bits), ::ProjectExportCapture)
    }
    /** The pictures this capture's project asks for (its `thumbnails`), drawn
     * from its active plate — a plate capture's only one — by the shared core
     * (`orcaxr_archive::thumbnail`). Synchronous; run it on the export worker. */
    fun thumbnails(): PlateThumbnails = read { GcodeThumbnails.read(NativeProject.exportThumbnails(it)) }
    /** Export as 3MF… of this capture under [options]: the browser's own package
     * (its serializer's Save, byte for byte) streamed to [destination], or the
     * refusal, which writes nothing. Synchronous; run it on the export worker. */
    fun writeProjectArchive(options: ProjectArchiveOptions, destination: java.io.OutputStream): ProjectArchiveExport = read {
        ModelExports.projectArchive(NativeProject.exportProjectArchive(it, ProjectArchive.VERSION, options.encode()) { bytes -> destination.write(bytes) })
    }
    /** File → Export as one STL… or Export all objects as STLs… of this capture
     * (`orcaxr_archive::exports`, the browser's bytes): [request] from
     * [ModelExports.stlRequest]. The file streams to [destination] in chunks of
     * at most 64 KiB; the reply says what was written, or is the browser's
     * refusal, which writes nothing. Synchronous; run it on the export worker. */
    fun writeStl(request: String, destination: java.io.OutputStream): StlExport = read {
        ModelExports.stl(NativeProject.exportStl(it, request) { bytes -> destination.write(bytes) })
    }
    /** Writes a single volume's canonical mesh as a binary STL in volume-local coordinates
     * to [destination]. Answers its triangle count. Synchronous; run it on the export worker. */
    fun writeVolumeStl(volumeId: String, destination: java.io.OutputStream): Long = read {
        ModelExports.volumeStl(NativeProject.exportVolumeStl(it, volumeId) { bytes -> destination.write(bytes) })
    }
    /** Export Diagnostics…'s shape of this capture's project
     * (`diagnosticsProjectSummaryOf`): counts and object names, never geometry. */
    fun diagnosticsSummary(): Diagnostics.ProjectShape = read { Diagnostics.projectShape(NativeProject.exportDiagnosticsSummary(it)) }
    /** Live slice preflight of exactly this frozen bundle. Synchronous; run it on
     * the export worker. Closing this capture cancels the native preflight. */
    fun preflight(request: ProjectIntents.PreflightRequest): ProjectPreflight = read {
        own(NativeProject.exportPreflight(it, ProjectIntents.encodePreflightRequest(request)), ::ProjectPreflight)
    }
}
/** One live preflight result, read item by item in canonical issue order. */
class ProjectPreflight internal constructor(handle: Long) : ProjectHandle(handle) {
    fun summary(): ProjectIntents.PreflightSummary = read {
        ProjectIntents.decodePreflightSummary(NativeProject.preflightSummary(it))
    }
    fun issue(position: Long): ProjectIntents.PreflightIssue = read {
        ProjectIntents.decodePreflightIssue(NativeProject.preflightIssue(it, position))
    }
    fun omission(position: Long): ProjectIntents.PreflightOmission = read {
        ProjectIntents.decodePreflightOmission(NativeProject.preflightOmission(it, position))
    }
    fun printableInstance(position: Long): ProjectIntents.PreflightEntity = read {
        ProjectIntents.decodePreflightEntity(NativeProject.preflightInstance(it, position))
    }
    fun usedFilament(position: Long): ProjectIntents.PreflightEntity = read {
        ProjectIntents.decodePreflightEntity(NativeProject.preflightFilament(it, position))
    }
}
data class ProjectStagingUsage(val resources: Long, val commands: Long, val units: Long, val assetBytes: Long)
data class ProjectClipboardInfo(val volumes: Long, val instances: Long, val layerRanges: Long, val assets: Long, val bytes: Long)
/** Counts against the same four-owner clipboard budget as a completed capture.
 * Consumed on success/failure; closing invalidates late worker results. */
class ProjectClipboardInput internal constructor(handle: Long) : ProjectHandle(handle) {
    fun capture(objectNode: ProjectQueryNode): ProjectClipboard = move {
        NativeProject.clipboardInputCapture(it, objectNode.reference())
        own(it, ::ProjectClipboard)
    }
}
/** Free the clipboard when replacing it. Commands already in preparation/history
 * retain their own data and budgets, without retaining this handle's permit. */
class ProjectClipboard internal constructor(handle: Long) : ProjectHandle(handle) {
    fun info(): ProjectClipboardInfo = read {
        val values = NativeProject.clipboardInfo(it)
        check(values.size == ProjectStaging.CLIPBOARD_INFO_LENGTH && values.all { n -> n.isFinite() && n >= 0 && n <= ProjectHost.MAX_BUDGET && n == n.toLong().toDouble() }) { "invalid_clipboard_info" }
        ProjectClipboardInfo(values[ProjectStaging.CLIPBOARD_VOLUMES].toLong(), values[ProjectStaging.CLIPBOARD_INSTANCES].toLong(), values[ProjectStaging.CLIPBOARD_LAYER_RANGES].toLong(), values[ProjectStaging.CLIPBOARD_ASSETS].toLong(), values[ProjectStaging.CLIPBOARD_BYTES].toLong())
    }
}
class ProjectCommandUpload internal constructor(handle: Long) : ProjectHandle(handle) {
    fun append(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.commandUploadAppend(it, offset, bytes)
    }
    /** Synchronous decoding/measurement belongs on the owned preparation executor. */
    fun seal() = read { NativeProject.commandUploadSeal(it) }
    fun units(): Long = read { NativeProject.commandUploadUnits(it) }
    fun commandCount(): Long = read { NativeProject.commandUploadCount(it) }
    /** Payload bytes the sealed work holds (each distinct payload once). */
    fun assetBytes(): Long = read { NativeProject.commandUploadAssetBytes(it) }
    /** Payloads the sealed records declared, in first-declaration order. */
    fun assetCount(): Long = read { NativeProject.commandUploadAssetCount(it) }
    /** Start one declared payload; returns its exact byte length. */
    fun beginAsset(position: Long): Long = read { NativeProject.commandUploadBeginAsset(it, position) }
    fun appendAsset(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.commandUploadAppendAsset(it, offset, bytes)
    }
    /** Validates the payload; the last one prepares the work's commands, so it
     * belongs on the owned preparation executor too. */
    fun finishAsset() = read { NativeProject.commandUploadFinishAsset(it) }
    fun cancelAsset() = read { NativeProject.commandUploadCancelAsset(it) }
}
/** Ready-input cleanup uses the session's ordinary call gate. Closing the whole
 * session remains nonblocking. A refused release retains this ID for retry. */
class ProjectStagedInput private constructor(private val session: ProjectSession, value: Long) : AutoCloseable {
    private val value = AtomicLong(value.also { require(it in 1..9007199254740991L) })
    val id: Long get() = value.get().also { check(it != 0L) { "closed" } }
    override fun close() {
        val id = value.get()
        if (id != 0L) { session.releaseInput(id); value.compareAndSet(id, 0) }
    }
    internal companion object {
        fun own(session: ProjectSession, id: Long): ProjectStagedInput = try { ProjectStagedInput(session, id) }
        catch (failure: Throwable) { session.releaseInput(id); throw failure }
    }
}
class ProjectSelectionInput : ProjectHandle(NativeProject.selectionInputNew()) {
    fun add(kind: Int, id: CharArray) = read {
        require(id.size <= ProjectHost.MAX_SELECTION_TEXT_UNITS) { "input_limit" }
        NativeProject.selectionInputAdd(it, kind, id)
    }
}
class ProjectReply internal constructor(handle: Long) : ProjectHandle(handle) {
    fun wire(): String = read { NativeProject.replyWire(it) }
    /** Read wire first; this consumes the reply in its reserved native slot,
     * without requiring another handle permit. Failed replies may carry
     * rollback effects, which have the same dispatch obligation as success. */
    fun effects(): ProjectEffects = move { own(NativeProject.replyEffects(it), ::ProjectEffects) }
}
class ProjectEffects internal constructor(handle: Long) : ProjectHandle(handle) {
    fun count(): Long = read { NativeProject.effectsCount(it) }
    fun kind(position: Long): Int = read { NativeProject.effectKind(it, position) }
    fun project(position: Long, previous: Boolean): ProjectSnapshot = read {
        check(NativeProject.effectKind(it, position) == ProjectHost.EFFECT_PROJECT) { "wrong_effect" }
        own(NativeProject.effectCapture(it, position, previous), ::ProjectSnapshot)
    }
    fun selection(position: Long, previous: Boolean): ProjectSelection = read {
        check(NativeProject.effectKind(it, position) == ProjectHost.EFFECT_SELECTION) { "wrong_effect" }
        own(NativeProject.effectCapture(it, position, previous), ::ProjectSelection)
    }
    fun history(position: Long, previous: Boolean): ProjectHistory = read {
        check(NativeProject.effectKind(it, position) == ProjectHost.EFFECT_HISTORY) { "wrong_effect" }
        own(NativeProject.effectCapture(it, position, previous), ::ProjectHistory)
    }
    fun reasonLength(position: Long): Long = read { NativeProject.effectReasonLength(it, position) }
    fun reason(position: Long, start: Long, count: Long): CharArray = read { NativeProject.effectReason(it, position, start, count) }
    fun dirtyCategories(position: Long): String = read { NativeProject.effectDirtyCategories(it, position) }
}
class ProjectSnapshot internal constructor(handle: Long) : ProjectHandle(handle) {
    fun query(): ProjectQueryNode = read { own(NativeProject.queryRoot(it, ProjectQuery.VERSION), ::ProjectQueryNode) }
    fun revision(): Long = read { NativeProject.projectRevision(it) }
    fun hash(): String = read { NativeProject.projectHash(it) }
    /** "New project" from this one (the browser's `freshProjectState`): the
     * canonical document of a clean project keeping its printer, base profile
     * and physical tools. See [NewProjects] for the words and timestamp. */
    fun fresh(words: DoubleArray, now: String): ByteArray = read { NativeProject.projectFresh(it, words, now) }
    /** The print configuration plate [plateId] overrides (the browser's
     * `platePrintOverrides`), as the engine wire strings a slice submission's
     * `overrides` field carries; an unknown plate overrides nothing. */
    fun platePrintOverrides(plateId: String): Map<String, String> = read {
        CanonicalJson.stringMap(NativeProject.projectPlateOverrides(it, CanonicalJson.quote(plateId)))
    }
    /** The ID plan a `duplicatePlate` intent of plate [plateId] needs, counted
     * as the command checks it (the browser's `duplicatePlate` mints exactly
     * these); null for an unknown plate. */
    fun plateShape(plateId: String): ProjectPlateShape? = read {
        val values = NativeProject.projectPlateShape(it, CanonicalJson.quote(plateId))
        if (values.isEmpty()) return@read null
        fun count(position: Int): Int {
            val value = values.getOrNull(position) ?: error("invalid_plate_shape")
            check(value.isFinite() && value >= 0 && value == value.toInt().toDouble()) { "invalid_plate_shape" }
            return value.toInt()
        }
        val objects = count(0)
        check(values.size == 3 + objects * 3) { "invalid_plate_shape" }
        ProjectPlateShape(
            List(objects) { index -> ProjectPlateShape.Objects(count(1 + index * 3), count(2 + index * 3), count(3 + index * 3)) },
            count(1 + objects * 3),
            count(2 + objects * 3),
        )
    }
    /** The bed the workspace reads from this project (its base profile when it
     * records one, else its configuration) with plate [plateId]'s wipe-tower
     * keep-out; no plate, or one the project lacks, keeps nothing out. */
    fun workspaceBed(plateId: String?): WorkspaceBed = read {
        WorkspaceBeds.read(NativeProject.projectWorkspaceBed(it, "{\"plateId\":${plateId?.let(CanonicalJson::quote) ?: "null"}}"))
    }
    /** The plates a slice of [scope] slices, in slicing order, or the browser's
     * words for why it slices none ([SlicePlans]). */
    fun slicePlan(scope: SliceScope): SlicePlan = read { SlicePlans.read(NativeProject.projectSlicePlan(it, scope.wire)) }
    /** The profile snapshot plate [plateId] is sliced with (`CanonicalStateProfileResolver.capture`),
     * or the browser's refusal for an unknown plate thrown as [SliceSidecarRefused]. */
    fun sliceProfiles(plateId: String): SliceProfiles =
        read { SliceSidecars.profiles(NativeProject.projectSliceProfiles(it, CanonicalJson.quote(plateId))) }
    /** What [target] would split for instance [instanceId] (the browser's
     * `splitSourceOf`): the object holding it, or the workspace's refusal in
     * its words — an instance this project lacks, an object the split would
     * lose data from, a volume over [triangleLimit], an object with parts. */
    fun splitSource(instanceId: String, target: SplitTarget, triangleLimit: Long = SplitSources.SYNC_TRIANGLE_LIMIT): SplitSourceResult = read {
        SplitSources.read(NativeProject.projectSplitSource(it, SplitSources.request(instanceId, target, triangleLimit)))
    }
    /** What the selected [refs] can be assigned and every filament the project
     * offers (the browser's `getFilamentAssignmentSnapshot`); a ref the project
     * lacks is refused in the browser's words. */
    fun filamentAssignment(refs: List<FilamentRef>): FilamentAssignmentResult = read {
        FilamentAssignments.resolution(NativeProject.projectFilamentAssignment(it, FilamentAssignments.refsRequest(refs)))
    }
    /** The assignments giving [entities] (objects, parts, height ranges)
     * [filamentId] — null inheriting — as one command submits them, or the
     * browser controller's refusal. */
    fun filamentAssignmentChanges(entities: List<FilamentRef>, filamentId: String?): FilamentAssignmentChanges = read {
        FilamentAssignments.changes(NativeProject.projectFilamentAssignmentChanges(it, FilamentAssignments.changesRequest(entities, filamentId)))
    }
    /** The virtual filament library this project shows (the browser's library
     * over its adapter's projection), or why it can show none, in its words. */
    fun virtualFilamentLibrary(): VirtualFilamentLibraryResult = read {
        VirtualFilaments.library(NativeProject.projectVirtualFilamentLibrary(it, "{}"))
    }
    /** The step [edit] submits on this project — a new recipe named by
     * [newId] — or the refusal in the browser's words. */
    fun virtualFilamentPlan(edit: VirtualFilamentEdit, newId: () -> String): VirtualFilamentPlan = read {
        VirtualFilaments.plan(NativeProject.projectVirtualFilamentMutation(it, VirtualFilaments.mutationRequest(edit, newId)))
    }
    /** The filament slots this project's own physical filaments describe, as
     * the browser adopts an opened project's; one without keeps [palette]. */
    fun filamentSlots(palette: List<SlicingSlot>): SlicingSlots = read {
        SlicingConfigurations.Json.slots(NativeProject.projectFilamentSlots(it, SlicingConfigurations.Json.paletteRequest(palette)))
    }
    /** The filament library as the painting palette, with stable IDs. */
    fun paintPalette(request: ProjectIntents.PaintPaletteRequest): ProjectIntents.PaintPalette = read {
        ProjectIntents.decodePaintPalette(NativeProject.projectPaintPalette(it, ProjectIntents.encodePaintPaletteRequest(request)))
    }
    /** One page of the Objects tree's visible rows under the host's expansion,
     * filter, selection and focus, or the selection activating a row commits.
     * [folder] folds non-ASCII search text; without one such text is refused. */
    fun objectTree(
        request: ProjectIntents.ObjectTreeRequest,
        folder: SearchFolding? = SearchFolding.PLATFORM,
    ): ProjectIntents.ObjectTreeReply = read {
        ProjectIntents.decodeObjectTreeReply(NativeProject.projectObjectTree(it, ProjectIntents.encodeObjectTreeRequest(request), folder))
    }
    /** One page of the nodes a scoped settings edit can address. */
    fun settingsTargets(request: ProjectIntents.SettingsTargetPageRequest): ProjectIntents.SettingsTargetPage = read {
        ProjectIntents.decodeSettingsTargetPage(
            NativeProject.projectSettingsTargets(it, ProjectIntents.encodeSettingsTargetPageRequest(request)),
        )
    }
    /** A node's overrides, foreign keys, chain and resolved configurations. */
    fun settingsSnapshot(request: ProjectIntents.SettingsTargetRequest): ProjectIntents.SettingsSnapshotResult = read {
        ProjectIntents.decodeSettingsSnapshotResult(
            NativeProject.projectSettingsSnapshot(it, ProjectIntents.encodeSettingsTargetRequest(request)),
        )
    }
    /** Why one key has its value at a node, and what it shadowed. */
    fun settingsExplain(request: ProjectIntents.SettingsExplainRequest): ProjectIntents.SettingsExplainResult = read {
        ProjectIntents.decodeSettingsExplainResult(
            NativeProject.projectSettingsExplain(it, ProjectIntents.encodeSettingsExplainRequest(request)),
        )
    }
    /** [objectId]'s height ranges as the semantic editor shows them, [selectedLayerRangeId] (one of them) selected; null for an object this project lacks. */
    fun layerRangeEditor(objectId: String, selectedLayerRangeId: String?): LayerRangeProjection? = read {
        LayerRangeEditors.projection(
            NativeProject.projectLayerRangeEditor(
                it,
                "{\"objectId\":${CanonicalJson.quote(objectId)},\"selectedLayerRangeId\":${selectedLayerRangeId?.let(CanonicalJson::quote) ?: "null"}}",
            ),
        )
    }
    /** Part [volumeId]'s role choices as the semantic editor shows them; null for a part this project lacks. */
    fun volumeRoleEditor(volumeId: String): VolumeRoleProjection? = read {
        VolumeRoleEditors.projection(NativeProject.projectVolumeRoleEditor(it, VolumeRoleEditors.projectionRequest(volumeId)))
    }
    /** The conversion command's decision for part [volumeId] and [role], any role text (`inspectVolumeRoleConversion`). */
    fun volumeRoleDecision(volumeId: String, role: String): VolumeRoleDecision = read {
        VolumeRoleEditors.decision(NativeProject.projectVolumeRoleDecision(it, VolumeRoleEditors.decisionRequest(volumeId, role)))
    }
    /** The settings editor a panel opens for one node; see [SettingsEditor.intent]. */
    fun settingsEditor(
        request: ProjectIntents.SettingsSessionRequest,
        collator: PresetCollator? = null,
        folder: SearchFolding? = SearchFolding.PLATFORM,
    ): SettingsEditor = read {
        own(NativeProject.projectSettingsEditor(it, ProjectIntents.encodeSettingsSessionRequest(request), collator, folder), ::SettingsEditor)
    }
    fun idLength(): Long = read { NativeProject.projectIdLength(it) }
    fun id(start: Long, count: Long): CharArray = read { NativeProject.projectId(it, start, count) }
    /** Explicit full serialization under an output bound. Reading in chunks
     * does not make serialization interruptible; use an owned export task. */
    fun exportJson(maxBytes: Long): ProjectBytes = read { own(NativeProject.projectExport(it, maxBytes), ::ProjectBytes) }
    /** Synchronous streaming on the export worker. No whole-document byte buffer
     * is created. The sink must accept every chunk or throw; failures are redacted. */
    fun writeJson(maxBytes: Long, sink: ProjectJsonSink): Long = read {
        require(maxBytes in 0..ProjectHost.MAX_BUDGET) { "invalid_options" }
        NativeProject.projectWriteJson(it, maxBytes, sink)
    }
}
/** Captured read projection. Children/metadata never mutate or re-read the live
 * session. Names and IDs are separate bounded reads, including lone surrogates. */
class ProjectQueryNode internal constructor(handle: Long) : ProjectHandle(handle) {
    fun snapshot(): ProjectSnapshot = read { own(NativeProject.queryProject(it), ::ProjectSnapshot) }
    fun metadata(): QueryMetadata = read { ProjectQuery.decodeMetadata(NativeProject.queryMetadata(it)) }
    fun textLength(field: QueryText): Long? = read { NativeProject.queryTextLength(it, field.ordinal).takeIf { length -> length >= 0 } }
    fun text(field: QueryText, start: Long, count: Long): CharArray = read { NativeProject.queryText(it, field.ordinal, start, count) }
    /** Plate/range sorting has a caller-supplied entry budget. It is synchronous
     * work on the captured graph and belongs to an owned projection executor. */
    fun children(relation: QueryRelation, maxSortEntries: Long): ProjectQueryList = read {
        own(NativeProject.queryChildren(it, relation.ordinal, maxSortEntries), ::ProjectQueryList)
    }
}
class ProjectQueryList internal constructor(handle: Long) : ProjectHandle(handle) {
    fun snapshot(): ProjectSnapshot = read { own(NativeProject.queryProject(it), ::ProjectSnapshot) }
    fun count(): Long = read { NativeProject.queryCount(it) }
    fun node(position: Long): ProjectQueryNode = read { own(NativeProject.queryNode(it, position), ::ProjectQueryNode) }
    fun page(start: Long, count: Long): QueryPage = read { ProjectQuery.decodePage(NativeProject.queryPage(it, start, count)) }
}
class ProjectBytes internal constructor(handle: Long) : ProjectHandle(handle) {
    fun length(): Long = read { NativeProject.bytesLength(it) }
    fun read(start: Long, count: Long): ByteArray = read { NativeProject.bytesRead(it, start, count) }
}
class ProjectAsset internal constructor(handle: Long) : ProjectHandle(handle) {
    fun idLength(): Long = read { NativeProject.assetIdLength(it) }
    fun id(start: Long, count: Long): CharArray = read { NativeProject.assetId(it, start, count) }
    fun length(): Long = read { NativeProject.assetLength(it) }
    fun digest(): String = read { NativeProject.assetDigest(it) }
    fun read(start: Long, count: Long): ByteArray = read { NativeProject.assetRead(it, start, count) }
    fun metadata(maxBytes: Long): ProjectBytes = read { own(NativeProject.assetMetadata(it, maxBytes), ::ProjectBytes) }
}
class ProjectSelection internal constructor(handle: Long) : ProjectHandle(handle) {
    fun count(): Long = read { NativeProject.selectionCount(it) }
    fun primaryIndex(): Long = read { NativeProject.selectionPrimary(it) }
    fun kind(position: Long): Int = read { NativeProject.selectionKind(it, position) }
    fun idLength(position: Long): Long = read { NativeProject.selectionIdLength(it, position) }
    fun id(position: Long, start: Long, count: Long): CharArray = read { NativeProject.selectionId(it, position, start, count) }
}
class ProjectHistory internal constructor(handle: Long) : ProjectHandle(handle) {
    fun count(undo: Boolean): Long = read { NativeProject.historyCount(it, undo) }
    fun hasLabel(undo: Boolean): Boolean = read { NativeProject.historyHasLabel(it, undo) }
    fun labelLength(undo: Boolean): Long = read { NativeProject.historyLabelLength(it, undo) }
    fun label(undo: Boolean, start: Long, count: Long): CharArray = read { NativeProject.historyLabel(it, undo, start, count) }
    fun dirtyCategories(): String = read { NativeProject.historyDirtyCategories(it) }
}
