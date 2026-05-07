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
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import java.io.File

@Composable
fun BindMobileWorkspaceModel(
    selectedProfile: SlicerProfile?,
    slicerFilePath: String?,
    onLoadModelFromPath: (String) -> Unit,
) {
    val workspace = remember { WorkspaceModel.get() }

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
