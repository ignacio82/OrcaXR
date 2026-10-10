package dev.orcaxr.core

import java.security.SecureRandom
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Constant-size host proof: no project ID, snapshot, native handle or actor closure.
 * Revisions never rewind/repeat in one actor; assets additionally bind their captured
 * fingerprint. The native local guard is rechecked after expensive preparation. */
class ProjectActorGuard internal constructor(
    internal val owner: Any,
    val revision: Long,
    val historyRevision: Long,
    internal val assets: String,
)

/** Immutable clipboard identity and bounded metadata; retains no native handle
 * or actor. Replacement/clear refuses new pastes with an older identity. */
class ProjectActorClipboard internal constructor(internal val owner: Any, val info: ProjectClipboardInfo)

/** A confirmed native result remains confirmed even if projection delivery fails.
 * authority can be absent when a completed summary is unavailable and the bounded
 * host identity capture also fails. Query again after freeing resources; never retry
 * the completed mutation to obtain its missing guard. */
sealed interface ProjectOutcome {
    data class Exported(val source: ProjectActorGuard, val checkpoint: ProjectCheckpoint, val projection: ProjectProjection) : ProjectOutcome
    data class Copied(val clipboard: ProjectActorClipboard, val projection: ProjectProjection) : ProjectOutcome
    data class ClipboardCleared(val projection: ProjectProjection) : ProjectOutcome
    data class Completed(val reply: ProjectIntents.SessionReply, val projection: ProjectProjection, val authority: ProjectActorGuard?) : ProjectOutcome
    data class Opened(val guard: ProjectIntents.SessionGuard, val history: ProjectIntents.SessionHistory, val projection: ProjectProjection, val authority: ProjectActorGuard?) : ProjectOutcome
    data class OpenedWithoutSummary(val projection: ProjectProjection, val authority: ProjectActorGuard?) : ProjectOutcome
    data class Reset(val guard: ProjectIntents.SessionGuard, val history: ProjectIntents.SessionHistory, val projection: ProjectProjection, val authority: ProjectActorGuard?) : ProjectOutcome
    data class ResetWithoutSummary(val projection: ProjectProjection, val authority: ProjectActorGuard?) : ProjectOutcome
    /** A prepared import: show [ProjectActorImport.preview], then commit or close it. */
    data class ImportPrepared(val candidate: ProjectActorImport, val projection: ProjectProjection) : ProjectOutcome
    /** A committed import: one undoable `Import <filename>` history entry. */
    data class Imported(val projection: ProjectProjection, val authority: ProjectActorGuard?) : ProjectOutcome
    data class NotStarted(val reason: ProjectRefusal) : ProjectOutcome
    /** What a read-only [ProjectActor.inspect] answered, or how it failed; the project is unchanged either way. */
    data class Inspected(val result: Result<Any?>) : ProjectOutcome
    /** A slicing configuration the project already has: nothing was staged or recorded. */
    data object SlicingUnchanged : ProjectOutcome
    /** The selection a [ProjectActor.select] planned is the session's now; [changed] when it differed. */
    data class Selected(val changed: Boolean, val projection: ProjectProjection) : ProjectOutcome
    /** A [ProjectActor.select] or [ProjectActor.stage] plan found nothing to do: the session is unchanged. */
    data object NothingToDo : ProjectOutcome
    /** A slicing configuration the core refused to stage (`orphaned-mixed-component`, `auto-pairs`, `ids-exhausted`), in the browser's words. */
    data class SlicingRefused(val code: String, val message: String) : ProjectOutcome
    /** No retry is safe: the operation may have changed the project or handed off output. */
    data object Uncertain : ProjectOutcome
}
enum class ProjectProjection { DELIVERED, FAILED, CLOSED }
enum class ProjectCheckpoint { NOT_REQUESTED, SAVED, STALE, UNAVAILABLE }
enum class ProjectRefusal { NOT_READY, BUSY, CLOSED, CANCELLED, INVALID_REQUEST, PREPARATION_FAILED, STALE, RESOURCE_LIMIT, UNCONFIRMED }

/** An import candidate and the browser's preview JSON. The caller owns it: commit
 * it through the actor that prepared it, or close it. A refused confirmation
 * (blocked preview or missing acknowledgements) keeps it for a retry. */
class ProjectActorImport internal constructor(
    internal val owner: Any,
    val preview: String,
    val blocked: Boolean,
    internal val native: ProjectImportPreview,
) : AutoCloseable {
    override fun close() = native.close()
}

/** A selection a [ProjectActor.select] plan chose: [refs] in order, and the
 * [primary] among them (the last by default, as the browser's store takes it). */
class ProjectSelectionChoice(
    val refs: List<ProjectIntents.SelectionEntity>,
    val primary: ProjectIntents.SelectionEntity? = refs.lastOrNull(),
)

class ProjectRequest internal constructor(cancelAction: () -> Boolean) {
    private val cancellation = AtomicReference<(() -> Boolean)?>(cancelAction)
    private val result = CompletableFuture<ProjectOutcome>()
    /** Cancelling/completing this view cannot change the actor's owned result. */
    val completion: CompletionStage<ProjectOutcome> get() = result.thenApply { it }
    /** True only when execution was prevented. Never rolls back an active edit. */
    fun cancel(): Boolean = cancellation.get()?.invoke() ?: false
    internal fun complete(value: ProjectOutcome) { cancellation.set(null); result.complete(value) }
}

/** Own native preparation handles immediately, before making any blocking calls.
 * A cancelled task closes current and late handles. Native calls may finish later;
 * their owner checks prevent publication. Streams should use their normal use{}.
 */
class ProjectPreparation internal constructor() : AutoCloseable {
    private val gate = Any()
    private var closed = false
    private val handles = linkedSetOf<ProjectHandle>()
    fun checkActive() = synchronized(gate) { check(!closed) { "cancelled" } }
    fun <T : ProjectHandle> own(value: T): T {
        val accepted = synchronized(gate) {
            if (closed || (value !in handles && handles.size >= 64)) false
            else { handles.add(value); true }
        }
        if (!accepted) { value.close(); error("cancelled_or_resource_limit") }
        return value
    }
    internal fun <T : ProjectHandle> transfer(value: T): T = synchronized(gate) {
        check(!closed && handles.remove(value)) { "cancelled" }
        value
    }
    override fun close() {
        val owned = synchronized(gate) { closed = true; handles.toList().also { handles.clear() } }
        owned.forEach { it.close() }
    }
}

/** Exclusive native session owner. All commits use one bounded authority executor;
 * document/command preparation uses two separate workers. Ordered borrowed effects are consumed
 * on a third executor before completing requests. Callbacks must return promptly and
 * must not wait for another request from this actor. Marshal UI state in that order.
 *
 * At most 32 operations (including preparations and undelivered effects) are retained.
 * close invalidates native owners without waiting for running JNI or callbacks;
 * settlement drains after an already running delivery callback returns. An effects
 * callback already in progress must observe its application's own lifetime token.
 * Native work and effect callbacks never run on the submitting/UI thread.
 * CompletableFuture continuations follow their normal executor semantics.
 */
class ProjectActor private constructor(
    onEffects: (ProjectEffects) -> Unit,
    private val maxPending: Int,
    private val staging: ProjectStagingPoolOptions,
) : AutoCloseable {
    private enum class Phase { QUEUED, PREPARING, EXPORTING, COMMIT, EXECUTING, DELIVERY, DONE }
    private enum class DocumentMode { OPEN, RESET }
    private sealed interface Work {
        data class Export(val expected: ProjectActorGuard, val limits: ProjectExportLimits, val save: Boolean,
            val write: (ProjectPreparation, ProjectExportSource) -> Unit) : Work
        data class Message(val wire: String) : Work
        data object ClearClipboard : Work
        data class Copy(val expected: ProjectActorGuard, val epoch: Any, val options: ProjectStagingClipboardOptions,
            val select: (ProjectPreparation, ProjectSnapshot) -> ProjectQueryNode) : Work
        data class Document(val mode: DocumentMode, val expected: ProjectActorGuard?,
            val produce: (ProjectPreparation, ProjectSnapshot?) -> ProjectDocument) : Work
        data class Commands(val expected: ProjectActorGuard, val clipboard: ProjectActorClipboard?, val bytes: Long, val options: ProjectStagingInputOptions,
            val write: (ProjectPreparation, ProjectSnapshot, ProjectCommandWriter) -> Unit,
            val assets: ((ProjectPreparation, ProjectAssetWriter) -> Unit)? = null) : Work
        data class Import(val expected: ProjectActorGuard, val prepare: (ProjectPreparation, ProjectImportBase) -> ProjectImportPreview) : Work
        data class CommitImport(val candidate: ProjectActorImport, val acknowledged: List<String>) : Work
        data class Inspect(val read: (ProjectSession) -> Any?) : Work
        data class Slicing(val stage: (ProjectSession) -> SlicingStage) : Work
        data class Select(val plan: (ProjectSession) -> ProjectSelectionChoice?) : Work
        data class Staged(val plan: (ProjectSession, ProjectGuard) -> ProjectStagedInput?) : Work
    }
    private sealed interface Prepared {
        data class Export(val source: ProjectActorGuard, val guard: ProjectGuard, val save: Boolean) : Prepared
        data class Copy(val epoch: Any, val guard: ProjectGuard, val clipboard: ProjectClipboard, val info: ProjectClipboardInfo) : Prepared
        data class Document(val mode: DocumentMode, val document: ProjectDocument, val ticket: ProjectOpen?, val guard: ProjectGuard?) : Prepared
        data class Commands(val upload: ProjectCommandUpload) : Prepared
        data class Import(val preview: ProjectImportPreview) : Prepared
    }
    private class Refusal(val reason: ProjectRefusal) : IllegalStateException()
    private data class NativeResult(val outcome: ProjectOutcome, val effects: ProjectEffects?)
    private data class Clipboard(val identity: ProjectActorClipboard, val native: ProjectClipboard)
    private val gate = Any()
    private var listener: ((ProjectEffects) -> Unit)? = onEffects
    private val guardOwner = Any()
    private var clipboardEpoch: Any = Any()
    private var clipboard: Clipboard? = null
    private val generation = SecureRandom().let { random -> List(4) { random.nextInt().toLong() and 0xffffffffL } }
    private var nextId = 1L
    private var closed = false
    private var connected = false
    private var session: ProjectSession? = null
    private val tasks = linkedSetOf<Task>()
    private val authority = executor("orcaxr-project", 1)
    private val preparation = executor("orcaxr-prepare", 2)
    private val delivery = executor("orcaxr-effects", 1)
    private val startup = Task().also { it.phase = Phase.PREPARING; tasks.add(it) }
    val ready: ProjectRequest get() = startup.request

    private fun executor(name: String, count: Int) = ThreadPoolExecutor(
        count, count, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(maxPending + 1),
        ThreadFactory { runnable -> Thread(runnable, name).apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )

    private inner class Task : Runnable {
        var phase = Phase.QUEUED
        var work: Work? = null
        var prepared: Prepared? = null
        var preparationJob: Runnable? = null
        val scope = ProjectPreparation()
        var effects: ProjectEffects? = null
        var outcome: ProjectOutcome? = null
        var mayCommit = false
        var handoff: Prepared.Export? = null
        val request = ProjectRequest { cancel(this) }
        override fun run() = execute(this)
    }

    companion object {
        /** Factory owns its uploads in scope and returns a fresh, exclusive session
         * opened with the supplied nonce. It runs on a preparation worker. */
        fun open(
            factory: (ProjectPreparation, LongArray) -> ProjectSession,
            onEffects: (ProjectEffects) -> Unit,
            maxPending: Int = 32,
            staging: ProjectStagingPoolOptions = ProjectStagingPoolOptions(0, 0, 0, 0),
        ): ProjectActor {
            require(maxPending in 1..32)
            staging.encode()
            return ProjectActor(onEffects, maxPending, staging).also { it.initialize(factory) }
        }
    }

    private fun initialize(factory: (ProjectPreparation, LongArray) -> ProjectSession) {
        preparation.execute {
            try {
                val value = startup.scope.own(factory(startup.scope, generation.toLongArray()))
                // Warm immutable asset metadata before handing authority to its worker.
                value.assetFingerprint()
                synchronized(gate) {
                    if (closed) return@execute
                    session = startup.scope.transfer(value)
                    startup.work = Work.Message(capture(ProjectIntents.SessionOperation.Hello(ProjectIntents.Hello(1, 1, 1, 1))))
                    startup.phase = Phase.QUEUED
                    authority.execute(startup)
                }
            } catch (_: Throwable) { failConnection() }
            finally { startup.scope.close() }
        }
    }

    /** Captures mutable caller lists into bounded immutable ASCII before enqueueing.
     * Session control belongs to this owner; use request.cancel() or actor.close(). */
    fun submit(operation: ProjectIntents.SessionOperation): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (operation is ProjectIntents.SessionOperation.Hello || operation is ProjectIntents.SessionOperation.Close || operation is ProjectIntents.SessionOperation.Cancel || operation is ProjectIntents.SessionOperation.ExecuteStaged || operation is ProjectIntents.SessionOperation.ReleaseStaged) return refused(ProjectRefusal.INVALID_REQUEST)
        val wire = try { capture(operation) } catch (_: IllegalArgumentException) { return refused(ProjectRefusal.INVALID_REQUEST) }
        enqueue(Work.Message(wire))
    }

    /** Begins a guarded Open in submission order. Expensive admission runs outside
     * the authority; newer Opens, edits and disposal invalidate its final commit. */
    fun openDocument(prepare: (ProjectPreparation) -> ProjectDocument): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        enqueue(Work.Document(DocumentMode.OPEN, null) { scope, _ -> prepare(scope) })
    }

    /** Select from the borrowed immutable source on a preparation worker. The
     * returned object node is owned by the task. Copy publishes only if its
     * original guard still matches and no newer copy/clear has been requested.
     * Failed/cancelled replacement keeps the previously completed clipboard. */
    fun copyObject(expected: ProjectActorGuard, options: ProjectStagingClipboardOptions,
        select: (ProjectPreparation, ProjectSnapshot) -> ProjectQueryNode): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (expected.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        try { options.encode() } catch (_: IllegalArgumentException) { return refused(ProjectRefusal.INVALID_REQUEST) }
        clipboardEpoch = Any()
        enqueue(Work.Copy(expected, clipboardEpoch, options, select))
    }

    /** Ordered clear invalidates pending copies immediately. Already prepared
     * pastes retain their captured data; clearing never cancels an accepted edit. */
    fun clearClipboard(): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        clipboardEpoch = Any()
        enqueue(Work.ClearClipboard)
    }

    /** Complete immutable bundle export (or one plate's slice archive,
     * [ProjectExportSource.writePlateArchive]), without changing dirty state. The host
     * owns its destination and returns only after successful output handoff.
     * Cancellation refuses once the callback starts: external writes may already
     * have happened. Callback failure/close reports uncertainty and never retries. */
    fun exportDocument(expected: ProjectActorGuard, limits: ProjectExportLimits,
        write: (ProjectPreparation, ProjectExportSource) -> Unit): ProjectRequest = exportDocument(expected, limits, false, write)

    /** Manual save: acknowledge the captured identity only after complete handoff.
     * Concurrent edits keep the exported file valid but leave the project dirty.
     * History-only changes do not invalidate a successful save. */
    fun saveDocument(expected: ProjectActorGuard, limits: ProjectExportLimits,
        write: (ProjectPreparation, ProjectExportSource) -> Unit): ProjectRequest = exportDocument(expected, limits, true, write)

    private fun exportDocument(expected: ProjectActorGuard, limits: ProjectExportLimits, save: Boolean,
        write: (ProjectPreparation, ProjectExportSource) -> Unit): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (expected.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        try { limits.validate() } catch (_: IllegalArgumentException) { return refused(ProjectRefusal.INVALID_REQUEST) }
        enqueue(Work.Export(expected, limits, save, write))
    }

    /** Reset checks the caller's export identity before preparation and at commit.
     * History-only changes remain valid; a failed reset preserves pending Open. */
    fun resetDocument(expected: ProjectActorGuard, prepare: (ProjectPreparation) -> ProjectDocument): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (expected.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        enqueue(Work.Document(DocumentMode.RESET, expected) { scope, _ -> prepare(scope) })
    }

    /** "New project": a reset whose producer borrows a snapshot matching
     * [expected] — the project being replaced — and derives the new document
     * from it ([ProjectSnapshot.fresh]). Guarded and committed as [resetDocument]. */
    fun resetFromSnapshot(expected: ProjectActorGuard, prepare: (ProjectPreparation, ProjectSnapshot) -> ProjectDocument): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (expected.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        enqueue(Work.Document(DocumentMode.RESET, expected) { scope, snapshot -> prepare(scope, checkNotNull(snapshot)) })
    }

    /** Prepare a single command or atomic batch through the separate bulk contract.
     * Configure explicit finished-pool limits at open; the default disables staging.
     * The callback borrows a snapshot matching expected, writes bounded chunks and
     * returns. The actor seals on a preparation worker, then admits/executes exactly
     * once on the authority. No ready reference escapes to the caller. */
    fun prepareCommands(
        expected: ProjectActorGuard,
        bytes: Long,
        options: ProjectStagingInputOptions,
        write: (ProjectPreparation, ProjectSnapshot, ProjectCommandWriter) -> Unit,
    ): ProjectRequest = prepareCommands(expected, null, bytes, options, write)

    /** Commands that carry mesh payloads: the records are written and sealed as
     * above, then [assets] streams each payload the records declared, in the
     * order the writer reports. Unstreamed payloads fail the preparation. */
    fun prepareCommands(
        expected: ProjectActorGuard,
        bytes: Long,
        options: ProjectStagingInputOptions,
        write: (ProjectPreparation, ProjectSnapshot, ProjectCommandWriter) -> Unit,
        assets: (ProjectPreparation, ProjectAssetWriter) -> Unit,
    ): ProjectRequest = prepareCommands(expected, null, bytes, options, write, assets)

    /** Capture this clipboard's data on the authority before the producer starts.
     * Each paste binds a fresh destination guard and retains its own data even
     * after clipboard replacement/clear. The producer uses clipboardPaste work. */
    fun preparePaste(
        expected: ProjectActorGuard,
        clipboard: ProjectActorClipboard,
        bytes: Long,
        options: ProjectStagingInputOptions,
        write: (ProjectPreparation, ProjectSnapshot, ProjectCommandWriter) -> Unit,
    ): ProjectRequest = prepareCommands(expected, clipboard, bytes, options, write)

    private fun prepareCommands(
        expected: ProjectActorGuard, source: ProjectActorClipboard?, bytes: Long,
        options: ProjectStagingInputOptions,
        write: (ProjectPreparation, ProjectSnapshot, ProjectCommandWriter) -> Unit,
        assets: ((ProjectPreparation, ProjectAssetWriter) -> Unit)? = null,
    ): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (expected.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        if (source != null && (source.owner !== guardOwner || clipboard?.identity !== source)) return refused(ProjectRefusal.STALE)
        try {
            options.encode()
            require(bytes in 0..options.bytes)
        } catch (_: IllegalArgumentException) { return refused(ProjectRefusal.INVALID_REQUEST) }
        if (staging.resources == 0L || staging.commands == 0L || staging.inputUnits == 0L) return refused(ProjectRefusal.RESOURCE_LIMIT)
        enqueue(Work.Commands(expected, source, bytes, options, write, assets))
    }

    /** Capture the import base on the authority (the expected guard must be
     * export-current), then decode, stage and preview on a preparation worker,
     * e.g. `base.prepareModel(ProjectDocuments.stageModel(scope, …), …)`. */
    fun prepareImport(expected: ProjectActorGuard, prepare: (ProjectPreparation, ProjectImportBase) -> ProjectImportPreview): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (expected.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        enqueue(Work.Import(expected, prepare))
    }

    /** Commit a candidate from [prepareImport] with the operator's acknowledgements.
     * A blocked preview or missing acknowledgement refuses with UNCONFIRMED and a
     * changed base with STALE, keeping the candidate; success consumes it. */
    fun commitImport(candidate: ProjectActorImport, acknowledged: List<String>): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (candidate.owner !== guardOwner) return refused(ProjectRefusal.STALE)
        enqueue(Work.CommitImport(candidate, acknowledged.toList()))
    }

    /**
     * Reads the session on the authority, between operations, without
     * changing it: a renderer's deltas (`render`) and mesh packets. The read
     * must not mutate the project or keep the session; a handle it returns
     * (such as a mesh packet) is the caller's to close. Its failure is its
     * answer, never the actor's.
     */
    fun inspect(read: (ProjectSession) -> Any?): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        enqueue(Work.Inspect(read))
    }

    /**
     * Makes the slicing configuration [stage] describes the project's own, on
     * the authority: staged against the current project and executed as one
     * undoable "Update slicing configuration", answered as [ProjectOutcome.Completed]
     * — or [ProjectOutcome.SlicingUnchanged] / [ProjectOutcome.SlicingRefused]
     * with nothing recorded.
     */
    fun configureSlicing(stage: (ProjectSession) -> SlicingStage): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        enqueue(Work.Slicing(stage))
    }

    /**
     * Sets the session's selection (the browser's `SelectionStore.set`, behind
     * every click, tree row and Select All) to what [plan] chooses on the
     * authority, from the state and selection it reads there: in order, with
     * its primary (none, or one of the refs). Answered [ProjectOutcome.Selected]
     * with the selection effect delivered first, or [ProjectOutcome.NothingToDo]
     * when [plan] chose nothing. A choice the session refuses (a primary not
     * among the refs, more refs or text than a selection holds) or a plan that
     * fails refuses as INVALID_REQUEST; nothing changes then.
     */
    fun select(plan: (ProjectSession) -> ProjectSelectionChoice?): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        enqueue(Work.Select(plan))
    }

    /**
     * Stages one edit with [plan] on the authority — against the state and
     * selection it reads there and the guard captured for it — and executes
     * it at once (`executeStaged`), as the browser's staged edits run: the
     * browser's clone of the selected instance, say. Answered
     * [ProjectOutcome.Completed], or [ProjectOutcome.NothingToDo] when [plan]
     * staged nothing; a plan the session refuses (`invalid_request`, `stale`,
     * `resource_limit`) refuses with that reason and changes nothing.
     */
    fun stage(plan: (ProjectSession, ProjectGuard) -> ProjectStagedInput?): ProjectRequest = synchronized(gate) {
        refusal()?.let { return refused(it) }
        if (staging.resources == 0L || staging.commands == 0L || staging.inputUnits == 0L) return refused(ProjectRefusal.RESOURCE_LIMIT)
        enqueue(Work.Staged(plan))
    }

    /** A host plan's own refusals keep the connection: they are its answer, not a broken session. */
    private fun <T> planned(block: () -> T): T = try { block() }
    catch (failure: Refusal) { throw failure }
    catch (failure: IllegalStateException) {
        throw Refusal(when (failure.message) {
            "stale" -> ProjectRefusal.STALE
            "resource_limit" -> ProjectRefusal.RESOURCE_LIMIT
            "closed", "disposed" -> ProjectRefusal.CLOSED
            else -> ProjectRefusal.INVALID_REQUEST
        })
    }
    catch (_: IllegalArgumentException) { throw Refusal(ProjectRefusal.INVALID_REQUEST) }

    private fun choose(value: ProjectSession, plan: (ProjectSession) -> ProjectSelectionChoice?): NativeResult {
        val choice = planned { plan(value) } ?: return NativeResult(ProjectOutcome.NothingToDo, null)
        val primary = choice.primary?.let { primary -> choice.refs.indexOf(primary).also { if (it < 0) throw Refusal(ProjectRefusal.INVALID_REQUEST) } } ?: -1
        val effects = planned {
            value.captureGuard().use { guard ->
                val input = ProjectSelectionInput()
                try {
                    for (ref in choice.refs) {
                        val (kind, id) = selectionKey(ref)
                        input.add(kind, id)
                    }
                } catch (failure: Throwable) { input.close(); throw failure }
                // Consumes the input on every outcome.
                value.select(guard, input, primary.toLong())
            }
        }
        return try {
            NativeResult(ProjectOutcome.Selected(effects.count() > 0, ProjectProjection.DELIVERED), effects)
        } catch (failure: Throwable) { effects.close(); throw failure }
    }

    private fun selectionKey(ref: ProjectIntents.SelectionEntity): Pair<Int, CharArray> {
        fun chars(units: List<Int>) = CharArray(units.size) { units[it].toChar() }
        return when (ref) {
            is ProjectIntents.SelectionEntity.Project -> ProjectHost.SELECT_PROJECT to CharArray(0)
            is ProjectIntents.SelectionEntity.Plate -> ProjectHost.SELECT_PLATE to chars(ref.value)
            is ProjectIntents.SelectionEntity.Object -> ProjectHost.SELECT_OBJECT to chars(ref.value)
            is ProjectIntents.SelectionEntity.Volume -> ProjectHost.SELECT_VOLUME to chars(ref.value)
            is ProjectIntents.SelectionEntity.Instance -> ProjectHost.SELECT_INSTANCE to chars(ref.value)
            is ProjectIntents.SelectionEntity.LayerRange -> ProjectHost.SELECT_LAYER_RANGE to chars(ref.value)
            is ProjectIntents.SelectionEntity.Filament -> ProjectHost.SELECT_FILAMENT to chars(ref.value)
        }
    }

    private fun enqueue(work: Work) = Task().also { it.work = work; tasks.add(it); authority.execute(it) }.request
    private fun refusal(): ProjectRefusal? = when {
        closed -> ProjectRefusal.CLOSED
        !connected -> ProjectRefusal.NOT_READY
        tasks.size >= maxPending -> ProjectRefusal.BUSY
        else -> null
    }
    private fun refused(reason: ProjectRefusal) = ProjectRequest { false }.also { it.complete(ProjectOutcome.NotStarted(reason)) }
    private fun capture(operation: ProjectIntents.SessionOperation): String = ProjectIntents.encodeSessionRequest(ProjectIntents.SessionRequest(1, generation, 1, operation))

    private fun exchange(value: ProjectSession, wire: String): Pair<ProjectIntents.SessionReply, ProjectEffects> {
        check(nextId <= 9007199254740991L) { "request_limit" }
        val request = ProjectIntents.decodeSessionRequest(wire).copy(requestId = nextId++)
        val reply = value.submit(ProjectIntents.encodeSessionRequest(request)) ?: value.runNext() ?: error("missing_reply")
        return reply.use {
            val decoded = ProjectIntents.decodeSessionReply(it.wire())
            check(decoded.protocolVersion == 1 && decoded.generation == generation && decoded.requestId == request.requestId) { "invalid_reply" }
            if (request.operation is ProjectIntents.SessionOperation.Hello) {
                val welcome = (decoded.result as? ProjectIntents.SessionResult.Welcome)?.value ?: error("invalid_handshake")
                check(welcome.protocolVersion == 1 && welcome.projectSchemaVersion == 1L && welcome.intentVersion == 1 && welcome.maxPending >= maxPending && welcome.maxBytes == ProjectIntents.MAX_BYTES.toLong() && welcome.maxNodes == ProjectIntents.MAX_NODES.toLong()) { "invalid_handshake" }
            } else {
                val valid = when (decoded.result) {
                    is ProjectIntents.SessionResult.Error -> true
                    is ProjectIntents.SessionResult.Released -> request.operation is ProjectIntents.SessionOperation.ReleaseStaged
                    is ProjectIntents.SessionResult.Acknowledged, is ProjectIntents.SessionResult.ReceiptUnavailable -> request.operation !is ProjectIntents.SessionOperation.ReleaseStaged
                    else -> false
                }
                check(valid) { "invalid_reply" }
            }
            decoded to it.effects()
        }
    }

    /** Only known pre-publication refusals keep the connection usable. */
    private fun <T> preflight(block: () -> T): T = try { block() }
    catch (failure: IllegalStateException) {
        when (failure.message) {
            "stale" -> throw Refusal(ProjectRefusal.STALE)
            "resource_limit" -> throw Refusal(ProjectRefusal.RESOURCE_LIMIT)
            else -> throw failure
        }
    }

    private fun captureAuthority(value: ProjectSession): ProjectActorGuard = value.snapshot().use { snapshot ->
        ProjectActorGuard(guardOwner, snapshot.revision(), value.historyRevision(), value.assetFingerprint())
    }

    private fun optionalAuthority(value: ProjectSession): ProjectActorGuard? =
        try { captureAuthority(value) } catch (_: IllegalStateException) { null }

    private fun replyAuthority(value: ProjectSession, reply: ProjectIntents.SessionReply): ProjectActorGuard? {
        val acknowledged = reply.result as? ProjectIntents.SessionResult.Acknowledged
        if (acknowledged != null) {
            val guard = acknowledged.value.guard
            return ProjectActorGuard(guardOwner, guard.revision, guard.historyRevision, String(CharArray(guard.assetFingerprint.size) { guard.assetFingerprint[it].toChar() }))
        }
        // A post-commit resource limit must not turn a confirmed native result
        // into an uncertain or failed mutation. This proof owns no native handle.
        return optionalAuthority(value)
    }

    private fun checkGuard(value: ProjectSession, expected: ProjectActorGuard, export: Boolean) {
        val current = captureAuthority(value)
        if (expected.owner !== guardOwner || current.revision != expected.revision || current.assets != expected.assets ||
            (!export && current.historyRevision != expected.historyRevision)) throw Refusal(ProjectRefusal.STALE)
    }

    /** Capture native guards/immutable inputs on the authority before offloading. */
    private fun planPreparation(task: Task, value: ProjectSession, work: Work): () -> Prepared {
        task.scope.checkActive()
        return when (work) {
            is Work.Export -> {
                checkGuard(value, work.expected, true)
                val guard = task.scope.own(value.captureGuard())
                val captured = task.scope.own(value.captureExport(guard))
                val project = task.scope.own(captured.project())
                ({
                    val source = preflight { ProjectExportSource(task.scope, captured, project, work.limits) }
                    try {
                        synchronized(gate) {
                            if (closed || task.phase != Phase.PREPARING) throw Refusal(ProjectRefusal.CANCELLED)
                            task.phase = Phase.EXPORTING
                            task.mayCommit = true
                        }
                        work.write(task.scope, source)
                        source.requireComplete(work.save)
                        val handoff = Prepared.Export(work.expected, guard, work.save)
                        synchronized(gate) {
                            if (task.phase == Phase.EXPORTING) task.handoff = handoff
                        }
                        handoff
                    } finally { source.invalidate() }
                })
            }
            is Work.Copy -> {
                checkGuard(value, work.expected, false)
                val guard = task.scope.own(value.captureGuard())
                val input = task.scope.own(value.clipboardInput(guard, work.options))
                val snapshot = task.scope.own(value.snapshot())
                ({
                    task.scope.checkActive()
                    val node = task.scope.own(work.select(task.scope, snapshot))
                    val captured = task.scope.own(preflight { input.capture(node) })
                    Prepared.Copy(work.epoch, guard, captured, captured.info())
                })
            }
            is Work.Document -> {
                if (work.expected != null) checkGuard(value, work.expected, true)
                val ticket = if (work.mode == DocumentMode.OPEN) task.scope.own(value.beginOpen()) else null
                val guard = if (work.mode == DocumentMode.RESET) task.scope.own(value.captureGuard()) else null
                val snapshot = if (work.mode == DocumentMode.RESET) task.scope.own(value.snapshot()) else null
                ({
                    task.scope.checkActive()
                    Prepared.Document(work.mode, task.scope.own(work.produce(task.scope, snapshot)), ticket, guard)
                })
            }
            is Work.Commands -> {
                checkGuard(value, work.expected, false)
                val guard = task.scope.own(value.captureGuard())
                val upload = task.scope.own(preflight {
                    if (work.clipboard == null) value.commandUpload(guard, work.bytes, work.options)
                    else {
                        val source = synchronized(gate) { clipboard?.takeIf { it.identity === work.clipboard } }
                            ?: throw Refusal(ProjectRefusal.STALE)
                        value.clipboardUpload(guard, source.native, work.bytes, work.options)
                    }
                })
                val snapshot = task.scope.own(value.snapshot())
                ({
                    task.scope.checkActive()
                    val writer = ProjectCommandWriter(task.scope, upload, work.bytes)
                    try {
                        work.write(task.scope, snapshot, writer)
                        writer.finish()
                    } finally { writer.invalidate() }
                    work.assets?.let { stream ->
                        val payloads = ProjectAssetWriter(task.scope, upload)
                        try { stream(task.scope, payloads) } finally { payloads.invalidate() }
                    }
                    // Every payload the records declared must have arrived.
                    require(upload.assetCount() == 0L) { "incomplete_input" }
                    Prepared.Commands(upload)
                })
            }
            is Work.Import -> {
                checkGuard(value, work.expected, true)
                val base = task.scope.own(value.importBase())
                ({
                    task.scope.checkActive()
                    Prepared.Import(task.scope.own(work.prepare(task.scope, base)))
                })
            }
            is Work.Message, Work.ClearClipboard, is Work.CommitImport, is Work.Inspect, is Work.Slicing, is Work.Select, is Work.Staged ->
                error("unexpected_preparation")
        }
    }

    private fun acknowledged(value: ProjectSession, message: Pair<ProjectIntents.SessionReply, ProjectEffects>): NativeResult = try {
        NativeResult(ProjectOutcome.Completed(message.first, ProjectProjection.DELIVERED, replyAuthority(value, message.first)), message.second)
    } catch (failure: Throwable) { message.second.close(); throw failure }

    private fun commit(task: Task, value: ProjectSession, prepared: Prepared): NativeResult = when (prepared) {
        is Prepared.Export -> {
            var effects: ProjectEffects? = null
            val checkpoint = if (!prepared.save) ProjectCheckpoint.NOT_REQUESTED else try {
                if (!value.isExportCurrent(prepared.guard)) ProjectCheckpoint.STALE else {
                    effects = value.acknowledgeCheckpoint(prepared.guard)
                    ProjectCheckpoint.SAVED
                }
            } catch (_: IllegalStateException) { ProjectCheckpoint.UNAVAILABLE }
            NativeResult(ProjectOutcome.Exported(prepared.source, checkpoint, ProjectProjection.DELIVERED), effects)
        }
        is Prepared.Copy -> {
            if (!value.isCurrent(prepared.guard)) throw Refusal(ProjectRefusal.STALE)
            synchronized(gate) {
                if (closed || task.phase != Phase.EXECUTING) throw Refusal(ProjectRefusal.CLOSED)
                if (prepared.epoch !== clipboardEpoch) throw Refusal(ProjectRefusal.STALE)
                val identity = ProjectActorClipboard(guardOwner, prepared.info)
                val owned = task.scope.transfer(prepared.clipboard)
                val previous = clipboard
                clipboard = Clipboard(identity, owned)
                previous?.native?.close()
                NativeResult(ProjectOutcome.Copied(identity, ProjectProjection.DELIVERED), null)
            }
        }
        is Prepared.Import -> {
            val preview = prepared.preview.json()
            val blocked = prepared.preview.blocked()
            synchronized(gate) {
                if (closed || task.phase != Phase.EXECUTING) throw Refusal(ProjectRefusal.CLOSED)
                val native = task.scope.transfer(prepared.preview)
                NativeResult(ProjectOutcome.ImportPrepared(ProjectActorImport(guardOwner, preview, blocked, native), ProjectProjection.DELIVERED), null)
            }
        }
        is Prepared.Commands -> {
            var result: NativeResult? = null
            try {
                preflight { value.stageCommands(prepared.upload) }.use { ready ->
                    result = acknowledged(value, exchange(value, capture(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(ready.id)))))
                }
                checkNotNull(result)
            } catch (failure: Throwable) { result?.effects?.close(); throw failure }
        }
        is Prepared.Document -> {
            val effects = preflight {
                when (prepared.mode) {
                    DocumentMode.OPEN -> value.finishOpen(checkNotNull(prepared.ticket), prepared.document)
                    DocumentMode.RESET -> value.resetDocument(checkNotNull(prepared.guard), prepared.document)
                }
            }
            try {
                // Adoption is already confirmed. Its effects can occupy the last
                // registry slot, leaving no capacity for the optional summary.
                val query = try { exchange(value, capture(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty))) }
                    catch (failure: IllegalStateException) {
                        if (failure.message != "resource_limit") throw failure
                        null
                    }
                query?.second?.close()
                val authority = if (query != null) replyAuthority(value, query.first) else optionalAuthority(value)
                val outcome = when (val result = query?.first?.result) {
                    is ProjectIntents.SessionResult.Acknowledged -> if (prepared.mode == DocumentMode.OPEN)
                        ProjectOutcome.Opened(result.value.guard, result.value.history, ProjectProjection.DELIVERED, authority)
                        else ProjectOutcome.Reset(result.value.guard, result.value.history, ProjectProjection.DELIVERED, authority)
                    null, is ProjectIntents.SessionResult.ReceiptUnavailable -> if (prepared.mode == DocumentMode.OPEN)
                        ProjectOutcome.OpenedWithoutSummary(ProjectProjection.DELIVERED, authority)
                        else ProjectOutcome.ResetWithoutSummary(ProjectProjection.DELIVERED, authority)
                    else -> error("missing_document_receipt")
                }
                NativeResult(outcome, effects)
            } catch (failure: Throwable) { effects.close(); throw failure }
        }
    }

    private fun execute(task: Task) {
        val value: ProjectSession
        val work: Work?
        val prepared: Prepared?
        val preparing: Boolean
        synchronized(gate) {
            if (closed || task.phase !in listOf(Phase.QUEUED, Phase.COMMIT)) return
            value = session ?: return
            work = task.work
            prepared = task.prepared
            preparing = prepared == null && work !is Work.Message && work != Work.ClearClipboard && work !is Work.CommitImport &&
                work !is Work.Inspect && work !is Work.Slicing && work !is Work.Select && work !is Work.Staged
            task.phase = if (preparing) Phase.PREPARING else Phase.EXECUTING
            task.mayCommit = !preparing && task !== startup && prepared !is Prepared.Copy && prepared !is Prepared.Import &&
                work != Work.ClearClipboard && work !is Work.Inspect
            task.work = null
        }
        try {
            if (preparing) {
                val planned = preflight { planPreparation(task, value, checkNotNull(work)) }
                synchronized(gate) {
                    if (task.phase != Phase.PREPARING) return
                    val job = Runnable { runPreparation(task, planned) }
                    task.preparationJob = job
                    preparation.execute(job)
                }
                return
            }
            val result = if (prepared != null) commit(task, value, prepared) else if (work is Work.CommitImport) {
                if (work.candidate.owner !== guardOwner) throw Refusal(ProjectRefusal.STALE)
                val effects = try { value.commitImport(work.candidate.native, work.acknowledged) }
                    catch (failure: IllegalStateException) {
                        throw when (failure.message) {
                            "stale" -> Refusal(ProjectRefusal.STALE)
                            "import_blocked", "missing_acknowledgements" -> Refusal(ProjectRefusal.UNCONFIRMED)
                            // The caller closed or already committed this candidate.
                            "closed", "invalid_state" -> Refusal(ProjectRefusal.CANCELLED)
                            else -> failure
                        }
                    }
                try {
                    work.candidate.close()
                    NativeResult(ProjectOutcome.Imported(ProjectProjection.DELIVERED, optionalAuthority(value)), effects)
                } catch (failure: Throwable) { effects.close(); throw failure }
            } else if (work is Work.Slicing) {
                when (val stage = preflight { work.stage(value) }) {
                    SlicingStage.Unchanged -> NativeResult(ProjectOutcome.SlicingUnchanged, null)
                    is SlicingStage.Refused -> NativeResult(ProjectOutcome.SlicingRefused(stage.code, stage.message), null)
                    is SlicingStage.Staged -> stage.input.use { ready ->
                        acknowledged(value, exchange(value, capture(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(ready.id)))))
                    }
                }
            } else if (work is Work.Select) {
                choose(value, work.plan)
            } else if (work is Work.Staged) {
                val staged = planned { value.captureGuard().use { guard -> work.plan(value, guard) } }
                staged?.use { ready ->
                    acknowledged(value, exchange(value, capture(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(ready.id)))))
                } ?: NativeResult(ProjectOutcome.NothingToDo, null)
            } else if (work is Work.Inspect) {
                // A read's own failure is its answer: it never ends the connection.
                NativeResult(ProjectOutcome.Inspected(runCatching { work.read(value) }), null)
            } else if (work == Work.ClearClipboard) {
                synchronized(gate) {
                    clipboard?.native?.close()
                    clipboard = null
                }
                NativeResult(ProjectOutcome.ClipboardCleared(ProjectProjection.DELIVERED), null)
            } else {
                if (task === startup) value.configureStaging(staging)
                val message = exchange(value, (work as Work.Message).wire)
                acknowledged(value, message)
            }
            synchronized(gate) {
                if (task.phase != Phase.EXECUTING) { result.effects?.close(); return }
                task.effects = result.effects
                queueDelivery(task, result.outcome)
            }
        } catch (failure: Throwable) {
            if (synchronized(gate) { task.phase == Phase.DELIVERY || task.phase == Phase.DONE }) return
            if (failure is Refusal) settle(task, ProjectOutcome.NotStarted(failure.reason)) else failConnection()
        } finally { if (!preparing) task.scope.close() }
    }

    private fun runPreparation(task: Task, prepare: () -> Prepared) {
        try {
            val input = prepare()
            synchronized(gate) {
                if (task.phase != Phase.PREPARING && task.phase != Phase.EXPORTING) return
                task.prepared = input
                task.phase = Phase.COMMIT
                task.preparationJob = null
                authority.execute(task)
            }
        } catch (failure: Throwable) {
            val activeExport = synchronized(gate) { task.phase == Phase.EXPORTING }
            settle(task, if (activeExport) ProjectOutcome.Uncertain else
                ProjectOutcome.NotStarted(if (failure is Refusal) failure.reason else ProjectRefusal.PREPARATION_FAILED))
        }
    }

    private fun cancel(task: Task): Boolean = synchronized(gate) {
        if (task === startup) return false
        if (task.handoff != null) return false
        if (task.phase !in listOf(Phase.QUEUED, Phase.PREPARING, Phase.COMMIT)) return false
        queueDelivery(task, ProjectOutcome.NotStarted(ProjectRefusal.CANCELLED))
        true
    }
    private fun settle(task: Task, outcome: ProjectOutcome) = synchronized(gate) {
        if (task.phase != Phase.DELIVERY && task.phase != Phase.DONE) queueDelivery(task, outcome)
    }
    /** gate held. There is one delivery runnable per admitted task, including close. */
    private fun queueDelivery(task: Task, outcome: ProjectOutcome) {
        task.outcome = outcome
        task.phase = Phase.DELIVERY
        task.work = null
        task.prepared = null
        task.handoff = null
        authority.remove(task)
        task.preparationJob?.let { preparation.remove(it) }
        task.preparationJob = null
        task.scope.close()
        delivery.execute { deliver(task) }
    }

    private fun deliver(task: Task) {
        val (effects, notify) = synchronized(gate) { task.effects to listener }
        var projection = ProjectProjection.DELIVERED
        try { effects?.use { if (it.count() > 0) notify?.invoke(it) } }
        catch (_: Throwable) { projection = ProjectProjection.FAILED }
        val result = synchronized(gate) {
            task.effects = null
            val outcome = checkNotNull(task.outcome)
            task.outcome = null
            task.phase = Phase.DONE
            tasks.remove(task)
            if (task === startup && outcome is ProjectOutcome.Completed && !closed) connected = true
            val delivered = if (closed) ProjectProjection.CLOSED else projection
            when (outcome) {
                is ProjectOutcome.Exported -> outcome.copy(projection = delivered)
                is ProjectOutcome.Copied -> outcome.copy(projection = delivered)
                is ProjectOutcome.ClipboardCleared -> outcome.copy(projection = delivered)
                is ProjectOutcome.Completed -> outcome.copy(projection = delivered)
                is ProjectOutcome.Opened -> outcome.copy(projection = delivered)
                is ProjectOutcome.OpenedWithoutSummary -> outcome.copy(projection = delivered)
                is ProjectOutcome.Reset -> outcome.copy(projection = delivered)
                is ProjectOutcome.ResetWithoutSummary -> outcome.copy(projection = delivered)
                is ProjectOutcome.ImportPrepared -> outcome.copy(projection = delivered)
                is ProjectOutcome.Imported -> outcome.copy(projection = delivered)
                is ProjectOutcome.Selected -> outcome.copy(projection = delivered)
                else -> outcome
            }
        }
        task.request.complete(result)
    }

    private fun failConnection() = close()
    override fun close() {
        synchronized(gate) {
            if (closed) return
            closed = true
            connected = false
            listener = null
            clipboard?.native?.close()
            clipboard = null
            session?.close()
            session = null
            tasks.toList().forEach { task ->
                task.effects?.close()
                task.effects = null
                if (task.phase != Phase.DELIVERY) {
                    val handoff = task.handoff
                    queueDelivery(task, if (handoff != null) ProjectOutcome.Exported(handoff.source,
                        if (handoff.save) ProjectCheckpoint.UNAVAILABLE else ProjectCheckpoint.NOT_REQUESTED, ProjectProjection.CLOSED)
                    else if (task.mayCommit) ProjectOutcome.Uncertain else ProjectOutcome.NotStarted(ProjectRefusal.CLOSED))
                }
            }
            authority.shutdownNow()
            preparation.shutdownNow()
            delivery.shutdown()
        }
    }
}
