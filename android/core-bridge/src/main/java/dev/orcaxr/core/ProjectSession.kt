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
class ProjectDocument internal constructor(handle: Long) : ProjectHandle(handle)
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
}
class ProjectGuard internal constructor(handle: Long) : ProjectHandle(handle)
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
