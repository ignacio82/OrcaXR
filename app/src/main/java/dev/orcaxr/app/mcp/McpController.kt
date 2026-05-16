package dev.orcaxr.app.mcp

import android.content.Context
import android.util.Log
import dev.orcaxr.app.mcp.tools.AiAdvancedPaintTools
import dev.orcaxr.app.mcp.tools.AiAnchorTools
import dev.orcaxr.app.mcp.tools.AiIntrospectionTools
import dev.orcaxr.app.mcp.tools.AiPaintTools
import dev.orcaxr.app.mcp.tools.AiSemanticPaintTools
import dev.orcaxr.app.mcp.tools.AiVisionTools
import dev.orcaxr.app.mcp.tools.AiVisionMaskTools
import dev.orcaxr.app.mcp.tools.AutoPaintLabelTool
import dev.orcaxr.app.mcp.tools.AutoPaintReferenceTool
import dev.orcaxr.app.mcp.tools.AutoPaintTool
import dev.orcaxr.app.mcp.tools.FindFeatureAnchorsTool
import dev.orcaxr.app.mcp.tools.PaintConstraintTools
import dev.orcaxr.app.mcp.tools.PaintDecalTool
import dev.orcaxr.app.mcp.tools.PaintRecipeTools
import dev.orcaxr.app.mcp.tools.PaintSessionTools
import dev.orcaxr.app.mcp.tools.PaintStrokeTool
import dev.orcaxr.app.mcp.tools.PaintTemplateTools
import dev.orcaxr.app.mcp.tools.FilamentTools
import dev.orcaxr.app.mcp.tools.HandyModelTools
import dev.orcaxr.app.mcp.tools.NativeBvhTools
import dev.orcaxr.app.mcp.tools.PrefsTools
import dev.orcaxr.app.mcp.tools.CalibrationTools
import dev.orcaxr.app.mcp.tools.SettingsBackupTools
import dev.orcaxr.app.mcp.tools.WipeTowerTools
import dev.orcaxr.app.mcp.tools.MagnetTools
import dev.orcaxr.app.mcp.tools.PrimitiveTools
import dev.orcaxr.app.mcp.tools.PrinterTools
import dev.orcaxr.app.mcp.tools.ProfileTools
import dev.orcaxr.app.mcp.tools.RecentTools
import dev.orcaxr.app.mcp.tools.RecipeRecommendTools
import dev.orcaxr.app.mcp.tools.RenderPaintSessionDiffTool
import dev.orcaxr.app.mcp.tools.ScorePaintAgainstReferenceTool
import dev.orcaxr.app.mcp.tools.SymmetryTools
import dev.orcaxr.app.mcp.tools.SystemTools
import dev.orcaxr.app.mcp.tools.WorkspaceTools
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * One-stop wrapper around [McpServer] + [McpSettings]. Lives in the
 * [Application] singleton so the server's lifetime tracks the process,
 * not any one Activity. The Devices panel UI only talks to this class
 * — flipping the toggle here resolves to a start/stop/rebind without
 * the panel having to own a Job.
 *
 * Threading: all suspending work runs on a dedicated SupervisorJob +
 * Dispatchers.IO. The controller never blocks the UI thread.
 */
class McpController private constructor(
    private val appContext: Context,
    private val settings: McpSettings,
) {

    private val tag: String = "OrcaXR/mcp/ctl"
    private val scope: CoroutineScope =
        CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var watcher: Job? = null
    private var server: McpServer? = null

    /**
     * True while [server] holds an open socket. Driven by
     * [startServerSnapshot] / [stopServer] so the value flips exactly
     * when the listener becomes / stops being reachable. The mobile
     * shell observes this to decide whether to keep the screen on
     * (FLAG_KEEP_SCREEN_ON), the foreground service observes it to
     * refresh its persistent notification, and PiP entry is gated on
     * it so we don't shrink the workspace into a thumbnail when the
     * user wasn't even using MCP.
     */
    private val _serverRunning = MutableStateFlow(false)
    val serverRunning: StateFlow<Boolean> = _serverRunning.asStateFlow()

    val toolContext: ToolContext by lazy { ToolContext(appContext) }

    /**
     * Begin watching settings. The first emission triggers a
     * start/stop/rebind matching the persisted state, so calling this
     * once during Application.onCreate is enough — the controller
     * keeps the server in sync with the user's toggle.
     *
     * Idempotent: subsequent calls are no-ops.
     */
    fun start() {
        if (watcher != null) return
        watcher = scope.launch {
            settings.enabled.combine(settings.port) { e, p -> e to p }
                .distinctUntilChanged()
                .collect { (enabled, port) ->
                    if (enabled) {
                        // Hand off to the foreground service so the
                        // OS doesn't reap the socket once OrcaXR is
                        // backgrounded (headset removed). The service
                        // re-enters this controller via
                        // onForegroundServiceStarted() to actually bind.
                        // Port lives in DataStore; the service reads
                        // the latest snapshot so we don't pass it here.
                        @Suppress("UNUSED_VARIABLE") val unusedPort = port
                        McpForegroundService.start(appContext)
                    } else {
                        // stopService → service.onDestroy →
                        // onForegroundServiceStopped() → socket close.
                        McpForegroundService.stop(appContext)
                    }
                }
        }
    }

    fun shutdown() {
        watcher?.cancel()
        watcher = null
        // Best-effort: ask the service to stop too. If the process is
        // already going away the OS will tear it down regardless.
        McpForegroundService.stop(appContext)
        stopServer()
        scope.cancel("McpController.shutdown")
    }

    /** True if the underlying socket is open. */
    fun isRunning(): Boolean = server?.isRunning() == true

    /** Bound port, or 0 when stopped. Useful for the settings panel. */
    fun boundPort(): Int = server?.boundPort ?: 0

    /**
     * Force a settings re-read + rebind. Used by the UI after the
     * user changes the port or rotates the API key — the watcher
     * already debounces on enabled+port, but the API key isn't part
     * of the watcher key (rotating it shouldn't cause a flap if the
     * server's already up with a different one in memory). Calling
     * this rebuilds the server with the latest snapshot.
     */
    suspend fun refresh() {
        val snap = settings.snapshot()
        if (snap.enabled) {
            // Cycle the foreground service so onForegroundServiceStarted
            // re-reads the snapshot and rebinds with the new key/port.
            stopServer()
            McpForegroundService.stop(appContext)
            McpForegroundService.start(appContext)
        } else {
            McpForegroundService.stop(appContext)
            stopServer()
        }
    }

    /**
     * Called by [McpForegroundService.onStartCommand] once the
     * foreground notification is up. Reads the current settings
     * snapshot and binds the socket. Splits the work: the watcher
     * decides "should the service be running?", the service decides
     * "I'm running, please bind."
     */
    internal fun onForegroundServiceStarted() {
        scope.launch {
            val snap = settings.snapshot()
            if (snap.enabled) startServerSnapshot(snap)
        }
    }

    /** Called by the foreground service on its way down. */
    internal fun onForegroundServiceStopped() {
        stopServer()
    }

    private fun startServerSnapshot(snap: McpSettings.Snapshot) {
        stopServer()
        val token = snap.apiKey?.takeIf { it.isNotBlank() }
        val s = McpServer.Builder()
            .authToken(token)
            .serverName(McpServer.DEFAULT_NAME)
            .serverVersion(McpServer.DEFAULT_VERSION)
            .also { b -> registerAllTools(b, toolContext, settings) }
            .build()
        server = s
        try {
            val bound = s.start(snap.port)
            _serverRunning.value = true
            Log.i(tag, "Server up on $bound (auth=${if (token != null) "on" else "off"})")
        } catch (e: IOException) {
            Log.e(tag, "Failed to bind on ${snap.port}: ${e.message}")
            server = null
            _serverRunning.value = false
        }
    }

    private fun stopServer() {
        server?.stop()
        server = null
        _serverRunning.value = false
    }

    companion object {
        @Volatile private var instance: McpController? = null

        /** Lazy-singleton getter. Pass an Application Context. */
        fun get(ctx: Context): McpController {
            instance?.let { return it }
            return synchronized(this) {
                instance ?: McpController(
                    appContext = ctx.applicationContext,
                    settings = McpSettings(ctx.applicationContext),
                ).also { instance = it }
            }
        }

        /**
         * D21a — read the bound port without a Context. Returns 0 when
         * the controller hasn't started yet (Application.onCreate
         * hasn't run; tests). AiVisionTools reads this to assemble an
         * absolute http://… URL for rendered PNGs so the driving LLM
         * can WebFetch them — the inline base64 image content path
         * sometimes drops in the Claude Code MCP transport, but a
         * plain http URL always works.
         */
        fun boundPortStatic(): Int = instance?.server?.boundPort ?: 0

        /**
         * Build a configured [McpServer.Builder] with all known tools
         * registered. Tests reuse this so the unit harness sees the
         * exact same surface the production server exposes.
         */
        internal fun registerAllTools(
            builder: McpServer.Builder,
            ctx: ToolContext,
            settings: McpSettings,
        ) {
            for (t in SystemTools.all(ctx)) builder.tool(t)
            for (t in PrinterTools.all(ctx)) builder.tool(t)
            for (t in ProfileTools.all(ctx)) builder.tool(t)
            for (t in FilamentTools.all(ctx)) builder.tool(t)
            for (t in RecentTools.all(ctx)) builder.tool(t)
            for (t in PrefsTools.all(ctx)) builder.tool(t)
            // Roadmap B13 — settings backup / restore as JSON.
            for (t in SettingsBackupTools.all(ctx)) builder.tool(t)
            // Roadmap A13 — auto-position wipe tower over the active plate.
            for (t in WipeTowerTools.all(WorkspaceModel.get(), ctx)) builder.tool(t)
            // Roadmap B12 — generate per-Z calibration ramps as
            // batches of A11 custom-gcode ticks.
            for (t in CalibrationTools.all(WorkspaceModel.get())) builder.tool(t)
            for (t in WorkspaceTools.all(ctx)) builder.tool(t)
            // D12 — primitive shape authoring (cube / cylinder / sphere / …).
            for (t in PrimitiveTools.all(ctx)) builder.tool(t)
            for (t in MagnetTools.all(ctx)) builder.tool(t)
            // D13 — handy model library (Benchy / Orca Cube / …).
            for (t in HandyModelTools.all(ctx)) builder.tool(t)
            // C9 milestone 1 — AI-driven spatial paint primitives.
            val aiPaintTools = AiPaintTools.all(WorkspaceModel.get())
            for (t in aiPaintTools) builder.tool(t)
            // M6 — procedural paint (gradient / value-noise) + 2D-bbox
            // frustum selection. Reuses AiPaintTools' internal preflight
            // and emit plumbing so paint history / sessions / merge
            // semantics behave identically to the existing primitives.
            for (t in AiAdvancedPaintTools.all(WorkspaceModel.get())) builder.tool(t)
            // C9 milestone 4 — headless paint sessions. Lets an LLM
            // iterate paint+render without each refinement triggering a
            // colored-GLB rebake / scene-entity swap. Commit emits one
            // LoadPaintState ⇒ one applyPaintMutation ⇒ one undo step.
            for (t in PaintSessionTools.all(WorkspaceModel.get())) builder.tool(t)
            // M7 — declarative paint constraints. Validated at
            // commit_paint_session; on violation the commit is
            // rejected and the live model is left untouched. Pass
            // force=true to commit anyway.
            for (t in PaintConstraintTools.all(WorkspaceModel.get())) builder.tool(t)
            // M8b — native BVH ray-mask projection (opt-in). The
            // Kotlin path is canonical; flip with set_native_bvh_enabled
            // after benchmark_native_bvh confirms parity + speedup
            // on this device.
            for (t in NativeBvhTools.all(WorkspaceModel.get())) builder.tool(t)
            // C9 milestone 3 — geometry / topology introspection.
            for (t in AiIntrospectionTools.all(WorkspaceModel.get())) builder.tool(t)
            // Anchor + seed + coverage tools — turn spatial reasoning
            // into name-picking for small on-device LLMs that can't pick
            // a triangle id off a render.
            for (t in AiAnchorTools.all(WorkspaceModel.get())) builder.tool(t)
            // C9 milestone 2 — vision pillar (software rasterizer).
            for (t in AiVisionTools.all(WorkspaceModel.get(), AiSessionState.get())) builder.tool(t)
            // D18j — persistent paint recipes.
            for (t in PaintRecipeTools.all(WorkspaceModel.get(), ctx)) builder.tool(t)
            // D18i — bundled paint templates that dispatch to the
            // AI paint primitives. Pass the registered paint tools
            // so paint_template can dispatch by name.
            for (t in PaintTemplateTools.all(WorkspaceModel.get(), ctx, aiPaintTools)) builder.tool(t)
            // D18c — vision LLM feature anchors. Requires an
            // Anthropic key from EITHER McpSettings (legacy) or the
            // user's in-app LlmSettings card. The LlmSettings flow
            // unifies both stores so a key entered in either UI works.
            val claudeKeyFlow = dev.orcaxr.app.llm.LlmSettings
                .get(ctx.appContext).unifiedClaudeKey
            builder.tool(FindFeatureAnchorsTool(WorkspaceModel.get(), AiSessionState.get(), claudeKeyFlow))
            // D19c — decal / texture projection (single undo step
            // via LoadPaintState). No outbound deps.
            builder.tool(PaintDecalTool(WorkspaceModel.get(), AiSessionState.get()))
            // D20 M1 — Smart Auto-Paint: whole-model geometric paint in
            // one undo step. Physical-only; no image/vision deps.
            builder.tool(AutoPaintTool(WorkspaceModel.get(), AiSessionState.get()))
            // D19a + D19d — vision-LLM driven 2D mask authoring.
            // Both share the FindFeatureAnchorsTool's API-key flow.
            builder.tool(AiVisionMaskTools.GenerateMaskFromPoint(
                WorkspaceModel.get(), AiSessionState.get(), claudeKeyFlow,
            ))
            builder.tool(AiVisionMaskTools.GetMaskForText(
                WorkspaceModel.get(), AiSessionState.get(), claudeKeyFlow,
            ))
            // D22 — LLM-painting amplifiers. Eight tools that close the
            // gap between "the LLM has tools" and "the LLM can drive
            // a Pikachu-class paint to convergence in one prompt":
            //   - paint_semantic_region / prime_region_cache: paint by
            //     segmentation region id rather than triangle list.
            //   - paint_stroke: polyline brush over the surface.
            //   - detect_symmetry + paint_with_mirror axis="auto":
            //     auto-detect bilateral symmetry.
            //   - render_paint_session_diff: before/after/delta in one PNG.
            //   - find_similar_recipe + suggest_palette_for_recipe:
            //     fingerprint-rank + palette auto-remap.
            //   - score_paint_against_reference: vision-LLM grader loop.
            for (t in AiSemanticPaintTools.all(WorkspaceModel.get(), aiPaintTools)) builder.tool(t)
            builder.tool(PaintStrokeTool(WorkspaceModel.get(), aiPaintTools))
            for (t in SymmetryTools.all(WorkspaceModel.get())) builder.tool(t)
            builder.tool(RenderPaintSessionDiffTool(WorkspaceModel.get(), AiSessionState.get()))
            for (t in RecipeRecommendTools.all(WorkspaceModel.get(), ctx)) builder.tool(t)
            builder.tool(ScorePaintAgainstReferenceTool(
                WorkspaceModel.get(), AiSessionState.get(), claudeKeyFlow,
            ))
            // D20 M4 — Smart Auto-Paint semantic transfer: paint the
            // whole model to resemble a reference image via a vision
            // plan + automated grade/refine loop. One undo step.
            builder.tool(AutoPaintReferenceTool(
                WorkspaceModel.get(), AiSessionState.get(), claudeKeyFlow,
            ))
            // Borrowed ideas #2/#3 — deterministic-segmentation + AI
            // naming/recolour (no spatial grounding), multi-provider.
            builder.tool(AutoPaintLabelTool(
                WorkspaceModel.get(), AiSessionState.get(), claudeKeyFlow,
            ))
        }
    }

    /** Expose settings for the UI panel. */
    fun settings(): McpSettings = settings
}
