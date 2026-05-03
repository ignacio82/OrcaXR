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

    /**
     * Mesh repair via libslic3r `MeshBoolean::self_union`. Replaces
     * the model's source with the repaired mesh; paint state is
     * dropped (per-triangle indices don't survive a re-mesh — see
     * libslic3r gotcha #27).
     */
    data class RepairModel(val modelId: String) : WorkspaceAction

    /**
     * Cut a model along a Z plane. `planeZmm` is in printer-frame
     * mm above the bed. Both halves are kept by default; the slicer
     * handles bed-grounding for the lower half.
     */
    data class CutModel(val modelId: String, val planeZmm: Float) : WorkspaceAction

    /**
     * Mesh boolean op between two models. `op` mirrors
     * SlicerEngine.BoolOp: 0 = Union, 1 = Difference (A − B), 2 =
     * Intersection.
     */
    data class MeshBoolean(val modelAId: String, val modelBId: String, val op: Int) : WorkspaceAction

    /**
     * Split a model into its disconnected components. Each
     * connected component becomes its own PlacedModel.
     */
    data class SplitModel(val modelId: String) : WorkspaceAction

    /**
     * Apply an embossed text or SVG inset to a model. Sub-types map
     * onto libslic3r's `Emboss::text2shapes` and `to_polygons`
     * pipelines respectively. `mode` decides whether the result is
     * UNION'd onto the host (raised letters) or A-NOT-B'd (engraved).
     *
     * Translation/rotation are applied to the emboss mesh BEFORE the
     * boolean — they let the caller place text off-center, rotate it
     * to fit a curved face, etc. Defaults all-zero put the text
     * centered on the host's top face.
     */
    sealed interface EmbossSource {
        data class Text(val text: String, val fontId: String) : EmbossSource
        data class Svg(val svgPath: String) : EmbossSource
    }

    enum class EmbossMode { Add, Sub }

    data class EmbossModel(
        val modelId: String,
        val source: EmbossSource,
        val sizeMm: Float,
        val depthMm: Float,
        val mode: EmbossMode,
        val translateXmm: Float = 0f,
        val translateYmm: Float = 0f,
        val rotZDeg: Float = 0f,
    ) : WorkspaceAction

    /**
     * Multi-volume editing — append a new volume to an existing
     * PlacedModel. `type` is one of MODEL_PART / NEGATIVE_VOLUME /
     * PARAMETER_MODIFIER / SUPPORT_BLOCKER / SUPPORT_ENFORCER (matches
     * `dev.orcaxr.app.ModelVolumeType`'s name() — passed as a string
     * here so the action surface stays JSON-friendly).
     */
    data class AddVolumeToModel(
        val modelId: String,
        val sourcePath: String,
        val type: String,
    ) : WorkspaceAction

    data class RemoveVolume(val modelId: String, val volumeId: String) : WorkspaceAction

    /**
     * Which per-triangle paint state to operate on. Mirrors the four
     * ByteArray fields on `PlacedModel`:
     * - `Color`: filament-slot tag (0..32, 0 = unpainted).
     * - `Support`: enforcer/blocker (0=none, 1=ENFORCER, 2=BLOCKER).
     * - `Seam`: same encoding as Support.
     * - `FuzzySkin`: 0=smooth, 1=fuzzy (libslic3r ignores 2).
     */
    enum class PaintKind { Color, Support, Seam, FuzzySkin }

    /**
     * Wipe paint state for one or all kinds on a model. `kind=null`
     * clears everything (color + support + seam + fuzzy).
     */
    data class ClearPaint(val modelId: String, val kind: PaintKind?) : WorkspaceAction

    /**
     * Find every triangle currently tagged `fromTag` and re-tag it as
     * `toTag`. Use this for "swap blue (slot 2) for red (slot 3)" or
     * "convert support enforcers to blockers." `toTag = 0` is
     * effectively a partial clear ("remove all triangles tagged
     * `fromTag`"). The action is a pure byte-array transform and
     * doesn't read or write the mesh itself.
     */
    data class ReplacePaintTag(
        val modelId: String,
        val kind: PaintKind,
        val fromTag: Int,
        val toTag: Int,
    ) : WorkspaceAction

    /** Undo the most recent paint stroke on a model. No-op if the history is empty. */
    data class PaintUndo(val modelId: String) : WorkspaceAction

    /** Redo a previously-undone paint stroke. */
    data class PaintRedo(val modelId: String) : WorkspaceAction

    /** Axis a [PaintPlaneSplit] divides the mesh on, in printer-frame mesh-mm. */
    enum class SplitAxis { X, Y, Z }

    /**
     * Bulk paint every triangle of a model based on which side of an
     * axis-aligned plane its centroid lies on. The plane lives in the
     * mesh's centered preview frame: bbox XY-center at the origin,
     * Z-min on the bed (the same frame `nativeWriteColoredGlb` uses,
     * see GEMINI.md gotcha #11d). With `planeMm = 0` and `axis = X`,
     * triangles whose centroid X is negative get [negativeTag], the
     * rest get [positiveTag] — i.e. the canonical "left red, right
     * blue" split.
     *
     * Recorded in PaintHistory so paint_undo restores it. Replaces
     * any prior paint of the same kind on the model — this is a bulk
     * authoring op, not a brush stamp.
     */
    data class PaintPlaneSplit(
        val modelId: String,
        val kind: PaintKind,
        val axis: SplitAxis,
        val planeMm: Float,
        val negativeTag: Int,
        val positiveTag: Int,
    ) : WorkspaceAction

    /**
     * How a [PaintTriangleSet] composes with the model's existing
     * per-triangle paint of the same kind.
     */
    enum class MergeMode {
        /** Overwrite tag for matched triangles regardless of prior state. */
        Replace,
        /** Set tag only for triangles whose current tag is 0 (unpainted). */
        OnlyUnpainted,
        /**
         * Set tag only for triangles whose current tag matches
         * [PaintTriangleSet.whereTag] (so the LLM can re-tag e.g. only
         * the triangles currently in slot 2).
         */
        OnlyTagged,
    }

    /**
     * AI-paint pillar (C9 milestone 1). Apply [tag] to the listed
     * [triangleIndices] on a paint kind. Every spatial-paint MCP tool
     * (paint_sphere / paint_slab / paint_normal_cone /
     * paint_surface_region / paint_connected_component /
     * paint_triangle_list / paint_projected_mask) eventually compiles
     * to one of these — single source of truth for PaintHistory +
     * paintCacheStore + paintContentVersion plumbing.
     *
     * Coordinate frame: [triangleIndices] are in the source-of-truth
     * triangle index space (see GEMINI.md #11d for the centering shift
     * — the BVH and `nativeWriteColoredGlb` agree on this frame). Index
     * 0 is the first triangle in the derived STL's binary layout.
     *
     * One MCP call ⇒ one [PaintTriangleSet] ⇒ one undo step (even an
     * 80 K-triangle projected-mask paint).
     */
    /**
     * D18j — replace a model's full paint state in one shot
     * (color / support / seam / fuzzy_skin all at once). Used by
     * `load_paint_recipe` so a saved paint design replays as a
     * single undo step instead of N PaintTriangleSet emissions.
     * Each ByteArray is sized to the model's source-mesh tri
     * count or null to clear that kind. Routes through
     * applyPaintMutation in MainActivity.
     */
    data class LoadPaintState(
        val modelId: String,
        val paintFilamentIndex: ByteArray?,
        val supportFlags: ByteArray?,
        val seamFlags: ByteArray?,
        val fuzzySkinFlags: ByteArray?,
    ) : WorkspaceAction {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is LoadPaintState) return false
            return modelId == other.modelId
                && paintFilamentIndex.contentEqualsOrBothNull(other.paintFilamentIndex)
                && supportFlags.contentEqualsOrBothNull(other.supportFlags)
                && seamFlags.contentEqualsOrBothNull(other.seamFlags)
                && fuzzySkinFlags.contentEqualsOrBothNull(other.fuzzySkinFlags)
        }
        override fun hashCode(): Int {
            var h = modelId.hashCode()
            h = 31 * h + (paintFilamentIndex?.contentHashCode() ?: 0)
            h = 31 * h + (supportFlags?.contentHashCode() ?: 0)
            h = 31 * h + (seamFlags?.contentHashCode() ?: 0)
            h = 31 * h + (fuzzySkinFlags?.contentHashCode() ?: 0)
            return h
        }
        private fun ByteArray?.contentEqualsOrBothNull(other: ByteArray?): Boolean {
            if (this == null) return other == null
            return other != null && this.contentEquals(other)
        }
    }

    data class PaintTriangleSet(
        val modelId: String,
        val kind: PaintKind,
        val triangleIndices: IntArray,
        val tag: Int,
        val mergeMode: MergeMode = MergeMode.Replace,
        /** Required when [mergeMode] = OnlyTagged. Ignored otherwise. */
        val whereTag: Int = 0,
    ) : WorkspaceAction {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is PaintTriangleSet) return false
            return modelId == other.modelId
                && kind == other.kind
                && tag == other.tag
                && mergeMode == other.mergeMode
                && whereTag == other.whereTag
                && triangleIndices.contentEquals(other.triangleIndices)
        }
        override fun hashCode(): Int {
            var h = modelId.hashCode()
            h = 31 * h + kind.hashCode()
            h = 31 * h + tag
            h = 31 * h + mergeMode.hashCode()
            h = 31 * h + whereTag
            h = 31 * h + triangleIndices.contentHashCode()
            return h
        }
    }
}
