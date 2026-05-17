/*
 * Mobile-specific WorkspaceModel wiring. The XR shell calls
 * [dev.orcaxr.app.mcp.BindWorkspaceModel] from XrShell with 30+ state
 * fields the mobile shell has no equivalent for (placedModels list,
 * gizmoTool, paintBrush, plate movability, slice progress, …). Rather
 * than fake all of those values from a single-model mobile context,
 * this slim binding publishes only what the mobile shell actually has
 * AND marks the workspace as attached so MCP tools' `requireAttached`
 * gate passes.
 *
 * Currently wires:
 *   - `attached` true while the binding is composed
 *   - `selectedProfile` from the active mobile profile pick
 *   - `placedModels` synthesized from the single `slicerFilePath`
 *     (empty list when no model is loaded; one PlacedModel when loaded)
 *   - `TierBCapability.LoadModelFromPath` so an LLM agent can drive
 *     the assistant via `load_model_from_path`
 *   - the four paint actions, AND (re-arch increment 1) the plain
 *     capability-free per-model data mutators `SetHeightRanges` /
 *     `SetObjectOverrides` / `SetVolumeOverrides` /
 *     `SetLayerHeightProfile` — applied to [MobileModelState] and
 *     carried onto the published `mobile_loaded` PlacedModel
 *
 * Not wired yet (and any tool that needs them will fail-fast via
 * `requireCapability` or hit the `else` drop until they are):
 *   - Multi-model arrange / select / cut / boolean / split / simplify
 *     / emboss / magnets (geometry ops — need a JNI run + source-file
 *     replace; subsequent re-arch increment)
 *   - Tier-B compute-adaptive / custom-gcode-tick mutators
 *   - Slice-path consumption of the accumulated state (the SlicerScreen
 *     slice call must read heightRanges / configOverrides /
 *     layerHeightProfile off the model; next increment)
 *   - Slice / save flows from the assistant takeover
 */
package dev.orcaxr.app.mobile

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.MeshBvhCache
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.SlicerEngine
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.StlReader
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun BindMobileWorkspaceModel(
    selectedProfile: SlicerProfile?,
    slicerFilePath: String?,
    onLoadModelFromPath: (String) -> Unit,
) {
    val workspace = remember { WorkspaceModel.get() }
    val ctx = LocalContext.current
    val bvhCache = remember { MeshBvhCache() }

    // Per-model state, keyed by modelId — paint arrays PLUS the
    // non-geometry mutables (height ranges, object/volume overrides,
    // layer-height profile) the binding now applies instead of
    // dropping. Lives across recompositions so a sequence of MCP
    // mutators accumulates. Per-process — not persisted (saved-recipe
    // / 3MF export are the explicit persistence paths).
    val stateByModel = remember { mutableStateMapOf<String, MobileModelState>() }

    // Register a BvhProvider so AI / vision MCP tools (get_model_geometry,
    // render_montage, paint_*) can resolve "mobile_loaded" back to a
    // built BVH on demand. Same shape as the XR shell's provider in
    // MainActivity:
    //   1. Look up the PlacedModel by id in workspace.placedModels.
    //   2. Probe-read the source as binary STL; on failure, convert
    //      via libslic3r (handles 3MF / OBJ / AMF / STEP / ASCII STL).
    //   3. Center on XY, drop to Z=0, build the BVH on Dispatchers.
    //      Default, cache by modelId. Subsequent calls hit the cache.
    // Without this provider, every mesh-aware tool returned "model
    // BVH isn't built yet" because nothing on mobile was building it.
    DisposableEffect(workspace) {
        workspace.setBvhProvider(
            WorkspaceModel.BvhProvider { modelId ->
                bvhCache.get(modelId)?.let { return@BvhProvider it }
                val model =
                    workspace.placedModels.value.firstOrNull { it.id == modelId }
                        ?: return@BvhProvider null
                val resolved = deriveStl(ctx, model.source) ?: return@BvhProvider null
                withContext(Dispatchers.Default) {
                    val mesh =
                        runCatching { StlReader.read(resolved) }.getOrNull()
                            ?: return@withContext null
                    val shiftX = -(mesh.bboxMin.x + mesh.bboxMax.x) / 2f
                    val shiftY = -(mesh.bboxMin.y + mesh.bboxMax.y) / 2f
                    val shiftZ = -mesh.bboxMin.z
                    val centered = mesh.translatedXyz(shiftX, shiftY, shiftZ)
                    val bvh =
                        runCatching { MeshBvh.build(centered) }.getOrNull()
                            ?: return@withContext null
                    bvhCache.put(modelId, bvh)
                    bvh
                }
            }
        )
        onDispose { workspace.setBvhProvider(null) }
    }

    // Mark the workspace attached for the lifetime of this composition
    // so MCP tools' `requireAttached` gate passes. Cleared on dispose
    // (assistant closed / app backgrounded) so a tool that arrives
    // after teardown gets a clear "not attached" error instead of
    // silently dropping.
    DisposableEffect(workspace) {
        workspace.setAttached(true)
        onDispose { workspace.setAttached(false) }
    }

    // Resolve the active palette so AI tools rendering headless PNGs can
    // see the correct colors instead of defaulting to gray/white.
    val prefs = remember { dev.orcaxr.app.UserPreferences(ctx) }
    val filamentEntriesStore = remember { dev.orcaxr.app.FilamentEntriesStore(ctx) }
    val allEntries by filamentEntriesStore.all.collectAsState(initial = emptyMap())
    val previewPalette = remember(allEntries, prefs.lastPrinterId) {
        val printerId = prefs.lastPrinterId
        val printerEntries = allEntries[printerId] ?: emptyList()
        val arr = arrayOfNulls<String>(4)
        for (e in printerEntries) {
            val s = e.slotIndex ?: continue
            if (s in 0 until 4) arr[s] = e.color
        }
        arr.map { it ?: "#FFFFFF" }
    }
    LaunchedEffect(previewPalette) { workspace.publishPreviewPalette(previewPalette) }
    // Publish the active printer id so MCP tools that key per-printer
    // state work on the phone path too — notably Smart Paint's
    // FullSpectrum mode, which materializes virtual mixed-filament rows
    // for this printer (without it FS degrades to physical-only).
    LaunchedEffect(prefs.lastPrinterId) {
        workspace.publishSelectedPrinterId(prefs.lastPrinterId?.takeIf { it.isNotBlank() })
    }

    LaunchedEffect(selectedProfile) { workspace.publishSelectedProfile(selectedProfile) }

    // Re-publish the placed-model list whenever EITHER the file path
    // OR a paint buffer for the current model changed. The two
    // dependencies share one effect because the list build needs both:
    // an incoming `LoadPaintState` mutates `paintByModel` and we have
    // to re-emit a new PlacedModel carrying those byte arrays so
    // `list_placed_models` / `get_paint_summary` reflect the commit.
    LaunchedEffect(slicerFilePath, stateByModel.toMap()) {
        val list =
            if (slicerFilePath.isNullOrBlank()) emptyList()
            else {
                val file = File(slicerFilePath)
                val st = stateByModel["mobile_loaded"]
                listOf(
                    PlacedModel(
                        id = "mobile_loaded",
                        source = file,
                        label = file.nameWithoutExtension,
                        plateId = 1,
                        paintFilamentIndex = st?.paint?.color,
                        supportFlags = st?.paint?.support,
                        seamFlags = st?.paint?.seam,
                        fuzzySkinFlags = st?.paint?.fuzzy,
                        configOverrides = st?.configOverrides ?: emptyMap(),
                        layerHeightProfile = st?.layerHeightProfile,
                        heightRanges = st?.heightRanges ?: emptyList(),
                    )
                )
            }
        workspace.publishPlacedModels(list)
    }

    // Publish wired Tier-B capabilities. Mobile wires the load-model
    // path AND the four paint-actions (LoadPaintState +
    // PaintTriangleSet + ClearPaint) — the action collector below
    // applies them to `paintByModel`. A capability NOT in this set
    // means the matching MCP tool fails fast via requireCapability
    // (see commit_paint_session, paint_sphere, etc).
    LaunchedEffect(Unit) {
        workspace.publishWiredTierBCapabilities(
            setOf(
                TierBCapability.LoadModelFromPath,
                TierBCapability.LoadPaintState,
                TierBCapability.PaintTriangleSet,
                TierBCapability.ClearPaint,
            ),
        )
    }

    // Whenever the slicer-loaded file changes, drop any prior BVHs
    // from the cache so the next BvhProvider call rebuilds against
    // the new source. Without this, switching between models would
    // hand the AI tools the cached BVH from the previous file.
    LaunchedEffect(slicerFilePath) {
        bvhCache.clear()
    }

    // Action collector. Same stale-closure pattern as the XR
    // BindWorkspaceModel: every callback / setter goes through
    // rememberUpdatedState before being read inside the long-lived
    // collector, so the collector always sees the most recent
    // composition's state. Without this the assistant calling
    // load_model_from_path after the user changed slicerFilePath
    // would route through a frozen old setter.
    val onLoadLatest = rememberUpdatedState(onLoadModelFromPath)
    LaunchedEffect(workspace) {
        // Same emit-id sync-by-FIFO trick the XR binding uses — the
        // SharedFlow delivers in order, a local counter mirrors the
        // model's monotonic emit ids, and we mark drained AFTER the
        // dispatch so `flush_actions` waiters wake up exactly when
        // the action's effect has landed in published state.
        var localId = 0L
        workspace.actions.collect { action ->
            localId++
            when (action) {
                is WorkspaceAction.LoadModelFromPath -> {
                    onLoadLatest.value.invoke(action.path)
                }
                is WorkspaceAction.LoadPaintState -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    stateByModel[action.modelId] =
                        st.copy(paint = st.paint.applyLoadPaintState(action))
                }
                is WorkspaceAction.PaintTriangleSet -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    val triCount = workspace.getBvh(action.modelId)?.triCount
                        ?: st.paint.let { s ->
                            s.color?.size ?: s.support?.size ?: s.seam?.size ?: s.fuzzy?.size
                        }
                        ?: ((action.triangleIndices.maxOrNull() ?: -1) + 1)
                    stateByModel[action.modelId] =
                        st.copy(paint = st.paint.applyTriangleSet(action, triCount))
                }
                is WorkspaceAction.ClearPaint -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    stateByModel[action.modelId] =
                        st.copy(paint = st.paint.applyClearPaint(action))
                }
                // Plain (capability-free) per-model data mutators the
                // binding used to drop. They take effect on phone now
                // and round-trip through the published PlacedModel so
                // get_object_overrides / list_height_ranges /
                // get_layer_height_profile read back correctly.
                is WorkspaceAction.SetHeightRanges -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    stateByModel[action.modelId] = st.applySetHeightRanges(action)
                }
                is WorkspaceAction.SetObjectOverrides -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    stateByModel[action.modelId] = st.applySetObjectOverrides(action)
                }
                is WorkspaceAction.SetVolumeOverrides -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    stateByModel[action.modelId] = st.applySetVolumeOverrides(action)
                }
                is WorkspaceAction.SetLayerHeightProfile -> {
                    val st = stateByModel[action.modelId] ?: MobileModelState()
                    stateByModel[action.modelId] = st.applySetLayerHeightProfile(action)
                }
                else -> {
                    // Action types whose Tier-B capability isn't in the
                    // wired set above. The MCP tool that emitted should
                    // have refused via requireCapability — log loudly
                    // here so any tool that slipped through the gate is
                    // visible in `adb logcat`. We still markDrained
                    // below so flush_actions doesn't wedge.
                    Log.w(
                        TAG,
                        "MobileWorkspaceBinding dropping unwired action " +
                            "${action::class.simpleName} (id=$localId). The matching tool " +
                            "should have refused via requireCapability — file a bug.",
                    )
                }
            }
            workspace.markDrained(localId)
        }
    }
}

private const val TAG = "OrcaXR/mobile/wsb"

/**
 * Probe-read [file] as binary STL; if that fails or the file is a
 * non-STL container (3MF / OBJ / AMF / STEP), convert via libslic3r
 * to `cacheDir/<base>_derived.stl`. Same contract as MainActivity's
 * `deriveStlFor`, copied here because that one's a method on the XR
 * activity and pulls in `ctx` from a different scope. Returns null
 * on any failure so the caller can short-circuit cleanly.
 */
private suspend fun deriveStl(
    ctx: android.content.Context,
    source: File,
): File? {
    if (source.extension.equals("stl", ignoreCase = true)) {
        if (runCatching { StlReader.read(source) }.isSuccess) return source
    }
    val derived = File(ctx.cacheDir, "${source.nameWithoutExtension}_derived.stl")
    val ok = runCatching { SlicerEngine.convertToStl(source, derived) }.getOrDefault(false)
    return if (ok && derived.exists() && derived.length() > 0) derived else null
}
