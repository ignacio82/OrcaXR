package dev.orcaxr.core

import java.time.ZoneId
import java.util.concurrent.CompletableFuture

/** What the Project area shows: a projection of the session, never a second copy of the project. */
data class ProjectView(
    val ready: Boolean = false,
    val name: String = "",
    val plates: Int = 0,
    val dirty: Boolean = false,
    /** The next undo's and redo's labels, when there is one. */
    val undo: String? = null,
    val redo: String? = null,
    /** The object tree's first page, as the browser's tree labels it. */
    val rows: List<ProjectIntents.ObjectTreeRow> = emptyList(),
    val totalRows: Long = 0,
    /** The document the project was opened from or last saved to, by its display name. */
    val document: String? = null,
)

/** An operation the session refused or could not confirm, in an operator's words. */
class ProjectFailure(message: String) : Exception(message)

/**
 * The Project area's session, as the browser's workspace runs its project:
 * one [ProjectActor] owning the native session, started with the browser's
 * empty project, and every operation through it — "New project" (keeping the
 * printer, base profile and physical tools), Open and Save through document
 * providers, model import (prepared, previewed, then committed as one undoable
 * entry with every required acknowledgement), undo and redo. The [view] is
 * rebuilt from the session's own effects and history; nothing here holds a
 * second copy of the project. Listeners hear every change.
 */
class ProjectWorkspace(
    private val clock: () -> Long = System::currentTimeMillis,
    private val words: () -> DoubleArray = { NewProjects.words() },
    private val resolver: LocalTimestampResolver = ProjectTimeZone(ZoneId.systemDefault()),
) : AutoCloseable {
    companion object {
        /** The browser's archive budgets: its safe-ZIP defaults and multi-million facets. */
        val ARCHIVE = ProjectArchiveOptions(1L shl 30, 4096, 512L shl 20, 2L shl 30, 16_000_000, 16_000_000,
            2_000_000, 64L shl 20, 256_000_000, 4096, 512L shl 20, 2L shl 30, 1_000_000)
        val EXPORT = ProjectExportLimits(512L shl 20, 4096, 2L shl 30)
        /** Where an imported model lands without a printer profile: the browser's 200 mm plate. */
        val PLACEMENT = ProjectModelPlacement(200.0, 200.0, dropToBed = true)
        /** The tree's largest page (the browser renders it in windows of this size). */
        private const val TREE_PAGE = 64L
        private const val MAX_NAME_UNITS = 256L
    }

    private val lock = Any()
    private val listeners = LinkedHashSet<() -> Unit>()
    @Volatile var view = ProjectView()
        private set

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun update(change: (ProjectView) -> ProjectView) {
        synchronized(lock) { view = change(view) }
        for (listener in synchronized(lock) { listeners.toList() }) listener()
    }

    fun subscribe(listener: () -> Unit): AutoCloseable {
        synchronized(lock) { listeners += listener }
        return AutoCloseable { synchronized(lock) { listeners -= listener } }
    }

    /** A canonical document as an upload's prepared document. */
    private fun document(scope: ProjectPreparation, bytes: ByteArray): ProjectDocument {
        val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 4096, 512L shl 20, 2L shl 30, 100, 64L shl 20)
        val upload = scope.own(ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM))
        upload.appendDocument(0, bytes)
        upload.sealDocument()
        return upload.prepare()
    }

    /** The project's name and object tree, from the snapshot a project effect carries. */
    private fun read(snapshot: ProjectSnapshot) {
        val (name, plates) = snapshot.query().use { root ->
            val length = minOf(root.textLength(QueryText.NAME) ?: 0, MAX_NAME_UNITS)
            String(root.text(QueryText.NAME, 0, length)) to (root.metadata().values[QueryNumber.PLATE_COUNT] ?: 0.0).toInt()
        }
        fun page(expansion: ProjectIntents.ObjectTreeExpansion) = (snapshot.objectTree(
            ProjectIntents.ObjectTreeRequest(
                expansion, emptyList(), emptyList(),
                ProjectIntents.OptionalSelectionEntity.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                ProjectIntents.ObjectTreeOperation.Page(ProjectIntents.ObjectTreePageRequest(0, TREE_PAGE)),
            ),
        ) as? ProjectIntents.ObjectTreeReply.Page)?.value
        // Plates open, so their objects show; objects stay closed.
        val plateKeys = page(ProjectIntents.ObjectTreeExpansion.Default(ProjectIntents.Empty))?.rows.orEmpty()
            .filter { it.kind == ProjectIntents.ObjectTreeRowKind.Plate }.map { it.key }
        val page = page(ProjectIntents.ObjectTreeExpansion.Keys(plateKeys))
        update { it.copy(name = name, plates = plates, rows = page?.rows.orEmpty(), totalRows = page?.totalRows ?: 0) }
    }

    private fun effects(effects: ProjectEffects) {
        for (position in (effects.count() - 1) downTo 0) {
            if (effects.kind(position) == ProjectHost.EFFECT_PROJECT) {
                effects.project(position, false).use(::read)
                return
            }
        }
    }

    val actor: ProjectActor = ProjectActor.open({ scope, nonce ->
        val bytes = NewProjects.empty(words(), NewProjects.timestamp(clock()))
        val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 4096, 512L shl 20, 2L shl 30, 100, 64L shl 20)
        val upload = scope.own(ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM))
        upload.appendDocument(0, bytes)
        upload.sealDocument()
        val session = upload.open(nonce)
        // The first view, before any effect.
        session.snapshot().use(::read)
        session
    }, ::effects)

    private fun outcome(request: ProjectRequest): CompletableFuture<ProjectOutcome> = request.completion.toCompletableFuture()

    /** The session's guards and history now, refreshing the view's history. */
    private fun query(): CompletableFuture<Pair<ProjectIntents.SessionAcknowledgement, ProjectActorGuard>> =
        outcome(actor.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty))).thenApply { result ->
            val completed = result as? ProjectOutcome.Completed ?: throw failure(result, null)
            val state = (completed.reply.result as? ProjectIntents.SessionResult.Acknowledged)?.value ?: throw ProjectFailure("The project did not answer.")
            val history = state.history
            fun label(present: Boolean, value: ProjectIntents.DisplayLabel) = if (present && value.present) text(value.text) else if (present) "" else null
            update {
                it.copy(
                    ready = true, dirty = history.dirtyCategories.isNotEmpty(),
                    undo = label(history.undoCount > 0, history.undoLabel), redo = label(history.redoCount > 0, history.redoLabel),
                )
            }
            state to (completed.authority ?: throw ProjectFailure("The project did not answer."))
        }

    /** Waits for the session to start and reads its first view. */
    fun ready(): CompletableFuture<ProjectView> = outcome(actor.ready).thenCompose { query() }.thenApply { view }

    private fun failure(outcome: ProjectOutcome, cause: Throwable?): ProjectFailure = ProjectFailure(
        when (outcome) {
            is ProjectOutcome.NotStarted -> when (outcome.reason) {
                ProjectRefusal.BUSY -> "The project is busy; try again when the current operation finishes."
                ProjectRefusal.STALE -> "The project changed meanwhile; try again."
                ProjectRefusal.UNCONFIRMED -> "Confirm every listed change before importing."
                ProjectRefusal.RESOURCE_LIMIT -> "The project is too large for this device."
                ProjectRefusal.CANCELLED -> "Cancelled."
                ProjectRefusal.PREPARATION_FAILED, ProjectRefusal.INVALID_REQUEST ->
                    cause?.message?.let { "OrcaXR could not read it ($it)." } ?: "OrcaXR could not read it."
                ProjectRefusal.NOT_READY, ProjectRefusal.CLOSED -> "The project is not open."
            }
            ProjectOutcome.Uncertain -> cause?.message?.let { "It may not have completed ($it)." } ?: "It may not have completed."
            else -> "Unexpected answer from the project."
        },
    )

    /** Runs [start] with the current guard, refreshing the history once it ends; [cause] holds a producer's failure. */
    private fun <T> run(
        start: (ProjectActorGuard, (Throwable) -> Unit) -> ProjectRequest,
        accept: (ProjectOutcome) -> T?,
    ): CompletableFuture<T> {
        var cause: Throwable? = null
        return query().thenCompose { (_, guard) -> outcome(start(guard) { cause = it }) }
            .thenCompose { result -> query().handle { _, _ -> result } }
            .thenApply { result -> accept(result) ?: throw failure(result, cause) }
    }

    private fun <T> capturing(record: (Throwable) -> Unit, work: () -> T): T = try {
        work()
    } catch (failure: Throwable) {
        record(failure)
        throw failure
    }

    /** "New project": a clean project keeping the printer, base profile and physical tools. */
    fun newProject(): CompletableFuture<Unit> = run({ guard, record ->
        actor.resetFromSnapshot(guard) { scope, snapshot ->
            capturing(record) { document(scope, snapshot.fresh(words(), NewProjects.timestamp(clock()))) }
        }
    }) { result ->
        if (result is ProjectOutcome.Reset || result is ProjectOutcome.ResetWithoutSummary) update { it.copy(document = null) } else null
    }

    /** Opens a project document (3MF, canonical or foreign) in place of the current project; answers its format. */
    fun open(input: ProjectDocumentInput, name: String): CompletableFuture<ProjectArchiveFormat> {
        var format: ProjectArchiveFormat? = null
        return run({ _, record ->
            actor.openDocument { scope ->
                capturing(record) {
                    ProjectDocuments.prepare(scope, input, ARCHIVE, resolver, ProjectIntegerProfile.CHROMIUM).let { prepared ->
                        format = prepared.format()
                        prepared.document()
                    }
                }
            }
        }) { result ->
            if (result is ProjectOutcome.Opened || result is ProjectOutcome.OpenedWithoutSummary) {
                update { it.copy(document = name) }
                format
            } else {
                null
            }
        }
    }

    /** Saves the project as a 3MF document; the checkpoint is acknowledged once the provider accepted it. */
    fun save(output: ProjectDocumentOutput, name: String): CompletableFuture<Unit> = run({ guard, record ->
        actor.saveDocument(guard, EXPORT) { _, source -> capturing(record) { ProjectDocuments.save(source, output, ARCHIVE) } }
    }) { result ->
        if (result is ProjectOutcome.Exported) update { it.copy(document = name) } else null
    }

    /** Writes a copy of the project as a 3MF document (to share it); the project's saved state is untouched. */
    fun export(output: ProjectDocumentOutput): CompletableFuture<Unit> = run({ guard, record ->
        actor.exportDocument(guard, EXPORT) { _, source -> capturing(record) { ProjectDocuments.save(source, output, ARCHIVE) } }
    }) { result -> if (result is ProjectOutcome.Exported) Unit else null }

    /** Prepares a model import (STL/OBJ/AMF/ZIP) against the current project; nothing changes until it is committed. */
    fun prepareImport(input: ProjectDocumentInput, filename: String): CompletableFuture<ProjectActorImport> = run({ guard, record ->
        actor.prepareImport(guard) { scope, base ->
            capturing(record) {
                val upload = ProjectDocuments.stageModel(scope, input, ProjectModelImportOptions(), resolver, ProjectIntegerProfile.CHROMIUM)
                base.prepareModel(upload, filename, NewProjects.timestamp(clock()), PLACEMENT)
            }
        }
    }) { result -> (result as? ProjectOutcome.ImportPrepared)?.candidate }

    /** Commits a prepared import as one undoable entry, with the acknowledgements its preview requires. */
    fun commitImport(candidate: ProjectActorImport, acknowledged: List<String>): CompletableFuture<Unit> =
        outcome(actor.commitImport(candidate, acknowledged))
            .thenCompose { result -> query().handle { _, _ -> result } }
            .thenApply { result -> if (result is ProjectOutcome.Imported) Unit else throw failure(result, null) }

    private fun step(undo: Boolean): CompletableFuture<Unit> = query().thenCompose { (state, _) ->
        val operation = if (undo) ProjectIntents.SessionOperation.Undo(state.guard) else ProjectIntents.SessionOperation.Redo(state.guard)
        outcome(actor.submit(operation))
    }.thenCompose { result -> query().handle { _, _ -> result } }.thenApply { result ->
        if (result is ProjectOutcome.Completed) Unit else throw failure(result, null)
    }

    fun undo(): CompletableFuture<Unit> = step(true)
    fun redo(): CompletableFuture<Unit> = step(false)

    override fun close() {
        actor.close()
        synchronized(lock) { listeners.clear() }
    }
}

/**
 * Recently used documents, newest first: at most [MAX] entries, one per
 * document, kept as text in a [DeviceTextStore]. Only an identifier the
 * platform resolves (a document URI) and its display name are kept; an entry
 * the platform no longer grants access to is forgotten when it fails.
 */
class RecentDocuments(private val store: DeviceTextStore) {
    companion object {
        const val MAX = 8
        private const val SEPARATOR = '\u0000'
    }

    data class Entry(val uri: String, val name: String)

    val entries: List<Entry>
        get() = store.read().orEmpty().split('\n').mapNotNull { line ->
            val parts = line.split(SEPARATOR)
            if (parts.size == 2 && parts[0].isNotEmpty()) Entry(parts[0], parts[1]) else null
        }.distinctBy { it.uri }.take(MAX)

    private fun write(entries: List<Entry>) = store.write(entries.joinToString("\n") { "${it.uri}$SEPARATOR${it.name}" })

    /** Records [uri] as the newest; returns the entries that fell off the end, whose grants can be released. */
    fun used(uri: String, name: String): List<Entry> {
        val clean = name.filter { it != SEPARATOR && it != '\n' }
        val all = listOf(Entry(uri, clean)) + entries.filter { it.uri != uri }
        write(all.take(MAX))
        return all.drop(MAX)
    }

    fun forget(uri: String) = write(entries.filter { it.uri != uri })
}
