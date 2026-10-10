package dev.orcaxr.nativeapp.project

import android.content.Context
import dev.orcaxr.core.LiveSlicingChoice
import dev.orcaxr.core.PresetOption
import dev.orcaxr.core.ProfileCatalog
import dev.orcaxr.core.ProfileCatalogs
import dev.orcaxr.core.ProfileSelection
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.SelectionSeverity
import org.json.JSONArray
import org.json.JSONObject

/** What the profile pickers show: the choices, what is selected, and what the last selection said. */
data class ProfilesView(
    val ready: Boolean = false,
    val machines: List<PresetOption> = emptyList(),
    val processes: List<PresetOption> = emptyList(),
    val filaments: List<PresetOption> = emptyList(),
    val machine: String? = null,
    val process: String? = null,
    /** Each palette slot's filament preset, the first one the profile's own. */
    val heads: List<String?> = emptyList(),
    /** The printer's heads: one "Filament" picker for one, a picker per head for more. */
    val extruders: Int = 1,
    /** The opened project slices with its own printer and filaments until a profile is chosen. */
    val authored: Boolean = false,
    val status: List<String> = emptyList(),
    val warning: Boolean = false,
    /** Why the catalog could not be loaded, if it could not. */
    val failure: String? = null,
)

/**
 * The browser workspace's profile selection (`OrcaWorkspace.profile` and its
 * head filaments) over the bundled catalog (built once per process and shared
 * by every window: [ProfileCatalogs.shared]), in the shared core: the pickers'
 * choices, selections that apply only when complete, the operator's last
 * choice remembered as the browser's `orcaxr.profiles`, and each applied
 * choice made the project's own configuration as one undoable step. An
 * opened project slices with its own printer and filaments until a profile
 * is chosen. Every method runs on the project worker, which serializes it
 * with opening and replacing projects.
 */
class SlicingProfiles(context: Context, private val publish: (ProfilesView) -> Unit) : AutoCloseable {
    private val assets = context.assets
    private val preferences = context.getSharedPreferences("orcaxr.profiles", Context.MODE_PRIVATE)
    // Written on the project worker; the preflight target reads them on the project's authority.
    @Volatile private var catalog: ProfileCatalog? = null
    @Volatile private var live = LiveSlicingChoice.EMPTY
    @Volatile private var authored = false
    private var feedback: Pair<List<String>, Boolean> = emptyList<String>() to false

    /**
     * Loads the catalog and selects the remembered choice (by preset, else by
     * name) or the catalog's default. A pristine project takes it as its
     * starting point, as the browser's new document does: applied, then made
     * the baseline with nothing to undo.
     */
    fun start(workspace: ProjectWorkspace) {
        val loaded = try {
            ProfileCatalogs.shared { assets.open(CATALOG).use { it.readBytes() } }
        } catch (failure: Exception) {
            publish(ProfilesView(failure = "The printer profiles could not be loaded: ${failure.message ?: failure.javaClass.simpleName}"))
            return
        }
        catalog = loaded
        val selection = restored(loaded) ?: loaded.defaultSelection(LiveSlicingChoice.EMPTY)
        selection?.live?.let { live = it }
        val pristine = workspace.view.let { it.undo == null && it.redo == null && !it.dirty && objects(it) == 0 }
        if (live.profile != null) {
            workspace.applySlicingChoice(loaded, live).get()
            if (pristine) workspace.newProject().get()
        }
        show()
    }

    private fun restored(catalog: ProfileCatalog): ProfileSelection? {
        val saved = preferences.getString(SELECTION, null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        val machine = saved.optString("machinePresetId").ifEmpty { null }
        val process = saved.optString("processPresetId").ifEmpty { null }
        val filaments = saved.optJSONArray("filamentPresetIds")?.let { list -> List(list.length()) { list.optString(it).ifEmpty { null } } }
        val byId = if (machine != null && process != null && !filaments.isNullOrEmpty()) {
            catalog.selectPresets(LiveSlicingChoice.EMPTY, machine, process, filaments).takeIf { it.feedback.applied }
        } else null
        return byId ?: catalog.selectByNames(
            LiveSlicingChoice.EMPTY, saved.optString("machine"), saved.optString("process"), saved.optString("filament"),
        ).takeIf { it.feedback.applied }
    }

    private fun objects(view: ProjectView) = view.rows.count { it.kind == ProjectIntents.ObjectTreeRowKind.Object }

    /** A project was opened (or restored) with its own printer and filaments: it slices as authored. */
    fun opened() {
        authored = true
        live = live.copy(profile = null)
        feedback = emptyList<String>() to false
        show()
    }

    /** Selects presets (absent parts keep the current choice) and, when complete, applies the choice to the project. */
    fun select(
        workspace: ProjectWorkspace,
        machine: String? = null,
        process: String? = null,
        filaments: List<String?>? = null,
    ) {
        val loaded = catalog ?: return
        val selection = loaded.selectPresets(live, machine, process, filaments)
        feedback = selection.feedback.messages to (selection.feedback.severity != SelectionSeverity.INFO)
        val next = selection.live
        if (!selection.feedback.applied || next == null) return show()
        live = next
        authored = false
        remember(loaded)
        show()
        workspace.applySlicingChoice(loaded, next).get()
    }

    /** One head's filament preset, the rest kept. */
    fun selectHead(workspace: ProjectWorkspace, index: Int, filament: String) {
        val heads = live.heads.map { it.presetId }.toMutableList()
        while (heads.size <= index) heads += null
        heads[index] = filament
        select(workspace, filaments = heads)
    }

    /** The preflight target for a project of `toolCount` tools: its own configuration while it owns it, else the chosen profile's. */
    fun target(toolCount: Int): ProjectIntents.PreflightTarget {
        val loaded = catalog
        if (authored || loaded == null) return ProjectWorkspace.AUTHORED
        return ProfileCatalogs.preflightTarget(loaded, live, toolCount) ?: ProjectWorkspace.AUTHORED
    }

    /** The choice as the browser's `orcaxr.profiles` keeps it: the presets, and their names to fall back on. */
    private fun remember(catalog: ProfileCatalog) {
        val profile = live.profile ?: return
        val names = catalog.slicingChoices(profile.machinePresetId, profile.processPresetId)
        fun name(options: List<PresetOption>, id: String) = options.firstOrNull { it.id == id }?.name.orEmpty()
        val record = JSONObject()
            .put("machinePresetId", profile.machinePresetId)
            .put("processPresetId", profile.processPresetId)
            .put("filamentPresetIds", JSONArray(live.heads.map { it.presetId ?: JSONObject.NULL }.ifEmpty { listOf(profile.filamentPresetId) }))
            .put("machine", name(names.machines, profile.machinePresetId))
            .put("process", name(names.processes, profile.processPresetId))
            .put("filament", name(names.filaments, profile.filamentPresetId))
        preferences.edit().putString(SELECTION, record.toString()).apply()
    }

    private fun show() {
        val loaded = catalog ?: return
        val profile = live.profile.takeUnless { authored }
        val choices = loaded.slicingChoices(profile?.machinePresetId, profile?.processPresetId)
        publish(
            ProfilesView(
                ready = true,
                machines = choices.machines,
                processes = if (profile != null) choices.processes else emptyList(),
                filaments = if (profile != null) choices.filaments else emptyList(),
                machine = profile?.machinePresetId,
                process = profile?.processPresetId,
                heads = if (profile != null) live.heads.map { it.presetId }.ifEmpty { listOf(profile.filamentPresetId) } else emptyList(),
                extruders = choices.extruders,
                authored = authored,
                status = feedback.first,
                warning = feedback.second,
            ),
        )
    }

    /** Lets go of the process's shared catalog, which stays open for other windows. */
    override fun close() {
        catalog = null
    }

    private companion object {
        const val CATALOG = "profiles/catalog.json"
        const val SELECTION = "selection"
    }
}
