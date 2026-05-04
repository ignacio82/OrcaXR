package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.PngWriter
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONObject
import java.util.Base64
import kotlin.math.abs

/**
 * Visual session diff. The LLM gets one PNG showing what it ACTUALLY
 * painted in the current session — before / after / delta side-by-
 * side, with the changed regions highlighted in red.
 *
 * Why this matters: render_diff (which compares two raw render
 * tokens) requires the LLM to remember which token was the "before"
 * and call render_view at session start to get one. Most LLMs forget.
 * This tool removes that bookkeeping by reading the session's frozen
 * initial paint state, rendering a "before" on demand, then composing
 * before|after|delta in one image.
 *
 * Layout (3 panels, left to right):
 *   ┌─────────┬─────────┬─────────┐
 *   │ BEFORE  │ AFTER   │ DELTA   │
 *   └─────────┴─────────┴─────────┘
 *
 * The DELTA panel shows changed pixels in red over a faded grayscale
 * of AFTER, matching render_diff's visual encoding so the LLM's
 * pixel-coord intuitions transfer.
 */
internal class RenderPaintSessionDiffTool(
    private val ws: WorkspaceModel,
    private val sessionState: AiSessionState,
) : Tool {
    override val name = "render_paint_session_diff"
    override val description =
        "Render a 3-panel before/after/delta image for a paint session. The 'before' panel " +
            "shows the model with the paint state captured at begin_paint_session; 'after' " +
            "shows the session's CURRENT paint; 'delta' is a pixel-XOR with changed pixels in " +
            "red over a faded grayscale of after, matching render_diff's encoding. Use this " +
            "AFTER each significant paint pass — small vision models can read 'I added these " +
            "ears' from the delta panel without you having to remember a render token from " +
            "before the paint. Cache lifetime = session lifetime; the session's initial " +
            "paint is frozen at begin and never mutates."
    override val inputSchema = Schemas.obj(
        required = listOf("session_id", "view_name"),
        properties = mapOf(
            "session_id" to Schemas.string("Id from begin_paint_session"),
            "view_name" to Schemas.string(
                "Camera preset (front | back | left | right | top | bottom | iso | iso_back) " +
                    "or a name from name_view.",
            ),
            "panel_size_px" to Schemas.integer("Per-panel width=height (default 384, max 768)"),
            "diff_threshold" to Schemas.integer(
                "Per-channel min diff to count as changed (default 8 / 255).",
            ),
            "lighting" to Schemas.obj(),
            "inline" to Schemas.bool("If true and PNG ≤ 200 KB, also include base64 image part"),
        ),
    )
    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        val sessionId = args.optString("session_id").trim()
        if (sessionId.isEmpty()) return ToolResult.error("'session_id' is required.")
        val session = AiPaintSessionStore.get().get(sessionId)
            ?: return ToolResult.error("Unknown session_id '$sessionId'.")
        val viewNameRaw = args.optString("view_name").trim()
        if (viewNameRaw.isEmpty()) return ToolResult.error("'view_name' is required.")
        val viewName = viewNameRaw.lowercase()

        val bvh = ws.getBvh(session.modelId)
            ?: return ToolResult.error("Couldn't build BVH for '${session.modelId}'.")
        if (bvh.triCount != session.triCount) {
            return ToolResult.error(
                "Session triCount=${session.triCount} no longer matches the live model " +
                    "(${bvh.triCount}). A mesh edit invalidated the session.",
            )
        }
        val cell = args.optInt("panel_size_px", 384).coerceIn(64, 768)
        val threshold = args.optInt("diff_threshold", 8).coerceIn(0, 255)

        val cam = if (viewName in AiRenderEngine.NAMED_PRESETS) {
            val geom = AiIntrospection.geometry(bvh, bins = 1)
            AiRenderEngine.namedPreset(viewName, geom.bboxCenteredPreview, cell, cell)
        } else {
            sessionState.getCameraPreset(viewName)?.copy(widthPx = cell, heightPx = cell)
                ?: return ToolResult.error(
                    "Unknown view_name '$viewName'. Built-ins: " +
                        AiRenderEngine.NAMED_PRESETS.joinToString(", "),
                )
        }

        // Reuse AiVisionTools' lighting parser for consistency.
        val lighting = AiVisionToolsLightingShim.parse(args.optJSONObject("lighting"))
        val palette = ws.previewPalette.value

        val beforeR = AiRenderEngine.render(
            bvh = bvh,
            camera = cam,
            mode = AiRenderEngine.RenderMode.Paint,
            palette = palette,
            paintFilamentIndex = session.initialPaintFilamentIndex,
            lighting = lighting,
        )
        val afterR = AiRenderEngine.render(
            bvh = bvh,
            camera = cam,
            mode = AiRenderEngine.RenderMode.Paint,
            palette = palette,
            paintFilamentIndex = session.paintFilamentIndex,
            lighting = lighting,
        )
        val before = AiRenderEngine.decodePng(beforeR.pngBytes)
            ?: return ToolResult.error("Couldn't decode 'before' render.")
        val after = AiRenderEngine.decodePng(afterR.pngBytes)
            ?: return ToolResult.error("Couldn't decode 'after' render.")
        if (before.widthPx != after.widthPx || before.heightPx != after.heightPx) {
            return ToolResult.error(
                "Internal error: before/after render dims differ " +
                    "(${before.widthPx}×${before.heightPx} vs ${after.widthPx}×${after.heightPx})",
            )
        }
        val w = before.widthPx; val h = before.heightPx

        // Build the diff RGBA (red over faded grayscale of after).
        val diff = ByteArray(w * h * 4)
        var changed = 0
        for (i in 0 until w * h) {
            val o = i * 4
            val ar = before.rgba[o].toInt() and 0xff
            val ag = before.rgba[o + 1].toInt() and 0xff
            val ab = before.rgba[o + 2].toInt() and 0xff
            val br = after.rgba[o].toInt() and 0xff
            val bg = after.rgba[o + 1].toInt() and 0xff
            val bb = after.rgba[o + 2].toInt() and 0xff
            val maxd = maxOf(abs(ar - br), abs(ag - bg), abs(ab - bb))
            if (maxd >= threshold) {
                diff[o] = 255.toByte(); diff[o + 1] = 64.toByte(); diff[o + 2] = 64.toByte()
                diff[o + 3] = 255.toByte()
                changed++
            } else {
                val gray = ((br + bg + bb) / 3 / 2 + 96).coerceIn(96, 200)
                diff[o] = gray.toByte(); diff[o + 1] = gray.toByte(); diff[o + 2] = gray.toByte()
                diff[o + 3] = 255.toByte()
            }
        }

        // Compose the 3-panel image. We allocate the full buffer and
        // blit each panel in. 1px gray separators between panels for
        // visual structure.
        val totalW = w * 3 + 2  // 2px of separator
        val totalH = h
        val composed = ByteArray(totalW * totalH * 4)
        // Background fill light gray.
        run {
            var i = 0
            while (i < composed.size) {
                composed[i] = 242.toByte()
                composed[i + 1] = 242.toByte()
                composed[i + 2] = 242.toByte()
                composed[i + 3] = 255.toByte()
                i += 4
            }
        }
        blitPanel(before.rgba, composed, totalW, 0, w, h)
        blitPanel(after.rgba, composed, totalW, w + 1, w, h)
        blitPanel(diff, composed, totalW, w * 2 + 2, w, h)
        // Separators (vertical lines between panels).
        for (sx in intArrayOf(w, w * 2 + 1)) {
            for (y in 0 until h) {
                val o = (y * totalW + sx) * 4
                composed[o] = 32; composed[o + 1] = 32; composed[o + 2] = 32; composed[o + 3] = 255.toByte()
            }
        }
        val outPng = PngWriter.encodeRgba(composed, totalW, totalH)
        val cacheCam = AiRenderEngine.CameraSpec(FloatArray(16), FloatArray(16), totalW, totalH)
        val token = AiSessionState.contentToken(
            modelId = session.modelId,
            mode = "session_diff:$viewName:$cell:$threshold:${session.id}",
            camera = cacheCam,
            paintContentVersion = session.version.toInt() xor changed,
        )
        sessionState.saveArtifact(AiSessionState.RenderArtifact(
            token = token,
            pngBytes = outPng,
            widthPx = totalW,
            heightPx = totalH,
            camera = cacheCam,
            triangleIdMap = null,
            createdAtMs = System.currentTimeMillis(),
        ))
        val total = w * h
        val pct = if (total > 0) (100.0 * changed / total) else 0.0
        val body = JSONObject().apply {
            put("ok", true)
            put("session_id", sessionId)
            put("model_id", session.modelId)
            put("view_name", viewName)
            put("render_token", token)
            put("image_uri", AiVisionToolsLightingShim.buildResourceUri(token))
            put("width_px", totalW)
            put("height_px", totalH)
            put("panel_size_px", cell)
            put("layout", "before|after|delta")
            put("changed_pixels", changed)
            put("total_panel_pixels", total)
            put("changed_pct", pct)
            put("diff_threshold", threshold)
            put("session_version", session.version)
            put("base_fingerprint", session.baseFingerprint)
            put("current_fingerprint", session.currentFingerprint())
            put("bytes", outPng.size)
        }
        val text = "render_paint_session_diff $sessionId @ $viewName: " +
            "$changed / $total px changed (${"%.2f".format(pct)} %); token=$token"
        val images = if (args.optBoolean("inline", false) && outPng.size <= 200_000) {
            listOf(ToolResult.ImagePart(
                mediaType = "image/png",
                base64Data = Base64.getEncoder().encodeToString(outPng),
            ))
        } else emptyList()
        return ToolResult.ok(text, body, images)
    }

    private fun blitPanel(src: ByteArray, dst: ByteArray, dstW: Int, dstX: Int, w: Int, h: Int) {
        for (y in 0 until h) {
            val srcOff = y * w * 4
            val dstOff = (y * dstW + dstX) * 4
            System.arraycopy(src, srcOff, dst, dstOff, w * 4)
        }
    }
}

/**
 * Re-export helpers from the `internal object AiVisionTools` so this
 * tool (which lives in the same package) doesn't have to duplicate
 * them. We intentionally do NOT make AiVisionTools' helpers public —
 * they're internal to its tool surface — so this thin shim keeps
 * the API surface tight.
 */
internal object AiVisionToolsLightingShim {
    fun parse(o: JSONObject?): AiRenderEngine.LightingParams {
        if (o == null) return AiRenderEngine.LightingParams.DEFAULT
        // For the diff renderer we only honor the `preset` shorthand —
        // the full param set lives in render_view's surface. This
        // keeps the diff tool's schema small (one knob) without
        // sacrificing the canonical "studio_soft" / "flat" presets.
        return when (o.optString("preset", "").lowercase()) {
            "flat", "legacy" -> AiRenderEngine.LightingParams.LEGACY_FLAT
            "matcap_soft", "soft", "studio" -> AiRenderEngine.LightingParams(
                keyDirection = floatArrayOf(-0.3f, 0.4f, 1.0f),
                fillDirection = floatArrayOf(0.5f, -0.5f, -0.3f),
                keyStrength = 0.7f,
                fillStrength = 0.4f,
                ambientStrength = 0.22f,
                rimStrength = 0.3f,
                rimExponent = 3f,
                aoStrength = 0.6f,
                aoRadiusPx = 8,
                silhouetteStrength = 0.4f,
            )
            else -> AiRenderEngine.LightingParams.DEFAULT
        }
    }

    fun buildResourceUri(token: String): String {
        val port = dev.orcaxr.app.mcp.McpController.boundPortStatic()
        if (port <= 0) return "mcp://resources/$token.png"
        val host = dev.orcaxr.app.mcp.McpServer.lanAddresses().firstOrNull()
            ?: return "mcp://resources/$token.png"
        return "http://$host:$port/resources/$token.png"
    }
}
