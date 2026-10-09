package dev.orcaxr.nativeapp.project

import android.app.Application
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
import dev.orcaxr.core.ProjectActorImport
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.RecentDocuments
import dev.orcaxr.nativeapp.device.PreferencesTextStore
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
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
    private lateinit var workspace: ProjectWorkspace
    private var subscription: AutoCloseable? = null
    /** The document "Save" writes to: one this app created or saved, never an opened foreign file. */
    private var savedUri: Uri? = null

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
    var pendingDiscard by mutableStateOf<PendingDiscard?>(null)
        private set

    init {
        work {
            workspace = ProjectWorkspace()
            subscription = workspace.subscribe { main.post { view = workspace.view } }
            workspace.ready().get()
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

    fun answerDiscard(discard: Boolean) {
        val pending = pendingDiscard ?: return
        pendingDiscard = null
        if (discard) pending.action()
    }

    fun dismissMessage() {
        message = null
    }

    fun newProject() = unlessDirty {
        work {
            workspace.newProject().await()
            savedUri = null
        }
    }

    /** Opens a document the operator picked; it joins the recent documents. */
    fun open(uri: Uri) = unlessDirty {
        work {
            val name = displayName(uri)
            workspace.open(ContentProjectDocument(resolver, uri), name).await()
            savedUri = null
            remember(uri, name)
        }
    }

    /** Opens a recent document; one whose access is gone is forgotten. */
    fun openRecent(entry: RecentDocuments.Entry) = unlessDirty {
        work {
            val uri = Uri.parse(entry.uri)
            try {
                workspace.open(ContentProjectDocument(resolver, uri), entry.name).await()
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
            savedUri = null
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
                savedUri = null
            }
        }
    }

    /** Saves to the document "Save as" created; returns false when there is none yet. */
    fun save(): Boolean {
        val target = savedUri ?: return false
        saveTo(target)
        return true
    }

    fun saveTo(uri: Uri) = work {
        val name = displayName(uri)
        workspace.save(ContentProjectDocument(resolver, uri), name).await()
        savedUri = uri
        remember(uri, name)
        main.post { message = "Saved $name." }
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

    override fun onCleared() {
        worker.execute {
            subscription?.close()
            pendingImport?.candidate?.close()
            if (::workspace.isInitialized) workspace.close()
        }
        worker.shutdown()
    }
}
