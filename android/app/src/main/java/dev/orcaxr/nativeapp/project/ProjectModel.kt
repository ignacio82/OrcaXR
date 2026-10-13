package dev.orcaxr.nativeapp.project

import android.app.ActivityManager
import android.app.Application
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.neverEqualPolicy
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.ActionArrangement
import dev.orcaxr.core.ActionPresentation
import dev.orcaxr.core.BrimEarAuto
import dev.orcaxr.core.BrimEarClear
import dev.orcaxr.core.BrimEarState
import dev.orcaxr.core.ContentProjectDocument
import dev.orcaxr.core.Diagnostics
import dev.orcaxr.core.ProjectArchiveExport
import dev.orcaxr.core.StlExport
import dev.orcaxr.core.DigestingDocument
import dev.orcaxr.core.DocumentOwners
import dev.orcaxr.core.GizmoMode
import dev.orcaxr.core.GizmoPose
import dev.orcaxr.core.HelperVolumeRole
import dev.orcaxr.core.MeasurePick
import dev.orcaxr.core.MeasurePickResult
import dev.orcaxr.core.MeasureReadout
import dev.orcaxr.core.ModelToolStatus
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PrimitiveShape
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectActorImport
import dev.orcaxr.core.ProjectArchiveFormat
import dev.orcaxr.core.ProjectBrimEars
import dev.orcaxr.core.ProjectDocumentOutput
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectMeasures
import dev.orcaxr.core.ProjectPlateArchive
import dev.orcaxr.core.ProjectPlatePreflight
import dev.orcaxr.core.ProjectRecovery
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.RecentDocuments
import dev.orcaxr.core.SimplifyConfiguration
import dev.orcaxr.core.SimplifyPreview
import dev.orcaxr.core.SimplifyPreviewResult
import dev.orcaxr.core.SlicePlan
import dev.orcaxr.core.SliceScope
import dev.orcaxr.core.SlicingSlots
import dev.orcaxr.core.SlotEdit
import dev.orcaxr.core.SplitConfirmation
import dev.orcaxr.core.TransformFieldEdit
import dev.orcaxr.core.TransformGizmo
import dev.orcaxr.core.TransformProxy
import dev.orcaxr.core.TransformReset
import dev.orcaxr.core.TransformTool
import dev.orcaxr.core.VirtualFilamentEdit
import dev.orcaxr.core.VirtualFilamentForm
import dev.orcaxr.core.VirtualFilamentLibrary
import dev.orcaxr.core.VirtualFilamentLibraryResult
import dev.orcaxr.core.VirtualFilamentOperation
import dev.orcaxr.core.VirtualFilamentRow
import dev.orcaxr.core.VirtualFilamentSearch
import dev.orcaxr.core.VirtualFilaments
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.device.PreferencesTextStore
import dev.orcaxr.nativeapp.exports.DiagnosticsLog
import dev.orcaxr.nativeapp.prepare.PlateSource
import dev.orcaxr.nativeapp.shell.AppActions
import dev.orcaxr.nativeapp.workspace.DrawnPartModel
import dev.orcaxr.nativeapp.workspace.PaintModel
import dev.orcaxr.renderer.CameraView
import dev.orcaxr.renderer.PacketMeshes
import dev.orcaxr.renderer.SceneSync
import dev.orcaxr.renderer.TriangleMesh
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.Future
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

/** A camera view asked of the Workspace's 3D view; [serial] tells one choice from the next of the same view. */
data class CameraRequest(val view: CameraView, val serial: Int)

/**
 * The Project area's host adapter: it owns the [ProjectWorkspace], runs
 * provider reads and writes on one worker thread, keeps recently used
 * documents with their persisted grants, and publishes the workspace's
 * [ProjectView] projection to Compose on the main thread. Prepare slices
 * through it ([PlateSource]), never through a second session.
 */
class ProjectModel(application: Application) : AndroidViewModel(application), PlateSource {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "project-model") }
    private val resolver = application.contentResolver
    private val recentStore = RecentDocuments(PreferencesTextStore(application, "orcaxr.projects", "recent"))
    /** Unsaved work kept for a session the system ends; in private storage, excluded from backups. */
    private val recovery = ProjectRecovery(File(application.filesDir, "recovery"))
    private lateinit var workspace: ProjectWorkspace
    /** The workspace, once the worker made it. */
    private val started = CompletableFuture<ProjectWorkspace>()
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

    override var view by mutableStateOf(ProjectView())
        private set
    var busy by mutableStateOf(false)
        private set
    /** Work handed to the worker and not yet finished (main thread); [busy] while there is any. */
    private var running = 0
    /** Files dropped on the window and not yet loaded: one at a time, as the browser's intake loop. */
    private val dropped = ArrayDeque<DropIntake.Item>()
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
    /** The printer, process and filament profiles the project slices with. */
    var profilesView by mutableStateOf(ProfilesView())
        private set
    private val profiles = SlicingProfiles(application) { next -> main.post { profilesView = next } }
    /** The project's filament slots the pickers last followed. */
    @Volatile private var followed: SlicingSlots? = null

    /** The inspector's settings panels (a node's settings, an object's height ranges) over this project's session. */
    val inspector = InspectorModel(object : InspectorModel.Host {
        override fun workspace(): ProjectWorkspace? = started.getNow(null)
    })

    /** Shows the project's [next] view; an open inspector panel follows it. Main thread. */
    private fun show(next: ProjectView) {
        view = next
        inspector.projectChanged(next)
    }

    /** The Workspace's Emboss Text and SVG Part tools over this project's session. */
    val drawn = DrawnPartModel(object : DrawnPartModel.Host {
        override fun workspace(): ProjectWorkspace = workspace
        override fun work(task: () -> Unit) = this@ProjectModel.work(task)
        override fun quietly(task: () -> Unit) = this@ProjectModel.quietly(task)
        override fun read(uri: Uri, limit: Int): Pair<String, ByteArray?> = displayName(uri) to readAtMost(uri, limit)
        override fun words(id: Int): String = this@ProjectModel.words(id)
        override fun message(text: String) {
            message = text
        }
        override fun otherToolsOff() {
            layFlat(false)
            if (measuring) measure(false)
            if (brimEaring) brimEars(false)
            if (paint.state.active) paint.stop()
        }
    })

    /** A picked document's bytes, or none when it holds more than [limit]. Worker thread. */
    private fun readAtMost(uri: Uri, limit: Int): ByteArray? =
        (resolver.openInputStream(uri) ?: throw java.io.IOException("That file could not be opened")).use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                out.write(buffer, 0, read)
                if (out.size() > limit) return@use null
            }
            out.toByteArray()
        }

    /** The Workspace's paint tool over this project's session and scene. */
    val paint = PaintModel(object : PaintModel.Host {
        override fun workspace(): ProjectWorkspace? = started.getNow(null)
        override fun scene(): SceneSync? = sceneSync
        override fun view(): ProjectView = view
    })

    init {
        work {
            workspace = ProjectWorkspace(recovery = recovery)
            val sync = SceneSync(workspace) { update -> main.post { sceneListeners.toList().forEach { it(update) } } }
            sceneSync = sync
            subscription = workspace.subscribe {
                main.post { show(workspace.view) }
                sync.request()
                refreshToolbar()
                // The Prepare pickers follow the project's filaments through edits, undo and redo.
                val slots = workspace.view.filamentSlots
                if (slots != followed) {
                    followed = slots
                    worker.execute { profiles.follow(slots) }
                }
            }
            sync.request()
            started.complete(workspace)
            workspace.ready().get()
            publishRecoveries()
            main.post { show(workspace.view) }
            // The browser's new document starts from the remembered or default catalog profile.
            profiles.start(workspace)
        }
    }

    private fun cause(failure: Throwable): Throwable =
        if ((failure is ExecutionException || failure is CompletionException) && failure.cause != null) cause(failure.cause!!) else failure

    /** Runs [task] on the worker, showing the area as busy and any failure as a message. Main thread. */
    private fun work(task: () -> Unit) {
        running++
        busy = true
        worker.execute {
            try {
                task()
            } catch (failure: Throwable) {
                val reason = cause(failure)
                DiagnosticsLog.recordError("project", reason)
                main.post { message = reason.message ?: reason.javaClass.simpleName }
            } finally {
                // After what the task posted: a dialog it raised is up before the next dropped file is considered.
                main.post {
                    running--
                    busy = running > 0
                    advance()
                }
            }
        }
    }

    /**
     * Loads files dropped on the window, after any dropped before: each model
     * through the import preview, each project through Open (asking first
     * about unsaved changes, as any Open does). One that another window holds
     * brings that window forward instead.
     */
    fun intake(files: List<DropIntake.Item>) {
        dropped.addAll(files)
        advance()
    }

    /** Starts the next dropped file once nothing runs and nothing waits for the operator; one that starts nothing gives way to the next. */
    private fun advance() {
        while (running == 0 && pendingImport == null && pendingDiscard == null && pendingConflict == null && !saveAsRequested) {
            val next = dropped.removeFirstOrNull() ?: return
            val uri = Uri.parse(next.uri)
            when (next.kind) {
                DropIntake.Kind.Model -> importModel(uri)
                DropIntake.Kind.Project -> {
                    val holder = owners.holder(next.uri)
                    if (holder != null && holder !== owner) holder.focus() else openIncoming(uri)
                }
                // Preview opens G-code; the shell never queues it here.
                DropIntake.Kind.Gcode -> Unit
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
            profiles.opened(workspace)
            savedUri = null
            hold(null)
            main.post { message = "Restored ${entry.projectName}. Save it to keep it." }
        }
    }

    fun discardRecovered(entry: ProjectRecovery.Entry) = work {
        recovery.discard(entry.session)
        publishRecoveries()
    }

    /**
     * Keeps the unsaved work now, as the app leaves the screen: the system may end it there.
     * Answers the capture, settled once it is written or has failed, for the leaving activity
     * to wait on; null when there is nothing to keep.
     */
    fun captureNow(): Future<Unit>? {
        // Not the very state the operator chose to discard: that is gone on purpose. Any
        // other way of leaving — a closed window, the app swiped away — keeps the work.
        if (!view.dirty || view == discarded || !::workspace.isInitialized) return null
        val captured = CompletableFuture<Unit>()
        work {
            try {
                workspace.captureRecovery().await()
            } finally {
                captured.complete(Unit)
            }
        }
        return captured
    }

    fun answerDiscard(answer: DiscardAnswer) {
        val pending = pendingDiscard ?: return
        pendingDiscard = null
        when (answer) {
            DiscardAnswer.Cancel -> advance()
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
        if (uri == null || next == null) return advance()
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
                profiles.opened(workspace)
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
            profiles.opened(workspace)
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
            message = DropIntake.NOT_SHARED
            return
        }
        unlessDirty {
            work {
                workspace.open(ContentProjectDocument(resolver, uri), displayName(uri)).await()
                profiles.opened(workspace)
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
            ConflictAnswer.Cancel -> advance()
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

    /** The plate's slice preflight as the project stands ([ProjectWorkspace.preflight]), against
     * the chosen profile — or the project's own configuration while an opened project owns it. */
    override fun preflight(plateId: String): CompletableFuture<ProjectPlatePreflight> =
        started.thenCompose { it.preflight(plateId, profiles::target) }

    /** Chooses a printer; its processes and filaments are reconciled as the browser's pickers do. */
    fun chooseMachine(id: String) = work { profiles.select(workspace, machine = id) }
    fun chooseProcess(id: String) = work { profiles.select(workspace, process = id) }
    /** Chooses head [index]'s filament (the first is the profile's own). */
    fun chooseFilament(index: Int, id: String) = work { profiles.selectHead(workspace, index, id) }

    // ---- The project's filaments: the Filaments list and the selection filament bar ----

    /** Adds a filament slot (the browser's "+"), one undoable step; past sixteen it is refused in the browser's words. */
    fun addFilament() = work { profiles.editSlot(workspace, SlotEdit.Add) }
    /** Removes extra palette slot [index] (the browser's Del). */
    fun removeFilament(index: Int) = work { profiles.editSlot(workspace, SlotEdit.Remove(index)) }
    /** Slot [index]'s colour, `#rrggbb`. */
    fun recolorFilament(index: Int, color: String) = work { profiles.editSlot(workspace, SlotEdit.Color(index, color)) }
    /** Head [index]'s nozzle. */
    fun setFilamentNozzle(index: Int, nozzle: String) = work { profiles.editSlot(workspace, SlotEdit.Nozzle(index, nozzle)) }

    /** What the selection filament bar's last press did, as the bar says it. */
    var filamentStatus by mutableStateOf<Filaments.Status?>(null)
        private set

    /**
     * The selection filament bar's press: [filamentId] (null: the object
     * default) for every scope the selection can assign, as one undoable step;
     * the bar says what happened, a refusal in the browser's words.
     */
    fun assignFilament(filamentId: String?, name: String) {
        filamentStatus = Filaments.Status.Assigning
        work {
            val failure = runCatching { workspace.assignFilament(filamentId).await() }.exceptionOrNull()?.let(::cause)
            main.post { filamentStatus = Filaments.finished(filamentId, name, failure) }
        }
    }

    // ---- The virtual filament library ----

    /** The shared core's dialog exchanges. */
    private val dialogs = object : VirtualFilamentDialogs.Exchange {
        override fun opening(library: VirtualFilamentLibrary, operation: VirtualFilamentOperation, filamentId: String?) =
            VirtualFilaments.opening(library, operation, filamentId)
        override fun validate(library: VirtualFilamentLibrary, form: VirtualFilamentForm, search: VirtualFilamentSearch?) =
            VirtualFilaments.validate(library, form, search)
    }
    /** The pinned Match search's thread (the browser's search worker). */
    private val searches = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "virtual-filament-search") }
    private var searchToken = 0L

    /** The open author dialog, if any (main thread). */
    var virtualAuthor by mutableStateOf<VirtualFilamentDialogs.Author?>(null)
        private set
    /** The open delete dialog, if any. */
    var virtualDelete by mutableStateOf<VirtualFilamentDialogs.Delete?>(null)
        private set
    /** What the library's last operation reported, instead of its own status. */
    var virtualStatus by mutableStateOf<VirtualFilamentDialogs.Status?>(null)
        private set
    /** Why the library's last enable or disable changed nothing. */
    var virtualFailure by mutableStateOf<VirtualFilamentDialogs.Failure?>(null)
        private set
    /** An enable or disable in flight. */
    var virtualBusy by mutableStateOf(false)
        private set

    private fun shownLibrary(): VirtualFilamentLibrary? = (view.virtualFilaments as? VirtualFilamentLibraryResult.Shown)?.library

    /** Opens the author dialog for [operation] on [row] (none when adding), its fields as the browser opens them. */
    fun openVirtualFilament(operation: VirtualFilamentOperation, row: VirtualFilamentRow?) {
        if (virtualAuthor != null || virtualDelete != null) return
        val library = shownLibrary() ?: return
        virtualAuthor = runCatching { VirtualFilamentDialogs.open(dialogs, library, view.revision, operation, row) }
            .onFailure { message = it.message }.getOrNull()
        startSearch()
    }

    /** The author dialog's fields as typed: validated by the core again, its Match search kept, cancelled or started. */
    fun typeVirtualFilament(form: VirtualFilamentForm) {
        val dialog = virtualAuthor ?: return
        if (dialog.busy) return
        virtualAuthor = VirtualFilamentDialogs.typed(dialogs, dialog, form)
        startSearch()
    }

    /** The triangle picker touched at view-box point ([x], [y]): its proportions written into the fields. */
    fun pickTriangle(x: Double, y: Double) {
        val dialog = virtualAuthor ?: return
        val weights = VirtualFilaments.triangleWeights(x, y) ?: return
        typeVirtualFilament(dialog.form.copy(ratioTriangle = weights))
    }

    /** Closes the author dialog; its search, if running, is dropped. */
    fun closeVirtualFilament() {
        if (virtualAuthor?.busy == true) return
        virtualAuthor = null
        searchToken++
    }

    /** Starts the search the dialog's fields ask for, after the browser's debounce; the newest wins. */
    private fun startSearch() {
        val dialog = virtualAuthor ?: return
        val request = VirtualFilamentDialogs.searchToStart(dialog) ?: return
        if (VirtualFilamentDialogs.stale(dialog.revision, view.revision)) return
        val token = ++searchToken
        virtualAuthor = VirtualFilamentDialogs.searching(dialogs, dialog, request, token)
        val library = dialog.library
        main.postDelayed({
            if (virtualAuthor?.search?.token != token) return@postDelayed
            searches.execute {
                val outcome = runCatching { VirtualFilaments.search(library, request) }
                main.post { virtualAuthor = virtualAuthor?.let { VirtualFilamentDialogs.searched(dialogs, it, token, outcome) } }
            }
        }, VirtualFilamentDialogs.SEARCH_DEBOUNCE_MS)
    }

    /** Submits the author dialog's draft as one undoable step; a refusal stays in the dialog, in the browser's words. */
    fun submitVirtualFilament() {
        val dialog = virtualAuthor ?: return
        if (!VirtualFilamentDialogs.canSubmit(dialog, view.revision)) return
        val edit = VirtualFilamentDialogs.edit(dialog) ?: return
        val name = VirtualFilamentDialogs.draftName(dialog)
        virtualAuthor = dialog.copy(busy = true, error = null)
        work {
            val failure = runCatching { workspace.changeVirtualFilament(edit).await() }.exceptionOrNull()?.let(::cause)
            main.post {
                if (failure == null) {
                    virtualAuthor = null
                    virtualFailure = null
                    virtualStatus = VirtualFilamentDialogs.Status.Accepted(dialog.operation, name)
                } else {
                    virtualAuthor = virtualAuthor?.copy(busy = false, error = failure.message ?: failure.javaClass.simpleName)
                }
            }
        }
    }

    /** Enables or disables [row] as one undoable step, the library saying so (or why not). */
    fun toggleVirtualFilament(row: VirtualFilamentRow) {
        if (virtualBusy) return
        val enabling = !row.enabled
        virtualFailure = null
        virtualBusy = true
        virtualStatus = VirtualFilamentDialogs.Status.Toggling(enabling, row.name)
        work {
            val failure = runCatching { workspace.changeVirtualFilament(VirtualFilamentEdit.SetEnabled(row.id, enabling)).await() }
                .exceptionOrNull()?.let(::cause)
            main.post {
                virtualBusy = false
                if (failure == null) {
                    virtualStatus = VirtualFilamentDialogs.Status.Toggled(enabling, row.name)
                } else {
                    virtualStatus = null
                    virtualFailure = VirtualFilamentDialogs.Failure.Toggle(row.name, failure.message ?: failure.javaClass.simpleName)
                }
            }
        }
    }

    /** Opens the delete dialog for [row]. */
    fun askDeleteVirtualFilament(row: VirtualFilamentRow) {
        if (virtualAuthor != null || virtualDelete != null) return
        virtualDelete = VirtualFilamentDialogs.Delete(row, view.revision)
    }

    /** Closes the delete dialog. */
    fun closeDeleteVirtualFilament() {
        if (virtualDelete?.busy == true) return
        virtualDelete = null
    }

    /** Deletes the dialog's row as one undoable step: removed when unreferenced, else a tombstone keeping its references. */
    fun deleteVirtualFilament() {
        val dialog = virtualDelete ?: return
        if (dialog.busy || VirtualFilamentDialogs.stale(dialog.revision, view.revision)) return
        virtualDelete = dialog.copy(busy = true, error = null)
        work {
            val failure = runCatching { workspace.changeVirtualFilament(VirtualFilamentEdit.Delete(dialog.row.id)).await() }
                .exceptionOrNull()?.let(::cause)
            main.post {
                if (failure == null) {
                    virtualDelete = null
                    virtualFailure = null
                    virtualStatus = VirtualFilamentDialogs.Status.Deleted(dialog.row.name)
                } else {
                    virtualDelete = virtualDelete?.copy(busy = false, error = failure.message ?: failure.javaClass.simpleName)
                }
            }
        }
    }

    /** The plate's one-plate slice archive ([ProjectWorkspace.projectPlate]); the project's saved state is untouched. */
    override fun projectPlate(plateId: String, output: ProjectDocumentOutput): CompletableFuture<ProjectPlateArchive> =
        started.thenCompose { it.projectPlate(plateId, output) }

    /** The plates a slice of [scope] slices as the project stands ([ProjectWorkspace.slicePlan]). */
    override fun slicePlan(scope: SliceScope): CompletableFuture<Pair<ProjectRevision, SlicePlan>> =
        started.thenCompose { it.slicePlan(scope) }

    /** The slice and output actions as the core enables them ([ProjectWorkspace.sliceActions]). */
    override fun sliceActions(slicing: Boolean, block: Boolean, gcodeReady: Boolean): CompletableFuture<Map<String, ProjectActionState>> =
        started.thenCompose { it.sliceActions(slicing, block, gcodeReady) }

    /**
     * File → Export as one STL… or Export all objects as STLs… of the project
     * as it stands once every queued edit has settled ([ProjectWorkspace.exportStl]),
     * written to [output]; the project's saved state is untouched.
     */
    fun exportStl(archive: Boolean, output: ProjectDocumentOutput): CompletableFuture<StlExport> =
        started.thenCompose { it.exportStl(archive, output) }

    /** File → Export as 3MF…: the browser's Save of the project as it stands ([ProjectWorkspace.export3mf]); the saved state is untouched. */
    fun export3mf(output: ProjectDocumentOutput): CompletableFuture<ProjectArchiveExport> =
        started.thenCompose { it.export3mf(output) }

    /**
     * File → Export Config…: the chosen profile's `orcaxr_config.json`
     * ([SlicingProfiles.configExport]) once every choice asked before it has
     * applied, or null when none is chosen (the project slices with its own).
     */
    fun exportConfig(): CompletableFuture<String?> = CompletableFuture.supplyAsync({ profiles.configExport() }, worker)

    /** Export Diagnostics…'s shape of the project as it stands once every queued edit has settled ([ProjectWorkspace.diagnosticsSummary]). */
    fun diagnosticsSummary(): CompletableFuture<Diagnostics.ProjectShape> = started.thenCompose { it.diagnosticsSummary() }

    fun undo() = work { workspace.undo().await() }
    fun redo() = work { workspace.redo().await() }

    /**
     * Runs a selection change on the worker after everything asked before it
     * (an edit of "the selected model" must act on the selection the operator
     * saw), without showing the area as busy: selecting is instant.
     */
    private fun quietly(task: () -> Unit) {
        worker.execute {
            try {
                task()
            } catch (failure: Throwable) {
                val reason = cause(failure)
                DiagnosticsLog.recordError("project", reason)
                main.post { message = reason.message ?: reason.javaClass.simpleName }
            }
        }
    }

    /** A tap on a model in the Workspace ([extend] with Shift/Ctrl/Meta held); a tap on nothing deselects all, as the browser's click does. */
    fun selectInstance(instanceId: String?, extend: Boolean) = quietly {
        if (instanceId == null) workspace.deselectAll().await() else workspace.selectInstance(instanceId, extend).await()
    }

    /** A tree row activated: [mode] from the keyboard's modifiers. */
    fun selectRow(key: String, mode: ProjectRowSelection) = quietly { workspace.selectRow(key, mode).await() }

    /** Opens or closes a tree row. */
    fun toggleRow(key: String) = quietly { workspace.toggleRow(key) }

    /** Performs catalogue action [id] (the Edit menu, a row's menu, a shortcut) on the selection or the active plate. */
    fun perform(id: String) {
        if (create(id)) return
        when (id) {
            "edit_select_all" -> quietly { workspace.selectAll().await() }
            "edit_deselect_all" -> quietly { workspace.deselectAll().await() }
            "edit_duplicate", "add_instance" -> work { workspace.cloneSelected().await() }
            "edit_delete_selected" -> work { workspace.deleteSelected().await() }
            "edit_delete_all" -> work { workspace.deleteAll().await() }
            "toggle_printable" -> work { workspace.togglePrintable().await() }
            "instance_to_object" -> work { workspace.instanceToObject().await() }
            "add_plate" -> work { workspace.addPlate().await() }
            "duplicate_plate" -> view.activePlate?.let { plate -> duplicatePlate(plate.id) }
            "delete_plate" -> view.activePlate?.let { plate -> deletePlate(plate.id) }
            "tool_lay_on_face" -> layFlat(!layingFlat)
            "tool_move" -> gizmoTool(GizmoMode.TRANSLATE)
            "tool_rotate" -> gizmoTool(GizmoMode.ROTATE)
            "tool_scale" -> gizmoTool(GizmoMode.SCALE)
            "mirror_x" -> work { workspace.mirrorSelected(ProjectIntents.PlacementAxis.X).await() }
            "mirror_y" -> work { workspace.mirrorSelected(ProjectIntents.PlacementAxis.Y).await() }
            "mirror_z" -> work { workspace.mirrorSelected(ProjectIntents.PlacementAxis.Z).await() }
            "reset_rotation" -> work { workspace.resetSelected(TransformReset.ROTATION).await() }
            "reset_scale" -> work { workspace.resetSelected(TransformReset.SCALE).await() }
            "center_on_plate" -> work { workspace.centerSelectedOnPlate().await() }
            "scale_to_fit_volume" -> work { status(ProjectEditing.scaledStatus(workspace.scaleSelectedToFit().await())) }
            "drop_to_bed" -> work { status(ProjectEditing.droppedStatus(workspace.dropSelectedToBed().await())) }
            "arrange_all" -> work { status(ProjectEditing.arrangedStatus(workspace.arrangeActivePlate().await())) }
            "split_to_objects" -> splitToObjects()
            "set_negative_part" -> setNegativePart()
            "split_to_parts" -> splitToParts()
            "simplify_model" -> simplifyNow()
            "tool_measure" -> measure(!measuring)
            "tool_brim_ears" -> brimEars(!brimEaring)
            "brim_ears_auto" -> autoPlaceBrimEars()
            "brim_ears_clear" -> clearBrimEars()
            "add_emboss" -> drawn.emboss(!drawn.embossing)
            "emboss_load_font" -> drawn.requestFont()
            "emboss_apply" -> drawn.applyEmboss()
            "tool_svg" -> drawn.svg(!drawn.svgCutting)
            "svg_load_drawing" -> drawn.requestDrawing()
            "svg_apply" -> drawn.applySvg()
            "auto_place_wipe" -> autoPlaceWipeTower()
            // The toolbar's, the command palette's and the menus' other actions: one call for all of them.
            "delete_models" -> work { workspace.deleteSelected().await() }
            "edit_undo" -> if (view.undo != null) undo()
            "edit_redo" -> if (view.redo != null) redo()
            in AppActions.DOCUMENT -> documentRequest = id
            else -> {
                CameraView.entries.firstOrNull { "view_camera_${it.id}" == id }?.let { cameraRequest = CameraRequest(it, ++cameraSerial) }
                PaintChannel.entries.firstOrNull { it.toolAction == id }?.let(::paintTool)
            }
        }
    }

    /**
     * A paint channel's toolbar tool (`tool_paint`, `tool_support_paint`, …):
     * chosen, it starts painting that channel — Lay flat and Measure go off,
     * one tool at a time as the browser's `setTool` — or switches the painter
     * to it; chosen again while it paints, it ends, as the Lay flat and
     * Measure tools do.
     */
    private fun paintTool(channel: PaintChannel) {
        val state = paint.state
        when {
            state.active && state.channel == channel -> paint.stop()
            state.active -> paint.chooseChannel(channel)
            paint.enabled(channel.toolAction) -> {
                layFlat(false)
                if (measuring) measure(false)
                if (brimEaring) brimEars(false)
                drawnToolsOff()
                paint.start(channel)
            }
        }
    }

    /** The Emboss Text and SVG Part tools off, as another tool takes the Workspace. */
    private fun drawnToolsOff() {
        if (drawn.embossing) drawn.emboss(false)
        if (drawn.svgCutting) drawn.svg(false)
    }

    /**
     * Whether toolbar tool [id] is the Workspace's tool now: Lay flat, Measure,
     * Brim Ears, Emboss Text, SVG Part, the paint channel being painted, or —
     * while none of those is — the gizmo's Move, Rotate or Scale.
     */
    fun toolActive(id: String): Boolean = when (id) {
        "tool_lay_on_face" -> layingFlat
        "tool_measure" -> measuring
        "tool_brim_ears" -> brimEaring
        "add_emboss" -> drawn.embossing
        "tool_svg" -> drawn.svgCutting
        "tool_move", "tool_rotate", "tool_scale" ->
            !layingFlat && !measuring && !brimEaring && !drawn.embossing && !drawn.svgCutting && !paint.state.active &&
                ProjectEditing.gizmoAction(gizmoMode) == id
        else -> paint.state.active && PaintChannel.entries.any { it.toolAction == id && it == paint.state.channel }
    }

    /** A document action (New, Open, Save, Save As, Import) for the Project area's pickers and dialogs to carry out. */
    var documentRequest by mutableStateOf<String?>(null)
        private set

    /** The Project area took [documentRequest] in hand. */
    fun documentShown() {
        documentRequest = null
    }

    /** A camera view (the View menu's, from the palette) for the Workspace's 3D view to take. */
    var cameraRequest by mutableStateOf<CameraRequest?>(null)
        private set
    private var cameraSerial = 0

    /** The Workspace's view took [request]. */
    fun cameraShown(request: CameraRequest) {
        if (cameraRequest == request) cameraRequest = null
    }

    /** The actions [surface] offers now, in catalogue order, as the core enables them (the command palette's and the toolbar's lists). */
    fun surfaceActions(surface: ProjectIntents.ActionSurface): CompletableFuture<List<ProjectActionState>> =
        started.thenCompose { it.surfaceActions(surface) }

    /**
     * The Workspace's model toolbar: the `dom-toolbar` actions the app
     * performs, in the browser's runs (a separator wherever the catalogue
     * group changes), as the core enables them; read again after every change
     * of the project, its selection or its actions.
     */
    var toolbar by mutableStateOf<List<List<ProjectActionState>>>(emptyList())
        private set
    /** The menu strip's quick actions, as the browser's: Save, Undo and Redo (`dom-menu`), as the core enables them. */
    var quickActions by mutableStateOf<List<ProjectActionState>>(emptyList())
        private set
    private val toolbarQueued = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun refreshToolbar() {
        if (!toolbarQueued.compareAndSet(false, true)) return
        started.thenCompose { workspace ->
            toolbarQueued.set(false)
            workspace.surfaceActions(ProjectIntents.ActionSurface.DomToolbar).thenCombine(
                workspace.surfaceActions(ProjectIntents.ActionSurface.DomMenu),
            ) { tools, menu -> tools to menu }
        }.thenApply { (tools, menu) ->
            val runs = ActionPresentation.arrange(AppActions.performed(tools), ActionArrangement.TOOLBAR) { it.id }.map { it.second }
            runs to AppActions.QUICK.mapNotNull { id -> menu.firstOrNull { it.id == id } }
        }.whenComplete { read, failure ->
            if (failure != null) toolbarQueued.set(false) else main.post {
                toolbar = read.first
                quickActions = read.second
            }
        }
    }

    /** Shows [text], the browser's status for an outcome the project alone does not show; none shows nothing. */
    private fun status(text: String?) {
        if (text != null) main.post { message = text }
    }

    // ---- The transform inspector and the Lay flat tool ----

    /** Inspector edits finished (main thread): a field shows the selection's value again after each, even a refused one. */
    var inspectorEdits by mutableIntStateOf(0)
        private set

    /**
     * An edit of the inspector's [tool] fields, [texts] as typed (the
     * browser's Tool Settings change): one undoable step, or refused with the
     * browser's status.
     */
    fun editTransform(tool: TransformTool, texts: List<String>) = work {
        try {
            workspace.editTransform(tool, texts).await()
        } catch (failure: Throwable) {
            throw IllegalStateException(words(R.string.project_transform_failed, cause(failure).message.orEmpty()))
        } finally {
            main.post { inspectorEdits++ }
        }
    }

    // ---- The Workspace's transform gizmo ----

    /**
     * What the Workspace's gizmo does to the selection (the browser's
     * `TransformControls` mode): Move until Rotate or Scale is chosen — from
     * the toolbar, the palette, or G, R and S.
     */
    var gizmoMode by mutableStateOf(GizmoMode.TRANSLATE)
        private set

    /**
     * Where the gizmo stands for the selection and what a drag carries, as
     * last read ([refreshGizmo]): every read is news, an unchanged one too,
     * since a drag that changed nothing still has to put the gizmo back.
     */
    var gizmoProxy by mutableStateOf<TransformProxy>(TransformProxy.None, neverEqualPolicy())
        private set

    /**
     * Move, Rotate or Scale (`tool_move`, `tool_rotate`, `tool_scale`): the
     * Workspace's one tool, as the browser's `setTool` — Lay flat, Measure and
     * painting end — and the gizmo's handles for it.
     */
    private fun gizmoTool(mode: GizmoMode) {
        layFlat(false)
        if (measuring) measure(false)
        if (brimEaring) brimEars(false)
        drawnToolsOff()
        if (paint.state.active) paint.stop()
        gizmoMode = mode
    }

    /** Reads where the gizmo stands for the selection again, as the browser's `syncTransformProxy` after every change. */
    fun refreshGizmo() = quietly {
        val proxy = workspace.transformProxy().await()
        main.post {
            gizmoProxy = proxy
            if (proxy is TransformProxy.Refused) message = proxy.message
        }
    }

    /** A drag of the gizmo's handles: its gesture, the proxy as the drag began, the origins it carries and its tool. */
    class GizmoDrag internal constructor(
        internal val gesture: ProjectWorkspace.TransformGesture,
        internal val initial: GizmoPose,
        internal val origins: List<ProjectIntents.InstanceTransform>,
        internal val tool: TransformTool,
    )

    /** A press took a handle of the gizmo standing at [proxy]: the drag starts from [initial], the proxy's pose then. */
    fun beginGizmoDrag(proxy: TransformProxy.Placed, initial: GizmoPose): GizmoDrag =
        GizmoDrag(workspace.transformGesture(), initial, proxy.origins, ProjectEditing.transformTool(gizmoMode))

    /**
     * The proxy of [drag] moved to [pose]: what that changes (the one
     * instance, or the selection carried around the proxy) goes to the
     * drag's gesture. A change the workspace refuses stops the drag, as the
     * browser's "Transform stopped"; answers whether the drag goes on.
     */
    fun dragGizmo(drag: GizmoDrag, pose: GizmoPose): Boolean =
        when (val edit = TransformGizmo.changes(drag.initial, pose, drag.tool, drag.origins)) {
            is TransformFieldEdit.Refused -> {
                drag.gesture.cancel()
                message = words(R.string.workspace_transform_stopped, edit.message)
                false
            }
            is TransformFieldEdit.Changes -> {
                drag.gesture.update(edit.changes)
                true
            }
        }

    /** The drag ended: its last pose lands, then the gizmo is placed again where the selection now is. */
    fun endGizmoDrag(drag: GizmoDrag) {
        drag.gesture.finish().whenComplete { _, failure ->
            failure?.let { main.post { message = words(R.string.workspace_transform_stopped, cause(it).message.orEmpty()) } }
            refreshGizmo()
        }
    }

    /** Whether G, R or S may choose gizmo tool [id] now (`tool_move`'s, `tool_rotate`'s and `tool_scale`'s shortcuts), as the core enables it. */
    fun gizmoShortcut(id: String): Boolean = !busy && ProjectEditing.enabled(view, id)

    /** The Lay flat tool (`tool_lay_on_face`): while on, a tap in the Workspace lays the tapped facet on the bed instead of selecting. */
    var layingFlat by mutableStateOf(false)
        private set
    /** What the Lay flat card says, as the browser's status does: the tool's hint, or why the last tap laid nothing flat. */
    @get:StringRes
    var layFlatNote by mutableIntStateOf(R.string.workspace_lay_flat_hint)
        private set

    fun layFlat(on: Boolean) {
        // One Workspace tool at a time, as the browser's `setTool`.
        if (on && measuring) measure(false)
        if (on && brimEaring) brimEars(false)
        if (on) drawnToolsOff()
        if (on && paint.state.active) paint.stop()
        layingFlat = on
        layFlatNote = R.string.workspace_lay_flat_hint
    }

    /**
     * A tap in the Workspace while laying flat: facet [facet] of volume
     * [volumeId]'s mesh, as instance [instanceId] places it, is laid on the
     * bed as one undoable step; a tap that met no facet ([instanceId] null)
     * is told to pick one. As the browser's registry gate, nothing happens
     * while the core does not enable the tool.
     */
    fun layFlatAt(instanceId: String?, volumeId: String?, facet: Int) {
        if (instanceId == null || volumeId.isNullOrEmpty()) {
            layFlatNote = R.string.workspace_lay_flat_missed
            return
        }
        layFlatNote = R.string.workspace_lay_flat_hint
        if (!ProjectEditing.enabled(view, "tool_lay_on_face")) return
        work {
            try {
                workspace.layOnFacet(instanceId, volumeId, facet.toLong()).await()
            } catch (failure: Throwable) {
                throw IllegalStateException(ProjectEditing.layFlatFailed(cause(failure).message))
            }
        }
    }

    // ---- Model tools: split, simplify and measure, as the browser's workspace runs them ----

    private fun words(id: Int): String = getApplication<Application>().getString(id)
    private fun words(id: Int, first: Any, vararg rest: Any): String = getApplication<Application>().getString(id, first, *rest)

    /** A Split to Objects waiting for the operator's answer: what it will replace (the browser's confirmation). */
    var pendingSplit by mutableStateOf<SplitConfirmation?>(null)
        private set

    /**
     * Split to Objects (`split_to_objects`): what it would replace is read and
     * offered for confirmation, as the browser's flow asks before it splits;
     * a selection or object it cannot split says why in the browser's words.
     */
    fun splitToObjects() = work {
        val confirmation = try {
            workspace.splitToObjectsConfirmation().await()
        } catch (failure: Throwable) {
            val reason = cause(failure).message
            main.post { message = ModelToolStatus.splitUnavailable(reason) }
            return@work
        }
        main.post { pendingSplit = confirmation }
    }

    /** The operator's answer to [pendingSplit]: split as confirmed, or leave the project as it is. */
    fun answerSplit(accept: Boolean) {
        val confirmation = pendingSplit ?: return
        pendingSplit = null
        if (!accept) {
            message = ModelToolStatus.SPLIT_CANCELLED
            return
        }
        work {
            val status = try {
                val split = workspace.splitSelectedToObjects(confirmation).await()
                ModelToolStatus.splitDone(confirmation.objectName, split.objectIds.size, confirmation.affectedInstanceIds.size)
            } catch (failure: Throwable) {
                ModelToolStatus.splitFailed(cause(failure).message)
            }
            main.post { message = status }
        }
    }

    /** Split to Parts (`split_to_parts`): the selected object's connected bodies as its parts, one undoable step. */
    fun splitToParts() = work {
        val status = try {
            workspace.splitSelectedToParts().await()
            words(R.string.project_split_parts_done)
        } catch (failure: Throwable) {
            "${words(R.string.project_split_parts_failed)}: ${cause(failure).message.orEmpty()}"
        }
        main.post { message = status }
    }

    /** The configuration the Simplify panel last previewed with, which its fields show again after Apply or Cancel (the browser's `requested`). */
    var simplifyRequested by mutableStateOf(SimplifyConfiguration.DEFAULT)
        private set
    /** The preview shown, until Apply or Cancel. */
    var simplifyPreview by mutableStateOf<SimplifyPreview?>(null)
        private set
    /** The preview's meshes, by volume, for the Workspace to draw in place of the volumes' own. */
    var simplifyMeshes by mutableStateOf<Map<String, TriangleMesh>>(emptyMap())
        private set

    private fun showPreview(preview: SimplifyPreview?, meshes: Map<String, TriangleMesh>) {
        simplifyPreview = preview
        simplifyMeshes = meshes
    }

    /**
     * The Simplify panel's Preview (`simplify_preview`): every part the
     * selection simplifies decimated with [configuration] and drawn in the
     * Workspace, nothing installed until Apply.
     */
    fun previewSimplify(configuration: SimplifyConfiguration) {
        simplifyRequested = configuration
        showPreview(null, emptyMap())
        work {
            val result = try {
                workspace.previewSimplify(configuration).await()
            } catch (failure: Throwable) {
                val reason = cause(failure).message
                main.post { message = ModelToolStatus.simplifyFailed(reason) }
                return@work
            }
            when (result) {
                SimplifyPreviewResult.NothingSelected -> main.post { message = words(R.string.simplify_select_model) }
                is SimplifyPreviewResult.NothingToSimplify -> main.post {
                    message = if (result.byCount) words(R.string.simplify_nothing_at_ratio) else ModelToolStatus.NOTHING_WITHIN_ERROR
                }
                is SimplifyPreviewResult.Previewing -> {
                    val preview = result.preview
                    val meshes = preview.parts.mapNotNull { part ->
                        part.mesh()?.let { bytes -> part.volumeId to PacketMeshes.indexed("simplify:${part.volumeId}", bytes, part.vertexCount, part.afterTriangles) }
                    }.toMap()
                    main.post {
                        showPreview(preview, meshes)
                        message = ModelToolStatus.simplifyPreview(preview.beforeTriangles, preview.afterTriangles)
                    }
                }
            }
        }
    }

    /** The panel's Apply (`simplify_apply`): exactly the previewed meshes installed, each part one undoable step. */
    fun applySimplify() = work {
        val status = try {
            val applied = workspace.applySimplifyPreview().await()
            if (applied == null) words(R.string.simplify_no_preview) else ModelToolStatus.simplified(applied.parts, applied.beforeTriangles, applied.afterTriangles)
        } catch (failure: Throwable) {
            ModelToolStatus.simplifyFailed(cause(failure).message)
        }
        main.post {
            showPreview(null, emptyMap())
            message = status
        }
    }

    /** The panel's Cancel (`simplify_cancel`): the model shown as it is; the project never changed. */
    fun cancelSimplify() {
        showPreview(null, emptyMap())
        quietly { workspace.cancelSimplifyPreview() }
    }

    /** The menu's Simplify (`simplify_model`): the selection decimated by half at once, each part one undoable step. */
    fun simplifyNow() = work {
        val status = try {
            val applied = workspace.simplifySelected().await()
            when {
                applied == null -> words(R.string.simplify_select_model)
                applied.parts == 0 -> words(R.string.simplify_nothing_at_ratio)
                else -> ModelToolStatus.simplified(applied.parts, applied.beforeTriangles, applied.afterTriangles)
            }
        } catch (failure: Throwable) {
            ModelToolStatus.simplifyFailed(cause(failure).message)
        }
        main.post { message = status }
    }

    /** The Measure tool (`tool_measure`): while on, a tap in the Workspace picks a feature instead of selecting. */
    var measuring by mutableStateOf(false)
        private set
    /** The Measure panel's readout of the picks (at most two), while the tool is on. */
    var measureReadout by mutableStateOf<MeasureReadout?>(null)
        private set
    /** The workspace's last Measure status (a pick, a miss, a failure, a cleared measurement). */
    var measureStatus by mutableStateOf<String?>(null)
        private set
    private var measurePicks: List<MeasurePick> = emptyList()

    /**
     * A Workspace tool's tap or stroke met a part a simplify preview draws in
     * its place, whose facets are not the project's: refused in the browser's
     * words (`refusePreviewedPick`) as the active tool's own status, nothing
     * painted, measured or laid flat.
     */
    fun refusePreviewedPick() {
        when {
            paint.state.active -> paint.refusePreviewed()
            measuring -> measureStatus = words(R.string.simplify_preview_pick)
            layingFlat -> layFlatNote = R.string.simplify_preview_pick
            brimEaring -> brimEarStatus = words(R.string.simplify_preview_pick)
        }
    }

    /** Turns the Measure tool on — with a fresh pair of picks, as the browser's `measureTool` — or off; Lay flat and painting go off. */
    fun measure(on: Boolean) {
        if (on) layFlat(false)
        if (on && brimEaring) brimEars(false)
        if (on) drawnToolsOff()
        if (on && paint.state.active) paint.stop()
        measuring = on
        measurePicks = emptyList()
        measureStatus = if (on) words(R.string.measure_start) else null
        measured()
    }

    /** The panel's Clear (`measure_clear`): both picks dropped for a new measurement. */
    fun clearMeasure() {
        measurePicks = emptyList()
        measureStatus = words(R.string.measure_cleared)
        measured()
    }

    /** The readout of the picks now (main thread). */
    private fun measured() {
        val picks = measurePicks
        val result = if (picks.size >= 2 && ::workspace.isInitialized) workspace.measure(picks[0], picks[1]) else null
        measureReadout = if (measuring) ProjectMeasures.readout(true, picks, result) else null
    }

    /**
     * A tap in the Workspace while measuring (`pickMeasureFeature`): facet
     * [facet] of volume [volumeId] as instance [instanceId] places it, at the
     * volume-local [point] the tap met, picks the feature there — a third
     * pick starts a new measurement —; a tap on nothing is told to pick a
     * surface. As the browser's registry gate, nothing happens while the core
     * does not enable the tool.
     */
    fun measureAt(instanceId: String?, volumeId: String?, facet: Int, point: List<Double>?) {
        if (!ProjectEditing.enabled(view, "tool_measure")) return
        if (instanceId == null || volumeId.isNullOrEmpty() || point == null) {
            measureStatus = words(R.string.measure_missed)
            return
        }
        quietly {
            val result = try {
                workspace.measurePick(instanceId, volumeId, facet.toLong(), point).await()
            } catch (failure: Throwable) {
                val reason = cause(failure).message
                main.post { measureStatus = ModelToolStatus.measureFailed(reason) }
                return@quietly
            }
            main.post {
                if (!measuring) return@post
                when (result) {
                    is MeasurePickResult.Uneven -> measureStatus = result.message
                    is MeasurePickResult.Picked -> {
                        measurePicks = (if (measurePicks.size >= 2) emptyList() else measurePicks) + result.pick
                        measureStatus = ModelToolStatus.measurePicked(result.pick.summary)
                        measured()
                    }
                }
            }
        }
    }

    // ---- The Brim Ears tool, as the browser's workspace runs it ----

    /** The Brim Ears tool (`tool_brim_ears`): while on, a tap in the Workspace places an ear where it meets the object ears go on. */
    var brimEaring by mutableStateOf(false)
        private set
    /** The front radius the next ear takes (`brimEarRadiusMm`, the panel's Ear radius). */
    var brimEarRadiusMm by mutableDoubleStateOf(ProjectBrimEars.DEFAULT_RADIUS_MM)
        private set
    /** Radius edits finished (main thread): the field shows the radius again after each, even a refused one. */
    var brimEarRadiusEdits by mutableIntStateOf(0)
        private set
    /** What the tool shows (the object ears go on, its ears, the stranded ones), as last read ([refreshBrimEars]). */
    var brimEarState by mutableStateOf(BrimEarState())
        private set
    /** The tool's last status (what the browser's status bar says while it is on). */
    var brimEarStatus by mutableStateOf<String?>(null)
        private set

    /**
     * Turns the Brim Ears tool on — Lay flat, Measure and painting go off,
     * one tool at a time as the browser's `setTool` — with its status, or off.
     */
    fun brimEars(on: Boolean) {
        if (on) {
            layFlat(false)
            if (measuring) measure(false)
            drawnToolsOff()
            if (paint.state.active) paint.stop()
        }
        brimEaring = on
        brimEarStatus = if (on) words(R.string.brim_ears_start) else null
        if (on) refreshBrimEars()
    }

    /** Reads what the tool shows again (`getBrimEarSnapshot`), as the browser's panel does after every change of the project or the selection. */
    fun refreshBrimEars() = quietly {
        val state = workspace.brimEars().await()
        main.post { brimEarState = state }
    }

    /** A status of the tool: its own line while it is on, the area's message otherwise (the browser's one status bar). */
    private fun brimStatus(text: String) {
        main.post { if (brimEaring) brimEarStatus = text else message = text }
    }

    /** The panel's Ear radius (`brim_ears_configure`, `setBrimEarRadius`): one outside 0.1–20 mm is refused with the browser's status. */
    fun setBrimEarRadius(radiusMm: Double) {
        if (ProjectBrimEars.radiusAllowed(radiusMm)) brimEarRadiusMm = radiusMm else brimStatus(ProjectBrimEars.RADIUS_BOUNDS)
        brimEarRadiusEdits++
    }

    /**
     * A tap while placing ears met nothing to place on (`placeBrimEar`): no
     * single object is in scope ([inScope] false), or the tap missed it.
     */
    fun brimEarMissed(inScope: Boolean) = brimStatus(words(if (inScope) R.string.brim_ears_missed else R.string.brim_ears_select_tap))

    /**
     * A tap met part [volumeId] of object [objectId] at [point] (the part's
     * own millimetres): one ear there, at the object's base, with the
     * current radius, as one undoable step (`placeBrimEar`).
     */
    fun placeBrimEarAt(objectId: String, volumeId: String, point: List<Double>) {
        val radius = brimEarRadiusMm
        work {
            brimStatus(
                try {
                    workspace.placeBrimEarOnPart(objectId, volumeId, point, radius).await()
                    ProjectBrimEars.placed(radius)
                } catch (failure: Throwable) {
                    ProjectBrimEars.failed(cause(failure).message)
                },
            )
        }
    }

    /**
     * "Place on corners" (`brim_ears_auto`, `autoPlaceBrimEars`): an ear on
     * every first-layer corner of the object that would lift, with the
     * current radius, as one undoable step; then the tool opens, so the discs
     * are on the model, as the browser's does.
     */
    fun autoPlaceBrimEars() {
        val radius = brimEarRadiusMm
        work {
            val status = try {
                when (val outcome = workspace.autoPlaceBrimEars(radius).await()) {
                    BrimEarAuto.NoTarget -> words(R.string.brim_ears_select_auto)
                    BrimEarAuto.NoGeometry -> words(R.string.brim_ears_no_geometry)
                    is BrimEarAuto.NoEars -> ProjectBrimEars.noEars(outcome.reason)
                    is BrimEarAuto.Placed -> {
                        main.post { if (!brimEaring) brimEars(true) }
                        ProjectBrimEars.autoPlaced(outcome.count)
                    }
                }
            } catch (failure: Throwable) {
                words(R.string.brim_ears_failed, cause(failure).message.orEmpty())
            }
            brimStatus(status)
        }
    }

    /** "Clear all" (`brim_ears_clear`): every ear of the object as one undoable step. */
    fun clearBrimEars() = work {
        brimStatus(
            try {
                when (workspace.clearBrimEars().await()) {
                    BrimEarClear.NO_TARGET -> words(R.string.brim_ears_select_clear)
                    BrimEarClear.NO_EARS -> words(R.string.brim_ears_none)
                    BrimEarClear.CLEARED -> words(R.string.brim_ears_cleared)
                }
            } catch (failure: Throwable) {
                words(R.string.brim_ears_failed, cause(failure).message.orEmpty())
            },
        )
    }

    /** A placed ear's Remove (`brim_ears_remove`): ear [index] as one undoable step; undo puts it back at its index. */
    fun removeBrimEar(index: Int) = work {
        val status = try {
            if (workspace.removeBrimEar(index.toLong()).await()) words(R.string.brim_ears_removed) else null
        } catch (failure: Throwable) {
            ProjectBrimEars.failed(cause(failure).message)
        }
        status?.let(::brimStatus)
    }

    // ---- The wipe tower ----

    /** The Process section's "Auto-position wipe tower" (the browser's `wipeTowerAuto`): off until switched on. */
    var wipeTowerAuto by mutableStateOf(false)
        private set
    /** The last wipe-tower status, shown under that switch as well as in the Project area. */
    var wipeTowerStatus by mutableStateOf<String?>(null)
        private set

    private fun towerStatus(text: String) {
        main.post {
            wipeTowerStatus = text
            message = text
        }
    }

    /**
     * Places the active plate's tower (the workspace's `autoPlaceWipeTower`)
     * on the worker; [fromProfile]: whether a chosen catalog profile states
     * the printable rectangle, which the browser hands over from its profile.
     * Answers the browser's status.
     */
    private fun placeTower(fromProfile: Boolean): String = try {
        if (workspace.autoPlaceWipeTower(fromProfile).await() != null) words(R.string.wipe_tower_placed) else words(R.string.wipe_tower_failed)
    } catch (_: Throwable) {
        words(R.string.wipe_tower_failed)
    }

    /**
     * "Auto-place Wipe Tower" (`auto_place_wipe`): the active plate's tower
     * moved where it has the most room around its printed footprint, as one
     * undoable step, with the browser's status.
     */
    fun autoPlaceWipeTower() {
        val fromProfile = !profilesView.authored
        work { towerStatus(placeTower(fromProfile)) }
    }

    /**
     * The Process section's switch (`auto_place_wipe` with `enabled`, the
     * workspace's `setWipeTowerAuto`): switched on, it places the tower at
     * once; either way it says so in the browser's words.
     */
    fun switchWipeTowerAuto(on: Boolean) {
        val fromProfile = !profilesView.authored
        wipeTowerAuto = on
        work {
            if (on) placeTower(fromProfile)
            towerStatus(words(if (on) R.string.wipe_tower_auto_on else R.string.wipe_tower_auto_off))
        }
    }

    /** The active plate's wipe tower as the Workspace draws it (the browser's ghost); none without an enabled tower. */
    var wipeTowerGhost by mutableStateOf<ProjectIntents.WipeTowerGhost?>(null)
        private set

    /** Reads the ghost again ([ProjectWorkspace.wipeTowerGhost]), as the browser rebuilds it after every change of the project. */
    fun refreshWipeTowerGhost() = quietly {
        val ghost = workspace.wipeTowerGhost().await()
        main.post { wipeTowerGhost = ghost }
    }

    /** Renames an object or part (the Objects panel's Rename). */
    fun rename(entity: ProjectIntents.ObjectTreeEntity, name: String) = work {
        val id = when (entity) {
            is ProjectIntents.ObjectTreeEntity.Object -> entity.value
            is ProjectIntents.ObjectTreeEntity.Volume -> entity.value
            else -> return@work
        }.let { units -> String(CharArray(units.size) { units[it].toChar() }) }
        if (entity is ProjectIntents.ObjectTreeEntity.Object) workspace.renameObject(id, name).await() else workspace.renameVolume(id, name).await()
    }

    // The plate bar: each plate named by its ID, as the browser's plate manager targets them.
    fun activatePlate(plateId: String) = work { workspace.activatePlate(plateId).await() }
    fun renamePlate(plateId: String, name: String) = work { workspace.renamePlate(plateId, name).await() }
    fun movePlate(plateId: String, by: Int) = work { workspace.movePlate(plateId, by).await() }
    fun duplicatePlate(plateId: String) = work { workspace.duplicatePlate(plateId).await() }
    fun deletePlate(plateId: String) = work { workspace.deletePlate(plateId).await() }
    fun setPlatePrintable(plateId: String, printable: Boolean) = work { workspace.setPlatePrintable(plateId, printable).await() }

    /**
     * Performs a creation action — Cut, Copy, Paste, Fill Bed with Instances,
     * a primitive or a helper volume — through the workspace's staged edits;
     * false for any other action.
     */
    private fun create(id: String): Boolean {
        val shape = PrimitiveShape.forAction(id)
        val role = HelperVolumeRole.forAction(id)
        when {
            shape != null -> work { workspace.addPrimitive(shape).await() }
            role != null -> work { workspace.addHelperVolume(role).await() }
            id == "edit_cut" -> work { workspace.cutSelected().await() }
            id == "edit_copy" -> work { workspace.copySelected().await() }
            id == "edit_paste" -> work { workspace.paste().await() }
            id == "fill_bed_with_instances" -> work { workspace.fillBed().await() }
            else -> return false
        }
        return true
    }

    /**
     * Set as Negative Part (`set_negative_part`): the selected part becomes a
     * negative volume, or one is added to the selected object; refused with
     * the browser's status ("Set as Negative Part failed: …").
     */
    private fun setNegativePart() = work {
        try {
            workspace.setNegativePart().await()
        } catch (failure: Throwable) {
            throw IllegalStateException("${words(R.string.project_set_negative_part_failed)}: ${cause(failure).message.orEmpty()}")
        }
    }

    /** Ctrl/Meta+C, +X and +V (Copy, Cut, Paste) from the keyboard, when the core enables them; answers whether one applied. */
    fun clipboardShortcut(id: String): Boolean = (!busy && ProjectEditing.enabled(view, id)).also { if (it) perform(id) }

    /** Delete from the keyboard (`edit_delete_selected`'s shortcut); answers whether it applied. */
    fun deleteShortcut(): Boolean = (!busy && ProjectEditing.enabled(view, "edit_delete_selected")).also { if (it) perform("edit_delete_selected") }

    /** Escape (`edit_deselect_all`'s shortcut) with something selected; answers whether it applied. */
    fun escapeShortcut(): Boolean = (view.selection.total > 0).also { if (it) perform("edit_deselect_all") }

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

    /** Everything the scene shows now — every mesh, draw and painted volume — handed to [to] on the main thread. */
    fun sceneSnapshot(to: (SceneSync.Update) -> Unit) {
        sceneSync?.snapshot { everything -> main.post { to(everything) } }
    }

    override fun onCleared() {
        paint.close()
        inspector.close()
        sceneSync?.close()
        worker.execute {
            drawn.close()
            owners.releaseAll(owner)
            subscription?.close()
            pendingImport?.candidate?.close()
            if (::workspace.isInitialized) workspace.close()
            profiles.close()
        }
        worker.shutdown()
        searches.shutdownNow()
    }
}

/** Characters a file name on a receiving device may not hold. */
private val UNSAFE_NAME = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]")
