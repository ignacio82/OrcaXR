package dev.orcaxr.app.mobile

import android.content.Context
import dev.orcaxr.app.llm.LlmSettings
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mcp.tools.AutoPaintLabelTool
import dev.orcaxr.app.mcp.tools.AutoPaintReferenceTool
import dev.orcaxr.app.mcp.tools.AutoPaintTool
import dev.orcaxr.app.mcp.tools.FsPaintSupport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Single source of truth for the Smart Paint UI ⇄ MCP parity rule
 * ([[feedback_ui_mcp_parity]]): the phone AND XR Smart Paint surfaces
 * both call THIS, which constructs the very same MCP `Tool` the network
 * MCP server would and invokes `tool.call(args)`. UI behavior is
 * therefore identical to driving `auto_paint` / `auto_paint_label` /
 * `auto_paint_from_reference` over MCP — by construction, not by
 * reimplementation.
 *
 * Pure of Compose so it unit-tests like `MobilePaintStateTest`. The
 * committed paint flows back into the shell automatically: the tool
 * emits `WorkspaceAction.LoadPaintState`, the shell's workspace binding
 * consumes it, no extra wiring here.
 */
internal object SmartPaintRunner {

    enum class Mode(val label: String, val needsImage: Boolean, val needsKey: Boolean) {
        Auto("Auto (smart)", false, false),
        HeightBands("Height bands", false, false),
        Components("Per shell", false, false),
        Cavity("Recess contrast", false, false),
        Image("From image", true, false),
        Label("AI: name & recolour", false, true),
        Reference("AI: match a reference", true, true),
    }

    data class Params(
        val mode: Mode,
        val axis: String = "z",
        val maxColors: Int? = null,
        val useFullSpectrum: Boolean = false,
        /** base64 PNG/JPEG for [Mode.Image] / [Mode.Reference]. */
        val imageBase64: String? = null,
        /** provider for [Mode.Label]: claude|gemini|openai|openrouter|pollinations. */
        val provider: String = "pollinations",
        val dryRun: Boolean = false,
    )

    data class Result(val ok: Boolean, val message: String, val structured: JSONObject?)

    /**
     * Build the args + the matching tool and invoke it off the main
     * thread. [appContext] is an application Context (stores / settings).
     */
    suspend fun run(appContext: Context, p: Params): Result = withContext(Dispatchers.IO) {
        runWith(
            ws = WorkspaceModel.get(),
            session = AiSessionState.get(),
            fsStore = FsPaintSupport.CtxMixedRowStore(ToolContext(appContext)),
            keyFlow = LlmSettings.get(appContext).unifiedClaudeKey,
            p = p,
        )
    }

    /**
     * Context-free core (the dependency seam) — same dispatch the
     * Context-bound [run] uses, unit-testable like the tool tests.
     */
    internal suspend fun runWith(
        ws: WorkspaceModel,
        session: AiSessionState,
        fsStore: FsPaintSupport.MixedRowStore,
        keyFlow: kotlinx.coroutines.flow.Flow<String?>,
        p: Params,
    ): Result {
        val args = JSONObject()
        p.maxColors?.let { args.put("max_colors", it) }
        if (p.dryRun) args.put("dry_run", true)
        if (p.useFullSpectrum) args.put("use_full_spectrum", true)

        val tool: Tool = when (p.mode) {
            Mode.Auto -> {
                args.put("strategy", "auto"); AutoPaintTool(ws, session, fsStore)
            }
            Mode.HeightBands -> {
                args.put("strategy", "height_bands"); args.put("axis", p.axis)
                AutoPaintTool(ws, session, fsStore)
            }
            Mode.Components -> {
                args.put("strategy", "components"); AutoPaintTool(ws, session, fsStore)
            }
            Mode.Cavity -> {
                args.put("strategy", "cavity"); AutoPaintTool(ws, session, fsStore)
            }
            Mode.Image -> {
                val img = p.imageBase64
                    ?: return Result(false, "Pick a target image first.", null)
                args.put("image_base64", img)
                AutoPaintTool(ws, session, fsStore)
            }
            Mode.Label -> {
                args.put("provider", p.provider)
                AutoPaintLabelTool(ws, session, keyFlow, fsStore = fsStore)
            }
            Mode.Reference -> {
                val img = p.imageBase64
                    ?: return Result(false, "Pick a reference image first.", null)
                args.put("reference_image_base64", img)
                AutoPaintReferenceTool(ws, session, keyFlow, fsStore = fsStore)
            }
        }

        val res = runCatching { tool.call(args) }.getOrElse {
            return Result(false, "Smart Paint failed: ${it.message}", null)
        }
        return Result(!res.isError, res.text, res.structured)
    }
}
