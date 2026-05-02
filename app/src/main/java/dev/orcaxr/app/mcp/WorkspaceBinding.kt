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

    // ---- Action collector ----
    val placedModelsLatest = rememberUpdatedState(placedModels)
    val selectedIdsLatest = rememberUpdatedState(selectedModelIds)
    val paintBrushLatest = rememberUpdatedState(paintBrush)
    val allProfilesLatest = rememberUpdatedState(allProfiles)

    LaunchedEffect(workspace) {
        workspace.actions.collect { action -> handleAction(
            action = action,
            placedModels = placedModelsLatest.value,
            setPlacedModels = setPlacedModels,
            selectedModelIds = selectedIdsLatest.value,
            setSelectedModelIds = setSelectedModelIds,
            paintBrush = paintBrushLatest.value,
            setPaintBrush = setPaintBrush,
            allProfiles = allProfilesLatest.value,
            setGizmoTool = setGizmoTool,
            setWorkspaceMode = setWorkspaceMode,
            setActivePlateId = setActivePlateId,
            setSelectedProfile = setSelectedProfile,
            setSelectedPrinterId = setSelectedPrinterId,
            setLayerHeightOverride = setLayerHeightOverride,
            setMaxLayer = setMaxLayer,
            setShowTravels = setShowTravels,
            setToolpathTubes = setToolpathTubes,
            onSliceActivePlate = onSliceActivePlate,
            onAutoArrangePlate = onAutoArrangePlate,
            onDropToBed = onDropToBed,
            onSaveGcode = onSaveGcode,
            onSaveProject3mf = onSaveProject3mf,
            onSaveModelStl = onSaveModelStl,
            onLoadModelFromPath = onLoadModelFromPath,
            setPlateMovable = setPlateMovable,
        ) }
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
    }
}

private const val TAG = "OrcaXR/mcp/bind"
