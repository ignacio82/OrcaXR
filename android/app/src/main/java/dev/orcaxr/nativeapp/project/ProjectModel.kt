package dev.orcaxr.nativeapp.project

import android.app.ActivityManager
import android.app.Application
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.ContentProjectDocument
import dev.orcaxr.core.DigestingDocument
import dev.orcaxr.core.DocumentOwners
import dev.orcaxr.core.ProjectActorImport
import dev.orcaxr.core.ProjectArchiveFormat
import dev.orcaxr.core.ProjectDocumentOutput
import dev.orcaxr.core.ProjectRecovery
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.RecentDocuments
import dev.orcaxr.nativeapp.device.PreferencesTextStore
import dev.orcaxr.renderer.SceneSync
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject

/** A prepared import as the dialog shows it: the objects the project will have and every change the operator must accept. */
class PendingImport(
    val filename: String,
    /** Objects in the project once imported (the preview counts the result, not the additions). */
    val objects: Int,
    val notices: List<String>,
    val blocked: Boolean,
    internal val candidate: ProjectActorImport,
    internal val acknowledgements: List<String>,
)

/** Something that would discard unsaved changes, held until the operator decides. */
class PendingDiscard(val name: String, internal val action: () -> Unit)

/** How the operator answers [PendingDiscard]: save first and go on, go on without saving, or stay. */
enum class DiscardAnswer { Save, Discard, Cancel }

/** A save that would overwrite changes made to the document outside OrcaXR, held until the operator decides. */
class PendingConflict(val name: String, internal val uri: Uri, internal val then: (() -> Unit)?)

/** How the operator answers [PendingConflict]: replace the outside changes, save a copy elsewhere, or stay. */
enum class ConflictAnswer { Overwrite, SaveAs, Cancel }

/**
 * The Project area's host adapter: it owns the [ProjectWorkspace], runs
 * provider reads and writes on one worker thread, keeps recently used
 * documents with their persisted grants, and publishes the workspace's
 * [ProjectView] projection to Compose on the main thread.
 */
class ProjectModel(application: Application) : AndroidViewModel(application) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "project-model") }
    private val resolver = application.contentResolver
    private val recentStore = RecentDocuments(PreferencesTextStore(application, "orcaxr.projects", "recent"))
    /** Unsaved work kept for a session the system ends; in private storage, excluded from backups. */
    private val recovery = ProjectRecovery(File(application.filesDir, "recovery"))
    private lateinit var workspace: ProjectWorkspace
    private var subscription: AutoCloseable? = null
    /** The document "Save" writes to: one this app saved, or an opened one in OrcaXR's own
     * canonical package (writing it back loses nothing); never a foreign 3MF it would convert. */
    private var savedUri: Uri? = null
    /** What [savedUri] held when this window last read or wrote it, to notice changes made outside. */
    private var knownDigest: String? = null
    /** The task this window lives in, so another window can bring it forward. */
    var taskId: Int = -1
    /** This window, as the holder of the document it opened or saved to. */
    val owner = DocumentOwners.Owner {
        val tasks = getApplication<Application>().getSystemService(ActivityManager::class.java).appTasks
        tasks.firstOrNull { it.taskInfo?.taskId == taskId }?.moveToFront()
    }
    private val owners = DocumentOwners.process
    private var held: String? = null
    /** The renderer's view of the session, kept in step with it; its listeners live on the main thread. */
    @Volatile private var sceneSync: SceneSync? = null
    private val sceneListeners = LinkedHashSet<(SceneSync.Update) -> Unit>()

    var view by mutableStateOf(ProjectView())
        private set
    var busy by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var recent by mutableStateOf(recentStore.entries)
        private set
    var pendingImport by mutableStateOf<PendingImport?>(null)
        private set
    /** Unsaved work earlier sessions left, newest first, for the operator to restore or discard. */
    var recoveries by mutableStateOf<List<ProjectRecovery.Entry>>(emptyList())
        private set
    var pendingDiscard by mutableStateOf<PendingDiscard?>(null)
        private set
    var pendingConflict by mutableStateOf<PendingConflict?>(null)
        private set
    /** Set while the screen should ask where to save before going on with [afterSave]. */
    var saveAsRequested by mutableStateOf(false)
        private set
    private var afterSave: (() -> Unit)? = null
    /** The view whose changes the operator discarded: not to be kept again as the app leaves. */
    private var discarded: ProjectView? = null
    /** The system's share sheet for a copy of the project, for the screen to show once. */
    var shareRequest by mutableStateOf<Intent?>(null)
        private set

    init {
        work {
            workspace = ProjectWorkspace(recovery = recovery)
            val sync = SceneSync(workspace) { update -> main.post { sceneListeners.toList().forEach { it(update) } } }
            sceneSync = sync
            subscription = workspace.subscribe {
                main.post { view = workspace.view }
                sync.request()
            }
            sync.request()
            workspace.ready().get()
            publishRecoveries()
            main.post { view = workspace.view }
        }
    }

    private fun cause(failure: Throwable): Throwable =
        if ((failure is ExecutionException || failure is CompletionException) && failure.cause != null) cause(failure.cause!!) else failure

    /** Runs [task] on the worker, showing the area as busy and any failure as a message. */
    private fun work(task: () -> Unit) {
        main.post { busy = true }
        worker.execute {
            try {
                task()
            } catch (failure: Throwable) {
                val reason = cause(failure)
                main.post { message = reason.message ?: reason.javaClass.simpleName }
            } finally {
                main.post { busy = false }
            }
        }
    }

    private fun <T> CompletableFuture<T>.await(): T = get()

    private fun displayName(uri: Uri): String = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
        }
    } catch (_: RuntimeException) {
        null
    } ?: uri.lastPathSegment ?: "document"

    /** Keeps access to [uri] across restarts, as far as its provider allows, and lists it first. */
    private fun remember(uri: Uri, name: String) {
        for (flags in listOf(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )) {
            if (runCatching { resolver.takePersistableUriPermission(uri, flags) }.isSuccess) break
        }
        for (dropped in recentStore.used(uri.toString(), name)) {
            runCatching {
                resolver.releasePersistableUriPermission(
                    Uri.parse(dropped.uri), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                )
            }
        }
        val entries = recentStore.entries
        main.post { recent = entries }
    }

    /** Runs [action] now, or once the operator agrees to discard unsaved changes. */
    private fun unlessDirty(action: () -> Unit) {
        if (view.dirty) pendingDiscard = PendingDiscard(view.name, action) else action()
    }

    /** Leaving the app (Back) with unsaved changes asks first, as New and Open do. */
    fun leave(finish: () -> Unit) = unlessDirty(finish)

    private fun publishRecoveries() {
        val earlier = recovery.list().filter { it.session != workspace.session }
        main.post { recoveries = earlier }
    }

    /** Restores unsaved work an earlier session left; the copy stays until it is discarded. */
    fun restore(entry: ProjectRecovery.Entry) = unlessDirty {
        work {
            workspace.restore(entry).await()
            savedUri = null
            hold(null)
            main.post { message = "Restored ${entry.projectName}. Save it to keep it." }
        }
    }

    fun discardRecovered(entry: ProjectRecovery.Entry) = work {
        recovery.discard(entry.session)
        publishRecoveries()
    }

    /** Keeps the unsaved work now, as the app leaves the screen: the system may end it there. */
    fun captureNow() {
        // Not the very state the operator chose to discard: that is gone on purpose. Any
        // other way of leaving — a closed window, the app swiped away — keeps the work.
        if (view.dirty && view != discarded && ::workspace.isInitialized) work { workspace.captureRecovery().await() }
    }

    fun answerDiscard(answer: DiscardAnswer) {
        val pending = pendingDiscard ?: return
        pendingDiscard = null
        when (answer) {
            DiscardAnswer.Cancel -> Unit
            DiscardAnswer.Discard -> {
                // The changes are dropped, and their recovery copy with them.
                discarded = view
                work { workspace.discardRecovery() }
                pending.action()
            }
            DiscardAnswer.Save -> {
                val target = savedUri
                if (target != null) {
                    // Goes on only once the save is confirmed; a failed save leaves the project as it was.
                    saveChecked(target, pending.action)
                } else {
                    afterSave = pending.action
                    saveAsRequested = true
                }
            }
        }
    }

    /** Where the operator chose to save before going on; none (the picker dismissed) keeps everything as it was. */
    fun saveAsAnswered(uri: Uri?) {
        saveAsRequested = false
        val next = afterSave
        afterSave = null
        if (uri == null || next == null) return
        work {
            saveDocument(uri)
            main.post { next() }
        }
    }

    fun dismissMessage() {
        message = null
    }

    fun newProject() = unlessDirty {
        work {
            workspace.newProject().await()
            savedUri = null
            hold(null)
        }
    }

    /** Opens a document the operator picked; it joins the recent documents. */
    fun open(uri: Uri) = unlessDirty {
        work {
            val name = displayName(uri)
            claimed(uri) {
                val document = DigestingDocument(ContentProjectDocument(resolver, uri), null)
                val format = workspace.open(document, name).await()
                adopt(uri, format, document.digest)
            }
            remember(uri, name)
        }
    }

    /** Opens a recent document; one whose access is gone is forgotten. */
    fun openRecent(entry: RecentDocuments.Entry) = unlessDirty {
        work {
            val uri = Uri.parse(entry.uri)
            val document = DigestingDocument(ContentProjectDocument(resolver, uri), null)
            val format = try {
                claimed(uri) { workspace.open(document, entry.name).await() }
            } catch (failure: Throwable) {
                val reason = cause(failure).message.orEmpty()
                if ("document_permission" in reason || "document_unavailable" in reason) {
                    recentStore.forget(entry.uri)
                    val entries = recentStore.entries
                    main.post { recent = entries }
                    throw IllegalStateException("${entry.name} is no longer available to OrcaXR; it was removed from recent documents.")
                }
                throw failure
            }
            adopt(uri, format, document.digest)
            remember(uri, entry.name)
        }
    }

    /**
     * Opens a document another app handed over (view or share). It is
     * untrusted input: only a content URI is accepted, read through the same
     * bounded Open as any document, and its one-time grant is not kept.
     */
    fun openIncoming(uri: Uri) {
        if (uri.scheme != "content") {
            message = "OrcaXR opens only documents shared through the system."
            return
        }
        unlessDirty {
            work {
                workspace.open(ContentProjectDocument(resolver, uri), displayName(uri)).await()
                // A one-time grant: this window does not write it back, so it holds nothing.
                savedUri = null
                hold(null)
            }
        }
    }

    /** Saves to the document "Save as" created; returns false when there is none yet. */
    fun save(): Boolean {
        val target = savedUri ?: return false
        saveChecked(target, null)
        return true
    }

    /** "Save as" to a document the operator picked; refused when another window holds it. */
    fun saveTo(uri: Uri) = work { claimed(uri) { saveDocument(uri) } }

    /**
     * Saves to [uri] — the document this window holds — unless it changed
     * outside OrcaXR since it was last read or written here: then the
     * operator decides first. [then] runs once the save is confirmed.
     */
    private fun saveChecked(uri: Uri, then: (() -> Unit)?) = work {
        val known = knownDigest
        val current = known?.let { DigestingDocument.current(ContentProjectDocument(resolver, uri)) }
        if (known != null && current != known) {
            val name = displayName(uri)
            main.post { pendingConflict = PendingConflict(name, uri, then) }
            return@work
        }
        saveDocument(uri)
        then?.let { main.post(it) }
    }

    fun answerConflict(answer: ConflictAnswer) {
        val pending = pendingConflict ?: return
        pendingConflict = null
        when (answer) {
            ConflictAnswer.Cancel -> Unit
            ConflictAnswer.Overwrite -> work {
                saveDocument(pending.uri)
                pending.then?.let { main.post(it) }
            }
            ConflictAnswer.SaveAs -> {
                afterSave = pending.then ?: {}
                saveAsRequested = true
            }
        }
    }

    /** Saves to [uri] on the worker; it becomes the document "Save" writes to, held by this window. */
    private fun saveDocument(uri: Uri) {
        val name = displayName(uri)
        val document = DigestingDocument(null, ContentProjectDocument(resolver, uri))
        workspace.save(document, name).await()
        savedUri = uri
        knownDigest = document.digest
        hold(uri)
        remember(uri, name)
        main.post { message = "Saved $name." }
    }

    /**
     * Runs [work] holding [uri] for this window. When another window holds
     * it, that window is brought forward and nothing is done here: a document
     * never gets a second writer. A claim the work did not keep is released.
     */
    private fun <T> claimed(uri: Uri, work: () -> T): T {
        val document = uri.toString()
        val previous = held
        owners.claim(document, owner)?.let { other ->
            main.post { other.focus() }
            throw IllegalStateException("That document is open in another OrcaXR window, which was brought forward.")
        }
        return try {
            work()
        } catch (failure: Throwable) {
            if (previous != document) owners.release(document, owner)
            throw failure
        }
    }

    /** The document an Open adopted: held by this window, saved back only in OrcaXR's own format. */
    private fun adopt(uri: Uri, format: ProjectArchiveFormat, digest: String?) {
        savedUri = uri.takeIf { format == ProjectArchiveFormat.CANONICAL }
        hold(uri)
        knownDigest = digest
    }

    /** Holds [uri] (or nothing) as this window's document, releasing the one held before. */
    private fun hold(uri: Uri?) {
        val document = uri?.toString()
        held?.takeIf { it != document }?.let { owners.release(it, owner) }
        held = document
        if (document == null) knownDigest = null
    }

    /**
     * Shares a copy of the project as a 3MF: written to the app's shared cache
     * (replacing the copy shared before) and offered through the system's
     * share sheet with a one-time read grant. The project's saved state is
     * untouched.
     */
    fun share() = work {
        val context = getApplication<Application>()
        val folder = SharedProjects.folder(context).apply { mkdirs() }
        folder.listFiles()?.forEach { it.delete() }
        val name = workspace.view.name.ifBlank { "Untitled project" }.replace(UNSAFE_NAME, "_").take(100) + ".3mf"
        val file = File(folder, name)
        workspace.export(object : ProjectDocumentOutput {
            override fun openOutput() = file.outputStream()
        }).await()
        val uri = SharedProjects.uri(context, file)
        val send = Intent(Intent.ACTION_SEND).setType("model/3mf").putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // The grant travels with the clip, so the chosen app may read the copy once.
        send.clipData = ClipData.newRawUri(name, uri)
        main.post { shareRequest = Intent.createChooser(send, null) }
    }

    fun shareShown() {
        shareRequest = null
    }

    /** Prepares a model import and shows its preview; nothing changes until it is accepted. */
    fun importModel(uri: Uri) = work {
        val filename = displayName(uri)
        val candidate = workspace.prepareImport(ContentProjectDocument(resolver, uri), filename).await()
        val preview = JSONObject(candidate.preview)
        val notices = buildList {
            for (field in listOf("repairs", "conflicts", "droppedFields", "diagnostics")) {
                val list = preview.optJSONArray(field) ?: continue
                for (index in 0 until list.length()) {
                    val notice = list.optJSONObject(index) ?: continue
                    notice.optString("message").takeIf { it.isNotEmpty() }?.let(::add)
                }
            }
        }
        val required = preview.optJSONArray("requiredAcknowledgementIds")
        val acknowledgements = List(required?.length() ?: 0) { required!!.getString(it) }
        val objects = preview.optJSONObject("counts")?.optInt("objects") ?: 0
        main.post { pendingImport = PendingImport(filename, objects, notices, candidate.blocked, candidate, acknowledgements) }
    }

    /** Accepts the previewed import with every change it listed, or drops it. */
    fun answerImport(accept: Boolean) {
        val pending = pendingImport ?: return
        pendingImport = null
        work {
            pending.candidate.use { candidate ->
                if (accept) workspace.commitImport(candidate, pending.acknowledgements).await()
            }
        }
    }

    fun undo() = work { workspace.undo().await() }
    fun redo() = work { workspace.redo().await() }

    /** Undo from the keyboard; answers whether there was a step to undo. */
    fun undoShortcut(): Boolean = (view.undo != null && !busy).also { if (it) undo() }

    /** Redo from the keyboard; answers whether there was a step to redo. */
    fun redoShortcut(): Boolean = (view.redo != null && !busy).also { if (it) redo() }

    /**
     * Listens to the renderer's view of the project on the main thread: first
     * everything known (once the session started), then each change.
     */
    fun listenScene(listener: (SceneSync.Update) -> Unit): AutoCloseable {
        sceneListeners += listener
        sceneSync?.snapshot { everything -> main.post { if (listener in sceneListeners) listener(everything) } }
        return AutoCloseable { sceneListeners -= listener }
    }

    override fun onCleared() {
        sceneSync?.close()
        worker.execute {
            owners.releaseAll(owner)
            subscription?.close()
            pendingImport?.candidate?.close()
            if (::workspace.isInitialized) workspace.close()
        }
        worker.shutdown()
    }
}

/** Characters a file name on a receiving device may not hold. */
private val UNSAFE_NAME = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]")
