package dev.orcaxr.core

import java.time.ZoneId
import java.util.concurrent.CompletableFuture

/**
 * Which state of the project something was made from — the browser's slice
 * guard (`sourceRevision`, `sourceHash`, `sourceAssetHash`): equal only while
 * nothing in the project changed. The revision only grows, so even an undo
 * back to the same content is a different state.
 */
data class ProjectRevision(val revision: Long, val semanticHash: String, val assetFingerprint: String)

/**
 * One plate as the project names it: [name] is its own, or "Plate n" as the
 * browser lists one without a name; [active] for the plate slicing works on
 * (the browser's `activePlateId`).
 */
data class ProjectPlateState(
    val id: String,
    val name: String,
    val printable: Boolean,
    val objects: Int,
    val active: Boolean = false,
)

/**
 * The session's selection (the browser's `SelectionStore` snapshot): its refs
 * in order — at most [ProjectWorkspace.MAX_VIEW_SELECTION] of them, of
 * [total] — and the primary one, which edits of "the selected model" act on.
 */
data class ProjectSelectionView(
    val refs: List<ProjectIntents.SelectionEntity> = emptyList(),
    val primary: ProjectIntents.SelectionEntity? = null,
    val total: Long = 0,
) {
    /** The selected instances, as the renderer highlights them (the browser's `selectedInstanceIds`). */
    val instances: Set<String>
        get() = refs.mapNotNullTo(LinkedHashSet()) { (it as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::unitsText) }

    /** Whether the primary selection is an instance: the browser's `hasInstanceSelection`. */
    val hasInstance: Boolean get() = primary is ProjectIntents.SelectionEntity.Instance

    private companion object {
        fun unitsText(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    }
}

/**
 * One action as the core's capability catalogue offers it now
 * (`ProjectSession.capabilities`): its catalogue [label] and whether the
 * workspace enables it, with the catalogue's [reason] when it does not.
 */
data class ProjectActionState(val id: String, val label: String, val enabled: Boolean, val reason: String? = null)

/** How a tree row's activation changes the selection (the browser's Objects panel): a plain click, Ctrl/Meta, Shift. */
typealias ProjectRowSelection = ProjectIntents.ObjectTreeSelectionMode

/** One plate's slice preflight and the state of the project it describes. At most
 * [ProjectWorkspace.MAX_PREFLIGHT_ISSUES] issues are read; the summary counts them all. */
class ProjectPlatePreflight(
    val revision: ProjectRevision,
    val summary: ProjectIntents.PreflightSummary,
    val issues: List<ProjectIntents.PreflightIssue>,
)

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
    /** The state the session last acknowledged, once it has answered. */
    val revision: ProjectRevision? = null,
    /** The bed the workspace places on, from the project's own configuration and its active plate's tower. */
    val bed: WorkspaceBed = WorkspaceBed.DEFAULT,
    /** The active plate, once the session has one. */
    val activePlate: ProjectPlateState? = null,
    /** Every plate, in the project's plate order (the browser's plate bar). */
    val plateList: List<ProjectPlateState> = emptyList(),
    /** The session's selection; tree [rows] report theirs as `selected`. */
    val selection: ProjectSelectionView = ProjectSelectionView(),
    /** The selection's names, in its order, for what the 3D view says ([ProjectSceneSummary]). */
    val selectionNames: List<String> = emptyList(),
    /** The actions the Project area offers, by catalogue ID, as the core enables them for the selection. */
    val actions: Map<String, ProjectActionState> = emptyMap(),
    /** The catalogue's context menus of an object and of a plate, in catalogue order. */
    val objectMenu: List<ProjectActionState> = emptyList(),
    val plateMenu: List<ProjectActionState> = emptyList(),
    /** The transform inspector of the selection's primary instance; none without one. */
    val inspector: ProjectInspector? = null,
    /** What the selection can be assigned and every filament the project offers (the browser's assignment snapshot). */
    val filaments: FilamentAssignment = FilamentAssignment(),
    /** The filament slots the project's own physical filaments describe: each one's preset, nozzle, colour and type. */
    val filamentSlots: SlicingSlots = SlicingSlots(emptyList(), emptyList(), emptyList()),
    /** The virtual filament library the project shows (the browser's library), or why it shows none. */
    val virtualFilaments: VirtualFilamentLibraryResult = VirtualFilamentLibraryResult.Shown(VirtualFilamentLibrary.EMPTY),
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
    /** Where unsaved work is kept for a session the system ends; none keeps nothing. */
    private val recovery: ProjectRecovery? = null,
    /** Runs a task after a delay in milliseconds; closing the handle cancels it. */
    private val schedule: (Long, () -> Unit) -> AutoCloseable = ::delayed,
    /** Where new entity IDs come from: the browser's UUID rule over secure words. */
    internal val ids: ProjectIds = ProjectIds(),
) : AutoCloseable {
    companion object {
        /** The browser's archive budgets: its safe-ZIP defaults and multi-million facets. */
        val ARCHIVE = ProjectArchiveOptions(1L shl 30, 4096, 512L shl 20, 2L shl 30, 16_000_000, 16_000_000,
            2_000_000, 64L shl 20, 256_000_000, 4096, 512L shl 20, 2L shl 30, 1_000_000)
        val EXPORT = ProjectExportLimits(512L shl 20, 4096, 2L shl 30)
        /** The tree's largest page (the browser renders it in windows of this size). */
        /** Vertices per mesh-packet chunk: small enough for 16-bit indices. */
        const val MESH_CHUNK_VERTICES = 65_535L
        /** The bounds a project document the workspace makes (the starting, new or reset
         * project) is read under: 1 M nodes, 8 M text units, 4096 assets of at most 512 MiB
         * and 2 GiB in all, and 100 history entries in 64 MiB. */
        fun hostOptions(documentBytes: Long) =
            ProjectHostOptions(documentBytes, 1_000_000, 8_000_000, 1024, 128, 4096, 512L shl 20, 2L shl 30, 100, 64L shl 20)

        /** The browser workspace's staged-edit pool (`INSTANCE_STAGING_LIMITS`): four staged
         * resources, 4096 commands, a whole project's 256 Mi units and its archive's 2 GiB of assets. */
        val STAGING = ProjectStagingPoolOptions(4, 4096, 256L shl 20, 2048L shl 20)
        /** The browser's clipboard bounds (`CLIPBOARD_ASSET_LIMITS`): 4096 assets in 512 MiB. */
        val CLIPBOARD = ProjectStagingClipboardOptions(4096, 512L shl 20)
        /** A project's own printer and filaments, as an opened project carries them. */
        val AUTHORED: ProjectIntents.PreflightTarget = ProjectIntents.PreflightTarget.Authored(ProjectIntents.Empty)
        /** A preflight's bounds: the archive's assets and facets, and the engine's 64 filaments. */
        val PREFLIGHT = ProjectIntents.PreflightBudget(512L shl 20, 48_000_000, 48_000_000, 4096, 48_000_000, 64)
        /** The most preflight issues read for display. */
        const val MAX_PREFLIGHT_ISSUES = 256L
        private const val TREE_PAGE = 64L
        private const val MAX_NAME_UNITS = 256L
        /** The most selection refs the view keeps (and the tree is paged with). */
        const val MAX_VIEW_SELECTION = 4096L
        /** The browser's plate limit (`MAX_PROJECT_PLATES`) and name bounds (`MAX_UI_NAME_LENGTH`, plate names). */
        const val MAX_PROJECT_PLATES = 36
        const val MAX_NAME_LENGTH = 160
        const val MAX_PLATE_NAME_LENGTH = 120
        /** The catalogue actions the Project area offers from its menu (`dom-menu`) and its plate bar (`dom-inspector`). */
        val MENU_ACTIONS = listOf(
            "edit_select_all", "edit_deselect_all", "edit_duplicate", "add_instance", "edit_delete_selected", "edit_delete_all",
            "toggle_printable", "instance_to_object", "add_plate", "duplicate_plate", "delete_plate",
        )
        val INSPECTOR_ACTIONS = listOf("activate_plate", "rename_plate", "reorder_plates", "set_plate_printable", "objects_rename")
        /**
         * The placement actions, read where the browser offers each: its menu
         * (mirror, the resets, centre, scale to fit, arrange), its toolbar
         * (lay flat, drop to bed) and, for the inspector's fields, the
         * transform tools its Tool Settings panel invokes on `dom-inspector`.
         */
        val PLACEMENT_MENU_ACTIONS = listOf(
            "mirror_x", "mirror_y", "mirror_z", "reset_rotation", "reset_scale", "center_on_plate", "scale_to_fit_volume", "arrange_all",
        )
        val PLACEMENT_TOOLBAR_ACTIONS = listOf("tool_lay_on_face", "drop_to_bed")
        val TRANSFORM_ACTIONS = listOf("tool_move", "tool_rotate", "tool_scale")
        /** The slicing actions ([sliceActions]): Slice and Cancel Slice on the browser's toolbar, Slice All Plates in its menu. */
        val SLICE_TOOLBAR_ACTIONS = listOf("slice_active_plate", "slice_cancel")
        val SLICE_MENU_ACTIONS = listOf("slice_all_plates")
        /** The catalogue actions the Project area's Edit and Add menus offer for creation (`dom-menu`):
         * the clipboard, the bed fill, the primitives, the helper volumes and Set as Negative Part. */
        val CREATE_ACTIONS = listOf(
            "edit_cut", "edit_copy", "edit_paste", "fill_bed_with_instances",
            "add_primitive_cube", "add_primitive_cylinder", "add_primitive_sphere", "add_primitive_cone", "add_primitive_disc", "add_primitive_torus",
            "add_modifier", "add_support_enforcer", "add_support_blocker", "set_negative_part",
        )
        /** The browser's words for Set as Negative Part with nothing selected (`CanonicalWorkspaceController.setNegativePart`). */
        const val NEGATIVE_PART_UNSELECTED = "Set as Negative Part requires a selected object, instance, or volume"
        /**
         * The painting actions, read where the browser offers each: the paint
         * tools on its toolbar (`dom-toolbar`, as the paint panel's Start
         * painting invokes them) and the panel's Erase all and its `1`–`9`
         * palette rows (`dom-inspector`).
         */
        val PAINT_TOOLBAR_ACTIONS = PaintChannel.entries.map { it.toolAction }
        val PAINT_INSPECTOR_ACTIONS = listOf("paint_erase_all") + (1..9).map { "paint_select_filament_$it" }
        /**
         * The model tools the Project area offers where the browser does: its
         * menu's split and simplify (`dom-menu`; split and simplify are also
         * an object's context actions), its toolbar's Measure (`dom-toolbar`)
         * and the Simplify and Measure panels' controls (`dom-inspector`).
         */
        val MODEL_TOOL_MENU_ACTIONS = listOf("split_to_objects", "split_to_parts", "simplify_model")
        val MODEL_TOOL_TOOLBAR_ACTIONS = listOf("tool_measure")
        val MODEL_TOOL_INSPECTOR_ACTIONS = listOf("simplify_preview", "simplify_apply", "simplify_cancel", "measure_clear")
        /** The browser's words for a Split to Objects whose confirmation no longer describes the project (`StaleCanonicalSplitToObjectsError`). */
        const val STALE_SPLIT = "Split to Objects confirmation is stale; reselect the model and review the affected instances again"
        /** The quadric error a one-shot Simplify allows (`SIMPLIFY_DEFAULT_MAX_ERROR`). */
        const val SIMPLIFY_DEFAULT_MAX_ERROR = 1.0
        /** Measure captures kept, by mesh asset; an asset ID names immutable bytes, so none goes stale. */
        private const val MEASURE_CAPTURES = 8
        /** The capability host facts of the Android shell: the flat (non-XR) workspace, preparing, without a printer job; [clipboard] while a copy is held, [previewing] while a simplify preview is shown. */
        private fun host(clipboard: Boolean, previewing: Boolean) = ProjectIntents.CapabilityHostState(
            ProjectIntents.OptionalStartupSnapshot.Absent(ProjectIntents.Empty), ProjectIntents.WorkspaceMode.Prepare,
            simplifyPreviewing = previewing, calibrationSessionOpen = false, projectionHealthy = true, hasClipboard = clipboard,
            isSlicing = false, gcodeReady = false, preflightBlocked = false, printerJobState = ProjectIntents.PrinterJobUiState.Disconnected,
        )
        private const val MAX_PLATES = 4096L
        /** The browser's capture timing: 5 s after the latest edit, at most 30 s after the first unsaved one. */
        const val CAPTURE_DELAY_MS = 5_000L
        const val CAPTURE_LIMIT_MS = 30_000L
        private val timers = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "project-recovery").also { it.isDaemon = true }
        }

        private fun delayed(delayMs: Long, task: () -> Unit): AutoCloseable {
            val pending = timers.schedule(task, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            return AutoCloseable { pending.cancel(false) }
        }
    }

    /** This editing session, which its recovery copy is kept under. */
    val session: String = java.util.UUID.randomUUID().toString()
    private var observed: String? = null
    private var firstEditAt: Long? = null
    private var timer: AutoCloseable? = null

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

    /** [bytes] into [upload] in the host's chunks: a project carrying a catalog configuration outgrows one. */
    private fun append(upload: ProjectUpload, bytes: ByteArray) {
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
            upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
    }

    /** A canonical document as an upload's prepared document. */
    private fun document(scope: ProjectPreparation, bytes: ByteArray): ProjectDocument {
        val options = hostOptions(bytes.size.toLong())
        val upload = scope.own(ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM))
        append(upload, bytes)
        upload.sealDocument()
        return upload.prepare()
    }

    /** Guards what the view is read from: the snapshot shown, the selection, the tree's expansion and range anchor. */
    private val showing = Any()
    /** The project snapshot the view shows (owned; replaced by each project effect). */
    private var shown: ProjectSnapshot? = null
    private var shownProject: String? = null
    /** The virtual filament library of the snapshot shown: read once per snapshot, not per selection. */
    private var shownLibrary: Pair<ProjectSnapshot, VirtualFilamentLibraryResult>? = null
    private var chosen = ProjectSelectionView()
    /** Rows the operator (or a reveal) opened, besides plates; plates the operator closed. */
    private val opened = LinkedHashSet<String>()
    private val closedPlates = HashSet<String>()
    /** The row a Shift activation extends from (the browser's Objects panel anchor). */
    private var anchor: String? = null
    @Volatile private var started = false
    private var disposed = false
    private val actionsQueued = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Adopts a newer snapshot and/or selection and reads the view from them. */
    private fun adopt(snapshot: ProjectSnapshot?, selection: ProjectSelectionView?) {
        val next = synchronized(showing) {
            if (disposed) {
                // A late effect after close: nothing shows it any more.
                snapshot?.close()
                return
            }
            if (snapshot != null) {
                shown?.close()
                shown = snapshot
            }
            if (selection != null) chosen = selection
            readView()
        } ?: return
        update(next)
    }

    /** Reads the view again from what it shows (an expansion changed, say). */
    private fun reread() {
        val next = synchronized(showing) { readView() } ?: return
        update(next)
    }

    /** The expansion the tree is paged with: plates open unless closed, objects and groups only once opened. Holds [showing]. */
    private fun expansion(snapshot: ProjectSnapshot): ProjectIntents.ObjectTreeExpansion {
        val plates = treePage(snapshot, ProjectIntents.ObjectTreeExpansion.Keys(emptyList()), emptyList(), null)?.rows.orEmpty()
            .filter { it.kind == ProjectIntents.ObjectTreeRowKind.Plate }.map { text(it.key) }
        return ProjectIntents.ObjectTreeExpansion.Keys((plates.filter { it !in closedPlates } + opened).distinct().map(::units))
    }

    private fun treeRequest(
        expansion: ProjectIntents.ObjectTreeExpansion,
        selection: List<ProjectIntents.SelectionEntity>,
        primary: ProjectIntents.SelectionEntity?,
        operation: ProjectIntents.ObjectTreeOperation,
    ) = ProjectIntents.ObjectTreeRequest(
        expansion, emptyList(), selection,
        primary?.let { ProjectIntents.OptionalSelectionEntity.Value(it) } ?: ProjectIntents.OptionalSelectionEntity.Absent(ProjectIntents.Empty),
        ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), operation,
    )

    private fun treePage(
        snapshot: ProjectSnapshot,
        expansion: ProjectIntents.ObjectTreeExpansion,
        selection: List<ProjectIntents.SelectionEntity>,
        primary: ProjectIntents.SelectionEntity?,
    ) = (snapshot.objectTree(
        treeRequest(expansion, selection, primary, ProjectIntents.ObjectTreeOperation.Page(ProjectIntents.ObjectTreePageRequest(0, TREE_PAGE))),
    ) as? ProjectIntents.ObjectTreeReply.Page)?.value

    /** The project's name, plates and object tree (with the selection) from the snapshot shown. Holds [showing]. */
    private fun readView(): ((ProjectView) -> ProjectView)? {
        val snapshot = shown ?: return null
        val project = String(CharArray(snapshot.idLength().toInt()).also { units ->
            var start = 0
            while (start < units.size) {
                val chunk = snapshot.id(start.toLong(), minOf(ProjectHost.MAX_TEXT_CHUNK_UNITS, units.size - start).toLong())
                check(chunk.isNotEmpty()) { "invalid_projection" }
                chunk.copyInto(units, start)
                start += chunk.size
            }
        })
        if (project != shownProject) {
            // Another project: its rows have nothing to do with the last one's.
            shownProject = project
            opened.clear()
            closedPlates.clear()
            anchor = null
        }
        val (name, count, plates) = snapshot.query().use { root ->
            val length = minOf(root.textLength(QueryText.NAME) ?: 0, MAX_NAME_UNITS)
            Triple(
                String(root.text(QueryText.NAME, 0, length)),
                (root.metadata().values[QueryNumber.PLATE_COUNT] ?: 0.0).toInt(),
                ProjectFacts.plates(root).mapIndexed { index, plate ->
                    ProjectPlateState(plate.id, plate.name.ifEmpty { "Plate ${index + 1}" }, plate.printable, plate.objects, plate.active)
                },
            )
        }
        val selection = chosen
        val page = treePage(snapshot, expansion(snapshot), selection.refs, selection.primary)
        val active = plates.firstOrNull { it.active }
        // The bed the project's own configuration states, with the active plate's wipe-tower keep-out.
        val bed = snapshot.workspaceBed(active?.id)
        val inspector = snapshot.query().use { root -> ProjectInspection.inspector(root, selection) }
        val (filaments, filamentSlots) = filamentsOf(snapshot, selection)
        val names = if (selection.refs.isEmpty()) emptyList() else snapshot.query().use { root -> ProjectSceneSummary.names(root, selection.refs) }
        val library = shownLibrary?.takeIf { it.first === snapshot }?.second
            ?: snapshot.virtualFilamentLibrary().also { shownLibrary = snapshot to it }
        return { view: ProjectView ->
            view.copy(
                name = name, plates = count, rows = page?.rows.orEmpty(), totalRows = page?.totalRows ?: 0,
                activePlate = active, plateList = plates, selection = selection, selectionNames = names, bed = bed, inspector = inspector,
                filaments = filaments, filamentSlots = filamentSlots, virtualFilaments = library,
            )
        }
    }

    /** A selection's refs and primary, at most [limit] refs of it. */
    private fun selectionView(selection: ProjectSelection, limit: Long = MAX_VIEW_SELECTION): ProjectSelectionView {
        fun entity(position: Long): ProjectIntents.SelectionEntity {
            val length = selection.idLength(position)
            val units = ArrayList<Int>(length.toInt())
            var start = 0L
            while (start < length) {
                val chunk = selection.id(position, start, minOf(ProjectHost.MAX_TEXT_CHUNK_UNITS.toLong(), length - start))
                check(chunk.isNotEmpty()) { "invalid_selection" }
                chunk.forEach { units += it.code }
                start += chunk.size
            }
            return when (selection.kind(position)) {
                ProjectHost.SELECT_PROJECT -> ProjectIntents.SelectionEntity.Project(ProjectIntents.Empty)
                ProjectHost.SELECT_PLATE -> ProjectIntents.SelectionEntity.Plate(units)
                ProjectHost.SELECT_OBJECT -> ProjectIntents.SelectionEntity.Object(units)
                ProjectHost.SELECT_VOLUME -> ProjectIntents.SelectionEntity.Volume(units)
                ProjectHost.SELECT_INSTANCE -> ProjectIntents.SelectionEntity.Instance(units)
                ProjectHost.SELECT_LAYER_RANGE -> ProjectIntents.SelectionEntity.LayerRange(units)
                ProjectHost.SELECT_FILAMENT -> ProjectIntents.SelectionEntity.Filament(units)
                else -> error("invalid_selection")
            }
        }
        val total = selection.count()
        val refs = List(minOf(total, limit).toInt()) { entity(it.toLong()) }
        val primary = selection.primaryIndex().takeIf { it in 0 until total }?.let { if (it < refs.size) refs[it.toInt()] else entity(it) }
        return ProjectSelectionView(refs, primary, total)
    }

    /** The newest project and selection the effects carry, then the actions they enable. */
    private fun effects(effects: ProjectEffects) {
        var project = -1L
        var selection = -1L
        for (position in 0 until effects.count()) when (effects.kind(position)) {
            ProjectHost.EFFECT_PROJECT -> project = position
            ProjectHost.EFFECT_SELECTION -> selection = position
        }
        val chosen = if (selection >= 0) effects.selection(selection, false).use { selectionView(it) } else null
        val snapshot = if (project >= 0) effects.project(project, false) else null
        try {
            if (snapshot != null || chosen != null) adopt(snapshot, chosen)
        } catch (failure: Throwable) {
            if (synchronized(showing) { shown !== snapshot }) snapshot?.close()
            throw failure
        }
        refreshActions()
    }

    /**
     * Reads which actions the core enables now (`ProjectSession.capabilities`,
     * the browser's registry gate) on the authority, after the operations
     * queued before it; reads requested while one is queued are that one.
     */
    private fun refreshActions() {
        if (!started || !actionsQueued.compareAndSet(false, true)) return
        val request = actor.inspect { session ->
            actionsQueued.set(false)
            fun page(surface: ProjectIntents.ActionSurface, query: ProjectIntents.CapabilityQuery) =
                session.capabilities(ProjectIntents.CapabilityRequest(surface, host(clipboard != null, simplifyPreview != null), query)).actions.map { action ->
                    val availability = action.availability
                    val reason = (availability as? ProjectIntents.ActionAvailability.Disabled)?.value?.text
                        ?: (availability as? ProjectIntents.ActionAvailability.Hidden)?.value?.text
                    ProjectActionState(text(action.id), text(action.label), availability is ProjectIntents.ActionAvailability.Enabled, reason?.let(::text))
                }
            fun actions(surface: ProjectIntents.ActionSurface, ids: List<String>) =
                page(surface, ProjectIntents.CapabilityQuery.Actions(ProjectIntents.CapabilityActions(ids.map(::units))))
            fun context(target: ProjectIntents.ActionContextTarget) =
                page(ProjectIntents.ActionSurface.DomContext, ProjectIntents.CapabilityQuery.Context(ProjectIntents.CapabilityContextPage(target, 0, TREE_PAGE)))
            val all = actions(ProjectIntents.ActionSurface.DomMenu, MENU_ACTIONS) + actions(ProjectIntents.ActionSurface.DomInspector, INSPECTOR_ACTIONS) +
                actions(ProjectIntents.ActionSurface.DomMenu, CREATE_ACTIONS)
            val placement = actions(ProjectIntents.ActionSurface.DomMenu, PLACEMENT_MENU_ACTIONS) +
                actions(ProjectIntents.ActionSurface.DomToolbar, PLACEMENT_TOOLBAR_ACTIONS) +
                actions(ProjectIntents.ActionSurface.DomInspector, TRANSFORM_ACTIONS)
            val painting = actions(ProjectIntents.ActionSurface.DomToolbar, PAINT_TOOLBAR_ACTIONS) +
                actions(ProjectIntents.ActionSurface.DomInspector, PAINT_INSPECTOR_ACTIONS)
            val tools = actions(ProjectIntents.ActionSurface.DomMenu, MODEL_TOOL_MENU_ACTIONS) +
                actions(ProjectIntents.ActionSurface.DomToolbar, MODEL_TOOL_TOOLBAR_ACTIONS) +
                actions(ProjectIntents.ActionSurface.DomInspector, MODEL_TOOL_INSPECTOR_ACTIONS)
            Triple((all + placement + painting + tools).associateBy { it.id }, context(ProjectIntents.ActionContextTarget.Object), context(ProjectIntents.ActionContextTarget.Plate))
        }
        request.completion.whenComplete { outcome, _ ->
            @Suppress("UNCHECKED_CAST")
            val read = (outcome as? ProjectOutcome.Inspected)?.result?.getOrNull() as? Triple<Map<String, ProjectActionState>, List<ProjectActionState>, List<ProjectActionState>>
            if (read == null) {
                // Refused or failed before it ran: a later change asks again.
                actionsQueued.set(false)
                return@whenComplete
            }
            update { it.copy(actions = read.first, objectMenu = read.second, plateMenu = read.third) }
        }
    }

    /**
     * Every action [surface] offers now, in catalogue order, as the core
     * enables it for the Android shell (`ProjectSession.capabilities`, paged
     * on the authority with the shell's host facts): what the command palette
     * lists (`command-palette`) and the model toolbar draws (`dom-toolbar`).
     * Hidden actions are left out, as the browser's palette and toolbar leave
     * them out.
     */
    fun surfaceActions(surface: ProjectIntents.ActionSurface): CompletableFuture<List<ProjectActionState>> = inspect { session ->
        val listed = ArrayList<ProjectActionState>()
        var start = 0L
        do {
            val page = session.capabilities(
                ProjectIntents.CapabilityRequest(
                    surface, host(clipboard != null, simplifyPreview != null),
                    ProjectIntents.CapabilityQuery.Page(ProjectIntents.SettingsTargetPageRequest(start, TREE_PAGE)),
                ),
            )
            for (action in page.actions) {
                val availability = action.availability
                if (availability is ProjectIntents.ActionAvailability.Hidden) continue
                val reason = (availability as? ProjectIntents.ActionAvailability.Disabled)?.value?.text
                listed += ProjectActionState(text(action.id), text(action.label), availability is ProjectIntents.ActionAvailability.Enabled, reason?.let(::text))
            }
            start += page.actions.size
        } while (page.actions.isNotEmpty() && start < page.total)
        listed
    }

    val actor: ProjectActor = ProjectActor.open({ scope, nonce ->
        val bytes = NewProjects.empty(words(), NewProjects.timestamp(clock()))
        val options = hostOptions(bytes.size.toLong())
        val upload = scope.own(ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM))
        append(upload, bytes)
        upload.sealDocument()
        val session = upload.open(nonce)
        // The first view, before any effect.
        adopt(session.snapshot(), ProjectSelectionView())
        session
    }, ::effects, staging = STAGING)

    internal fun outcome(request: ProjectRequest): CompletableFuture<ProjectOutcome> = request.completion.toCompletableFuture()

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
                    revision = revision(state.guard),
                )
            }
            observe(state)
            state to (completed.authority ?: throw ProjectFailure("The project did not answer."))
        }

    /**
     * Schedules a recovery capture when the project has unsaved changes it has
     * not captured yet, as the browser does: 5 s after the latest change, and
     * never later than 30 s after the first unsaved one. A clean project
     * cancels it.
     */
    private fun observe(state: ProjectIntents.SessionAcknowledgement) {
        if (recovery == null) return
        synchronized(lock) {
            if (state.history.dirtyCategories.isEmpty()) {
                timer?.close()
                timer = null
                firstEditAt = null
                observed = null
                return
            }
            val identity = "${text(state.guard.projectId)}|${state.guard.revision}|${text(state.guard.semanticHash)}"
            if (identity == observed) return
            observed = identity
            val now = clock()
            val first = firstEditAt ?: now.also { firstEditAt = it }
            timer?.close()
            timer = schedule(maxOf(0, minOf(CAPTURE_DELAY_MS, first + CAPTURE_LIMIT_MS - now))) { captureRecovery() }
        }
    }

    /**
     * Captures this session's recovery copy now, with the identities the
     * restore will be checked against; answers whether a copy was written. A
     * clean project writes none.
     */
    fun captureRecovery(): CompletableFuture<Boolean> {
        val store = recovery ?: return CompletableFuture.completedFuture(false)
        synchronized(lock) {
            timer = null
            firstEditAt = null
        }
        return query().thenCompose { (state, guard) ->
            if (state.history.dirtyCategories.isEmpty()) return@thenCompose CompletableFuture.completedFuture(false)
            val identity = ProjectIdentity(text(state.guard.projectId), text(state.guard.semanticHash), text(state.guard.assetFingerprint))
            val current = view
            outcome(actor.exportDocument(guard, EXPORT) { _, source ->
                store.capture(session, current.name, current.document, clock(), identity) { stream ->
                    ProjectDocuments.save(source, object : ProjectDocumentOutput {
                        override fun openOutput() = stream
                    }, ARCHIVE)
                }
            }).thenApply { it is ProjectOutcome.Exported }
        }
    }

    /** Forgets this session's recovery copy: its changes were discarded or saved. */
    fun discardRecovery() {
        synchronized(lock) {
            timer?.close()
            timer = null
            firstEditAt = null
            observed = null
        }
        recovery?.discard(session)
    }

    /**
     * Restores a recovery copy in place of the current project, refused before
     * adoption unless the copy is the project its record names (id, semantic
     * hash, asset fingerprint), as the browser's recovery proof requires. The
     * copy stays until the operator discards it.
     */
    fun restore(entry: ProjectRecovery.Entry): CompletableFuture<Unit> {
        val store = recovery ?: return CompletableFuture.failedFuture(ProjectFailure("Nothing to restore."))
        if (entry.damaged) return CompletableFuture.failedFuture(ProjectFailure("That copy is damaged and cannot be restored."))
        return run({ _, record ->
            actor.openDocument { scope ->
                capturing(record) {
                    val document = ProjectDocuments.prepare(scope, store.document(entry.session), ARCHIVE, resolver, ProjectIntegerProfile.CHROMIUM).document()
                    if (document.identity() != entry.identity) {
                        document.close()
                        error("recovery_mismatch")
                    }
                    document
                }
            }
        }) { result ->
            if (result is ProjectOutcome.Opened || result is ProjectOutcome.OpenedWithoutSummary) update { it.copy(document = null) } else null
        }
    }

    /** Reads the session on the actor's authority, between operations; the read's failure is its answer. */
    @Suppress("UNCHECKED_CAST")
    internal fun <T> inspect(read: (ProjectSession) -> T): CompletableFuture<T> =
        outcome(actor.inspect(read)).thenApply { result ->
            (result as? ProjectOutcome.Inspected)?.result?.getOrThrow() as T? ?: throw failure(result, null)
        }

    /**
     * One page of the renderer's deltas (`ProjectSession.render`): the
     * changes from the snapshot a renderer shows to the session's current
     * one (or the request's target), at most 64 at a time.
     */
    fun render(request: ProjectIntents.RenderRequest): CompletableFuture<ProjectIntents.RenderPage> = inspect { it.render(request) }

    /** One mesh asset's renderer packet, read off the authority by the caller, who closes it. */
    fun meshPacket(assetId: String, maxChunkVertices: Long = MESH_CHUNK_VERTICES): CompletableFuture<ProjectMeshPacket> =
        inspect { it.meshPacket(ProjectIntents.MeshPacketRequest(units(assetId), maxChunkVertices)) }

    /** Waits for the session to start and reads its first view, then which actions it enables. */
    fun ready(): CompletableFuture<ProjectView> = outcome(actor.ready).thenCompose {
        started = true
        refreshActions()
        query()
    }.thenApply { view }

    internal fun failure(outcome: ProjectOutcome, cause: Throwable?): ProjectFailure = ProjectFailure(
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
    ): CompletableFuture<T> = guarded({ _, guard, record -> start(guard, record) }, accept)

    /** [run], with the state the guard was taken from: a guarded operation works on exactly that state. */
    private fun <T> guarded(
        start: (ProjectIntents.SessionAcknowledgement, ProjectActorGuard, (Throwable) -> Unit) -> ProjectRequest,
        accept: (ProjectOutcome) -> T?,
    ): CompletableFuture<T> {
        var cause: Throwable? = null
        return query().thenCompose { (state, guard) -> outcome(start(state, guard) { cause = it }) }
            .thenCompose { result -> query().handle { _, _ -> result } }
            .thenApply { result -> accept(result) ?: throw failure(result, cause) }
    }

    private fun revision(guard: ProjectIntents.SessionGuard) =
        ProjectRevision(guard.revision, text(guard.semanticHash), text(guard.assetFingerprint))

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
        if (result is ProjectOutcome.Exported) {
            update { it.copy(document = name) }
            // The work is in a document now; its recovery copy is no longer needed.
            if (result.checkpoint == ProjectCheckpoint.SAVED) recovery?.discard(session)
        } else {
            null
        }
    }

    /** Writes a copy of the project as a 3MF document (to share it); the project's saved state is untouched. */
    fun export(output: ProjectDocumentOutput): CompletableFuture<Unit> = run({ guard, record ->
        actor.exportDocument(guard, EXPORT) { _, source -> capturing(record) { ProjectDocuments.save(source, output, ARCHIVE) } }
    }) { result -> if (result is ProjectOutcome.Exported) Unit else null }

    /**
     * The slice preflight of plate [plateId] as the project stands now (the
     * browser's `CanonicalSlicePreflightValidator`, in the shared core),
     * against the [target] made for the project's tool count: its own
     * printer and filaments (authored) or the catalog profile chosen for it
     * ([ProfileCatalogs.preflightTarget]), with the state it describes.
     */
    fun preflight(
        plateId: String,
        target: (toolCount: Int) -> ProjectIntents.PreflightTarget = { AUTHORED },
    ): CompletableFuture<ProjectPlatePreflight> = inspect { session ->
        val (revision, tools) = session.snapshot().use { snapshot ->
            val tools = snapshot.query().use { it.metadata().values[QueryNumber.TOOL_COUNT] ?: 0.0 }
            ProjectRevision(snapshot.revision(), snapshot.hash(), session.assetFingerprint()) to tools.toInt()
        }
        val request = ProjectIntents.PreflightRequest(1, units(plateId), target(tools), PREFLIGHT)
        session.captureGuard().use { guard ->
            session.captureExport(guard).use { capture ->
                capture.preflight(request).use { report ->
                    val summary = report.summary()
                    ProjectPlatePreflight(revision, summary, List(minOf(summary.issueCount, MAX_PREFLIGHT_ISSUES).toInt()) { report.issue(it.toLong()) })
                }
            }
        }
    }

    /**
     * The plates a slice of [scope] slices as the project stands now, in
     * slicing order, or the browser's words for why it slices none
     * ([SlicePlans]), with the state it describes.
     */
    fun slicePlan(scope: SliceScope): CompletableFuture<Pair<ProjectRevision, SlicePlan>> = inspect { session ->
        session.snapshot().use { snapshot ->
            ProjectRevision(snapshot.revision(), snapshot.hash(), session.assetFingerprint()) to snapshot.slicePlan(scope)
        }
    }

    /**
     * The slice actions as the core enables them now (the browser's registry
     * gate: `slice_active_plate`, `slice_all_plates`, `slice_cancel`), while a
     * slice is or is not [slicing] and the active plate's preflight does or
     * does not [block] it — the host facts only the slicing area knows.
     */
    fun sliceActions(slicing: Boolean, block: Boolean): CompletableFuture<Map<String, ProjectActionState>> = inspect { session ->
        val host = ProjectIntents.CapabilityHostState(
            ProjectIntents.OptionalStartupSnapshot.Absent(ProjectIntents.Empty), ProjectIntents.WorkspaceMode.Prepare,
            simplifyPreviewing = simplifyPreview != null, calibrationSessionOpen = false, projectionHealthy = true, hasClipboard = clipboard != null,
            isSlicing = slicing, gcodeReady = false, preflightBlocked = block, printerJobState = ProjectIntents.PrinterJobUiState.Disconnected,
        )
        // Where the browser offers each: Slice and Cancel Slice on its toolbar, Slice All Plates in its menu.
        listOf(ProjectIntents.ActionSurface.DomPrimary to SLICE_TOOLBAR_ACTIONS, ProjectIntents.ActionSurface.DomMenu to SLICE_MENU_ACTIONS)
            .flatMap { (surface, ids) ->
                val query = ProjectIntents.CapabilityQuery.Actions(ProjectIntents.CapabilityActions(ids.map(::units)))
                session.capabilities(ProjectIntents.CapabilityRequest(surface, host, query)).actions
            }
            .associate { action ->
                val availability = action.availability
                val reason = (availability as? ProjectIntents.ActionAvailability.Disabled)?.value?.text
                    ?: (availability as? ProjectIntents.ActionAvailability.Hidden)?.value?.text
                text(action.id) to ProjectActionState(text(action.id), text(action.label), availability is ProjectIntents.ActionAvailability.Enabled, reason?.let(::text))
            }
    }

    /**
     * Writes plate [plateId] as the one-plate archive an external slicer
     * loads (the browser's slice projection) to [output], and answers its
     * fingerprint, the print overrides to submit with it and the state of
     * the project it was written from. A plate that cannot be projected fails
     * with the browser's message before [output] opens. The project's saved
     * state is untouched.
     */
    fun projectPlate(plateId: String, output: ProjectDocumentOutput): CompletableFuture<ProjectPlateArchive> {
        var archive: ProjectPlateArchive? = null
        var refusal: ProjectFailure? = null
        var from: ProjectRevision? = null
        return guarded({ state, guard, record ->
            from = revision(state.guard)
            actor.exportDocument(guard, EXPORT) { _, source ->
                capturing(record) {
                    archive = try {
                        ProjectDocuments.savePlate(source, plateId, output, ARCHIVE, resolver, ProjectIntegerProfile.CHROMIUM)
                    } catch (failure: IllegalStateException) {
                        refusal = when (failure.message) {
                            "plate_projection_unknown_plate" -> ProjectFailure("Unknown plate $plateId")
                            "plate_projection_not_printable" -> ProjectFailure("Plate $plateId is not printable")
                            else -> null
                        }
                        throw failure
                    }
                }
            }
        }) { result ->
            // The export was guarded by the state just read, so the archive is that state's.
            if (result is ProjectOutcome.Exported) archive?.let { ProjectPlateArchive(it.sourceHash, it.overrides, it.warnings, from, it.thumbnails, it.profiles) } else null
        }
            // The export reads a failed callback as uncertain; a refused projection wrote nothing.
            .handle { value, error -> if (error == null) value else throw (refusal ?: error) }
    }

    /** Prepares a model import (STL/OBJ/AMF/ZIP) against the current project; nothing changes until it is committed. */
    fun prepareImport(input: ProjectDocumentInput, filename: String): CompletableFuture<ProjectActorImport> = run({ guard, record ->
        // Centred on the project's own printable area and dropped onto the bed, as the browser places an import.
        val placement = ProjectModelPlacement(view.bed.areaMm, dropToBed = true)
        actor.prepareImport(guard) { scope, base ->
            capturing(record) {
                val upload = ProjectDocuments.stageModel(scope, input, ProjectModelImportOptions(), resolver, ProjectIntegerProfile.CHROMIUM)
                base.prepareModel(upload, filename, NewProjects.timestamp(clock()), placement)
            }
        }
    }) { result -> (result as? ProjectOutcome.ImportPrepared)?.candidate }

    /** Commits a prepared import as one undoable entry, with the acknowledgements its preview requires. */
    fun commitImport(candidate: ProjectActorImport, acknowledged: List<String>): CompletableFuture<Unit> =
        outcome(actor.commitImport(candidate, acknowledged))
            .thenCompose { result -> query().handle { _, _ -> result } }
            .thenApply { result -> if (result is ProjectOutcome.Imported) Unit else throw failure(result, null) }

    /**
     * The browser's `commitLiveSlicingConfiguration`: the catalog choice [live]
     * becomes the project's own slicing configuration (printer, settings and
     * one physical filament per palette slot) as one undoable "Update slicing
     * configuration". Completes true when it changed the project, false when
     * the project already had it; a refusal (a mixed filament that would lose
     * a component) fails with the browser's message.
     */
    fun applySlicingChoice(
        catalog: ProfileCatalog,
        live: LiveSlicingChoice,
        policy: AutoPairPolicy = AutoPairPolicy(enabled = false),
    ): CompletableFuture<Boolean> {
        val words = SlicingConfigurations.words(live.palette.size)
        return outcome(actor.configureSlicing { session -> session.stageSlicingConfiguration(catalog, live, policy, words) })
            .thenCompose { result -> query().handle { _, _ -> result } }
            .thenApply { result ->
                when (result) {
                    is ProjectOutcome.Completed -> true
                    ProjectOutcome.SlicingUnchanged -> false
                    is ProjectOutcome.SlicingRefused -> throw ProjectFailure(result.message)
                    else -> throw failure(result, null)
                }
            }
    }

    // --- Filaments ---------------------------------------------------------------------------
    // The browser's filament list (its Filament tab's slots, committed as the live slicing
    // configuration) and filament assignment (its selection filament bar and assignment
    // selector), in the shared core: `slicing::choices` edits the slots,
    // `filaments::assignment` resolves the selection's scopes and the assignments a choice makes.

    /** The assignment snapshot of [selection] and the project's own filament slots, from [snapshot]. Holds [showing]. */
    private fun filamentsOf(snapshot: ProjectSnapshot, selection: ProjectSelectionView): Pair<FilamentAssignment, SlicingSlots> {
        val assignment = when (val resolved = snapshot.filamentAssignment(selection.refs.mapNotNull(FilamentRef::of))) {
            is FilamentAssignmentResult.Resolved -> resolved.assignment
            // The session prunes what the project lacks from its selection; were a ref left, the filaments still show.
            is FilamentAssignmentResult.Refused -> (snapshot.filamentAssignment(emptyList()) as FilamentAssignmentResult.Resolved).assignment
        }
        return assignment to snapshot.filamentSlots(emptyList())
    }

    /**
     * The selection filament bar's press (`objects_assign_filament`, the
     * browser's `SelectionFilamentBar` and assignment selector): [filamentId]
     * — null removes the local assignments, so each scope follows its object —
     * given to every scope the session's selection can assign (an instance
     * stands for its object), as one undoable step the core labels "Assign
     * filament" or "Assign n scopes". Planned on the authority from the
     * selection and state it reads there and executed under that state's
     * guard. A selection with nothing assignable, or holding anything that
     * cannot take a filament (a plate), assigns nothing and answers null, as
     * the bar does not show; a destination the project lacks or has disabled
     * is refused in the browser's words. Answers how many scopes it assigned.
     */
    fun assignFilament(filamentId: String?): CompletableFuture<Int?> = edit { session, snapshot ->
        val assignment = when (val resolved = snapshot.filamentAssignment(whole(session).refs.mapNotNull(FilamentRef::of))) {
            is FilamentAssignmentResult.Refused -> throw ProjectFailure(resolved.message)
            is FilamentAssignmentResult.Resolved -> resolved.assignment
        }
        if (!assignment.assignable) return@edit null
        when (val changes = snapshot.filamentAssignmentChanges(assignment.scopes.map { it.entity }, filamentId)) {
            is FilamentAssignmentChanges.Refused -> throw ProjectFailure(changes.message)
            is FilamentAssignmentChanges.Changes -> Edit(
                listOf(ProjectIntents.Command.SetFilamentAssignments(ProjectIntents.SetFilamentAssignments(changes.assignments))),
                changes.assignments.size,
            )
        }
    }

    /**
     * One edit of the virtual filament library (`filament_virtual_mutate`,
     * the browser's `VirtualFilamentLibrary` through its canonical adapter):
     * add, edit or duplicate a recipe from a validated draft, enable or
     * disable one, or delete one — removed when nothing references it, else
     * a tombstone that keeps its references. Planned on the authority from
     * the state it reads there (a new recipe's ID drawn as the browser's
     * controller draws it) and executed under that state's guard as one
     * undoable step with the browser's label: "Add <name>", "Edit mixed
     * filament", "Enable/Disable mixed filament", "Remove mixed filament" or
     * "Delete mixed filament". The core's refusal (an incompatible pair, a
     * disabled head, a recipe no longer there) fails in the browser's words.
     * Automatic pairs are not reconciled: the browser generates them only
     * when its preference is on, and its default is off.
     */
    fun changeVirtualFilament(change: VirtualFilamentEdit): CompletableFuture<VirtualFilamentStep?> = edit { _, snapshot ->
        when (val plan = snapshot.virtualFilamentPlan(change) { ids.next() }) {
            is VirtualFilamentPlan.Refused -> throw ProjectFailure(plan.message)
            is VirtualFilamentPlan.Planned -> Edit(plan.step.batch.commands, plan.step, plan.step.label, transaction = !plan.step.intent)
        }
    }

    /** The filament slots the project's own physical filaments describe, read on the authority; [palette] when it has none. */
    fun filamentSlots(palette: List<SlicingSlot>): CompletableFuture<SlicingSlots> =
        inspect { session -> session.snapshot().use { it.filamentSlots(palette) } }

    /**
     * One of the browser's Filament-tab edits ([SlotEdit]: a filament slot
     * added, a palette slot past the printer's heads removed, a slot's colour
     * or a head's nozzle changed) on the project's own filament slots —
     * adopted on the authority as the browser adopts an opened project's, so
     * a slot an undo removed is never brought back — then committed as the
     * browser's `commitLiveSlicingConfiguration`: one undoable "Update slicing
     * configuration" under [live]'s profile. Answers the edit: the live choice
     * it made (the project unchanged when it already had it), nothing to do,
     * or the browser's refusal of a slot past the palette's limit. A
     * configuration the core refuses (a mixed filament that would lose a
     * component) fails with the browser's message.
     */
    fun editFilamentSlots(
        catalog: ProfileCatalog,
        live: LiveSlicingChoice,
        edit: SlotEdit,
        policy: AutoPairPolicy = AutoPairPolicy(enabled = false),
    ): CompletableFuture<SlotEditResult> {
        val edited = java.util.concurrent.atomic.AtomicReference<SlotEditResult>()
        return outcome(
            actor.configureSlicing { session ->
                val adopted = session.snapshot().use { live.with(it.filamentSlots(live.palette)) }
                when (val result = catalog.editSlots(adopted, edit).also(edited::set)) {
                    is SlotEditResult.Edited ->
                        session.stageSlicingConfiguration(catalog, result.live, policy, SlicingConfigurations.words(result.live.palette.size))
                    SlotEditResult.Unchanged -> SlicingStage.Unchanged
                    is SlotEditResult.Refused -> SlicingStage.Refused(result.code, result.message)
                }
            },
        )
            .thenCompose { result -> query().handle { _, _ -> result } }
            .thenApply { result ->
                when (result) {
                    is ProjectOutcome.Completed, ProjectOutcome.SlicingUnchanged -> checkNotNull(edited.get())
                    is ProjectOutcome.SlicingRefused -> edited.get() as? SlotEditResult.Refused ?: throw ProjectFailure(result.message)
                    else -> throw failure(result, null)
                }
            }
    }

    // --- Placement edits ---------------------------------------------------------------------
    // The browser workspace's placement actions (CanonicalWorkspaceController's mirror, resets,
    // centre, scale to fit, lay flat, drop to bed and arrange): planned by the shared core on
    // the actor's authority from exactly the state the guard names, on the project's own bed,
    // and applied as one guarded, undoable `setInstanceTransforms` under the browser's gesture.

    /** The transform sequence `batch:<n>` gestures draw from (the browser's `transformSequence`). */
    private val transformSequence = java.util.concurrent.atomic.AtomicLong()

    /** What a placement planned: the changes to submit under [gesture] and what it reports. */
    private class Planned<T>(val changes: List<ProjectIntents.InstanceTransform>, val gesture: String, val report: T)

    /**
     * Plans on the actor's authority against the state the current guard
     * names (refused as changed when another edit landed first), then submits
     * the changes as one `setInstanceTransforms` under that guard. No changes
     * submit nothing; an edit that changes nothing leaves history alone.
     */
    private fun <T> place(plan: (ProjectSession, WorkspaceBed) -> Planned<T>): CompletableFuture<T> =
        query().thenCompose { (state, _) ->
            inspect { session ->
                session.snapshot().use { snapshot ->
                    if (snapshot.revision() != state.guard.revision) throw ProjectFailure("The project changed meanwhile; try again.")
                    plan(session, snapshot.workspaceBed(view.activePlate?.id))
                }
            }.thenCompose { planned ->
                if (planned.changes.isEmpty()) return@thenCompose CompletableFuture.completedFuture(planned.report)
                val command = ProjectIntents.Command.SetInstanceTransforms(ProjectIntents.SetInstanceTransforms(planned.changes, units(planned.gesture)))
                outcome(actor.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state.guard, ProjectIntents.Intent(1, command)))))
                    .thenCompose { result -> query().handle { _, _ -> result } }
                    .thenApply { result ->
                        val completed = result as? ProjectOutcome.Completed ?: throw failure(result, null)
                        when (val reply = completed.reply.result) {
                            is ProjectIntents.SessionResult.Acknowledged, is ProjectIntents.SessionResult.ReceiptUnavailable -> planned.report
                            is ProjectIntents.SessionResult.Error -> throw ProjectFailure(
                                when (reply.value) {
                                    ProjectIntents.SessionError.Stale -> "The project changed meanwhile; try again."
                                    ProjectIntents.SessionError.Busy -> "The project is busy; try again when the current operation finishes."
                                    ProjectIntents.SessionError.ResourceLimit -> "The project is too large for this device."
                                    else -> "The project refused the change."
                                },
                            )
                            else -> throw ProjectFailure("Unexpected answer from the project.")
                        }
                    }
            }
        }

    /** The core's plan for [request], or its refusal in the browser's words. */
    private fun planned(session: ProjectSession, request: ProjectIntents.PlacementRequest): ProjectIntents.PlacementPlan =
        when (val reply = session.planPlacement(request)) {
            is ProjectIntents.PlacementReply.Plan -> reply.value
            is ProjectIntents.PlacementReply.Refused -> throw ProjectFailure(text(reply.value.message))
        }

    private fun ids(instanceIds: List<String>) = instanceIds.map(::units)

    private fun <T> placement(gesture: () -> String, request: (WorkspaceBed) -> ProjectIntents.PlacementRequest, report: (ProjectIntents.PlacementPlan) -> T) =
        place { session, bed -> planned(session, request(bed)).let { Planned(it.changes, gesture(), report(it)) } }

    /**
     * "Drop to bed": each instance moved down (or up) until its lowest model
     * point rests on the bed, as one entry; answers each instance's lowest point
     * before and its move.
     */
    fun dropToBed(instanceIds: List<String>): CompletableFuture<List<ProjectIntents.PlacementDrop>> =
        placement({ PlacementGestures.batch(transformSequence.incrementAndGet()) }, {
            ProjectIntents.PlacementRequest.DropToBed(ProjectIntents.PlacementSelection(ids(instanceIds)))
        }) { it.drops }

    /** "Mirror" on one axis: each instance across its own centre, its scale on that axis negated (the browser's `mirrorInstances`). */
    fun mirror(instanceIds: List<String>, axis: ProjectIntents.PlacementAxis): CompletableFuture<Unit> =
        placement({ PlacementGestures.mirror(axis) }, {
            ProjectIntents.PlacementRequest.Mirror(ProjectIntents.PlacementMirror(ids(instanceIds), axis))
        }) { }

    /** "Reset rotation", "Reset scale" or both. */
    fun resetTransforms(instanceIds: List<String>, target: TransformReset): CompletableFuture<Unit> =
        placement({ target.gesture }, {
            val selection = ProjectIntents.PlacementSelection(ids(instanceIds))
            when (target) {
                TransformReset.ROTATION -> ProjectIntents.PlacementRequest.ResetRotation(selection)
                TransformReset.SCALE -> ProjectIntents.PlacementRequest.ResetScale(selection)
                TransformReset.BOTH -> ProjectIntents.PlacementRequest.ResetTransform(selection)
            }
        }) { }

    /** "Center on plate": the selection's bounds centred on the project's printable area ([WorkspaceBed.areaMm]). */
    fun centerOnPlate(instanceIds: List<String>): CompletableFuture<Unit> =
        placement({ PlacementGestures.CENTER }, { bed ->
            ProjectIntents.PlacementRequest.CenterOnPlate(ProjectIntents.PlacementCenter(ids(instanceIds), bed.areaMm.wire()))
        }) { }

    /**
     * "Scale to fit the build volume" ([WorkspaceBed.volumeMm]: the printable
     * box the slice preflight checks), centred on it and resting on the bed;
     * answers how many instances changed (0 when the selection already fills
     * it, committing nothing). A project that states no printable height is
     * refused in the browser's words.
     */
    fun scaleToFit(instanceIds: List<String>): CompletableFuture<Int> =
        placement({ PlacementGestures.SCALE_TO_FIT }, { bed ->
            val volume = bed.volumeMm ?: throw ProjectFailure(PlacementGestures.NO_PRINTABLE_HEIGHT)
            ProjectIntents.PlacementRequest.ScaleToFit(ProjectIntents.PlacementScaleToFit(ids(instanceIds), volume.wire()))
        }) { it.changes.size }

    /** "Lay on face": the instance turned so the face with [localNormal] (in its own frame) rests on the bed. */
    fun layOnFace(instanceId: String, localNormal: List<Double>): CompletableFuture<Unit> =
        placement({ PlacementGestures.LAY_ON_FACE }, {
            ProjectIntents.PlacementRequest.LayOnFace(ProjectIntents.PlacementLayOnFace(units(instanceId), localNormal))
        }) { }

    /** "Lay on face" by a picked facet: facet [triangle] of volume [volumeId]'s mesh rests on the bed. */
    fun layOnFacet(instanceId: String, volumeId: String, triangle: Long): CompletableFuture<Unit> =
        placement({ PlacementGestures.LAY_ON_FACE }, {
            ProjectIntents.PlacementRequest.LayOnFacet(ProjectIntents.PlacementLayOnFacet(units(instanceId), units(volumeId), triangle))
        }) { }

    /**
     * "Arrange" plate [plateId] in the project's printable area ([WorkspaceBed.areaMm]), keeping its wipe tower
     * clear, as one entry; answers the arrangement (what moved, what did not
     * fit, what stayed). An arrangement that moves nothing commits nothing.
     */
    fun arrangePlate(plateId: String): CompletableFuture<ProjectIntents.Arrangement> = place { session, _ -> arrangement(session, plateId) }

    /** The arrangement of plate [plateId] on its own bed, its tower kept clear, as one planned edit. */
    private fun arrangement(session: ProjectSession, plateId: String): Planned<ProjectIntents.Arrangement> {
        val bed = session.snapshot().use { it.workspaceBed(plateId) }
        // An edge JSON cannot carry (an infinite tower width) is not a rectangle: the core
        // refuses an inverted one with the browser's own words, as it refuses that edge.
        val exclusions = listOfNotNull(bed.keepOut).map { keep ->
            if (listOf(keep.minX, keep.minY, keep.maxX, keep.maxY).all(Double::isFinite)) ProjectIntents.ArrangeRegion(keep.minX, keep.minY, keep.maxX, keep.maxY)
            else ProjectIntents.ArrangeRegion(1.0, 1.0, 0.0, 0.0)
        }
        val absent = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
        val request = ProjectIntents.ArrangeRequest(
            units(plateId),
            ProjectIntents.ArrangeConstraintsInput(
                bed.areaMm.wire(), absent, absent, exclusions, emptyList(),
                ProjectIntents.OptionalVolumeRoleNames.Absent(ProjectIntents.Empty),
            ),
        )
        return when (val reply = session.planArrangement(request)) {
            is ProjectIntents.ArrangeReply.Arrangement -> Planned(
                reply.value.placements.map { ProjectIntents.InstanceTransform(it.instanceId, it.transform) },
                PlacementGestures.arrange(plateId),
                reply.value,
            )
            is ProjectIntents.ArrangeReply.Refused -> throw ProjectFailure(text(reply.value.message))
        }
    }

    // ---- The Edit menu's placement actions: the browser's, on the selection the authority holds ----
    // OrcaWorkspace reads its targets as an action runs: the selected instances
    // (`selectedInstanceIdsForTransform`) — for centre and scale to fit the active plate's when
    // none is selected —, the primary and the selection on its plate for drop to bed
    // (`captureSelectedInstanceOrigins`), the active plate for arrange. These read them on the
    // actor's authority with the state the plan is made from; nothing to act on submits nothing
    // and answers null.

    /** Nothing to plan: no changes, nothing submitted, null answered. */
    private fun <T> nothing() = Planned<T?>(emptyList(), "", null)

    /** The selected instances, in selection order (the browser's `selectedInstanceIdsForTransform`). */
    private fun selectedInstances(session: ProjectSession): List<String> =
        whole(session).refs.mapNotNull { (it as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::text) }.distinct()

    /** [selectedInstances], or the active plate's instances in project order when none is selected. */
    private fun selectedOrPlate(session: ProjectSession): List<String> = selectedInstances(session).ifEmpty {
        session.snapshot().use { snapshot ->
            snapshot.query().use { root ->
                ProjectFacts.plates(root).firstOrNull { it.active }?.let { plate -> ProjectFacts.instances(root, plate.id).map { it.id } }.orEmpty()
            }
        }
    }

    /** Mirror on X, Y or Z (`mirror_x`…) of the selected instances; answers how many, null with none selected. */
    fun mirrorSelected(axis: ProjectIntents.PlacementAxis): CompletableFuture<Int?> = place { session, _ ->
        val ids = selectedInstances(session)
        if (ids.isEmpty()) return@place nothing()
        val plan = planned(session, ProjectIntents.PlacementRequest.Mirror(ProjectIntents.PlacementMirror(ids(ids), axis)))
        Planned(plan.changes, PlacementGestures.mirror(axis), ids.size)
    }

    /** Reset Rotation or Reset Scale (`reset_rotation`, `reset_scale`) of the selected instances; answers how many. */
    fun resetSelected(target: TransformReset): CompletableFuture<Int?> = place { session, _ ->
        val ids = selectedInstances(session)
        if (ids.isEmpty()) return@place nothing()
        val selection = ProjectIntents.PlacementSelection(ids(ids))
        val request = when (target) {
            TransformReset.ROTATION -> ProjectIntents.PlacementRequest.ResetRotation(selection)
            TransformReset.SCALE -> ProjectIntents.PlacementRequest.ResetScale(selection)
            TransformReset.BOTH -> ProjectIntents.PlacementRequest.ResetTransform(selection)
        }
        Planned(planned(session, request).changes, target.gesture, ids.size)
    }

    /** Centre on Plate (`center_on_plate`): the selection, or the active plate's models; answers how many. */
    fun centerSelectedOnPlate(): CompletableFuture<Int?> = place { session, bed ->
        val ids = selectedOrPlate(session)
        if (ids.isEmpty()) return@place nothing()
        val plan = planned(session, ProjectIntents.PlacementRequest.CenterOnPlate(ProjectIntents.PlacementCenter(ids(ids), bed.areaMm.wire())))
        Planned(plan.changes, PlacementGestures.CENTER, ids.size)
    }

    /**
     * Scale to build volume (`scale_to_fit_volume`): the selection, or the
     * active plate's models; answers how many changed (0 when they already
     * fill it). A project stating no printable height is refused in the
     * browser's words.
     */
    fun scaleSelectedToFit(): CompletableFuture<Int?> = place { session, bed ->
        val ids = selectedOrPlate(session)
        if (ids.isEmpty()) return@place nothing()
        val volume = bed.volumeMm ?: throw ProjectFailure(PlacementGestures.NO_PRINTABLE_HEIGHT)
        val plan = planned(session, ProjectIntents.PlacementRequest.ScaleToFit(ProjectIntents.PlacementScaleToFit(ids(ids), volume.wire())))
        Planned(plan.changes, PlacementGestures.SCALE_TO_FIT, plan.changes.size)
    }

    /**
     * Drop to bed (`drop_to_bed`): the primary instance and the selection on
     * its plate; answers each one's lowest point and move, null without a
     * selected instance.
     */
    fun dropSelectedToBed(): CompletableFuture<List<ProjectIntents.PlacementDrop>?> = place { session, _ ->
        val selection = whole(session)
        val origins = session.snapshot().use { snapshot -> snapshot.query().use { ProjectInspection.origins(it, selection.refs, selection.primary) } }
            ?: return@place nothing()
        val plan = planned(session, ProjectIntents.PlacementRequest.DropToBed(ProjectIntents.PlacementSelection(origins.origins.map { it.instanceId })))
        Planned(plan.changes, PlacementGestures.batch(transformSequence.incrementAndGet()), plan.drops)
    }

    /** Auto-arrange Plate (`arrange_all`): the active plate on its bed; null when the project has none. */
    fun arrangeActivePlate(): CompletableFuture<ProjectIntents.Arrangement?> = place { session, _ ->
        val plate = session.snapshot().use { snapshot -> snapshot.query().use { root -> ProjectFacts.plates(root).firstOrNull { it.active } } }
            ?: return@place nothing()
        arrangement(session, plate.id).let { Planned(it.changes, it.gesture, it.report) }
    }

    // ---- The transform inspector ----

    /**
     * An edit of the inspector's [tool] fields — the X, Y and Z [texts] as
     * typed — as the browser's Tool Settings panel applies one (`main.ts`
     * `onTransformChange` → `OrcaWorkspace.setSelectedModelPosition`,
     * `Rotation` or `Scale`): [TransformFields.edit] over the primary instance
     * and the selection on its plate, read on the authority, then one
     * `setInstanceTransform` (one instance) or `setInstanceTransforms` under
     * that state's guard — "Transform instance" or "Transform n instances".
     * The browser gives a field edit no gesture of its own: it draws
     * `single:<n>` or `batch:<n>` from the workspace's transform sequence, so
     * every edit is its own undo entry and repeated edits never coalesce; an
     * edit that changes nothing records nothing. A refused edit (a zero
     * scale, a non-finite value, a zero rotation) fails in the browser's
     * words. Answers how many instances it changed, or null without a
     * selected instance.
     */
    fun editTransform(tool: TransformTool, texts: List<String>): CompletableFuture<Int?> = later {
        require(texts.size == 3) { "A transform tool has three fields" }
        edit { session, snapshot ->
            val selection = whole(session)
            val origins = snapshot.query().use { ProjectInspection.origins(it, selection.refs, selection.primary) } ?: return@edit null
            when (val fields = TransformFields.edit(tool, texts, origins.origins, origins.primary)) {
                is TransformFieldEdit.Refused -> throw ProjectFailure(fields.message)
                is TransformFieldEdit.Changes -> {
                    val sequence = transformSequence.incrementAndGet()
                    val command = fields.changes.singleOrNull()?.let { change ->
                        ProjectIntents.Command.SetInstanceTransform(
                            ProjectIntents.SetInstanceTransform(change.instanceId, change.transform, units(PlacementGestures.single(sequence))),
                        )
                    } ?: ProjectIntents.Command.SetInstanceTransforms(
                        ProjectIntents.SetInstanceTransforms(fields.changes, units(PlacementGestures.batch(sequence))),
                    )
                    Edit(listOf(command), fields.changes.size)
                }
            }
        }
    }

    // ---- The Workspace's transform gizmo ----

    /**
     * Where the transform gizmo stands for the selection now (the browser's
     * `syncTransformProxy`), read on the authority: the primary instance's own
     * pose, or the centre of the selection's bounds, with the origins a drag
     * carries — [TransformProxy.None] without a primary instance.
     */
    fun transformProxy(): CompletableFuture<TransformProxy> = outcome(
        actor.inspect { session ->
            val selection = whole(session)
            val primary = (selection.primary as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::text)
            TransformGizmo.proxy(session, primary, selection.instances.toList())
        },
    ).thenApply { result ->
        ((result as? ProjectOutcome.Inspected) ?: throw failure(result, null)).result.getOrThrow() as TransformProxy
    }

    /**
     * A new drag of the gizmo's handles: its edits share the gesture
     * `transform-controls:<n>`, drawn from the workspace's transform sequence
     * as the browser draws it when a drag begins, so the history keeps the
     * whole drag as one step.
     */
    fun transformGesture(): TransformGesture = TransformGesture("transform-controls:${transformSequence.incrementAndGet()}")

    /**
     * One drag's transform edits (the browser's `AsyncTransformGesture`): at
     * most one edit in flight and the latest pose waiting behind it, each
     * `setInstanceTransform` (one instance) or `setInstanceTransforms` under
     * [id], so consecutive steps coalesce into one "Transform instance" (or
     * "Transform n instances") step. A failed edit stops the gesture and is
     * not retried; [cancel] drops the waiting pose without undoing the steps
     * already made. Each step is planned against the state it applies to,
     * where the browser carries one guard from step to step: the app's
     * project has no other editor while a finger drags.
     */
    inner class TransformGesture internal constructor(val id: String) {
        private val lock = Any()
        private var latest: List<ProjectIntents.InstanceTransform>? = null
        private var running = false
        private var accepting = true
        private var failure: Throwable? = null
        private val settled = CompletableFuture<Unit>()

        /** Submits [changes] now, or after the edit in flight in place of any pose still waiting. */
        fun update(changes: List<ProjectIntents.InstanceTransform>) {
            synchronized(lock) {
                if (!accepting) return
                latest = changes
                if (!running) drain()
            }
        }

        /** No more poses: completes once the last one is applied, or fails with the edit that failed. */
        fun finish(): CompletableFuture<Unit> {
            synchronized(lock) {
                accepting = false
                if (!running) settle()
            }
            return settled
        }

        /** Stops the gesture: the waiting pose is dropped; the steps already made stay. */
        fun cancel() {
            synchronized(lock) {
                accepting = false
                latest = null
                if (!running) settle()
            }
        }

        private fun drain() {
            val next = latest
            if (next == null) {
                running = false
                if (!accepting) settle()
                return
            }
            latest = null
            running = true
            submit(next).whenComplete { _, error ->
                synchronized(lock) {
                    if (error != null) {
                        failure = error
                        accepting = false
                        latest = null
                    }
                    drain()
                }
            }
        }

        private fun settle() {
            failure?.let(settled::completeExceptionally) ?: settled.complete(Unit)
        }

        private fun submit(changes: List<ProjectIntents.InstanceTransform>): CompletableFuture<Int?> = edit { _, _ ->
            val command = changes.singleOrNull()?.let { change ->
                ProjectIntents.Command.SetInstanceTransform(ProjectIntents.SetInstanceTransform(change.instanceId, change.transform, units(id)))
            } ?: ProjectIntents.Command.SetInstanceTransforms(ProjectIntents.SetInstanceTransforms(changes, units(id)))
            Edit(listOf(command), changes.size)
        }
    }

    private fun step(undo: Boolean): CompletableFuture<Unit> = query().thenCompose { (state, _) ->
        val operation = if (undo) ProjectIntents.SessionOperation.Undo(state.guard) else ProjectIntents.SessionOperation.Redo(state.guard)
        outcome(actor.submit(operation))
    }.thenCompose { result -> query().handle { _, _ -> result } }.thenApply { result ->
        if (result is ProjectOutcome.Completed) Unit else throw failure(result, null)
    }

    fun undo(): CompletableFuture<Unit> = step(true)
    fun redo(): CompletableFuture<Unit> = step(false)

    // ---- Selection: the browser's SelectionStore, set on the authority ----

    private fun entityText(entity: ProjectIntents.SelectionEntity): String? = when (entity) {
        is ProjectIntents.SelectionEntity.Project -> null
        is ProjectIntents.SelectionEntity.Plate -> text(entity.value)
        is ProjectIntents.SelectionEntity.Object -> text(entity.value)
        is ProjectIntents.SelectionEntity.Volume -> text(entity.value)
        is ProjectIntents.SelectionEntity.Instance -> text(entity.value)
        is ProjectIntents.SelectionEntity.LayerRange -> text(entity.value)
        is ProjectIntents.SelectionEntity.Filament -> text(entity.value)
    }

    private fun selectionEntity(entity: ProjectIntents.ObjectTreeEntity): ProjectIntents.SelectionEntity = when (entity) {
        is ProjectIntents.ObjectTreeEntity.Plate -> ProjectIntents.SelectionEntity.Plate(entity.value)
        is ProjectIntents.ObjectTreeEntity.Object -> ProjectIntents.SelectionEntity.Object(entity.value)
        is ProjectIntents.ObjectTreeEntity.Volume -> ProjectIntents.SelectionEntity.Volume(entity.value)
        is ProjectIntents.ObjectTreeEntity.Instance -> ProjectIntents.SelectionEntity.Instance(entity.value)
        is ProjectIntents.ObjectTreeEntity.LayerRange -> ProjectIntents.SelectionEntity.LayerRange(entity.value)
    }

    /** The session's whole selection now (on the authority). */
    internal fun whole(session: ProjectSession): ProjectSelectionView = session.selection().use { selectionView(it, Long.MAX_VALUE) }

    private fun selected(request: ProjectRequest): CompletableFuture<Boolean> = outcome(request).thenApply { result ->
        when (result) {
            is ProjectOutcome.Selected -> result.changed
            ProjectOutcome.NothingToDo -> false
            else -> throw failure(result, null)
        }
    }

    /** Opens the tree down to an object's instances, so a selected instance's row shows. */
    private fun reveal(objectId: String) = synchronized(showing) {
        opened += "object:$objectId"
        opened += "instance-group:$objectId"
    }

    /**
     * A click on a model in the Workspace (the browser's `selectModel`):
     * selects instance [instanceId] alone, or — [extend], Shift/Ctrl/Meta —
     * toggles it among the selected instances (other kinds of ref dropped),
     * the last one primary. The tree opens down to a newly selected instance.
     * An instance the project no longer has selects nothing. Completes true
     * when the selection changed.
     */
    fun selectInstance(instanceId: String, extend: Boolean = false): CompletableFuture<Boolean> = selected(actor.select { session ->
        val facts = session.snapshot().use { snapshot -> snapshot.query().use { ProjectFacts.instance(it, instanceId) } } ?: return@select null
        val target = ProjectIntents.SelectionEntity.Instance(units(instanceId))
        val choice = if (!extend) ProjectSelectionChoice(listOf(target)) else {
            val instances = whole(session).refs.filterIsInstance<ProjectIntents.SelectionEntity.Instance>()
            val next = if (target in instances) instances - target else instances + target
            ProjectSelectionChoice(next, next.lastOrNull())
        }
        if (target in choice.refs) reveal(facts.objectId)
        choice
    }).thenApply { changed -> reread(); changed }

    /**
     * Activates a tree row as the browser's Objects panel does
     * (`objectTreeSelectionRequest`, resolved by the core): [mode] Replace
     * selects the row's entity, Toggle adds or removes it, Range selects the
     * visible rows from the last activated one. A row that selects nothing
     * (a group) changes nothing.
     */
    fun selectRow(key: String, mode: ProjectRowSelection = ProjectRowSelection.Replace): CompletableFuture<Boolean> =
        selected(actor.select { session ->
            val current = whole(session)
            session.snapshot().use { snapshot ->
                val (expansion, from) = synchronized(showing) { expansion(snapshot) to anchor }
                // Replace and Range never read the selection; Toggle is applied below to the whole of it.
                val request = treeRequest(
                    expansion, emptyList(), null,
                    ProjectIntents.ObjectTreeOperation.Select(
                        ProjectIntents.ObjectTreeSelect(
                            units(key),
                            if (mode == ProjectRowSelection.Range) mode else ProjectRowSelection.Replace,
                            from?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                        ),
                    ),
                )
                val reply = (snapshot.objectTree(request) as? ProjectIntents.ObjectTreeReply.Selected)?.value ?: return@select null
                val primary = (reply.primary as? ProjectIntents.OptionalObjectTreeEntity.Value)?.value?.let(::selectionEntity)
                val refs = reply.refs.map(::selectionEntity)
                synchronized(showing) {
                    anchor = when (mode) {
                        ProjectRowSelection.Range -> (reply.anchorKey as? ProjectIntents.OptionalText.Value)?.value?.let(::text)
                        else -> key
                    }
                }
                if (mode != ProjectRowSelection.Toggle || primary == null) return@select ProjectSelectionChoice(refs, primary)
                // `resolveObjectTreeSelection`'s toggle: the primary stays unless it is the one removed.
                if (primary in current.refs) {
                    val next = current.refs - primary
                    ProjectSelectionChoice(next, current.primary?.takeIf { it in next } ?: next.lastOrNull())
                } else {
                    ProjectSelectionChoice(current.refs + primary, primary)
                }
            }
        })

    /** Opens or closes a tree row (plates start open, everything else closed). */
    fun toggleRow(key: String) {
        synchronized(showing) {
            if (key.startsWith("plate:")) {
                if (!closedPlates.remove(key)) closedPlates += key
            } else if (!opened.remove(key)) {
                opened += key
            }
        }
        reread()
    }

    /** Select All (`edit_select_all`): every instance on the active plate, the last primary; none clears. */
    fun selectAll(): CompletableFuture<Boolean> = selected(actor.select { session ->
        session.snapshot().use { snapshot ->
            snapshot.query().use { root ->
                val plate = ProjectFacts.plates(root).firstOrNull { it.active }
                val refs = plate?.let { ProjectFacts.instances(root, it.id) }.orEmpty().map { ProjectIntents.SelectionEntity.Instance(units(it.id)) }
                ProjectSelectionChoice(refs)
            }
        }
    })

    /** Deselect All (`edit_deselect_all`, Escape). */
    fun deselectAll(): CompletableFuture<Boolean> = selected(actor.select { ProjectSelectionChoice(emptyList(), null) })

    // ---- Edits: one guarded intent per undoable step, with the core's history label ----

    /** What an edit's plan chose: its commands (one step, a labelled batch, or each its own step) and what it answers. */
    private class Edit<T>(
        val commands: List<ProjectIntents.Command>,
        val result: T,
        val label: String? = null,
        val separate: Boolean = false,
        /** One command as a labelled transaction, as the browser submits some single edits. */
        val transaction: Boolean = false,
    )

    /** The guard of [snapshot] in [session]: what a query would answer for that state. */
    internal fun guardOf(session: ProjectSession, snapshot: ProjectSnapshot): ProjectIntents.SessionGuard {
        val id = ArrayList<Int>(snapshot.idLength().toInt())
        while (id.size < snapshot.idLength()) {
            val chunk = snapshot.id(id.size.toLong(), minOf(ProjectHost.MAX_TEXT_CHUNK_UNITS.toLong(), snapshot.idLength() - id.size))
            check(chunk.isNotEmpty()) { "invalid_projection" }
            chunk.forEach { id += it.code }
        }
        return ProjectIntents.SessionGuard(id, snapshot.revision(), units(snapshot.hash()), units(session.assetFingerprint()), session.historyRevision())
    }

    internal fun refusedBy(error: ProjectIntents.SessionError) = ProjectFailure(
        when (error) {
            ProjectIntents.SessionError.Stale -> "The project changed meanwhile; try again."
            ProjectIntents.SessionError.Busy -> "The project is busy; try again when the current operation finishes."
            ProjectIntents.SessionError.ResourceLimit -> "The project is too large for this device."
            ProjectIntents.SessionError.CommandFailed -> "The project refused that change."
            ProjectIntents.SessionError.Disposed, ProjectIntents.SessionError.NotReady -> "The project is not open."
            else -> "Unexpected answer from the project."
        },
    )

    /** One operation's acknowledgement, or why it changed nothing; a committed step without a receipt answers null. */
    internal fun submitted(operation: ProjectIntents.SessionOperation): CompletableFuture<ProjectIntents.SessionAcknowledgement?> =
        outcome(actor.submit(operation)).thenApply { result ->
            val completed = result as? ProjectOutcome.Completed ?: throw failure(result, null)
            when (val reply = completed.reply.result) {
                is ProjectIntents.SessionResult.Acknowledged -> reply.value
                is ProjectIntents.SessionResult.ReceiptUnavailable -> null
                is ProjectIntents.SessionResult.Error -> throw refusedBy(reply.value)
                else -> throw failure(result, null)
            }
        }

    /** [future], once the view's history caught up with it either way. */
    internal fun <T> refreshed(future: CompletableFuture<T>): CompletableFuture<T> =
        future.handle { value, error -> value to error }.thenCompose { (value, error) ->
            query().handle { _, _ -> if (error != null) throw (error as? java.util.concurrent.CompletionException)?.cause ?: error else value }
        }

    /** Runs [edit]'s commands under [guard]: one step, a labelled batch, or each its own step chained on the last one's receipt. */
    private fun <T> commit(guard: ProjectIntents.SessionGuard, edit: Edit<T>): CompletableFuture<T> {
        fun intent(command: ProjectIntents.Command) = ProjectIntents.Intent(ProjectIntents.VERSION, command)
        if (!edit.separate) {
            val operation = if (edit.commands.size == 1 && !edit.transaction) {
                ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(guard, intent(edit.commands.single())))
            } else {
                ProjectIntents.SessionOperation.Transaction(
                    ProjectIntents.GuardedBatch(guard, ProjectIntents.Batch(ProjectIntents.VERSION, units(checkNotNull(edit.label)), edit.commands)),
                )
            }
            return submitted(operation).thenApply { edit.result }
        }
        // The browser's per-instance printability: each its own entry, the next under the last one's receipt.
        fun from(index: Int, at: ProjectIntents.SessionGuard): CompletableFuture<T> {
            if (index == edit.commands.size) return CompletableFuture.completedFuture(edit.result)
            return submitted(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(at, intent(edit.commands[index]))))
                .handle { receipt, error -> receipt to error }
                .thenCompose { (receipt, error) ->
                    val cause = (error as? java.util.concurrent.CompletionException)?.cause ?: error
                    when {
                        cause == null && receipt != null -> from(index + 1, receipt.guard)
                        index == 0 && cause != null -> throw cause
                        else -> {
                            // Committed steps stay; the receipt-less one committed too.
                            val done = index + if (cause == null) 1 else 0
                            if (done == edit.commands.size) CompletableFuture.completedFuture(edit.result)
                            else throw ProjectFailure("Printability changed on $done model(s) before interruption. ${cause?.message ?: "The remaining edits could not complete."}")
                        }
                    }
                }
        }
        return from(0, guard)
    }

    /**
     * An edit planned on the authority from the state and selection it reads
     * there — as the browser's controller reads its state, captures the
     * guard and builds the intent in one turn — and executed under that very
     * state's guard: a change in between refuses it as stale. A plan that
     * finds nothing to do answers null; a plan's own [ProjectFailure] (the
     * browser's refusal, such as deleting the last plate) is the answer.
     */
    private fun <T> edit(plan: (ProjectSession, ProjectSnapshot) -> Edit<T>?): CompletableFuture<T?> = refreshed(
        outcome(actor.inspect { session -> session.snapshot().use { snapshot -> plan(session, snapshot)?.let { it to guardOf(session, snapshot) } } })
            .thenCompose { result ->
                @Suppress("UNCHECKED_CAST")
                val planned = ((result as? ProjectOutcome.Inspected) ?: throw failure(result, null)).result.getOrThrow() as Pair<Edit<T>, ProjectIntents.SessionGuard>?
                if (planned == null) CompletableFuture.completedFuture(null) else commit(planned.second, planned.first)
            },
    )

    /** One intent under the session's current guard, as one undoable step with the core's history label. */
    fun execute(command: ProjectIntents.Command): CompletableFuture<Unit> = refreshed(
        query().thenCompose { (state, _) ->
            submitted(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state.guard, ProjectIntents.Intent(ProjectIntents.VERSION, command))))
        }.thenApply { },
    )

    /** Several intents under the session's current guard, applied atomically as one undoable step labelled [label]. */
    fun transaction(label: String, commands: List<ProjectIntents.Command>): CompletableFuture<Unit> = refreshed(
        query().thenCompose { (state, _) ->
            submitted(
                ProjectIntents.SessionOperation.Transaction(
                    ProjectIntents.GuardedBatch(state.guard, ProjectIntents.Batch(ProjectIntents.VERSION, units(label), commands)),
                ),
            )
        }.thenApply { },
    )

    private fun instanceOf(snapshot: ProjectSnapshot, id: String): InstanceFacts =
        snapshot.query().use { ProjectFacts.instance(it, id) } ?: throw ProjectFailure("Unknown instance $id")

    private fun platesOf(snapshot: ProjectSnapshot): List<PlateFacts> = snapshot.query().use(ProjectFacts::plates)

    private fun plateOf(snapshot: ProjectSnapshot, id: String): PlateFacts =
        platesOf(snapshot).firstOrNull { it.id == id } ?: throw ProjectFailure("Unknown plate $id")

    /**
     * Delete Selected (`edit_delete_selected`, the Delete key): the primary
     * selected instance, or its whole object when it is the object's last
     * one (the browser's `deleteSelectedInstance`). Answers what was deleted,
     * or null when the primary selection is not an instance.
     */
    fun deleteSelected(): CompletableFuture<ProjectDeletion?> = edit { session, snapshot ->
        val primary = whole(session).primary as? ProjectIntents.SelectionEntity.Instance ?: return@edit null
        val facts = instanceOf(snapshot, text(primary.value))
        if (facts.objectInstances == 1) {
            Edit(listOf(ProjectIntents.Command.DeleteObject(ProjectIntents.DeleteObject(units(facts.objectId)))), ProjectDeletion.OBJECT)
        } else {
            Edit(listOf(ProjectIntents.Command.DeleteInstance(ProjectIntents.DeleteInstance(primary.value))), ProjectDeletion.INSTANCE)
        }
    }

    /** Delete All (`edit_delete_all`): every model on the active plate as one step; answers how many objects, or null when none. */
    fun deleteAll(): CompletableFuture<Int?> = edit { _, snapshot ->
        val plate = platesOf(snapshot).firstOrNull { it.active } ?: return@edit null
        if (plate.objects == 0) null else Edit(listOf(ProjectIntents.Command.DeletePlateObjects(ProjectIntents.DeletePlateObjects(units(plate.id)))), plate.objects)
    }

    /**
     * Printable (`toggle_printable`): the selected instances become printable
     * unless all of them are, then not; each changed instance is its own
     * undoable step (the browser's `setInstancePrintable`). Answers the new
     * state and how many changed, or null without a selected instance.
     */
    fun togglePrintable(): CompletableFuture<ProjectPrintableChange?> = edit { session, snapshot ->
        val selected = whole(session).refs.filterIsInstance<ProjectIntents.SelectionEntity.Instance>().map { text(it.value) }.distinct()
        if (selected.isEmpty()) return@edit null
        val wanted = selected.toHashSet()
        val facts = snapshot.query().use { root -> ProjectFacts.instances(root).filter { it.id in wanted } }.associateBy { it.id }
        selected.firstOrNull { it !in facts }?.let { throw ProjectFailure("Unknown instance $it") }
        val printable = !selected.all { facts.getValue(it).printable }
        val commands = selected.filter { facts.getValue(it).printable != printable }
            .map { ProjectIntents.Command.SetInstancePrintable(ProjectIntents.SetInstancePrintable(units(it), printable)) }
        Edit(commands, ProjectPrintableChange(printable, commands.size), separate = true)
    }

    /** [start], or its refusal as a failed future: a refused name fails as the browser's promise rejects. */
    private fun <T> later(start: () -> CompletableFuture<T>): CompletableFuture<T> = try {
        start()
    } catch (refused: ProjectFailure) {
        CompletableFuture.failedFuture(refused)
    }

    /** Renames an object (the Objects panel's Rename), trimmed and bounded as the browser's controller takes it. */
    fun renameObject(objectId: String, name: String): CompletableFuture<Unit> = later {
        execute(ProjectIntents.Command.RenameObject(ProjectIntents.RenameObject(units(objectId), units(ProjectNames.bounded(name, "Object name", MAX_NAME_LENGTH)))))
    }

    /** Renames a part (volume). */
    fun renameVolume(volumeId: String, name: String): CompletableFuture<Unit> = later {
        execute(ProjectIntents.Command.RenameVolume(ProjectIntents.RenameVolume(units(volumeId), units(ProjectNames.bounded(name, "Volume name", MAX_NAME_LENGTH)))))
    }

    /** Renames one instance. */
    fun renameInstance(instanceId: String, name: String): CompletableFuture<Unit> = later {
        execute(ProjectIntents.Command.RenameInstance(ProjectIntents.RenameInstance(units(instanceId), units(ProjectNames.bounded(name, "Instance name", MAX_NAME_LENGTH)))))
    }

    /**
     * Set as an individual object (`instance_to_object`): the first selected
     * instance becomes an object of its own with fresh IDs (the browser's
     * `convertInstanceToIndependentObject`); refused for an object's only
     * instance. Answers the new object's ID, or null without a selected instance.
     */
    fun instanceToObject(): CompletableFuture<String?> = edit { session, snapshot ->
        val first = whole(session).refs.firstOrNull { it is ProjectIntents.SelectionEntity.Instance } as ProjectIntents.SelectionEntity.Instance?
            ?: return@edit null
        val facts = instanceOf(snapshot, text(first.value))
        if (facts.objectInstances <= 1) throw ProjectFailure("Cannot convert sole instance to individual object")
        val objectId = ids.next()
        val volumeIds = ids.next(facts.objectVolumes)
        val instanceId = ids.next()
        val rangeIds = ids.next(facts.objectRanges)
        Edit(
            listOf(
                ProjectIntents.Command.ConvertInstanceToObject(
                    ProjectIntents.ConvertInstanceToObject(
                        first.value,
                        ProjectIntents.IndependentInstanceIds(units(objectId), volumeIds.map(::units), units(instanceId), rangeIds.map(::units)),
                        ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                    ),
                ),
            ),
            objectId,
        )
    }

    /**
     * Clone Selected (`edit_duplicate`) and Add Instance (`add_instance`):
     * another instance of the primary selected instance's object, as the
     * browser's `duplicateSelectedInstance` stages it — one "Create instance"
     * that selects the copy. Answers the copy's ID, or null when the primary
     * selection is not an instance.
     */
    fun cloneSelected(): CompletableFuture<String?> {
        var made: String? = null
        return refreshed(
            outcome(actor.stage { session, guard ->
                val primary = whole(session).primary as? ProjectIntents.SelectionEntity.Instance ?: return@stage null
                val id = ids.next()
                session.stageInstanceCopy(guard, text(primary.value), id).also { made = id }
            }).thenApply { result ->
                when (result) {
                    ProjectOutcome.NothingToDo -> null
                    is ProjectOutcome.Completed -> when (val reply = result.reply.result) {
                        is ProjectIntents.SessionResult.Acknowledged, is ProjectIntents.SessionResult.ReceiptUnavailable -> made
                        is ProjectIntents.SessionResult.Error -> throw refusedBy(reply.value)
                        else -> throw failure(result, null)
                    }
                    else -> throw failure(result, null)
                }
            },
        )
    }

    /** Add build plate (`add_plate`): an empty "Plate n", last in order, made active. Answers its ID. */
    fun addPlate(): CompletableFuture<String?> = edit { _, snapshot ->
        val plates = platesOf(snapshot)
        if (plates.size >= MAX_PROJECT_PLATES) throw ProjectFailure("A project cannot contain more than $MAX_PROJECT_PLATES plates")
        val id = ids.next()
        val order = maxOf(-1.0, plates.maxOfOrNull { it.order } ?: -1.0) + 1
        val name = ProjectNames.nextAvailable("Plate", plates.map { it.name })
        Edit(listOf(ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(units(id), units(name), order, true))), id)
    }

    /**
     * Duplicate a plate (`duplicate_plate`): the plate and everything on it
     * as a new plate with fresh IDs for every editable entity and plate row,
     * minted in the browser's order. Answers the copy's ID.
     */
    fun duplicatePlate(plateId: String): CompletableFuture<String?> = edit { _, snapshot ->
        val shape = snapshot.plateShape(plateId) ?: throw ProjectFailure("Unknown plate $plateId")
        if (platesOf(snapshot).size >= MAX_PROJECT_PLATES) throw ProjectFailure("A project cannot contain more than $MAX_PROJECT_PLATES plates")
        val id = ids.next()
        val objects = shape.objects.map { counts ->
            ProjectIntents.DuplicateObject(
                units(ids.next()), ids.next(counts.volumes).map(::units), ids.next(counts.instances).map(::units), ids.next(counts.layerRanges).map(::units),
            )
        }
        val gcode = ids.next(shape.customGcode).map(::units)
        val thumbnails = ids.next(shape.thumbnails).map(::units)
        Edit(listOf(ProjectIntents.Command.DuplicatePlate(ProjectIntents.DuplicatePlate(units(plateId), units(id), objects, gcode, thumbnails))), id)
    }

    /** Delete a plate (`delete_plate`); the last plate is refused, as the browser refuses it. */
    fun deletePlate(plateId: String): CompletableFuture<Unit?> = edit { _, snapshot ->
        plateOf(snapshot, plateId)
        if (platesOf(snapshot).size <= 1) throw ProjectFailure("Cannot delete the last plate")
        Edit(listOf(ProjectIntents.Command.DeletePlate(ProjectIntents.DeletePlate(units(plateId)))), Unit)
    }

    /** Make a plate the active one (`activate_plate`); the active plate already is. */
    fun activatePlate(plateId: String): CompletableFuture<Unit?> = edit { _, snapshot ->
        if (plateOf(snapshot, plateId).active) null
        else Edit(listOf(ProjectIntents.Command.ActivatePlate(ProjectIntents.ActivatePlate(units(plateId)))), Unit)
    }

    /** Rename a plate (`rename_plate`), bounded as the browser's controller takes a plate name; an unchanged name changes nothing. */
    fun renamePlate(plateId: String, name: String): CompletableFuture<Unit?> = later {
        val next = ProjectNames.bounded(name, "Plate name", MAX_PLATE_NAME_LENGTH)
        edit { _, snapshot ->
            if (plateOf(snapshot, plateId).name == next) null
            else Edit(listOf(ProjectIntents.Command.RenamePlate(ProjectIntents.RenamePlate(units(plateId), units(next)))), Unit)
        }
    }

    /** Include a plate in printing or exclude it (`set_plate_printable`). */
    fun setPlatePrintable(plateId: String, printable: Boolean): CompletableFuture<Unit?> = edit { _, snapshot ->
        if (plateOf(snapshot, plateId).printable == printable) null
        else Edit(listOf(ProjectIntents.Command.SetPlatePrintable(ProjectIntents.SetPlatePrintable(units(plateId), printable))), Unit)
    }

    /** Put the plates in [plateIds]' order (`reorder_plates`). */
    fun reorderPlates(plateIds: List<String>): CompletableFuture<Unit?> = edit { _, _ ->
        Edit(listOf(ProjectIntents.Command.ReorderPlates(ProjectIntents.ReorderPlates(plateIds.map(::units)))), Unit)
    }

    /** Move a plate one place earlier ([by] −1) or later (+1), as the plate bar's Move up and Move down swap neighbours. */
    fun movePlate(plateId: String, by: Int): CompletableFuture<Unit?> = edit { _, snapshot ->
        val order = platesOf(snapshot).map { it.id }.toMutableList()
        val index = order.indexOf(plateId).takeIf { it >= 0 } ?: throw ProjectFailure("Unknown plate $plateId")
        val destination = index + by
        if (destination !in order.indices) return@edit null
        order[index] = order[destination].also { order[destination] = order[index] }
        Edit(listOf(ProjectIntents.Command.ReorderPlates(ProjectIntents.ReorderPlates(order.map(::units)))), Unit)
    }

    // ---- Creation: new geometry, instances and the clipboard, staged as the browser stages them ----
    // Each plans on the actor's authority against exactly the state the current guard names (an
    // edit landing first refuses it as changed), writes the browser's staged records
    // (`ProjectStagedRecords`) and stages them on the actor under that guard — mesh payloads
    // streamed after the records — as one undoable step with the browser's history label.

    /** The latest copy (the browser controller's clipboard), kept across New and Open as the browser keeps it. */
    @Volatile private var clipboard: ProjectActorClipboard? = null

    /** Whether a copy is held, so Paste has something to paste (`hasClipboard`). */
    val hasClipboard: Boolean get() = clipboard != null

    /** What a creation's plan chose: the work to stage (none: nothing to commit) and what the operation answers. */
    private class Creation<T>(val work: StagedWork?, val result: T)

    /** [work]'s records and payloads staged and executed on the actor under [guard] (through [paste]'s upload when it pastes). */
    private fun stage(guard: ProjectActorGuard, work: StagedWork, paste: ProjectActorClipboard?): CompletableFuture<Unit> {
        val bytes = ProjectStagedRecords.encode(work)
        val payloads = ProjectStagedRecords.payloads(work)
        val options = ProjectStagedRecords.options(bytes.size.toLong())
        val write = { _: ProjectPreparation, _: ProjectSnapshot, writer: ProjectCommandWriter -> ProjectStagedRecords.write(writer, bytes) }
        val request = when {
            paste != null -> actor.preparePaste(guard, paste, bytes.size.toLong(), options, write)
            payloads.isEmpty() -> actor.prepareCommands(guard, bytes.size.toLong(), options, write)
            else -> actor.prepareCommands(guard, bytes.size.toLong(), options, write) { _, assets -> ProjectStagedRecords.stream(assets, payloads) }
        }
        return outcome(request).thenApply { result ->
            val completed = result as? ProjectOutcome.Completed ?: throw failure(result, null)
            when (val reply = completed.reply.result) {
                is ProjectIntents.SessionResult.Acknowledged, is ProjectIntents.SessionResult.ReceiptUnavailable -> Unit
                is ProjectIntents.SessionResult.Error -> throw refusedBy(reply.value)
                else -> throw failure(result, null)
            }
        }
    }

    /**
     * Plans on the authority from the state the current guard names (null:
     * nothing selected to act on), then stages the plan's work under that guard.
     */
    private fun <T> create(paste: ProjectActorClipboard? = null, plan: (ProjectSession, ProjectSnapshot) -> Creation<T>?): CompletableFuture<T?> = refreshed(
        query().thenCompose { (state, guard) ->
            inspect { session ->
                session.snapshot().use { snapshot ->
                    if (snapshot.revision() != state.guard.revision) throw ProjectFailure("The project changed meanwhile; try again.")
                    listOfNotNull(plan(session, snapshot))
                }
            }.thenCompose { planned ->
                val creation = planned.firstOrNull() ?: return@thenCompose CompletableFuture.completedFuture<T?>(null)
                val work = creation.work ?: return@thenCompose CompletableFuture.completedFuture<T?>(creation.result)
                stage(guard, work, paste).thenApply<T?> { creation.result }
            }
        },
    )

    /**
     * A primitive (`add_primitive_*`, the browser's `addPrimitive`): a new
     * object named after its file (`cube.stl`) on the active plate, centred on
     * the project's printable area and resting on the bed, its mesh shared with an asset the
     * project already holds with the same bytes — one "Add cube.stl".
     */
    fun addPrimitive(shape: PrimitiveShape): CompletableFuture<ProjectPrimitiveAdded?> = later {
        if (shape == PrimitiveShape.HELPER_CUBE) throw ProjectFailure("The helper cube is not a primitive.")
        create { session, snapshot ->
            val bed = snapshot.workspaceBed(null)
            val drawn = ids.next(Primitives.PRIMITIVE_IDS)
            val request = Primitives.primitiveRequest(shape, bed.areaMm, drawn, NewProjects.timestamp(clock()))
            when (val plan = session.planPrimitiveObject(request)) {
                is PrimitivePlan.Refused -> {
                    ids.giveBack(drawn)
                    throw ProjectFailure(plan.message)
                }
                is PrimitivePlan.Planned -> {
                    // The browser draws an asset ID only for a mesh the project does not hold yet.
                    ids.giveBack(drawn.drop(plan.plan.idsUsed))
                    val made = CanonicalJson.read(plan.plan.objectJson) as ProjectJsonObject
                    val instance = ((made.get("instances") as ProjectJsonArray).get(0) as ProjectJsonObject).get("id") as String
                    val payload = StagedPayload(plan.plan.assetJson, Primitives.payload(shape))
                    Creation(
                        StagedWork.Single(StagedCommand.AddObjectWithAsset(plan.plan.plateId, StagedRecord.of(plan.plan.objectJson), payload)),
                        ProjectPrimitiveAdded(made.get("id") as String, instance, plan.plan.reusedAsset),
                    )
                }
            }
        }
    }

    /**
     * A helper volume (`add_modifier`, `add_support_enforcer`,
     * `add_support_blocker`; the browser's `addHelperVolume`): a 10 mm cube
     * part of the object the primary selected instance, object or part belongs
     * to, named after its role ("Modifier 2") — one "Add modifier to object"
     * that selects the part. Without such a selection it is refused in the
     * browser's words.
     */
    fun addHelperVolume(role: HelperVolumeRole): CompletableFuture<ProjectHelperAdded?> = create { session, _ ->
        val drawn = ids.next(Primitives.HELPER_IDS)
        when (val plan = session.planHelperVolume(Primitives.helperRequest(role, whole(session).primary, drawn))) {
            is PrimitivePlan.Refused -> {
                ids.giveBack(drawn)
                throw ProjectFailure(plan.message)
            }
            is PrimitivePlan.Planned -> {
                ids.giveBack(drawn.drop(plan.plan.idsUsed))
                val volume = (CanonicalJson.read(plan.plan.volumeJson) as ProjectJsonObject).get("id") as String
                val payload = StagedPayload(plan.plan.assetJson, Primitives.payload(PrimitiveShape.HELPER_CUBE))
                Creation(
                    StagedWork.Single(StagedCommand.AddVolume(plan.plan.objectId, StagedRecord.of(plan.plan.volumeJson), payload)),
                    ProjectHelperAdded(plan.plan.objectId, volume),
                )
            }
        }
    }

    /**
     * Set as Negative Part (`set_negative_part`, the browser's
     * `setNegativePart`): a selected part that is not a negative volume
     * becomes one — the semantic editor's "Convert volume to negative part",
     * guarded by the state the part was read on, and refused before anything
     * is submitted in the conversion command's words (the object's last model
     * part, facet paint, a local filament) — and otherwise a negative volume
     * is added to the object the selection names, as [addHelperVolume] adds
     * one ("Add negative part to object", the new part selected). Nothing
     * selected is refused in the browser's words.
     */
    fun setNegativePart(): CompletableFuture<NegativePartResult?> = edit { session, snapshot ->
        val primary = whole(session).primary ?: throw ProjectFailure(NEGATIVE_PART_UNSELECTED)
        val volumeId = (primary as? ProjectIntents.SelectionEntity.Volume)?.let { text(it.value) } ?: return@edit null
        val part = snapshot.volumeRoleEditor(volumeId)?.takeIf { it.role != VolumeRole.NEGATIVE_VOLUME } ?: return@edit null
        val decision = snapshot.volumeRoleDecision(part.volumeId, VolumeRole.NEGATIVE_VOLUME.wire)
        if (decision is VolumeRoleDecision.Blocked) throw ProjectFailure(decision.reason)
        Edit(
            listOf(ProjectIntents.Command.ConvertVolumeRole(ProjectIntents.ConvertVolumeRole(units(part.volumeId), VolumeRole.NEGATIVE_VOLUME.intent))),
            NegativePartResult.Converted(part.volumeId) as NegativePartResult,
        )
    }.thenCompose { converted ->
        if (converted != null) CompletableFuture.completedFuture<NegativePartResult?>(converted)
        else addHelperVolume(HelperVolumeRole.NEGATIVE_VOLUME).thenApply<NegativePartResult?> { added -> added?.let { NegativePartResult.Added(it) } }
    }

    /**
     * Fill Bed with Instances (`fill_bed_with_instances`, the browser's
     * `fillPlateWithSelection`): copies of the last selected instance laid into
     * its plate's free space in the project's printable area, keeping the active plate's
     * tower clear, as one "Fill n instances" (one copy: "Duplicate instance").
     * Answers how many were added (none commits nothing) and how many free
     * slots the copy limit left; null without a selected instance.
     */
    fun fillBed(): CompletableFuture<ProjectBedFill?> = create { session, snapshot ->
        val selected = whole(session).refs.lastOrNull { it is ProjectIntents.SelectionEntity.Instance } as ProjectIntents.SelectionEntity.Instance?
            ?: return@create null
        val instanceId = text(selected.value)
        val (facts, name) = snapshot.query().use { root ->
            (ProjectFacts.instance(root, instanceId) ?: throw ProjectFailure("Unknown instance $instanceId")) to ProjectFacts.instanceName(root, instanceId)
        }
        val bed = snapshot.workspaceBed(platesOf(snapshot).firstOrNull { it.active }?.id)
        // As arranging does: an edge JSON cannot carry refuses through an inverted rectangle.
        val exclusions = listOfNotNull(bed.keepOut).map { keep ->
            if (listOf(keep.minX, keep.minY, keep.maxX, keep.maxY).all(Double::isFinite)) ProjectIntents.ArrangeRegion(keep.minX, keep.minY, keep.maxX, keep.maxY)
            else ProjectIntents.ArrangeRegion(1.0, 1.0, 0.0, 0.0)
        }
        val absent = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
        val request = ProjectIntents.BedFillRequest(
            units(facts.plateId), units(instanceId), absent,
            ProjectIntents.ArrangeConstraintsInput(
                bed.areaMm.wire(), absent, absent, exclusions, emptyList(),
                ProjectIntents.OptionalVolumeRoleNames.Absent(ProjectIntents.Empty),
            ),
        )
        when (val reply = session.planBedFill(request)) {
            is ProjectIntents.BedFillReply.Refused -> throw ProjectFailure(text(reply.value.message))
            is ProjectIntents.BedFillReply.Fill -> {
                val placements = reply.value.placements
                val result = ProjectBedFill(placements.size, reply.value.withheldSlotCount)
                if (placements.isEmpty()) return@create Creation(null, result)
                val commands = placements.map { placement ->
                    // `createInstancesAtTransforms` omits an empty name.
                    StagedCommand.CreateInstance(facts.objectId, StagedRecord.instance(ids.next(), placement.transform, facts.printable, name?.takeIf { it.isNotEmpty() }))
                }
                Creation(StagedWork.Transaction(if (commands.size == 1) "Duplicate instance" else "Fill ${commands.size} instances", commands), result)
            }
        }
    }

    /** The object a copy takes: the primary selected object, or the primary selected instance's. */
    private fun copiedObject(session: ProjectSession): String? = when (val primary = whole(session).primary) {
        is ProjectIntents.SelectionEntity.Object -> text(primary.value)
        is ProjectIntents.SelectionEntity.Instance -> session.snapshot().use { snapshot ->
            snapshot.query().use { ProjectFacts.instance(it, text(primary.value))?.objectId }
        }
        else -> null
    }

    /**
     * Copy (`edit_copy`, the browser's `copySelectedObject`): the selected
     * model's whole object and the assets it uses into the clipboard, replacing
     * the copy held; the project is unchanged. Answers the copied object's ID,
     * or null with nothing selected to copy.
     */
    fun copySelected(): CompletableFuture<String?> = query().thenCompose { (_, guard) ->
        inspect { session -> listOfNotNull(copiedObject(session)) }.thenCompose { found ->
            val objectId = found.firstOrNull() ?: return@thenCompose CompletableFuture.completedFuture<String?>(null)
            outcome(
                actor.copyObject(guard, CLIPBOARD) { _, snapshot ->
                    snapshot.query().use { root -> ProjectFacts.objectNode(root, objectId) } ?: error("missing_object")
                },
            ).thenApply<String?> { result ->
                val copied = result as? ProjectOutcome.Copied ?: throw failure(result, null)
                clipboard = copied.clipboard
                refreshActions()
                objectId
            }
        }
    }

    /**
     * Cut (`edit_cut`, the browser's `cutSelectedObject`): Copy, then — when
     * the primary selection is an instance — Delete Selected as one step
     * ("Delete instance", or "Delete object" with its last instance). Answers
     * what was deleted, or null when nothing was (an object row cuts as a copy).
     */
    fun cutSelected(): CompletableFuture<ProjectDeletion?> = copySelected().thenCompose { copied ->
        if (copied == null) CompletableFuture.completedFuture(null) else deleteSelected()
    }

    /**
     * Paste (`edit_paste`, the browser's `pasteClipboard`): the copied object
     * under fresh IDs (object, then each part, instance and height range) on
     * the active plate, its assets restored when the project no longer holds
     * them — one "Paste model". Answers the new object's ID, or null without a copy.
     */
    fun paste(): CompletableFuture<String?> {
        val source = clipboard ?: return CompletableFuture.completedFuture(null)
        return create(source) { _, _ ->
            val objectId = ids.next()
            val info = source.info
            val command = StagedCommand.ClipboardPaste(
                objectId, ids.next(info.volumes.toInt()), ids.next(info.instances.toInt()), ids.next(info.layerRanges.toInt()),
            )
            Creation(StagedWork.Single(command), objectId)
        }
    }

    // ---- Model tools: split, simplify and measure, as the browser's workspace runs them ----
    // Split to Objects and Split to Parts (CanonicalWorkspaceController's splitSelectedToObjects
    // and splitSelectedToParts, behind CanonicalSplitToObjectsFlow), the Simplify panel's preview,
    // apply and cancel and the menu's one-shot Simplify (OrcaWorkspace.previewSimplify,
    // applySimplifyPreview, cancelSimplifyPreview, simplifySelected) and the Measure tool's picks
    // (pickMeasureFeature), each through the shared core: what a split would split
    // (`split::source`), its components (`split`), the decimation (`simplify`) and the features
    // and measurement (`measure`). Each edit is one guarded step with the core's label: "Split to
    // objects", "Split volume to parts", and "Replace mesh topology" for each simplified part.

    /** A step staged on the authority: true once it committed, false when the plan staged nothing; a refusal fails in the browser's words. */
    private fun stagedStep(result: ProjectOutcome): Boolean = when (result) {
        ProjectOutcome.NothingToDo -> false
        is ProjectOutcome.Completed -> when (val reply = result.reply.result) {
            is ProjectIntents.SessionResult.Acknowledged, is ProjectIntents.SessionResult.ReceiptUnavailable -> true
            is ProjectIntents.SessionResult.Error -> throw refusedBy(reply.value)
            else -> throw failure(result, null)
        }
        else -> throw failure(result, null)
    }

    /** The primary selected instance, or the browser's refusal in [words]. */
    private fun primaryInstance(selection: ProjectSelectionView, words: String): String =
        (selection.primary as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::text) ?: throw ProjectFailure(words)

    /** [target]'s source for [instanceId] in [snapshot], or its refusal in the browser's words. */
    private fun splitSource(snapshot: ProjectSnapshot, instanceId: String, target: SplitTarget): SplitSource =
        when (val found = snapshot.splitSource(instanceId, target)) {
            is SplitSourceResult.Refused -> throw ProjectFailure(found.message)
            is SplitSourceResult.Found -> found.source
        }

    /** A volume's split prepared on [session]'s current state: the handle and its parts, or the core's refusal (the handle closed). */
    private fun prepareSplit(session: ProjectSession, volumeId: String): Pair<ProjectVolumeSplit, ProjectIntents.VolumeSplitPreview> {
        val split = session.captureGuard().use { guard -> session.volumeSplit(guard, ProjectIntents.VolumeSplitRequest(units(volumeId))) }
        try {
            return when (val reply = split.reply()) {
                is ProjectIntents.VolumeSplitReply.Refused -> throw ProjectFailure(text(reply.value.message))
                is ProjectIntents.VolumeSplitReply.Prepared -> split to reply.value
            }
        } catch (failure: Throwable) {
            split.close()
            throw failure
        }
    }

    /** One volume ID per part and one asset ID per distinct geometry, drawn in part order as each geometry first appears (`drawVolumeSplitIds`). */
    private fun drawSplitIds(preview: ProjectIntents.VolumeSplitPreview): Pair<List<String>, List<String>> {
        val volumeIds = ArrayList<String>()
        val assetIds = ArrayList<String>()
        for (part in preview.parts) {
            if (part.geometry == assetIds.size.toLong()) assetIds += ids.next()
            volumeIds += ids.next()
        }
        return volumeIds to assetIds
    }

    /** An object per volume, each with fresh instances for all [instances] of the source (`allocateSeparatedObjectIdentities`). */
    private fun separated(volumeIds: List<String>, instances: Int): List<ProjectIntents.SeparatedObject> = volumeIds.map { volumeId ->
        ProjectIntents.SeparatedObject(units(volumeId), units(ids.next()), ids.next(instances).map(::units))
    }

    /** A split prepared on the authority, staged and executed there as one step; the prepared split is closed either way. */
    private fun <T> stageSplit(split: ProjectVolumeSplit, stage: ProjectIntents.VolumeSplitStage, result: T): CompletableFuture<T> =
        outcome(actor.stage { session, _ -> session.stageVolumeSplit(split, stage) })
            .whenComplete { _, _ -> split.close() }
            .thenApply { outcome ->
                stagedStep(outcome)
                result
            }

    /** A split planned on the authority: the existing volumes' promotion as an intent, or prepared components to stage. */
    private sealed interface SplitPlan<T> {
        class Promote<T>(val edit: Edit<T>, val guard: ProjectIntents.SessionGuard) : SplitPlan<T>
        class Components<T>(val split: ProjectVolumeSplit, val stage: ProjectIntents.VolumeSplitStage, val result: T) : SplitPlan<T>
    }

    /** Plans a split on the authority with [plan], then commits it: an intent under the planned state's guard, or the staged components. */
    private fun <T> split(plan: (ProjectSession) -> SplitPlan<T>): CompletableFuture<T> = refreshed(
        outcome(actor.inspect(plan)).thenCompose { result ->
            @Suppress("UNCHECKED_CAST")
            when (val planned = ((result as? ProjectOutcome.Inspected) ?: throw failure(result, null)).result.getOrThrow() as SplitPlan<T>) {
                is SplitPlan.Promote -> commit(planned.guard, planned.edit)
                is SplitPlan.Components -> stageSplit(planned.split, planned.stage, planned.result)
            }
        },
    )

    /**
     * What Split to Objects will replace, for the operator to confirm (the
     * browser's `getSplitToObjectsConfirmation`): the object of the primary
     * selected instance, how it splits — its volumes promoted, or its one
     * volume separated by connected body —, its triangles and the instances
     * the split replaces. A selection without a primary instance, or an
     * object the workspace would not split, fails in the browser's words.
     */
    fun splitToObjectsConfirmation(): CompletableFuture<SplitConfirmation> = inspect { session ->
        val selection = whole(session)
        val instanceId = primaryInstance(selection, "Split to Objects requires a primary selected model instance")
        session.snapshot().use { snapshot ->
            val source = splitSource(snapshot, instanceId, SplitTarget.OBJECTS)
            SplitConfirmation(
                source.objectName, source.strategy, source.volumeIds.size, source.triangleCount, source.instanceIds,
                snapshot.revision(), snapshot.hash(), selection, source.plateId, source.objectId, instanceId,
            )
        }
    }

    /**
     * Split to Objects of a [confirmation] the operator accepted (the
     * browser's `splitSelectedToObjects`), as one undoable "Split to
     * objects": the object's volumes promoted to objects of their own
     * (`separateObjectVolumes`), or its one volume's connected bodies staged
     * as objects, each with an instance for every instance of the source.
     * The project or the selection having changed since refuses it as stale;
     * a source the workspace would not split fails in the browser's words.
     */
    fun splitSelectedToObjects(confirmation: SplitConfirmation): CompletableFuture<SplitToObjectsResult> = split { session ->
        session.snapshot().use { snapshot ->
            val selection = whole(session)
            val primary = (selection.primary as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::text)
            if (snapshot.revision() != confirmation.revision || snapshot.hash() != confirmation.hash ||
                selection != confirmation.selection || primary != confirmation.primaryInstanceId
            ) {
                throw ProjectFailure(STALE_SPLIT)
            }
            val source = splitSource(snapshot, confirmation.primaryInstanceId, SplitTarget.OBJECTS)
            if (source.plateId != confirmation.plateId || source.objectId != confirmation.objectId) throw ProjectFailure(STALE_SPLIT)
            fun result(identities: List<ProjectIntents.SeparatedObject>) =
                SplitToObjectsResult(identities.map { text(it.objectId) }, identities.flatMap { it.instanceIds.map(::text) })
            if (source.volumeIds.size > 1) {
                val identities = separated(source.volumeIds, source.instanceIds.size)
                val command = ProjectIntents.Command.SeparateObjectVolumes(
                    ProjectIntents.SeparateObjectVolumes(
                        ProjectIntents.SettingsGuard(snapshot.revision(), units(snapshot.hash())), units(source.objectId), identities,
                    ),
                )
                SplitPlan.Promote(Edit(listOf(command), result(identities)), guardOf(session, snapshot))
            } else {
                val (prepared, preview) = prepareSplit(session, source.volumeIds.single())
                try {
                    val (volumeIds, assetIds) = drawSplitIds(preview)
                    val identities = separated(volumeIds, source.instanceIds.size)
                    val stage = ProjectIntents.VolumeSplitStage(
                        volumeIds.map(::units), assetIds.map(::units), ProjectIntents.OptionalSeparatedObjects.Value(identities),
                    )
                    SplitPlan.Components(prepared, stage, result(identities))
                } catch (failure: Throwable) {
                    prepared.close()
                    throw failure
                }
            }
        }
    }

    /**
     * Split to Parts of the primary selected instance's object (the browser's
     * `splitSelectedToParts`): its one volume's connected bodies staged as
     * parts of the same object, one undoable "Split volume to parts". A
     * selection without a primary instance, an object that already has parts
     * or one the workspace would not split fails in the browser's words.
     */
    fun splitSelectedToParts(): CompletableFuture<SplitToPartsResult> = split { session ->
        val instanceId = primaryInstance(whole(session), "Split to Parts requires an instance selection")
        val source = session.snapshot().use { splitSource(it, instanceId, SplitTarget.PARTS) }
        val (prepared, preview) = prepareSplit(session, source.volumeIds.single())
        try {
            val (volumeIds, assetIds) = drawSplitIds(preview)
            val stage = ProjectIntents.VolumeSplitStage(
                volumeIds.map(::units), assetIds.map(::units), ProjectIntents.OptionalSeparatedObjects.Absent(ProjectIntents.Empty),
            )
            SplitPlan.Components(prepared, stage, SplitToPartsResult(preview.parts.size, source.objectName))
        } catch (failure: Throwable) {
            prepared.close()
            throw failure
        }
    }

    /** The simplify preview shown, until it is applied or cancelled (the browser's `simplifyPreview`). */
    @Volatile var simplifyPreview: SimplifyPreview? = null
        private set

    /** Shows [preview] (or none) in place of [expected] and reads the actions that enables (Apply, Cancel); false when another was shown meanwhile. */
    private fun showPreview(preview: SimplifyPreview?, expected: SimplifyPreview?): Boolean {
        synchronized(lock) {
            if (simplifyPreview !== expected) return false
            simplifyPreview = preview
        }
        if (expected !== preview) expected?.parts?.forEach(SimplifyPart::release)
        refreshActions()
        return true
    }

    /** The volumes the workspace's Simplify takes: the model parts the selection paints ([ProjectFacts.selectedModelParts]). */
    private fun simplifyTargets(session: ProjectSession, root: ProjectQueryNode): List<VolumeFacts> =
        ProjectFacts.selectedModelParts(root, whole(session).refs)

    private fun simplifyRequest(volumeId: String, configuration: SimplifyConfiguration) =
        ProjectIntents.VolumeSimplifyRequest(units(volumeId), configuration.useCount, configuration.decimateRatio, configuration.maxError)

    /**
     * The Simplify panel's Preview (`previewSimplify`): every part the
     * selection simplifies decimated with [configuration] and shown, nothing
     * installed — the preview before dropped. Answers the preview, nothing
     * selected, or nothing to simplify (no part would lose a triangle); a part
     * the workspace cannot simplify fails in the browser's words.
     */
    fun previewSimplify(configuration: SimplifyConfiguration): CompletableFuture<SimplifyPreviewResult> {
        cancelSimplifyPreview()
        return inspect { session ->
            session.snapshot().use { snapshot ->
                val targets = snapshot.query().use { root -> simplifyTargets(session, root) }
                if (targets.isEmpty()) return@inspect SimplifyPreviewResult.NothingSelected
                val revision = snapshot.revision()
                val parts = ArrayList<SimplifyPart>()
                try {
                    session.captureGuard().use { guard ->
                        for (volume in targets) {
                            val run = session.volumeSimplify(guard, simplifyRequest(volume.id, configuration))
                            when (val reply = run.reply()) {
                                is ProjectIntents.VolumeSimplifyReply.Prepared -> parts += SimplifyPart(
                                    volume.id, reply.value.beforeTriangles, reply.value.afterTriangles, reply.value.vertexCount,
                                    reply.value.stoppedOnError, text(reply.value.digest), reply.value.byteLength,
                                    volume.assetId, volume.topologyRevision, revision, run,
                                )
                                is ProjectIntents.VolumeSimplifyReply.Unchanged -> run.close()
                                is ProjectIntents.VolumeSimplifyReply.Refused -> {
                                    run.close()
                                    throw ProjectFailure(text(reply.value.message))
                                }
                            }
                        }
                    }
                } catch (failure: Throwable) {
                    parts.forEach(SimplifyPart::release)
                    throw failure
                }
                if (parts.isEmpty()) return@inspect SimplifyPreviewResult.NothingToSimplify(configuration.useCount)
                val preview = SimplifyPreview(configuration, parts)
                if (!showPreview(preview, null)) {
                    // Another preview was shown meanwhile: this one is not.
                    parts.forEach(SimplifyPart::release)
                    throw ProjectFailure("The project changed meanwhile; try again.")
                }
                SimplifyPreviewResult.Previewing(preview)
            }
        }
    }

    /** The panel's Cancel (`cancelSimplifyPreview`): the preview is dropped; the project never changed. Answers whether one was shown. */
    fun cancelSimplifyPreview(): Boolean {
        val shown = simplifyPreview ?: return false
        return showPreview(null, shown)
    }

    /**
     * One previewed part installed as one "Replace mesh topology" under a
     * fresh asset ID (`applyPreparedSimplify`), guarded as the browser guards
     * it, by the part's mesh alone: a volume whose mesh changed since the
     * preview is refused in the browser's words, and one that did not is
     * installed even after other edits — the same decimation of the same mesh
     * run again, which must give the previewed bytes, when the session's
     * state moved on.
     */
    private fun applyPart(part: SimplifyPart, configuration: SimplifyConfiguration): CompletableFuture<Unit> {
        val refusal = java.util.concurrent.atomic.AtomicReference<String?>()
        return outcome(
            actor.stage { session, guard ->
                val stage = ProjectIntents.VolumeSimplifyStage(units(ids.next()))
                val now = session.snapshot().use { snapshot ->
                    snapshot.query().use { root -> ProjectFacts.objects(root).firstNotNullOfOrNull { o -> o.volumes.firstOrNull { it.id == part.volumeId } } }
                }
                val stale = when {
                    now == null -> "is missing"
                    now.assetId != part.assetId -> "changed mesh asset"
                    now.topologyRevision != part.topologyRevision -> "changed topology revision"
                    now.triangleCount != part.beforeTriangles -> "changed triangle count"
                    else -> null
                }
                if (stale != null) {
                    refusal.set("Stale topology guard: volume ${part.volumeId} $stale")
                    return@stage null
                }
                val held = synchronized(part) { part.run }
                if (held == null) {
                    refusal.set("There is no simplify preview to apply.")
                    return@stage null
                }
                try {
                    session.stageVolumeSimplify(held, stage)
                } catch (moved: IllegalStateException) {
                    if (moved.message != "stale") throw moved
                    session.volumeSimplify(guard, simplifyRequest(part.volumeId, configuration)).use { again ->
                        val prepared = again.reply() as? ProjectIntents.VolumeSimplifyReply.Prepared
                        if (prepared == null || text(prepared.value.digest) != part.digest) {
                            refusal.set("Stale topology guard: volume ${part.volumeId} asset topology changed")
                            null
                        } else {
                            session.stageVolumeSimplify(again, stage)
                        }
                    }
                }
            },
        ).thenApply { result ->
            refusal.get()?.let { throw ProjectFailure(it) }
            if (!stagedStep(result)) throw ProjectFailure("Unexpected answer from the project.")
        }
    }

    /**
     * The panel's Apply (`applySimplifyPreview`): exactly the previewed
     * meshes installed, part by part, each its own "Replace mesh topology";
     * the preview is gone either way. A part refused (its mesh changed under
     * the preview) stops there in the browser's words, the parts before it
     * installed. Answers what was installed, or null without a preview.
     */
    fun applySimplifyPreview(): CompletableFuture<SimplifyApplied?> {
        val preview = simplifyPreview ?: return CompletableFuture.completedFuture(null)
        fun from(index: Int): CompletableFuture<Unit> =
            if (index == preview.parts.size) CompletableFuture.completedFuture(Unit)
            else applyPart(preview.parts[index], preview.configuration).thenCompose { from(index + 1) }
        return refreshed(
            from(0).handle { _, error ->
                showPreview(null, preview)
                if (error != null) throw (error as? java.util.concurrent.CompletionException)?.cause ?: error
                SimplifyApplied(preview.parts.size, preview.beforeTriangles, preview.afterTriangles)
            },
        )
    }

    /**
     * The menu's Simplify (`simplify_model`, the browser's
     * `simplifySelected`): each part the selection simplifies decimated by
     * [decimateRatio] percent of its triangles and installed at once, each a
     * "Replace mesh topology"; a part with nothing to remove is left. Answers
     * the parts changed and the triangles before and after (the unchanged
     * counted), or null with nothing selected; a part the workspace cannot
     * simplify stops there in the browser's words.
     */
    fun simplifySelected(decimateRatio: Double = 50.0): CompletableFuture<SimplifyApplied?> {
        val configuration = SimplifyConfiguration(useCount = true, decimateRatio = decimateRatio, maxError = SIMPLIFY_DEFAULT_MAX_ERROR)
        var before = 0L
        var after = 0L
        var changed = 0
        fun from(targets: List<String>, index: Int): CompletableFuture<SimplifyApplied?> {
            if (index == targets.size) return CompletableFuture.completedFuture(SimplifyApplied(changed, before, after))
            val refusal = java.util.concurrent.atomic.AtomicReference<String?>()
            val counts = java.util.concurrent.atomic.AtomicReference<Pair<Long, Long>?>()
            return outcome(
                actor.stage { session, guard ->
                    session.volumeSimplify(guard, simplifyRequest(targets[index], configuration)).use { run ->
                        when (val reply = run.reply()) {
                            is ProjectIntents.VolumeSimplifyReply.Prepared -> {
                                counts.set(reply.value.beforeTriangles to reply.value.afterTriangles)
                                session.stageVolumeSimplify(run, ProjectIntents.VolumeSimplifyStage(units(ids.next())))
                            }
                            is ProjectIntents.VolumeSimplifyReply.Unchanged -> {
                                counts.set(reply.value.triangleCount to reply.value.triangleCount)
                                null
                            }
                            is ProjectIntents.VolumeSimplifyReply.Refused -> {
                                refusal.set(text(reply.value.message))
                                null
                            }
                        }
                    }
                },
            ).thenCompose { result ->
                refusal.get()?.let { throw ProjectFailure(it) }
                stagedStep(result)
                val (was, now) = counts.get() ?: throw failure(result, null)
                before += was
                after += now
                if (now < was) changed++
                from(targets, index + 1)
            }
        }
        return refreshed(
            inspect { session -> session.snapshot().use { snapshot -> snapshot.query().use { root -> simplifyTargets(session, root).map { it.id } } } }
                .thenCompose { targets -> if (targets.isEmpty()) CompletableFuture.completedFuture(null) else from(targets, 0) },
        )
    }

    /** Measure captures by mesh asset, least recently used first (the browser keeps its extractors by asset). */
    private val measured = object : LinkedHashMap<String, ProjectMeasureVolume>(MEASURE_CAPTURES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ProjectMeasureVolume>): Boolean =
            (size > MEASURE_CAPTURES).also { if (it) eldest.value.close() }
    }

    /**
     * A Measure pick (`pickMeasureFeature`): the feature the workspace claims
     * at volume-local [point] on facet [triangle] of volume [volumeId], as
     * instance [instanceId] places it, in printer millimetres
     * ([ProjectMeasures.placedTransform]), with its one-line description. A
     * hole an uneven scale distorts answers the browser's words
     * ([MeasurePickResult.Uneven]); a volume or facet the core cannot measure
     * fails in its words.
     */
    fun measurePick(instanceId: String, volumeId: String, triangle: Long, point: List<Double>): CompletableFuture<MeasurePickResult> = inspect { session ->
        val placed = session.snapshot().use { snapshot ->
            snapshot.query().use { root ->
                ProjectFacts.objects(root).firstNotNullOfOrNull { o ->
                    val instance = o.instances.firstOrNull { it.first == instanceId }
                    val volume = o.volumes.firstOrNull { it.id == volumeId }
                    if (instance == null || volume == null) null else volume.assetId to ProjectMeasures.placedTransform(instance.second, volume.transform)
                }
            }
        } ?: throw ProjectFailure("Click a model surface to measure it.")
        val (assetId, transform) = placed
        val capture = synchronized(measured) { measured[assetId] } ?: session.measureVolume(ProjectIntents.MeasureVolumeRequest(units(volumeId))).let { fresh ->
            when (val reply = fresh.reply()) {
                is ProjectIntents.MeasureVolumeReply.Refused -> {
                    fresh.close()
                    throw ProjectFailure(text(reply.value.message))
                }
                is ProjectIntents.MeasureVolumeReply.Captured -> synchronized(measured) {
                    measured.getOrPut(assetId) { fresh }.also { if (it !== fresh) fresh.close() }
                }
            }
        }
        when (val reply = capture.feature(ProjectIntents.MeasureFeatureRequest(triangle, point, false, ProjectIntents.OptionalWorldTransform.Value(transform)))) {
            is ProjectIntents.MeasureFeatureReply.Feature -> MeasurePickResult.Picked(MeasurePick(reply.value.feature, text(reply.value.summary), instanceId))
            is ProjectIntents.MeasureFeatureReply.Refused ->
                if (reply.value.code == ProjectIntents.MeasureRefusalCode.UnevenScale) MeasurePickResult.Uneven(text(reply.value.message))
                else throw ProjectFailure(text(reply.value.message))
        }
    }

    /** The measurement of two picks (`measureSurfaceFeatures`): distances, their X/Y/Z parts and the angle; null when it is not finite. */
    fun measure(first: MeasurePick, second: MeasurePick): ProjectIntents.MeasureResult? =
        (ProjectMeasureVolume.measure(ProjectIntents.MeasureRequest(first.feature, second.feature)) as? ProjectIntents.MeasureReply.Measured)?.value

    override fun close() {
        synchronized(lock) { timer?.close() }
        cancelSimplifyPreview()
        synchronized(measured) {
            measured.values.forEach(ProjectMeasureVolume::close)
            measured.clear()
        }
        actor.close()
        synchronized(lock) { listeners.clear() }
        synchronized(showing) {
            disposed = true
            shown?.close()
            shown = null
        }
    }
}

/** What Delete Selected removed: one instance, or its object with its last instance. */
enum class ProjectDeletion { INSTANCE, OBJECT }

/** What Printable did: the state the selected instances took, and how many changed to it. */
data class ProjectPrintableChange(val printable: Boolean, val changed: Int)

/** A primitive placed: its object and instance, and whether its mesh is shared with an asset the project held. */
data class ProjectPrimitiveAdded(val objectId: String, val instanceId: String, val reusedAsset: Boolean)

/** A helper volume added: the object it joined and the new part. */
data class ProjectHelperAdded(val objectId: String, val volumeId: String)

/** What Set as Negative Part did: converted the selected part, or added a negative volume to the selected object. */
sealed interface NegativePartResult {
    data class Converted(val volumeId: String) : NegativePartResult
    data class Added(val added: ProjectHelperAdded) : NegativePartResult
}

/** A bed fill: how many copies were added, and how many free slots the copy limit left. */
data class ProjectBedFill(val created: Int, val withheld: Long)

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
