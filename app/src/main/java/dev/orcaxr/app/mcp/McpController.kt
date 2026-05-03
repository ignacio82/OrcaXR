package dev.orcaxr.app.mcp

import android.content.Context
import android.util.Log
import dev.orcaxr.app.mcp.tools.AiIntrospectionTools
import dev.orcaxr.app.mcp.tools.AiPaintTools
import dev.orcaxr.app.mcp.tools.AiVisionTools
import dev.orcaxr.app.mcp.tools.FindFeatureAnchorsTool
import dev.orcaxr.app.mcp.tools.PaintRecipeTools
import dev.orcaxr.app.mcp.tools.PaintTemplateTools
import dev.orcaxr.app.mcp.tools.FilamentTools
import dev.orcaxr.app.mcp.tools.HandyModelTools
import dev.orcaxr.app.mcp.tools.PrefsTools
import dev.orcaxr.app.mcp.tools.PrimitiveTools
import dev.orcaxr.app.mcp.tools.PrinterTools
import dev.orcaxr.app.mcp.tools.ProfileTools
import dev.orcaxr.app.mcp.tools.RecentTools
import dev.orcaxr.app.mcp.tools.SystemTools
import dev.orcaxr.app.mcp.tools.WorkspaceTools
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
                    if (enabled) startServer(port) else stopServer()
                }
        }
    }

    fun shutdown() {
        watcher?.cancel()
        watcher = null
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
        if (snap.enabled) startServerSnapshot(snap) else stopServer()
    }

    private suspend fun startServer(port: Int) {
        val snap = settings.snapshot()
        if (!snap.enabled) return
        // Force the snapshot's port to the watcher's current value so
        // we don't race the DataStore reader.
        startServerSnapshot(snap.copy(port = port))
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
            Log.i(tag, "Server up on $bound (auth=${if (token != null) "on" else "off"})")
        } catch (e: IOException) {
            Log.e(tag, "Failed to bind on ${snap.port}: ${e.message}")
            server = null
        }
    }

    private fun stopServer() {
        server?.stop()
        server = null
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
            for (t in WorkspaceTools.all(ctx)) builder.tool(t)
            // D12 — primitive shape authoring (cube / cylinder / sphere / …).
            for (t in PrimitiveTools.all(ctx)) builder.tool(t)
            // D13 — handy model library (Benchy / Orca Cube / …).
            for (t in HandyModelTools.all(ctx)) builder.tool(t)
            // C9 milestone 1 — AI-driven spatial paint primitives.
            val aiPaintTools = AiPaintTools.all(WorkspaceModel.get())
            for (t in aiPaintTools) builder.tool(t)
            // C9 milestone 3 — geometry / topology introspection.
            for (t in AiIntrospectionTools.all(WorkspaceModel.get())) builder.tool(t)
            // C9 milestone 2 — vision pillar (software rasterizer).
            for (t in AiVisionTools.all(WorkspaceModel.get(), AiSessionState.get())) builder.tool(t)
            // D18j — persistent paint recipes.
            for (t in PaintRecipeTools.all(WorkspaceModel.get(), ctx)) builder.tool(t)
            // D18i — bundled paint templates that dispatch to the
            // AI paint primitives. Pass the registered paint tools
            // so paint_template can dispatch by name.
            for (t in PaintTemplateTools.all(WorkspaceModel.get(), ctx, aiPaintTools)) builder.tool(t)
            // D18c — vision LLM feature anchors. Requires an
            // Anthropic API key set via McpSettings.
            builder.tool(FindFeatureAnchorsTool(WorkspaceModel.get(), AiSessionState.get(), settings.anthropicApiKey))
        }
    }

    /** Expose settings for the UI panel. */
    fun settings(): McpSettings = settings
}
