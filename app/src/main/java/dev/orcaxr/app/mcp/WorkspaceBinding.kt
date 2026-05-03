package dev.orcaxr.app.mcp

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import dev.orcaxr.app.BedCollision
import dev.orcaxr.app.BedFit
import dev.orcaxr.app.GizmoTool
import dev.orcaxr.app.PaintBrush
import dev.orcaxr.app.PaintMode
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.SliceUiState
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.WorkspaceMode

/**
 * Composable that mirrors XrShell's in-session state into the
 * process-scoped [WorkspaceModel] singleton, and drains the singleton's
 * action channel back onto the shell's setters. Call this exactly
 * once near the bottom of XrShell after every tracked piece of state
 * is in scope.
 *
 * Why a Composable? Because the easiest way to observe Compose state
 * at all is from inside the composition. Each tracked field gets its
 * own `LaunchedEffect(value)` that fires once per change and pushes
 * to the model — Compose snapshot diffing makes those effectively
 * free when nothing's changed.
 *
 * The function takes plain `value` + `setter` pairs (rather than
 * `MutableState<T>`) because XrShell's state is a mix of
 * `var x by remember { mutableStateOf(...) }` and `MutableState<T>`
 * params; both reduce to the same shape on the call site
 * (`gizmoTool, { gizmoTool = it }`). Writing through a setter inside
 * the action collector is correct across recompositions because the
 * `var by remember { mutableStateOf(...) }` delegate dispatches to a
 * stable MutableState the entire composition shares — the closure's
 * "old" reference still routes to the right place.
 *
 * The collector uses [rememberUpdatedState] to read the latest
 * value of compound state (placedModels, paintBrush, etc.) when
 * computing the next value — without that the captured
 * coroutine-scope reference would freeze at the first composition's
 * value.
 *
 * Tier-B actions (SliceActivePlate, AutoArrangePlate, save_*) are
 * **acknowledged but not implemented** here — they need to call
 * specific suspending pipelines that are deeper inside MainActivity
 * (the slice flow, the save-as-3MF flow). Hooking those up cleanly
 * needs a follow-up commit; for now they log a not-yet-supported
 * warning so an LLM client gets a clear failure mode.
 */
@Composable
fun BindWorkspaceModel(
    placedModels: List<PlacedModel>,
    setPlacedModels: (List<PlacedModel>) -> Unit,
    selectedModelIds: Set<String>,
    setSelectedModelIds: (Set<String>) -> Unit,
    gizmoTool: GizmoTool,
    setGizmoTool: (GizmoTool) -> Unit,
    paintBrush: PaintBrush,
    setPaintBrush: (PaintBrush) -> Unit,
    workspaceMode: WorkspaceMode,
    setWorkspaceMode: (WorkspaceMode) -> Unit,
    activePlateId: Int,
    setActivePlateId: (Int) -> Unit,
    selectedProfile: SlicerProfile,
    setSelectedProfile: (SlicerProfile) -> Unit,
    selectedPrinterId: String?,
    setSelectedPrinterId: (String?) -> Unit,
    layerHeightOverride: String,
    setLayerHeightOverride: (String) -> Unit,
    printSettingsOverrides: Map<String, String>,
    sliceState: SliceUiState,
    maxLayer: Int?,
    setMaxLayer: (Int?) -> Unit,
    bedFit: BedFit?,
    bedCollision: BedCollision.Result?,
    showTravels: Boolean,
    setShowTravels: (Boolean) -> Unit,
    toolpathTubes: Boolean,
    setToolpathTubes: (Boolean) -> Unit,
    plateMovable: Boolean,
    setPlateMovable: (Boolean) -> Unit,
    allProfiles: List<SlicerProfile>,
    /** Live "as-will-print" palette for the active printer (one entry
     *  per slot, hex `#RRGGBB`). MCP tools surface this via
     *  `list_active_palette` so the LLM knows the real on-bed colors
     *  instead of the user-configured filament list. */
    previewPalette: List<String> = emptyList(),
    /**
     * Tier-B callbacks. Each fires when the corresponding
     * [WorkspaceAction] arrives. Default null = "log warning, do
     * nothing" — useful for tests + the (unlikely) case where MCP
     * clients hit one of these before MainActivity wires them.
     * MainActivity passes lambdas that call into the existing
     * onSliceClick / runAutoArrange / saveGcodeToDownloads /
     * saveProjectAs3mfToDownloads / saveModelAsStlToDownloads flows
     * so the result is identical to the user tapping the same buttons.
     */
    onSliceActivePlate: (() -> Unit)? = null,
    onAutoArrangePlate: (() -> Unit)? = null,
    onDropToBed: ((modelId: String) -> Unit)? = null,
    onSaveGcode: (() -> Unit)? = null,
    onSaveProject3mf: (() -> Unit)? = null,
    onSaveModelStl: (() -> Unit)? = null,
    /**
     * Load a file from disk into the bed. The host activity converts
     * the [WorkspaceAction.LoadMode] into its internal `PickerMode`
     * (Replace = drop existing, Add = append) and calls the same
     * `onFileSelected` codepath the file picker uses, so paint
     * restoration / GLB bake / bedFit / bedCollision run identically.
     */
    onLoadModelFromPath: ((java.io.File, WorkspaceAction.LoadMode) -> Unit)? = null,
    /** Mesh repair (`runRepair`). */
    onRepairModel: ((modelId: String) -> Unit)? = null,
    /** D17 — quadric edge collapse simplification (`runSimplify`). */
    onSimplifyModel: ((modelId: String, targetTriangleCount: Int, maxError: Float) -> Unit)? = null,
    /** Cut a model along a Z plane (`runCut` after selecting the model). */
    onCutModel: ((modelId: String, planeZmm: Float) -> Unit)? = null,
    /** Mesh boolean op (`runBoolean`). */
    onMeshBoolean: ((modelAId: String, modelBId: String, op: Int) -> Unit)? = null,
    /** Split into connected components (`runSplit`). */
    onSplitModel: ((modelId: String) -> Unit)? = null,
    /** Apply an embossed text or SVG to a model (`runEmboss`). */
    onEmbossModel: ((WorkspaceAction.EmbossModel) -> Unit)? = null,
    /** D15 — add standalone text/SVG as a fresh PlacedModel (`runAddTextOrSvgObject`). */
    onAddTextOrSvgObject: ((WorkspaceAction.AddTextOrSvgObject) -> Unit)? = null,
    /** Append a volume of `type` to a PlacedModel (PickerMode.AddVolume codepath). */
    onAddVolumeToModel: ((modelId: String, sourcePath: String, type: String) -> Unit)? = null,
    /** Drop a previously-attached volume from a PlacedModel. */
    onRemoveVolume: ((modelId: String, volumeId: String) -> Unit)? = null,
    /**
     * Paint-state edits — color / support / seam / fuzzy slot remap,
     * clear, undo, redo. Each sub-action passes through to a
     * MainActivity-side handler so the existing PaintHistory + paint-
     * cache persistence pipelines fire identically.
     */
    onClearPaint: ((modelId: String, kind: WorkspaceAction.PaintKind?) -> Unit)? = null,
    onReplacePaintTag: ((modelId: String, kind: WorkspaceAction.PaintKind, fromTag: Int, toTag: Int) -> Unit)? = null,
    onPaintPlaneSplit: ((WorkspaceAction.PaintPlaneSplit) -> Unit)? = null,
    onPaintUndo: ((modelId: String) -> Unit)? = null,
    onPaintRedo: ((modelId: String) -> Unit)? = null,
    /**
     * AI-paint pillar (C9 milestone 1) — apply a precomputed triangle
     * index set to a paint kind. The MainActivity-side handler walks
     * the merge mode (Replace / OnlyUnpainted / OnlyTagged) and routes
     * through `applyPaintMutation` so PaintHistory stays correct.
     */
    onPaintTriangleSet: ((WorkspaceAction.PaintTriangleSet) -> Unit)? = null,
    /** D18j — replace full paint state for `load_paint_recipe`. */
    onLoadPaintState: ((WorkspaceAction.LoadPaintState) -> Unit)? = null,
) {
    val workspace = remember { WorkspaceModel.get() }

    // Mark attached only while this composition is alive. A future MCP
    // tool can refuse early when the user backgrounded the app and the
    // shell tore down (placedModels would be stale).
    DisposableEffect(workspace) {
        workspace.setAttached(true)
        onDispose { workspace.setAttached(false) }
    }

    // ---- Publishers ----
    LaunchedEffect(placedModels) { workspace.publishPlacedModels(placedModels) }
    LaunchedEffect(selectedModelIds) { workspace.publishSelectedModelIds(selectedModelIds) }
    LaunchedEffect(gizmoTool) { workspace.publishGizmoTool(gizmoTool) }
    LaunchedEffect(paintBrush) { workspace.publishPaintBrush(paintBrush) }
    LaunchedEffect(workspaceMode) { workspace.publishWorkspaceMode(workspaceMode) }
    LaunchedEffect(activePlateId) { workspace.publishActivePlateId(activePlateId) }
    LaunchedEffect(selectedProfile) { workspace.publishSelectedProfile(selectedProfile) }
    LaunchedEffect(selectedPrinterId) { workspace.publishSelectedPrinterId(selectedPrinterId) }
    LaunchedEffect(layerHeightOverride) { workspace.publishLayerHeightOverride(layerHeightOverride) }
    LaunchedEffect(printSettingsOverrides) { workspace.publishPrintSettingsOverrides(printSettingsOverrides) }
    LaunchedEffect(sliceState) { workspace.publishSliceState(sliceState) }
    LaunchedEffect(maxLayer) { workspace.publishMaxLayer(maxLayer) }
    LaunchedEffect(bedFit) { workspace.publishBedFit(bedFit) }
    LaunchedEffect(bedCollision) { workspace.publishBedCollision(bedCollision) }
    LaunchedEffect(showTravels) { workspace.publishShowTravels(showTravels) }
    LaunchedEffect(toolpathTubes) { workspace.publishToolpathTubes(toolpathTubes) }
    LaunchedEffect(plateMovable) { workspace.publishPlateMovable(plateMovable) }
    LaunchedEffect(previewPalette) { workspace.publishPreviewPalette(previewPalette) }

    // ---- Action collector ----
    //
    // The collector lives inside `LaunchedEffect(workspace)` whose
    // coroutine survives recomposition. Without `rememberUpdatedState`
    // wrappers, every captured value (including the callbacks) would
    // freeze at the first composition's bindings, so an LLM action
    // arriving after the user changed something in the UI would dispatch
    // through stale lambdas. Each `Latest` state is .value-read inside
    // the collector so the most-recent reference is used.
    val placedModelsLatest = rememberUpdatedState(placedModels)
    val selectedIdsLatest = rememberUpdatedState(selectedModelIds)
    val paintBrushLatest = rememberUpdatedState(paintBrush)
    val allProfilesLatest = rememberUpdatedState(allProfiles)
    val setPlacedModelsLatest = rememberUpdatedState(setPlacedModels)
    val setSelectedModelIdsLatest = rememberUpdatedState(setSelectedModelIds)
    val setPaintBrushLatest = rememberUpdatedState(setPaintBrush)
    val setGizmoToolLatest = rememberUpdatedState(setGizmoTool)
    val setWorkspaceModeLatest = rememberUpdatedState(setWorkspaceMode)
    val setActivePlateIdLatest = rememberUpdatedState(setActivePlateId)
    val setSelectedProfileLatest = rememberUpdatedState(setSelectedProfile)
    val setSelectedPrinterIdLatest = rememberUpdatedState(setSelectedPrinterId)
    val setLayerHeightOverrideLatest = rememberUpdatedState(setLayerHeightOverride)
    val setMaxLayerLatest = rememberUpdatedState(setMaxLayer)
    val setShowTravelsLatest = rememberUpdatedState(setShowTravels)
    val setToolpathTubesLatest = rememberUpdatedState(setToolpathTubes)
    val setPlateMovableLatest = rememberUpdatedState(setPlateMovable)
    val onSliceLatest = rememberUpdatedState(onSliceActivePlate)
    val onArrangeLatest = rememberUpdatedState(onAutoArrangePlate)
    val onDropLatest = rememberUpdatedState(onDropToBed)
    val onSaveGcodeLatest = rememberUpdatedState(onSaveGcode)
    val onSave3mfLatest = rememberUpdatedState(onSaveProject3mf)
    val onSaveStlLatest = rememberUpdatedState(onSaveModelStl)
    val onLoadLatest = rememberUpdatedState(onLoadModelFromPath)
    val onRepairLatest = rememberUpdatedState(onRepairModel)
    val onSimplifyLatest = rememberUpdatedState(onSimplifyModel)
    val onCutLatest = rememberUpdatedState(onCutModel)
    val onBoolLatest = rememberUpdatedState(onMeshBoolean)
    val onSplitLatest = rememberUpdatedState(onSplitModel)
    val onEmbossLatest = rememberUpdatedState(onEmbossModel)
    val onAddTextOrSvgObjectLatest = rememberUpdatedState(onAddTextOrSvgObject)
    val onAddVolumeLatest = rememberUpdatedState(onAddVolumeToModel)
    val onRemoveVolumeLatest = rememberUpdatedState(onRemoveVolume)
    val onClearPaintLatest = rememberUpdatedState(onClearPaint)
    val onReplacePaintLatest = rememberUpdatedState(onReplacePaintTag)
    val onPaintPlaneSplitLatest = rememberUpdatedState(onPaintPlaneSplit)
    val onPaintUndoLatest = rememberUpdatedState(onPaintUndo)
    val onPaintRedoLatest = rememberUpdatedState(onPaintRedo)
    val onPaintTriangleSetLatest = rememberUpdatedState(onPaintTriangleSet)
    val onLoadPaintStateLatest = rememberUpdatedState(onLoadPaintState)

    LaunchedEffect(workspace) {
        // D18g — track per-action ids matching WorkspaceModel's
        // monotonic emit counter. SharedFlow delivery is FIFO so a
        // local counter that increments per delivered action stays
        // in sync with the model's emit ids. After dispatch, mark
        // drained so flush_actions can wake.
        var localId = 0L
        workspace.actions.collect { action ->
            localId++
            handleAction(
            action = action,
            placedModels = placedModelsLatest.value,
            setPlacedModels = setPlacedModelsLatest.value,
            selectedModelIds = selectedIdsLatest.value,
            setSelectedModelIds = setSelectedModelIdsLatest.value,
            paintBrush = paintBrushLatest.value,
            setPaintBrush = setPaintBrushLatest.value,
            allProfiles = allProfilesLatest.value,
            setGizmoTool = setGizmoToolLatest.value,
            setWorkspaceMode = setWorkspaceModeLatest.value,
            setActivePlateId = setActivePlateIdLatest.value,
            setSelectedProfile = setSelectedProfileLatest.value,
            setSelectedPrinterId = setSelectedPrinterIdLatest.value,
            setLayerHeightOverride = setLayerHeightOverrideLatest.value,
            setMaxLayer = setMaxLayerLatest.value,
            setShowTravels = setShowTravelsLatest.value,
            setToolpathTubes = setToolpathTubesLatest.value,
            onSliceActivePlate = onSliceLatest.value,
            onAutoArrangePlate = onArrangeLatest.value,
            onDropToBed = onDropLatest.value,
            onSaveGcode = onSaveGcodeLatest.value,
            onSaveProject3mf = onSave3mfLatest.value,
            onSaveModelStl = onSaveStlLatest.value,
            onLoadModelFromPath = onLoadLatest.value,
            setPlateMovable = setPlateMovableLatest.value,
            onRepairModel = onRepairLatest.value,
            onSimplifyModel = onSimplifyLatest.value,
            onCutModel = onCutLatest.value,
            onMeshBoolean = onBoolLatest.value,
            onSplitModel = onSplitLatest.value,
            onEmbossModel = onEmbossLatest.value,
            onAddTextOrSvgObject = onAddTextOrSvgObjectLatest.value,
            onAddVolumeToModel = onAddVolumeLatest.value,
            onRemoveVolume = onRemoveVolumeLatest.value,
            onClearPaint = onClearPaintLatest.value,
            onReplacePaintTag = onReplacePaintLatest.value,
            onPaintPlaneSplit = onPaintPlaneSplitLatest.value,
            onPaintUndo = onPaintUndoLatest.value,
            onPaintRedo = onPaintRedoLatest.value,
            onPaintTriangleSet = onPaintTriangleSetLatest.value,
            onLoadPaintState = onLoadPaintStateLatest.value,
            )
            workspace.markDrained(localId)
        }
    }
}

private fun handleAction(
    action: WorkspaceAction,
    placedModels: List<PlacedModel>,
    setPlacedModels: (List<PlacedModel>) -> Unit,
    selectedModelIds: Set<String>,
    setSelectedModelIds: (Set<String>) -> Unit,
    paintBrush: PaintBrush,
    setPaintBrush: (PaintBrush) -> Unit,
    allProfiles: List<SlicerProfile>,
    setGizmoTool: (GizmoTool) -> Unit,
    setWorkspaceMode: (WorkspaceMode) -> Unit,
    setActivePlateId: (Int) -> Unit,
    setSelectedProfile: (SlicerProfile) -> Unit,
    setSelectedPrinterId: (String?) -> Unit,
    setLayerHeightOverride: (String) -> Unit,
    setMaxLayer: (Int?) -> Unit,
    setShowTravels: (Boolean) -> Unit,
    setToolpathTubes: (Boolean) -> Unit,
    onSliceActivePlate: (() -> Unit)?,
    onAutoArrangePlate: (() -> Unit)?,
    onDropToBed: ((modelId: String) -> Unit)?,
    onSaveGcode: (() -> Unit)?,
    onSaveProject3mf: (() -> Unit)?,
    onSaveModelStl: (() -> Unit)?,
    onLoadModelFromPath: ((java.io.File, WorkspaceAction.LoadMode) -> Unit)?,
    setPlateMovable: (Boolean) -> Unit,
    onRepairModel: ((modelId: String) -> Unit)?,
    onSimplifyModel: ((modelId: String, targetTriangleCount: Int, maxError: Float) -> Unit)?,
    onCutModel: ((modelId: String, planeZmm: Float) -> Unit)?,
    onMeshBoolean: ((modelAId: String, modelBId: String, op: Int) -> Unit)?,
    onSplitModel: ((modelId: String) -> Unit)?,
    onEmbossModel: ((WorkspaceAction.EmbossModel) -> Unit)?,
    onAddTextOrSvgObject: ((WorkspaceAction.AddTextOrSvgObject) -> Unit)?,
    onAddVolumeToModel: ((modelId: String, sourcePath: String, type: String) -> Unit)?,
    onRemoveVolume: ((modelId: String, volumeId: String) -> Unit)?,
    onClearPaint: ((modelId: String, kind: WorkspaceAction.PaintKind?) -> Unit)?,
    onReplacePaintTag: ((modelId: String, kind: WorkspaceAction.PaintKind, fromTag: Int, toTag: Int) -> Unit)?,
    onPaintPlaneSplit: ((WorkspaceAction.PaintPlaneSplit) -> Unit)?,
    onPaintUndo: ((modelId: String) -> Unit)?,
    onPaintRedo: ((modelId: String) -> Unit)?,
    onPaintTriangleSet: ((WorkspaceAction.PaintTriangleSet) -> Unit)?,
    onLoadPaintState: ((WorkspaceAction.LoadPaintState) -> Unit)?,
) {
    when (action) {
        is WorkspaceAction.SetGizmoTool -> setGizmoTool(action.tool)
        is WorkspaceAction.SetWorkspaceMode -> setWorkspaceMode(action.mode)
        is WorkspaceAction.SetActivePlateId -> setActivePlateId(action.plateId)
        is WorkspaceAction.SetSelectedModels -> setSelectedModelIds(
            if (action.additive) selectedModelIds + action.ids else action.ids,
        )
        is WorkspaceAction.SetLayerHeightOverride -> setLayerHeightOverride(action.value)
        is WorkspaceAction.SetPaintMode -> setPaintBrush(paintBrush.copy(mode = action.mode))
        is WorkspaceAction.UpdatePaintBrush -> setPaintBrush(
            paintBrush.copy(
                mode = action.mode ?: paintBrush.mode,
                activeSlot = action.activeSlot ?: paintBrush.activeSlot,
                radiusMm = action.radiusMm ?: paintBrush.radiusMm,
                smartFill = action.smartFill ?: paintBrush.smartFill,
                smartFillAngleDeg = action.smartFillAngleDeg ?: paintBrush.smartFillAngleDeg,
            ),
        )
        is WorkspaceAction.SetMaxLayer -> setMaxLayer(action.layer)
        is WorkspaceAction.SwitchProfile -> {
            val match = allProfiles.firstOrNull { it.id == action.profileId }
            if (match != null) setSelectedProfile(match)
            else Log.w(TAG, "SwitchProfile: no profile id=${action.profileId}")
        }
        is WorkspaceAction.SetSelectedPrinter -> setSelectedPrinterId(action.printerId)
        is WorkspaceAction.SetShowTravels -> setShowTravels(action.value)
        is WorkspaceAction.SetToolpathTubes -> setToolpathTubes(action.value)
        is WorkspaceAction.TransformModel -> {
            val updated = placedModels.map { m ->
                if (m.id != action.modelId) m
                else m.copy(
                    translateXmm = action.translateXmm ?: m.translateXmm,
                    translateYmm = action.translateYmm ?: m.translateYmm,
                    translateZmm = action.translateZmm ?: m.translateZmm,
                    rotXDeg = action.rotXDeg ?: m.rotXDeg,
                    rotYDeg = action.rotYDeg ?: m.rotYDeg,
                    rotZDeg = action.rotZDeg ?: m.rotZDeg,
                    scaleXPct = action.scaleXPct ?: m.scaleXPct,
                    scaleYPct = action.scaleYPct ?: m.scaleYPct,
                    scaleZPct = action.scaleZPct ?: m.scaleZPct,
                    mirrorX = action.mirrorX ?: m.mirrorX,
                    mirrorY = action.mirrorY ?: m.mirrorY,
                    mirrorZ = action.mirrorZ ?: m.mirrorZ,
                )
            }
            setPlacedModels(updated)
        }
        is WorkspaceAction.DeleteModels -> {
            setPlacedModels(placedModels.filterNot { it.id in action.ids })
            setSelectedModelIds(selectedModelIds - action.ids)
        }
        // Tier-B actions route through callbacks the call site
        // wires to MainActivity's existing slice / save / arrange
        // pipelines. Each callback is null-safe so tests + early
        // bring-up don't NPE; the warning fires once per attempt
        // so an LLM client gets a clear "this build doesn't wire
        // it" signal in logcat.
        WorkspaceAction.SliceActivePlate -> {
            if (onSliceActivePlate != null) onSliceActivePlate()
            else Log.w(TAG, "SliceActivePlate not wired by the host activity.")
        }
        WorkspaceAction.AutoArrangePlate -> {
            if (onAutoArrangePlate != null) onAutoArrangePlate()
            else Log.w(TAG, "AutoArrangePlate not wired.")
        }
        is WorkspaceAction.DropToBed -> {
            if (onDropToBed != null) {
                onDropToBed(action.modelId)
            } else {
                // Fallback: do the drop ourselves (translateZmm = 0)
                // since it's a pure data-class change. The MainActivity
                // path is preferred because its updateSelected helper
                // also bumps preview state, but this keeps the action
                // useful even when no callback is wired.
                val updated = placedModels.map { m ->
                    if (m.id == action.modelId) m.copy(translateZmm = 0f) else m
                }
                setPlacedModels(updated)
            }
        }
        WorkspaceAction.SaveGcodeToDownloads -> {
            if (onSaveGcode != null) onSaveGcode()
            else Log.w(TAG, "SaveGcodeToDownloads not wired.")
        }
        WorkspaceAction.SaveProject3mf -> {
            if (onSaveProject3mf != null) onSaveProject3mf()
            else Log.w(TAG, "SaveProject3mf not wired.")
        }
        WorkspaceAction.SaveModelStl -> {
            if (onSaveModelStl != null) onSaveModelStl()
            else Log.w(TAG, "SaveModelStl not wired.")
        }
        WorkspaceAction.CancelSlice ->
            // libslic3r doesn't expose an abort hook through our JNI
            // shim today (no nativeCancelSlice). Surface the missing
            // capability so a tool caller knows to wait or kill the
            // app rather than retry.
            Log.w(TAG, "CancelSlice not supported — libslic3r doesn't expose an abort hook.")
        is WorkspaceAction.LoadModelFromPath -> {
            val file = java.io.File(action.path)
            if (!file.exists() || !file.canRead()) {
                Log.w(TAG, "LoadModelFromPath: '$action.path' is missing or unreadable.")
            } else if (onLoadModelFromPath != null) {
                onLoadModelFromPath(file, action.mode)
            } else {
                Log.w(TAG, "LoadModelFromPath: no callback wired by host activity.")
            }
        }
        is WorkspaceAction.SetPlateMovable -> setPlateMovable(action.movable)
        is WorkspaceAction.RepairModel -> {
            if (onRepairModel != null) onRepairModel(action.modelId)
            else Log.w(TAG, "RepairModel not wired by host activity.")
        }
        is WorkspaceAction.SimplifyModel -> {
            if (onSimplifyModel != null)
                onSimplifyModel(action.modelId, action.targetTriangleCount, action.maxError)
            else Log.w(TAG, "SimplifyModel not wired by host activity.")
        }
        is WorkspaceAction.CutModel -> {
            if (onCutModel != null) onCutModel(action.modelId, action.planeZmm)
            else Log.w(TAG, "CutModel not wired.")
        }
        is WorkspaceAction.MeshBoolean -> {
            if (onMeshBoolean != null) onMeshBoolean(action.modelAId, action.modelBId, action.op)
            else Log.w(TAG, "MeshBoolean not wired.")
        }
        is WorkspaceAction.SplitModel -> {
            if (onSplitModel != null) onSplitModel(action.modelId)
            else Log.w(TAG, "SplitModel not wired.")
        }
        is WorkspaceAction.EmbossModel -> {
            if (onEmbossModel != null) onEmbossModel(action)
            else Log.w(TAG, "EmbossModel not wired.")
        }
        is WorkspaceAction.AddTextOrSvgObject -> {
            if (onAddTextOrSvgObject != null) onAddTextOrSvgObject(action)
            else Log.w(TAG, "AddTextOrSvgObject not wired.")
        }
        is WorkspaceAction.AddVolumeToModel -> {
            if (onAddVolumeToModel != null) onAddVolumeToModel(action.modelId, action.sourcePath, action.type)
            else Log.w(TAG, "AddVolumeToModel not wired.")
        }
        is WorkspaceAction.RemoveVolume -> {
            if (onRemoveVolume != null) onRemoveVolume(action.modelId, action.volumeId)
            else Log.w(TAG, "RemoveVolume not wired.")
        }
        is WorkspaceAction.ClearPaint -> {
            if (onClearPaint != null) onClearPaint(action.modelId, action.kind)
            else Log.w(TAG, "ClearPaint not wired.")
        }
        is WorkspaceAction.ReplacePaintTag -> {
            if (onReplacePaintTag != null) onReplacePaintTag(action.modelId, action.kind, action.fromTag, action.toTag)
            else Log.w(TAG, "ReplacePaintTag not wired.")
        }
        is WorkspaceAction.PaintPlaneSplit -> {
            if (onPaintPlaneSplit != null) onPaintPlaneSplit(action)
            else Log.w(TAG, "PaintPlaneSplit not wired.")
        }
        is WorkspaceAction.PaintUndo -> {
            if (onPaintUndo != null) onPaintUndo(action.modelId)
            else Log.w(TAG, "PaintUndo not wired.")
        }
        is WorkspaceAction.PaintRedo -> {
            if (onPaintRedo != null) onPaintRedo(action.modelId)
            else Log.w(TAG, "PaintRedo not wired.")
        }
        is WorkspaceAction.PaintTriangleSet -> {
            if (onPaintTriangleSet != null) onPaintTriangleSet(action)
            else Log.w(TAG, "PaintTriangleSet not wired.")
        }
        is WorkspaceAction.LoadPaintState -> {
            if (onLoadPaintState != null) onLoadPaintState(action)
            else Log.w(TAG, "LoadPaintState not wired.")
        }
    }
}

private const val TAG = "OrcaXR/mcp/bind"
