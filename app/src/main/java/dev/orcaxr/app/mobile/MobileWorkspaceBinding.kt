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
 *
 * Not wired yet (and any tool that needs them will fail-fast via
 * `requireCapability` until they are):
 *   - Multi-model arrange / select / paint / cut / boolean / split
 *   - Slice / save flows (slicing is invoked from the SlicerScreen
 *     button; the MCP slice tool would need a separate hook into
 *     SlicerScreen's runSlice that survives the assistant takeover)
 */
package dev.orcaxr.app.mobile

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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

    LaunchedEffect(selectedProfile) { workspace.publishSelectedProfile(selectedProfile) }

    // Synthesize a single-element PlacedModel list from the loaded
    // file so MCP tools that read `list_placed_models` /
    // `get_workspace_state` see *something* meaningful on mobile.
    LaunchedEffect(slicerFilePath) {
        val list =
            if (slicerFilePath.isNullOrBlank()) emptyList()
            else {
                val file = File(slicerFilePath)
                listOf(
                    PlacedModel(
                        id = "mobile_loaded",
                        source = file,
                        label = file.nameWithoutExtension,
                        plateId = 1,
                    )
                )
            }
        workspace.publishPlacedModels(list)
    }

    // Publish wired Tier-B capabilities. Only LoadModelFromPath for
    // now — the others stay null on mobile so their MCP tools fail
    // -fast with a useful error instead of dispatching an action that
    // drops silently.
    LaunchedEffect(Unit) {
        workspace.publishWiredTierBCapabilities(setOf(TierBCapability.LoadModelFromPath))
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
        workspace.actions.collect { action ->
            when (action) {
                is WorkspaceAction.LoadModelFromPath ->
                    onLoadLatest.value.invoke(action.path)
                else -> {
                    // Other actions either (a) have a Compose-state
                    // fallback the mobile shell doesn't replicate yet,
                    // or (b) require capabilities not in the mobile
                    // wiredTierBCapabilities set. The tool that emitted
                    // them already returned isError to the LLM via
                    // requireCapability, so there's no further work to
                    // do here. Silent drop is correct.
                }
            }
        }
    }
}

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
