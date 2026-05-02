package dev.orcaxr.app.mcp

import dev.orcaxr.app.GizmoTool
import dev.orcaxr.app.PaintBrush
import dev.orcaxr.app.PaintMode
import dev.orcaxr.app.WorkspaceMode

/**
 * Mutations a remote actor (MCP tool, future Smart-Assistant chat)
 * can post into [WorkspaceModel.actions]. MainActivity's collector
 * dispatches each one onto the matching `remember { mutableStateOf
 * (...) }` setter or async coroutine pipeline.
 *
 * Design notes:
 * - These are *intent* records — "select these IDs", "begin a slice".
 *   Whether the action is allowed in the current state (e.g. you can't
 *   slice while already slicing) is decided by MainActivity's handler,
 *   not the tool. The tool's job is to translate JSON args into the
 *   right [WorkspaceAction] subclass.
 * - Keep these data classes serializable-by-hand (no embedded Kotlin
 *   reflection types) — future commits may persist a replay log.
 * - Tier-A actions (this commit) only need MainActivity's setter call.
 *   Tier-B actions (transforms, slice, save) trigger longer-running
 *   pipelines; MainActivity wraps those in coroutines and writes the
 *   resulting state back through the publisher API.
 */
sealed interface WorkspaceAction {

    // ---- Tier A — direct setters ----

    data class SetGizmoTool(val tool: GizmoTool) : WorkspaceAction

    data class SetWorkspaceMode(val mode: WorkspaceMode) : WorkspaceAction

    data class SetActivePlateId(val plateId: Int) : WorkspaceAction

    /**
     * Replace the entire selection set. `additive=false` (the default)
     * is "set selection to exactly these ids"; `additive=true` is
     * "union with the current selection." `ids = emptySet() &&
     * additive=false` clears the selection.
     */
    data class SetSelectedModels(
        val ids: Set<String>,
        val additive: Boolean = false,
    ) : WorkspaceAction

    data class SetLayerHeightOverride(val value: String) : WorkspaceAction

    data class SetPaintMode(val mode: PaintMode) : WorkspaceAction

    /**
     * Paint-brush partial update. Only fields that differ from the
     * current PaintBrush get changed; null leaves the field alone.
     */
    data class UpdatePaintBrush(
        val mode: PaintMode? = null,
        val activeSlot: Int? = null,
        val radiusMm: Float? = null,
        val smartFill: Boolean? = null,
        val smartFillAngleDeg: Float? = null,
    ) : WorkspaceAction

    /** Set the toolpath layer scrubber. Null = "show all layers". */
    data class SetMaxLayer(val layer: Int?) : WorkspaceAction

    /**
     * Apply a slicer profile by id. MainActivity resolves against the
     * bundled + user catalog and calls the same callback path as the
     * UI picker.
     */
    data class SwitchProfile(val profileId: String) : WorkspaceAction

    /**
     * Set the printer the "Send to printer" + status polling targets.
     * Null clears the selection.
     */
    data class SetSelectedPrinter(val printerId: String?) : WorkspaceAction

    data class SetShowTravels(val value: Boolean) : WorkspaceAction

    data class SetToolpathTubes(val value: Boolean) : WorkspaceAction

    // ---- Tier B — pipelines (placeholders so the action surface is
    //                          stable; MainActivity handlers land in a
    //                          follow-up commit) ----

    /**
     * Apply a transform to one model. Translation values are absolute
     * mm. Rotation is degrees (0..360, the activity normalizes).
     * Scale is percent (100 = unchanged). All fields are optional —
     * null leaves that axis alone.
     */
    data class TransformModel(
        val modelId: String,
        val translateXmm: Float? = null,
        val translateYmm: Float? = null,
        val translateZmm: Float? = null,
        val rotXDeg: Float? = null,
        val rotYDeg: Float? = null,
        val rotZDeg: Int? = null,
        val scaleXPct: Float? = null,
        val scaleYPct: Float? = null,
        val scaleZPct: Float? = null,
        val mirrorX: Boolean? = null,
        val mirrorY: Boolean? = null,
        val mirrorZ: Boolean? = null,
    ) : WorkspaceAction

    /** Delete the named models from the bed (and optionally the
     *  paint history cache). */
    data class DeleteModels(val ids: Set<String>) : WorkspaceAction

    /** libnest2d-driven plate auto-arrange on the active plate. */
    data object AutoArrangePlate : WorkspaceAction

    /** Drop a model so its lowest face sits on z=0. */
    data class DropToBed(val modelId: String) : WorkspaceAction

    /** Trigger a slice of the active plate. Tools should typically
     *  follow up by polling sliceState. */
    data object SliceActivePlate : WorkspaceAction

    /** Cancel the running slice (no-op if not slicing). Currently
     *  declared but unimplemented — libslic3r doesn't expose an abort
     *  hook through the JNI shim yet. */
    data object CancelSlice : WorkspaceAction

    /** Save the most-recent successful slice's G-code to /Downloads. */
    data object SaveGcodeToDownloads : WorkspaceAction

    /** Save the currently-selected model as an STL into /Downloads. */
    data object SaveModelStl : WorkspaceAction

    /** Save the currently-selected model + active config as a 3MF
     *  project into /Downloads. */
    data object SaveProject3mf : WorkspaceAction

    /**
     * How an incoming file changes the bed.
     * - `Replace`: clear current models + drop in the new one (the
     *   default file-picker behavior).
     * - `Add`: append a new PlacedModel alongside the existing ones
     *   (the "+ Add another" affordance).
     */
    enum class LoadMode { Replace, Add }

    /**
     * Load a model from a filesystem path. The caller passes an
     * absolute path that's already readable on-device (e.g.
     * /sdcard/Download/dragon.3mf or a path returned by
     * list_recent_files). MainActivity dispatches through the same
     * `onFileSelected` codepath the file picker uses, so paint
     * restoration, GLB bake, bedFit, and bedCollision all run
     * identically. STL, 3MF, OBJ, AMF are accepted; libslic3r decides
     * the rest at parse time.
     */
    data class LoadModelFromPath(val path: String, val mode: LoadMode) : WorkspaceAction

    /**
     * Toggle the workspace-grab affordance (the bed becomes a single
     * MovableComponent target in XR). UI default is OFF so model
     * gizmos stay reachable; flipping ON lets the user grab and
     * reposition the entire bed in space.
     */
    data class SetPlateMovable(val movable: Boolean) : WorkspaceAction
}
