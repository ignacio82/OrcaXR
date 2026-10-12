package dev.orcaxr.nativeapp.project

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.orcaxr.core.LayerRangeEditors
import dev.orcaxr.core.LayerRangeOperation
import dev.orcaxr.core.LayerRangePanel
import dev.orcaxr.core.LayerRangeProjection
import dev.orcaxr.core.VolumeRoleProjection
import dev.orcaxr.core.ProjectSettings
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.SettingsPanel
import dev.orcaxr.core.SettingsPanelApply
import dev.orcaxr.core.SettingsPanelEdit
import dev.orcaxr.core.SettingsPanelMode
import dev.orcaxr.core.VolumeRole
import dev.orcaxr.core.VolumeRoleEditors
import dev.orcaxr.core.VolumeRolePanel
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/** What the semantic editor (its volume roles, its height ranges) says about its last operation. */
sealed interface EditorStatus {
    /** "Changes are applied only after the canonical adapter accepts a guarded request." */
    data object Idle : EditorStatus
    /** An operation's words while it runs. */
    data class Pending(val text: String) : EditorStatus
    /** An operation's words once the project took it. */
    data class Done(val text: String) : EditorStatus
    /** "The guarded operation was rejected; …" with the reason. */
    data class Rejected(val reason: String) : EditorStatus
}

/**
 * The height-range editor as the operator sees it: an object's ranges with
 * the selection's range, its add, edit and split forms (rebuilt from each read
 * of the project, as the browser's editor renders afresh), and its status.
 */
data class RangesShell(
    val objectId: String,
    val projection: LayerRangeProjection? = null,
    val add: RangeForm = RangeForm(),
    val edit: RangeForm = RangeForm(),
    val split: RangeForm = RangeForm(),
    val pending: Boolean = false,
    val status: EditorStatus = EditorStatus.Idle,
    /** Read once: an object the project no longer has shows nothing. */
    val loaded: Boolean = false,
)

/**
 * The semantic editor's "Volume role" section as the operator sees it: what
 * the selection asks it to show ([target]), the selected part's role choices
 * read last (rebuilt from each read of the project, as the browser's editor
 * renders afresh), whether a conversion is running, and its status — the
 * editor's own, kept as the selection moves from part to part.
 */
data class RolesShell(
    val target: RoleTarget,
    val projection: VolumeRoleProjection? = null,
    val pending: Boolean = false,
    val status: EditorStatus = EditorStatus.Idle,
    /** Read once: a part the project no longer has shows the hint. */
    val loaded: Boolean = false,
)

/**
 * The inspector's settings panels on the project ([ProjectSettings]): the
 * panel a tree row opened, the scoped settings panel's shell around the
 * shared core's panel model, the height-range editor, and — following the
 * selection, beside whichever panel is open — the semantic editor's volume
 * roles. The native panel is owned and called on one worker thread; Compose
 * state changes on the main thread. A project change reloads an open panel,
 * or — under a draft — keeps it as the browser's conflict.
 */
class InspectorModel(private val host: Host) : AutoCloseable {
    /** What the inspector needs from the project area. */
    interface Host {
        /** The project's workspace once started; null before. */
        fun workspace(): ProjectWorkspace?
    }

    private companion object {
        /** The project's own settings, the picker's first target. */
        const val PROJECT = "project"
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "project-inspector").also { it.isDaemon = true } }
    private var settings: ProjectSettings? = null
    /** The open settings panel's native model (worker thread). */
    private var native: SettingsPanel? = null
    /** The height ranges read last, with their state's guard (worker thread). */
    private var ranges: LayerRangePanel? = null
    /** The selected part's role choices read last, with their state's guard (worker thread). */
    private var roles: VolumeRolePanel? = null
    /** The project's revision and selection last seen (main thread). */
    private var seen: Pair<Long?, Any?>? = null

    var panel by mutableStateOf<InspectorPanel?>(null)
        private set
    var settingsShell by mutableStateOf<SettingsShell?>(null)
        private set
    var rangesShell by mutableStateOf<RangesShell?>(null)
        private set
    var rolesShell by mutableStateOf<RolesShell?>(null)
        private set

    private fun cause(failure: Throwable): Throwable =
        if ((failure is ExecutionException || failure is CompletionException) && failure.cause != null) cause(failure.cause!!) else failure
    private fun reason(failure: Throwable): String = cause(failure).let { it.message ?: it.javaClass.simpleName }

    /**
     * [task] on the worker with the project's settings workflows; skipped
     * before the workspace starts. A failure it did not answer itself is
     * shown where the open panel shows its errors, never thrown at the app.
     */
    private fun work(task: (ProjectSettings) -> Unit) {
        val workspace = host.workspace() ?: return
        worker.execute {
            try {
                val project = settings ?: ProjectSettings(workspace).also { settings = it }
                task(project)
            } catch (failure: Throwable) {
                val message = reason(failure)
                post {
                    settingsShell?.let { settingsShell = it.copy(loading = false, busy = false, error = SettingsError(SettingsErrorKind.LoadFailed, message)) }
                    rangesShell?.let { rangesShell = it.copy(pending = false, status = EditorStatus.Rejected(message)) }
                }
            }
        }
    }
    private fun post(action: () -> Unit) = main.post(action)

    /** Opens [next] in place of what the inspector showed (a tree row's tap). */
    fun open(next: InspectorPanel) {
        panel = next
        when (next) {
            is InspectorPanel.Settings -> openSettings(next.targetId)
            is InspectorPanel.HeightRanges -> openRanges(next.objectId)
        }
    }

    /** Closes the inspector's panel; its drafts are dropped. */
    fun dismiss() {
        panel = null
        settingsShell = null
        rangesShell = null
        worker.execute {
            native?.close()
            native = null
            ranges = null
        }
    }

    /** The project changed: an open panel reads it again, a settings draft becomes a conflict (main thread). */
    fun projectChanged(view: ProjectView) {
        val now = view.revision?.revision to view.selection
        if (now == seen) return
        val revisionChanged = seen?.first != now.first
        seen = now
        followSelection(view)
        rangesShell?.let { if (!it.pending) readRanges(it.objectId, keep = it) }
        val shell = settingsShell ?: return
        if (!revisionChanged) return
        when (shell.projectChanged(view.revision?.revision)) {
            SettingsRefresh.None, SettingsRefresh.Later -> Unit
            SettingsRefresh.Conflict -> settingsShell = shell.copy(conflict = true, note = SettingsNote.ConflictKept)
            SettingsRefresh.Reload -> reloadSettings(SettingsNote.Refreshed)
        }
    }

    // ---- The scoped settings panel ----

    private fun openSettings(targetId: String) {
        // A new node's panel starts at the Simple level with no search, as the browser rebuilds its panel per target.
        settingsShell = SettingsShell(targetId)
        rangesShell = null
        load(targetId, SettingsPanelMode.SIMPLE, "", null)
    }

    /** Reads [targetId]'s panel on the current state (worker), replacing the open one. */
    private fun load(targetId: String, mode: SettingsPanelMode, search: String, note: SettingsNote?) = work { project ->
        native?.close()
        native = null
        try {
            val opened = project.open(targetId).get()
            native = opened
            val view = opened.view(mode, search)
            val state = opened.state()
            post {
                if (settingsShell?.targetId != targetId) return@post
                val loaded = SettingsShell(
                    targetId, opened.target, opened.targets, mode, search, view, state, opened.revision,
                    loading = false, note = note,
                )
                settingsShell = loaded
                // A change the project made while this read ran, which the panel let wait (`authorityRefreshQueued`).
                val latest = seen?.first
                if (latest != null && latest > opened.revision) reloadSettings(SettingsNote.Refreshed)
            }
        } catch (failure: Throwable) {
            val message = reason(failure)
            post {
                val shell = settingsShell ?: return@post
                if (shell.targetId != targetId) return@post
                // A node the project no longer has gives way to the project's own settings, as the browser's picker falls back.
                if (message.startsWith("No settings target named") && targetId != PROJECT) chooseTarget(PROJECT)
                else settingsShell = shell.copy(loading = false, busy = false, error = SettingsError(SettingsErrorKind.LoadFailed, message))
            }
        }
    }

    private fun reloadSettings(note: SettingsNote?) {
        val shell = settingsShell ?: return
        settingsShell = shell.copy(loading = true)
        load(shell.targetId, shell.mode, shell.search, note)
    }

    /** The picker's choice: another node's panel. */
    fun chooseTarget(targetId: String) {
        if (settingsShell?.targetId == targetId) return
        panel = InspectorPanel.Settings(targetId)
        openSettings(targetId)
    }

    /** Re-reads the view after [change] ran on the native panel (worker), then applies [after] to the shell. */
    private fun refresh(change: (SettingsPanel) -> Unit = {}, after: (SettingsShell) -> SettingsShell = { it }) {
        val shell = settingsShell ?: return
        work {
            val opened = native ?: return@work
            change(opened)
            val view = opened.view(shell.mode, shell.search)
            val state = opened.state()
            post {
                val current = settingsShell ?: return@post
                if (current.targetId == shell.targetId) settingsShell = after(current.copy(view = view, draft = state))
            }
        }
    }

    fun chooseMode(mode: SettingsPanelMode) {
        val shell = settingsShell?.takeIf { it.interactive && it.mode != mode } ?: return
        settingsShell = shell.copy(mode = mode)
        refresh()
    }

    fun search(text: String) {
        val shell = settingsShell?.takeIf { it.interactive } ?: return
        settingsShell = shell.copy(search = text)
        refresh()
    }

    /** A typed value: drafted, the row's issues and badges following (`updateDraftFeedback`). */
    fun draft(fieldId: String, raw: String) {
        if (settingsShell?.interactive != true) return
        var outcome: SettingsPanelEdit? = null
        refresh({ outcome = it.set(fieldId, raw) }) { shell ->
            if (outcome == SettingsPanelEdit.Applied) shell.copy(error = null, note = SettingsNote.DraftPending) else shell
        }
    }

    /** "Use inherited". */
    fun useInherited(fieldId: String) {
        if (settingsShell?.interactive != true) return
        refresh({ it.inherit(fieldId) })
    }

    /** "Use default"; a default the codec cannot write shows "Default reset failed". */
    fun useDefault(fieldId: String) {
        if (settingsShell?.interactive != true) return
        var outcome: SettingsPanelEdit? = null
        refresh({ outcome = it.useDefault(fieldId) }) { shell ->
            (outcome as? SettingsPanelEdit.Unserializable)?.let { shell.copy(error = SettingsError(SettingsErrorKind.DefaultResetFailed, it.message)) } ?: shell
        }
    }

    /**
     * Apply (`applyDrafts`): the drafts' one commit — refused before anything
     * is submitted when invalid, nothing to do without changes — submitted as
     * one undoable step; the panel then reads the node again.
     */
    fun apply() {
        val shell = settingsShell?.takeIf { it.canApply } ?: return
        work { project ->
            val opened = native ?: return@work
            val outcome = try {
                project.prepare(opened)
            } catch (failure: Throwable) {
                SettingsPanelApply.Failed(reason(failure))
            }
            if (outcome !is SettingsPanelApply.Committed) {
                val view = opened.view(shell.mode, shell.search)
                val state = opened.state()
                post {
                    val current = settingsShell ?: return@post
                    if (current.targetId == shell.targetId) settingsShell = current.copy(view = view, draft = state).prepared(outcome) ?: current
                }
                return@work
            }
            post {
                settingsShell?.let { if (it.targetId == shell.targetId) settingsShell = it.copy(busy = true, error = null, note = SettingsNote.Applying(outcome.changes)) }
            }
            val failure = try {
                project.submit(opened).get()
                null
            } catch (thrown: Throwable) {
                reason(thrown)
            }
            post {
                val current = settingsShell ?: return@post
                if (current.targetId != shell.targetId) return@post
                if (failure != null) {
                    val kept = current.copy(busy = false, error = SettingsError(SettingsErrorKind.NotApplied, failure), note = SettingsNote.KeptForReview)
                    // The project change that waited while this ran: the kept draft is now a conflict.
                    settingsShell = if (kept.projectChanged(seen?.first) == SettingsRefresh.Conflict) kept.copy(conflict = true, note = SettingsNote.ConflictKept) else kept
                } else {
                    // The node as the project now holds it: a fresh panel on the new state.
                    settingsShell = current.copy(busy = false, conflict = false, loading = true)
                    load(current.targetId, current.mode, current.search, SettingsNote.Applied(outcome.changes))
                }
            }
        }
    }

    /** Cancel: the drafts dropped; under a conflict, "Discard draft and reload current settings". */
    fun cancel() {
        val shell = settingsShell?.takeIf { it.canCancel } ?: return
        if (shell.conflict) return discardAndReload()
        refresh({ it.cancel() }) { it.copy(error = null, note = SettingsNote.Cancelled) }
    }

    /** "Discard draft and reload current settings". */
    fun discardAndReload() {
        val shell = settingsShell?.takeIf { it.conflict && !it.loading && !it.busy } ?: return
        settingsShell = shell.copy(conflict = false, error = null)
        reloadSettings(SettingsNote.Reloaded)
    }

    // ---- The height ranges ----

    private fun openRanges(objectId: String) {
        settingsShell = null
        rangesShell = RangesShell(objectId)
        readRanges(objectId, keep = null)
        worker.execute {
            native?.close()
            native = null
        }
    }

    /** Reads [objectId]'s ranges on the current state; the forms open afresh, the status stays. */
    private fun readRanges(objectId: String, keep: RangesShell?) = work { project ->
        val read = try {
            project.layerRanges(objectId).get()
        } catch (_: Throwable) {
            null
        }
        ranges = read
        post {
            val shell = rangesShell ?: return@post
            if (shell.objectId != objectId) return@post
            val projection = read?.projection
            val edit = projection?.selectedRange?.let(RangeForms::editForm) ?: RangeForm()
            rangesShell = shell.copy(projection = projection, add = RangeForm(), edit = edit, split = RangeForm(), loaded = true, status = keep?.status ?: shell.status)
        }
    }

    fun typeAdd(form: RangeForm) { rangesShell = rangesShell?.copy(add = form.copy(touched = true)) }
    fun typeEdit(form: RangeForm) { rangesShell = rangesShell?.copy(edit = form.copy(touched = true)) }
    fun typeSplit(form: RangeForm) { rangesShell = rangesShell?.copy(split = form.copy(touched = true)) }

    /** Runs one height-range operation as the browser's editor does (`runOperation`): pending, then done or rejected. */
    private fun operate(operation: LayerRangeOperation, edit: (ProjectSettings, LayerRangePanel) -> CompletableFuture<*>) {
        val shell = rangesShell?.takeIf { !it.pending && it.projection != null } ?: return
        work { project ->
            val read = ranges ?: return@work
            val words = LayerRangeEditors.messages(operation)
            post { rangesShell = rangesShell?.copy(pending = true, status = EditorStatus.Pending(words.pending)) }
            val failure = try {
                edit(project, read).get()
                null
            } catch (thrown: Throwable) {
                reason(thrown)
            }
            post {
                val current = rangesShell ?: return@post
                if (current.objectId != shell.objectId) return@post
                rangesShell = current.copy(pending = false, status = if (failure == null) EditorStatus.Done(words.success) else EditorStatus.Rejected(failure))
                // The editor reads the project afresh either way: nothing was changed optimistically.
                readRanges(current.objectId, keep = rangesShell)
            }
        }
    }

    fun addRange(minZMm: Double, maxZMm: Double) =
        operate(LayerRangeOperation.Add(minZMm, maxZMm)) { project, read -> project.addLayerRange(read, minZMm, maxZMm) }

    fun editRange(rangeId: String, fromMinZMm: Double, fromMaxZMm: Double, minZMm: Double, maxZMm: Double) =
        operate(LayerRangeOperation.Edit(fromMinZMm, fromMaxZMm, minZMm, maxZMm)) { project, read -> project.editLayerRange(read, rangeId, minZMm, maxZMm) }

    fun splitRange(rangeId: String, splitZMm: Double) =
        operate(LayerRangeOperation.Split(splitZMm)) { project, read -> project.splitLayerRange(read, rangeId, splitZMm) }

    fun mergeRange(rangeId: String, otherRangeId: String, previous: Boolean) =
        operate(LayerRangeOperation.Merge(previous)) { project, read -> project.mergeLayerRanges(read, rangeId, otherRangeId) }

    fun deleteRange(rangeId: String) =
        operate(LayerRangeOperation.Delete) { project, read -> project.deleteLayerRange(read, rangeId) }

    /** Selects a listed range, as its tree row does. */
    fun selectRange(rangeId: String) = work { project ->
        runCatching { project.selectLayerRange(rangeId).get() }
    }

    // ---- The volume roles ----

    /** The section the selection asks for (main thread): a part's choices read afresh, the hint, or nothing. */
    private fun followSelection(view: ProjectView) {
        val target = VolumeRoleSection.target(view.selection.primary)
        val shell = rolesShell
        when {
            target == null -> rolesShell = null
            shell == null || shell.target != target -> {
                rolesShell = RolesShell(target, status = shell?.status ?: EditorStatus.Idle)
                if (target is RoleTarget.Part) readRoles(target.volumeId)
            }
            !shell.pending && target is RoleTarget.Part -> readRoles(target.volumeId)
        }
    }

    /** Reads part [volumeId]'s role choices on the current state; the status stays. */
    private fun readRoles(volumeId: String) {
        val workspace = host.workspace() ?: return
        worker.execute {
            val read = try {
                (settings ?: ProjectSettings(workspace).also { settings = it }).volumeRoles(volumeId).get()
            } catch (_: Throwable) {
                null
            }
            roles = read
            post {
                val shell = rolesShell ?: return@post
                if ((shell.target as? RoleTarget.Part)?.volumeId != volumeId) return@post
                rolesShell = shell.copy(projection = read?.projection, loaded = true)
            }
        }
    }

    /**
     * Converts the selected part to [role] as the browser's editor does
     * (`runOperation`): only a choice the core offers, its pending words, then
     * done or rejected; the section reads the project afresh either way.
     */
    fun convertRole(role: VolumeRole) {
        val shell = rolesShell?.takeIf { !it.pending } ?: return
        val projection = shell.projection ?: return
        if (projection.choices.none { it.role == role && VolumeRoleSection.choosable(it, pending = false) }) return
        val workspace = host.workspace() ?: return
        rolesShell = shell.copy(pending = true)
        worker.execute {
            val read = roles?.takeIf { it.projection.volumeId == projection.volumeId }
            var success: String? = null
            val failure = try {
                checkNotNull(read) { "The part's roles were not read." }
                val words = VolumeRoleEditors.messages(read.projection.volumeName, role)
                post { rolesShell = rolesShell?.copy(status = EditorStatus.Pending(words.pending)) }
                (settings ?: ProjectSettings(workspace).also { settings = it }).convertVolumeRole(read, role).get()
                success = words.success
                null
            } catch (thrown: Throwable) {
                reason(thrown)
            }
            post {
                val current = rolesShell ?: return@post
                rolesShell = current.copy(pending = false, status = success?.let { EditorStatus.Done(it) } ?: EditorStatus.Rejected(failure.orEmpty()))
                (current.target as? RoleTarget.Part)?.let { readRoles(it.volumeId) }
            }
        }
    }

    override fun close() {
        worker.execute {
            native?.close()
            native = null
        }
        worker.shutdown()
    }
}
