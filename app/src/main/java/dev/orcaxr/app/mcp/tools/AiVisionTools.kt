package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.PngWriter
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * AI-driven paint pillar (C9 milestone 2) — vision tools that emit
 * PNGs the LLM can read. Pure Kotlin software rasterizer (see
 * [AiRenderEngine]); no JNI, no native rebuild.
 *
 * Image transport: every render result includes `image_uri` in
 * structuredContent. When the MCP server has a LAN address bound,
 * `image_uri` is an absolute `http://<lan-ip>:<port>/resources/
 * <token>.png` URL the driving LLM can WebFetch directly — no
 * Authorization header required (the 64-bit token is the capability;
 * see McpServer.handleResourceGet). When the PNG is < 200 KB, an
 * inline base64 `image` content part is also attached as a best-
 * effort path; not every MCP transport surfaces it back to the
 * model, so the absolute URL is the load-bearing channel. The
 * server streams the binary PNG via the GET route added in
 * [dev.orcaxr.app.mcp.McpServer].
 *
 * Tools shipped here:
 *  - list_camera_presets
 *  - render_view
 *  - render_paint_overlay
 *  - render_triangle_id_map
 *  - resolve_image_pixel
 *  - name_view
 */
internal object AiVisionTools {

    /** Maximum render dimension. The Kotlin rasterizer is single-
     *  threaded; 2048² on a 144 K-tri Pikachu is ~2 s on host JVM,
     *  expected ~6 s on Galaxy XR arm64. Larger renders are
     *  clamped. D18h bumped this from 1024 to 2048 so a triangle-ID
     *  map of a 1.4 M-tri dragon covers ≥ 90 % of unique tris in
     *  ≥ 1 pixel each (was ~1.8 px/tri at 512 → many tris lost). */
    private const val MAX_RENDER_DIM = 2048
    private const val DEFAULT_RENDER_DIM = 512
    private const val INLINE_BASE64_BYTE_CAP = 200_000

    fun all(ws: WorkspaceModel, session: AiSessionState): List<Tool> = listOf(
        ListCameraPresets(ws),
        RenderView(ws, session),
        RenderPaintOverlay(ws, session),
        RenderTriangleIdMap(ws, session),
        ResolveImagePixel(session),
        NameView(ws, session),
        RenderViewsGrid(ws, session),
        ListActivePalette(ws),
        RenderDiff(session),
        RenderMontage(ws, session),
    )

    // ---- Helpers ----

    /**
     * Outcome of [resolveModelAndBvh]. Splitting the failure modes lets
     * callers emit a specific error message for each cause — the LLM
     * (and humans debugging) need to know whether to add a model_id
     * argument, look up a different id, or just wait for the BVH to
     * finish building.
     */
    private sealed interface ResolvedModel {
        data class Found(val model: PlacedModel, val bvh: MeshBvh) : ResolvedModel
        /** No `model_id` argument was passed at all. */
        data object MissingId : ResolvedModel
        /** `model_id` was passed but doesn't match any placed model. */
        data class UnknownId(val id: String, val knownIds: List<String>) : ResolvedModel
        /** Model exists but its BVH hasn't finished building. Retry shortly. */
        data class BvhNotReady(val id: String) : ResolvedModel
    }

    private suspend fun resolveModelAndBvh(
        ws: WorkspaceModel,
        args: JSONObject,
    ): ResolvedModel {
        val id = args.optString("model_id").trim()
        if (id.isEmpty()) return ResolvedModel.MissingId
        val placed = ws.placedModels.value
        val model = placed.firstOrNull { it.id == id }
            ?: return ResolvedModel.UnknownId(id, placed.map { it.id })
        val bvh = ws.getBvh(id) ?: return ResolvedModel.BvhNotReady(id)
        return ResolvedModel.Found(model, bvh)
    }

    /** Format a [ResolvedModel] failure as the message body of a [ToolResult.error]. */
    private fun ResolvedModel.toError(): ToolResult = when (this) {
        is ResolvedModel.Found ->
            // Caller should never call this on a Found; defend against
            // a future copy-paste regression with a clear message.
            ToolResult.error("Internal error: tried to format a Found result.")
        is ResolvedModel.MissingId ->
            ToolResult.error(
                "model_id argument is required. Call list_placed_models first " +
                    "and pass the `id=...` value of the target model.",
            )
        is ResolvedModel.UnknownId ->
            ToolResult.error(
                "No model with id=\"$id\" on the active plate. " +
                    if (knownIds.isEmpty()) "Workspace is empty — load a model first."
                    else "Known ids: ${knownIds.joinToString(", ")}.",
            )
        is ResolvedModel.BvhNotReady ->
            ToolResult.error(
                "Model $id is loading but its BVH isn't built yet. " +
                    "Call get_workspace_state once or twice and retry — " +
                    "BVH usually finishes within a second of load_model_from_path returning.",
            )
    }

    private fun parseMode(raw: String): AiRenderEngine.RenderMode? = when (raw.lowercase()) {
        "", "paint" -> AiRenderEngine.RenderMode.Paint
        "solid" -> AiRenderEngine.RenderMode.Solid
        "triangle_id", "tri_id", "triid" -> AiRenderEngine.RenderMode.TriangleId
        "normals", "normal_sphere" -> AiRenderEngine.RenderMode.NormalSphere
        "depth" -> AiRenderEngine.RenderMode.Depth
        "paint_mask" -> AiRenderEngine.RenderMode.Paint  // alias for v1; full paint_mask comes in M4
        else -> null
    }

    /** Build a CameraSpec from a tool's args, deferring to a named
     *  preset, the session's stored named cameras, or a custom matrix. */
    private suspend fun buildCamera(
        ws: WorkspaceModel,
        session: AiSessionState,
        bvh: MeshBvh,
        args: JSONObject,
        widthPx: Int,
        heightPx: Int,
    ): AiRenderEngine.CameraSpec? {
        // Custom: explicit view + proj matrix.
        if (args.has("custom")) {
            val custom = args.getJSONObject("custom")
            val view = custom.optJSONArray("view_matrix_4x4")
                ?: return null
            val projObj = custom.optJSONObject("projection") ?: return null
            if (view.length() != 16) return null
            val viewArr = FloatArray(16) { (view.optDouble(it, 0.0)).toFloat() }
            val proj = parseProjection(projObj, widthPx, heightPx) ?: return null
            return AiRenderEngine.CameraSpec(viewArr, proj, widthPx, heightPx)
        }
        val viewName = args.optString("view_name").lowercase()
        if (viewName.isNotEmpty()) {
            // Check custom session-stored presets first.
            session.getCameraPreset(viewName)?.let { stored ->
                return if (stored.widthPx == widthPx && stored.heightPx == heightPx) stored
                else stored.copy(widthPx = widthPx, heightPx = heightPx)
            }
            if (viewName in AiRenderEngine.NAMED_PRESETS) {
                val geom = AiIntrospection.geometry(bvh, bins = 1)
                return AiRenderEngine.namedPreset(viewName, geom.bboxCenteredPreview, widthPx, heightPx)
            }
            return null
        }
        // Default: iso preset.
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        return AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, widthPx, heightPx)
    }

    private fun parseProjection(obj: JSONObject, widthPx: Int, heightPx: Int): FloatArray? {
        val kind = obj.optString("kind", "perspective").lowercase()
        return when (kind) {
            "perspective" -> {
                val fov = obj.optDouble("fov_y_deg", 45.0).toFloat()
                val aspect = obj.optDouble("aspect", widthPx.toDouble() / heightPx.toDouble().coerceAtLeast(1.0)).toFloat()
                val near = obj.optDouble("near", 0.1).toFloat()
                val far = obj.optDouble("far", 5000.0).toFloat()
                AiRenderEngine.perspectiveRowMajor(fov, aspect, near, far)
            }
            "orthographic" -> {
                val scale = obj.optDouble("scale_mm", 100.0).toFloat()
                val near = obj.optDouble("near", -1000.0).toFloat()
                val far = obj.optDouble("far", 1000.0).toFloat()
                floatArrayOf(
                    2f / scale, 0f, 0f, 0f,
                    0f, 2f / scale, 0f, 0f,
                    0f, 0f, -2f / (far - near), -(far + near) / (far - near),
                    0f, 0f, 0f, 1f,
                )
            }
            else -> null
        }
    }

    private fun encodeCameraDescriptor(camera: AiRenderEngine.CameraSpec): JSONObject = JSONObject().apply {
        val view = JSONArray().apply { for (v in camera.viewMatrixRowMajor) put(v.toDouble()) }
        val proj = JSONArray().apply { for (v in camera.projMatrixRowMajor) put(v.toDouble()) }
        put("view_matrix_4x4", view)
        put("projection_matrix_4x4", proj)
        put("width_px", camera.widthPx)
        put("height_px", camera.heightPx)
    }

    /**
     * D21a: build a real HTTP URL for a rendered token so the driving
     * LLM can `WebFetch(absolute url)` even when the MCP transport
     * drops inline image content blocks. Falls back to the legacy
     * `mcp://` capability URI when the server has no LAN address yet
     * (boot before Wi-Fi associates) or when callers explicitly want
     * the protocol-relative form.
     */
    internal fun buildResourceUri(token: String): String {
        val port = dev.orcaxr.app.mcp.McpController.boundPortStatic()
        if (port <= 0) return "mcp://resources/$token.png"
        // Prefer the first non-loopback IPv4 — typical home LAN. If no
        // LAN address (offline build), fall back to the legacy form so
        // existing callers still see a stable URI shape.
        val host = dev.orcaxr.app.mcp.McpServer.lanAddresses().firstOrNull()
            ?: return "mcp://resources/$token.png"
        return "http://$host:$port/resources/$token.png"
    }

    private fun packResult(
        modelId: String,
        camera: AiRenderEngine.CameraSpec,
        png: ByteArray,
        token: String,
        inlineRequested: Boolean,
        extra: JSONObject = JSONObject(),
    ): ToolResult {
        val uri = buildResourceUri(token)
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", modelId)
            put("image_uri", uri)
            put("render_token", token)
            put("bytes", png.size)
            put("width_px", camera.widthPx)
            put("height_px", camera.heightPx)
            put("camera_descriptor", encodeCameraDescriptor(camera))
            val keys = extra.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                put(k, extra.get(k))
            }
        }
        val text = if (uri.startsWith("http")) {
            "Rendered ${camera.widthPx}×${camera.heightPx} png (${png.size} B); fetch via WebFetch($uri); token=$token"
        } else {
            "Rendered ${camera.widthPx}×${camera.heightPx} png (${png.size} B); token=$token"
        }
        val images = if (inlineRequested && png.size <= INLINE_BASE64_BYTE_CAP) {
            listOf(ToolResult.ImagePart(
                mediaType = "image/png",
                base64Data = Base64.getEncoder().encodeToString(png),
            ))
        } else emptyList()
        return ToolResult.ok(text, body, images)
    }

    // ---- Tools ----

    class ListCameraPresets(private val ws: WorkspaceModel) : Tool {
        override val name = "list_camera_presets"
        override val description =
            "List the named camera presets available for render_view (iso, iso_back, front, back, " +
                "left, right, top, bottom) plus any user-saved cameras (via name_view). Returns the " +
                "model's bbox in centered_preview_mm so the LLM has a coordinate frame to reason in."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val resolved = resolveModelAndBvh(ws, args)
            if (resolved !is ResolvedModel.Found) return resolved.toError()
            val (model, bvh) = resolved.model to resolved.bvh
            val geom = AiIntrospection.geometry(bvh, bins = 1)
            val builtin = JSONArray().apply {
                for (n in AiRenderEngine.NAMED_PRESETS) {
                    put(JSONObject().apply {
                        put("name", n)
                        put("description", presetDescription(n))
                    })
                }
            }
            val saved = JSONArray().apply {
                for (n in AiSessionState.get().listCameraPresetNames()) {
                    put(JSONObject().apply { put("name", n); put("description", "user-saved view") })
                }
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("builtin_presets", builtin)
                put("saved_presets", saved)
                val bbox = JSONObject().apply {
                    put("x_min", geom.bboxCenteredPreview.minX.toDouble())
                    put("y_min", geom.bboxCenteredPreview.minY.toDouble())
                    put("z_min", geom.bboxCenteredPreview.minZ.toDouble())
                    put("x_max", geom.bboxCenteredPreview.maxX.toDouble())
                    put("y_max", geom.bboxCenteredPreview.maxY.toDouble())
                    put("z_max", geom.bboxCenteredPreview.maxZ.toDouble())
                }
                put("bbox_centered_preview", bbox)
            }
            return ToolResult.ok("${AiRenderEngine.NAMED_PRESETS.size} built-in presets + ${AiSessionState.get().listCameraPresetNames().size} saved", body)
        }

        private fun presetDescription(name: String): String = when (name) {
            "iso" -> "Default 3/4 view from (+X, -Y, +Z); good general orientation."
            "iso_back" -> "3/4 view from behind (-X, +Y, +Z)."
            "front" -> "Camera at -Y, looking +Y."
            "back" -> "Camera at +Y, looking -Y."
            "left" -> "Camera at -X, looking +X."
            "right" -> "Camera at +X, looking -X."
            "top" -> "Camera above (+Z), looking down."
            "bottom" -> "Camera below (-Z), looking up."
            else -> ""
        }
    }

    class RenderView(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
    ) : Tool {
        override val name = "render_view"
        override val description =
            "Render the model from a named preset (iso/front/back/left/right/top/bottom) or a custom " +
                "view+projection matrix. mode controls what's drawn: 'paint' (default — current paint " +
                "state visible), 'solid' (uniform tint with shading), 'triangle_id' (each triangle's " +
                "id encoded in RGB; pair with resolve_image_pixel to chain reads → narrow → paint), " +
                "'normals' (RGB = normal sphere), 'depth' (linear depth grayscale). The result " +
                "includes image_uri — when OrcaXR has a LAN address this is an absolute http:// URL " +
                "the driving LLM can WebFetch DIRECTLY (no auth header required; the token is the " +
                "capability). If inline=true and the PNG is < 200 KB, an inline base64 image content " +
                "part is also attached as a best-effort path; the http URL is the load-bearing one " +
                "because not every MCP transport propagates inline image blocks back to the model."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "view_name" to Schemas.string("Named preset (iso/front/...) or a name_view-saved name"),
                "custom" to Schemas.obj(
                    properties = mapOf(
                        "view_matrix_4x4" to JSONObject().apply {
                            put("type", "array")
                            put("description", "16-element row-major view matrix")
                            put("items", Schemas.number(""))
                        },
                        "projection" to Schemas.obj(
                            properties = mapOf(
                                "kind" to Schemas.string("'perspective' | 'orthographic'"),
                                "fov_y_deg" to Schemas.number(""),
                                "aspect" to Schemas.number(""),
                                "near" to Schemas.number(""),
                                "far" to Schemas.number(""),
                                "scale_mm" to Schemas.number("(orthographic only)"),
                            ),
                        ),
                    ),
                ),
                "width_px" to Schemas.integer("Default 512, capped at 1024"),
                "height_px" to Schemas.integer("Default 512, capped at 1024"),
                "mode" to Schemas.string("'paint' (default) | 'solid' | 'triangle_id' | 'normals' | 'depth'"),
                "inline" to Schemas.bool("If true and PNG < 200 KB, also include base64 image part"),
                "annotate" to Schemas.bool("D18e — burn axis triad (R=X G=Y B=Z), bbox dims (e.g. '60 x 31 x 48 mm'), and a 10 mm scale bar into the corners. Default false. Skipped for triangle_id mode (would corrupt the encoding)."),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult =
            renderInternal(ws, session, args, defaultMode = "paint")
    }

    class RenderPaintOverlay(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
    ) : Tool {
        override val name = "render_paint_overlay"
        override val description =
            "Convenience wrapper for render_view with mode='paint' forced. Use after a paint primitive " +
                "to verify the result."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "view_name" to Schemas.string("Named preset (default 'iso')"),
                "width_px" to Schemas.integer(""),
                "height_px" to Schemas.integer(""),
                "inline" to Schemas.bool(""),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            // Force mode=paint regardless of caller input.
            args.put("mode", "paint")
            return renderInternal(ws, session, args, defaultMode = "paint")
        }
    }

    class RenderTriangleIdMap(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
    ) : Tool {
        override val name = "render_triangle_id_map"
        override val description =
            "Render a triangle-ID map: each pixel's RGB encodes (id+1)>>16/>>8/&0xff so the LLM (or " +
                "resolve_image_pixel) can decode any pixel back to a triangle index. Background is " +
                "(0,0,0). The render_token returned can be passed to resolve_image_pixel(x_px, y_px) " +
                "without the LLM having to decode the PNG itself."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "view_name" to Schemas.string("Named preset (default 'iso')"),
                "width_px" to Schemas.integer(""),
                "height_px" to Schemas.integer(""),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            args.put("mode", "triangle_id")
            // Triangle-ID maps are meant to be machine-decoded — never
            // inline.
            args.put("inline", false)
            return renderInternal(ws, session, args, defaultMode = "triangle_id")
        }
    }

    class ResolveImagePixel(private val session: AiSessionState) : Tool {
        override val name = "resolve_image_pixel"
        override val description =
            "Look up the triangle ID at a pixel in a previously-rendered triangle-ID map. Returns " +
                "{tri_id, hit:bool}. hit=false means the pixel is background. Use after " +
                "render_triangle_id_map to translate 'the bow region in the iso view' into a triangle " +
                "id you can pass to paint_surface_region or paint_triangle_list. " +
                "D18h: pass radius_px > 0 to ALSO scan a square neighborhood and return the unique " +
                "triangle ids found there in `nearby_tri_ids` (ordered by occurrence count). Useful " +
                "when the click lands near a triangle boundary or when the LLM wants candidate " +
                "anchors close to its target."
        override val inputSchema = Schemas.obj(
            required = listOf("render_token", "x_px", "y_px"),
            properties = mapOf(
                "render_token" to Schemas.string("Token from render_triangle_id_map"),
                "x_px" to Schemas.integer("0..width-1"),
                "y_px" to Schemas.integer("0..height-1 (top-down origin)"),
                "radius_px" to Schemas.integer("D18h — scan a (2r+1)² neighborhood for nearby tri ids (default 0)"),
                "max_nearby" to Schemas.integer("Cap on returned nearby_tri_ids (default 16)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val token = args.optString("render_token").trim()
            val x = args.optInt("x_px", -1)
            val y = args.optInt("y_px", -1)
            if (token.isEmpty()) return ToolResult.error("'render_token' is required")
            val art = session.getArtifact(token)
                ?: return ToolResult.error("Unknown render token. Render a triangle_id map first.")
            val triMap = art.triangleIdMap
                ?: return ToolResult.error("Token didn't come from a triangle_id render.")
            if (x < 0 || x >= art.widthPx || y < 0 || y >= art.heightPx) {
                return ToolResult.error("(x=$x, y=$y) out of [0,${art.widthPx})×[0,${art.heightPx})")
            }
            val tri = triMap[y * art.widthPx + x]
            val radius = args.optInt("radius_px", 0).coerceIn(0, 32)
            val maxNearby = args.optInt("max_nearby", 16).coerceIn(1, 256)
            // D18h — count tri occurrences in a (2r+1)² window.
            val nearby = if (radius > 0) {
                val counts = LinkedHashMap<Int, Int>()  // ordered by first-seen
                for (dy in -radius..radius) {
                    val yy = y + dy
                    if (yy < 0 || yy >= art.heightPx) continue
                    for (dx in -radius..radius) {
                        val xx = x + dx
                        if (xx < 0 || xx >= art.widthPx) continue
                        val t = triMap[yy * art.widthPx + xx]
                        if (t < 0) continue
                        counts.merge(t, 1) { a, b -> a + b }
                    }
                }
                // Sort by descending count, take top N.
                counts.entries
                    .sortedByDescending { it.value }
                    .take(maxNearby)
                    .map { it.key to it.value }
            } else emptyList()
            val body = JSONObject().apply {
                put("ok", true)
                put("render_token", token)
                put("x_px", x); put("y_px", y)
                put("tri_id", tri)
                put("hit", tri >= 0)
                if (radius > 0) {
                    val arr = JSONArray()
                    for ((triId, count) in nearby) {
                        arr.put(JSONObject().apply {
                            put("tri_id", triId); put("pixel_count", count)
                        })
                    }
                    put("nearby_tri_ids", arr)
                    put("radius_px", radius)
                }
            }
            return ToolResult.ok(
                if (tri >= 0) "tri_id $tri at ($x, $y)${if (radius > 0) " + ${nearby.size} nearby" else ""}"
                else "no triangle at ($x, $y) — pixel is background",
                body,
            )
        }
    }

    class NameView(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
    ) : Tool {
        override val name = "name_view"
        override val description =
            "Save a camera under a name so subsequent render_view calls can refer back to it via " +
                "view_name. Lives only for this AI session (lost on app restart)."
        override val inputSchema = Schemas.obj(
            required = listOf("name", "camera_descriptor"),
            properties = mapOf(
                "name" to Schemas.string("Camera name (e.g. 'bow', 'stern')"),
                "camera_descriptor" to Schemas.obj(
                    properties = mapOf(
                        "view_matrix_4x4" to JSONObject().apply {
                            put("type", "array"); put("items", Schemas.number(""))
                        },
                        "projection_matrix_4x4" to JSONObject().apply {
                            put("type", "array"); put("items", Schemas.number(""))
                        },
                        "width_px" to Schemas.integer(""),
                        "height_px" to Schemas.integer(""),
                    ),
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val name = args.optString("name").trim().lowercase()
            if (name.isEmpty()) return ToolResult.error("'name' is required")
            if (name in AiRenderEngine.NAMED_PRESETS) {
                return ToolResult.error("'$name' is a reserved built-in preset; pick a different name.")
            }
            val descriptor = args.optJSONObject("camera_descriptor")
                ?: return ToolResult.error("'camera_descriptor' is required")
            val view = descriptor.optJSONArray("view_matrix_4x4") ?: return ToolResult.error("descriptor.view_matrix_4x4 missing")
            val proj = descriptor.optJSONArray("projection_matrix_4x4") ?: return ToolResult.error("descriptor.projection_matrix_4x4 missing")
            if (view.length() != 16 || proj.length() != 16) {
                return ToolResult.error("view + proj matrices must each be 16 floats")
            }
            val w = descriptor.optInt("width_px", 512)
            val h = descriptor.optInt("height_px", 512)
            val viewArr = FloatArray(16) { view.optDouble(it, 0.0).toFloat() }
            val projArr = FloatArray(16) { proj.optDouble(it, 0.0).toFloat() }
            session.saveCameraPreset(name, AiRenderEngine.CameraSpec(viewArr, projArr, w, h))
            val body = JSONObject().apply {
                put("ok", true)
                put("name", name)
                put("saved", true)
            }
            return ToolResult.ok("Saved camera '$name'", body)
        }
    }

    class RenderDiff(private val session: AiSessionState) : Tool {
        override val name = "render_diff"
        override val description =
            "XOR two cached render artifacts (by their render tokens) and return a PNG that " +
                "highlights changed pixels in red over a faded grayscale of the original. Lets the " +
                "LLM verify a paint action did what it expected in one call instead of comparing two " +
                "PNGs visually. Both tokens must come from the SAME view + dimensions — diff against " +
                "different cameras or sizes returns isError. Returns a new render_token for the diff " +
                "image (so the LLM can fetch via /resources/<token>.png and pass it to " +
                "resolve_image_pixel if it wants to know the tri at a changed pixel)."
        override val inputSchema = Schemas.obj(
            required = listOf("token_a", "token_b"),
            properties = mapOf(
                "token_a" to Schemas.string("Earlier render token (the 'before')"),
                "token_b" to Schemas.string("Later render token (the 'after')"),
                "threshold" to Schemas.integer("Per-channel min diff to count as changed (default 8 / 255)"),
                "inline" to Schemas.bool("Include inline base64 PNG if ≤200 KB (default false)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val tokA = args.optString("token_a").trim()
            val tokB = args.optString("token_b").trim()
            if (tokA.isEmpty() || tokB.isEmpty()) {
                return ToolResult.error("token_a and token_b are required")
            }
            val artA = session.getArtifact(tokA)
                ?: return ToolResult.error("Unknown token_a '$tokA' (artifact may have been evicted)")
            val artB = session.getArtifact(tokB)
                ?: return ToolResult.error("Unknown token_b '$tokB' (artifact may have been evicted)")
            if (artA.widthPx != artB.widthPx || artA.heightPx != artB.heightPx) {
                return ToolResult.error(
                    "Dimension mismatch: ${artA.widthPx}×${artA.heightPx} vs ${artB.widthPx}×${artB.heightPx}",
                )
            }
            val threshold = args.optInt("threshold", 8).coerceIn(0, 255)
            val w = artA.widthPx; val h = artA.heightPx
            val pixA = AiRenderEngine.decodePng(artA.pngBytes)
                ?: return ToolResult.error("Couldn't decode token_a's PNG")
            val pixB = AiRenderEngine.decodePng(artB.pngBytes)
                ?: return ToolResult.error("Couldn't decode token_b's PNG")
            val out = ByteArray(w * h * 4)
            var changedPx = 0
            for (i in 0 until w * h) {
                val o = i * 4
                val ar = pixA.rgba[o].toInt() and 0xff
                val ag = pixA.rgba[o + 1].toInt() and 0xff
                val ab = pixA.rgba[o + 2].toInt() and 0xff
                val br = pixB.rgba[o].toInt() and 0xff
                val bg = pixB.rgba[o + 1].toInt() and 0xff
                val bb = pixB.rgba[o + 2].toInt() and 0xff
                val dr = kotlin.math.abs(ar - br)
                val dg = kotlin.math.abs(ag - bg)
                val db = kotlin.math.abs(ab - bb)
                val maxDiff = maxOf(dr, dg, db)
                if (maxDiff >= threshold) {
                    // Changed: bright red.
                    out[o] = 255.toByte()
                    out[o + 1] = 64.toByte()
                    out[o + 2] = 64.toByte()
                    out[o + 3] = 255.toByte()
                    changedPx++
                } else {
                    // Unchanged: faded grayscale of B.
                    val gray = ((br + bg + bb) / 3 / 2 + 96).coerceIn(96, 200)
                    out[o] = gray.toByte()
                    out[o + 1] = gray.toByte()
                    out[o + 2] = gray.toByte()
                    out[o + 3] = 255.toByte()
                }
            }
            val png = PngWriter.encodeRgba(out, w, h)
            // New artifact under a stable hash of (a, b, threshold).
            val token = AiSessionState.contentToken(
                modelId = "diff:$tokA:$tokB",
                mode = "render_diff",
                camera = artA.camera,
                paintContentVersion = threshold,
            )
            session.saveArtifact(AiSessionState.RenderArtifact(
                token = token,
                pngBytes = png,
                widthPx = w, heightPx = h,
                camera = artA.camera,
                triangleIdMap = null,
                createdAtMs = System.currentTimeMillis(),
            ))
            val inline = args.optBoolean("inline", false)
            val total = w * h
            val pct = if (total > 0) (100.0 * changedPx / total) else 0.0
            val body = JSONObject().apply {
                put("ok", true)
                put("token_a", tokA); put("token_b", tokB)
                put("render_token", token)
                put("image_uri", buildResourceUri(token))
                put("width_px", w); put("height_px", h)
                put("bytes", png.size)
                put("changed_pixels", changedPx)
                put("total_pixels", total)
                put("changed_pct", pct)
                put("threshold", threshold)
            }
            val text = "render_diff: $changedPx / $total pixels changed (${"%.2f".format(pct)} %); token=$token"
            val images = if (inline && png.size <= INLINE_BASE64_BYTE_CAP) {
                listOf(ToolResult.ImagePart(
                    mediaType = "image/png",
                    base64Data = Base64.getEncoder().encodeToString(png),
                ))
            } else emptyList()
            return ToolResult.ok(text, body, images)
        }
    }

    class ListActivePalette(private val ws: WorkspaceModel) : Tool {
        override val name = "list_active_palette"
        override val description =
            "Return the live 'as-will-print' filament palette for the active printer — i.e. the colors " +
                "the on-bed colored-GLB renderer actually uses. This is what the LLM should query before " +
                "picking paint tags, NOT list_filaments. The two can differ when:\n" +
                "  - the printer has different physical spools loaded than the user's configured filament list,\n" +
                "  - virtual mixed-filament rows are active,\n" +
                "  - the user remapped project filaments to different slots in the picker.\n" +
                "Each entry is { tag, hex, slot_index } where tag is the value to pass to paint primitives " +
                "(paint_sphere/slab/etc.) and hex is the actual rendered color (e.g. '#FFFF00'). Tag 0 is " +
                "always 'unpainted' and is not returned. Returns an empty palette when no printer is selected " +
                "or the printer hasn't loaded yet."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val palette = ws.previewPalette.value
            val arr = JSONArray()
            for ((i, hex) in palette.withIndex()) {
                arr.put(JSONObject().apply {
                    put("tag", i + 1)
                    put("slot_index", i)
                    put("hex", hex)
                })
            }
            val text = if (palette.isEmpty()) {
                "No active palette — no printer selected or palette not yet loaded."
            } else {
                buildString {
                    append("Active palette (${palette.size} slots):\n")
                    for ((i, h) in palette.withIndex()) {
                        append("  tag ${i + 1}  $h\n")
                    }
                }.trimEnd()
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("count", palette.size)
                val pid = ws.selectedPrinterId.value
                if (pid != null) put("printer_id", pid)
                put("entries", arr)
            }
            return ToolResult.ok(text, body)
        }
    }

    class RenderViewsGrid(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
    ) : Tool {
        override val name = "render_views_grid"
        override val description =
            "Render multiple named views into a single composed PNG (laid out left-to-right). " +
                "Useful for orientation checks: pass [\"front\", \"back\", \"left\", \"right\"] to " +
                "see all four orthographic views in one round-trip. Each panel is the same size; " +
                "view_names not in the built-in preset list are skipped (with a warning in the " +
                "response)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "view_names"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "view_names" to Schemas.stringArray("Names of presets to render"),
                "panel_width_px" to Schemas.integer("Per-panel width (default 256)"),
                "panel_height_px" to Schemas.integer("Per-panel height (default 256)"),
                "mode" to Schemas.string("'paint' (default) | 'solid' | 'normals' | 'depth'"),
                "inline" to Schemas.bool(""),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val resolved = resolveModelAndBvh(ws, args)
            if (resolved !is ResolvedModel.Found) return resolved.toError()
            val (model, bvh) = resolved.model to resolved.bvh
            val viewsRaw = args.optJSONArray("view_names")
                ?: return ToolResult.error("'view_names' array required")
            val pw = args.optInt("panel_width_px", 256).coerceIn(16, MAX_RENDER_DIM)
            val ph = args.optInt("panel_height_px", 256).coerceIn(16, MAX_RENDER_DIM)
            val modeRaw = args.optString("mode", "paint")
            val mode = parseMode(modeRaw)
                ?: return ToolResult.error("Unknown mode '$modeRaw'.")
            if (mode == AiRenderEngine.RenderMode.TriangleId) {
                return ToolResult.error("triangle_id mode isn't supported in render_views_grid.")
            }
            val geom = AiIntrospection.geometry(bvh, bins = 1)
            val skipped = ArrayList<String>()
            val panels = ArrayList<ByteArray>()
            val panelWs = ArrayList<Int>()
            val panelHs = ArrayList<Int>()
            for (i in 0 until viewsRaw.length()) {
                val name = viewsRaw.optString(i).lowercase()
                val cam = if (name in AiRenderEngine.NAMED_PRESETS) {
                    AiRenderEngine.namedPreset(name, geom.bboxCenteredPreview, pw, ph)
                } else session.getCameraPreset(name)?.copy(widthPx = pw, heightPx = ph)
                if (cam == null) {
                    skipped.add(name); continue
                }
                val r = AiRenderEngine.render(
                    bvh = bvh,
                    camera = cam,
                    mode = mode,
                    palette = ws.previewPalette.value,
                    paintFilamentIndex = if (mode == AiRenderEngine.RenderMode.Paint) model.paintFilamentIndex else null,
                )
                panels.add(r.pngBytes); panelWs.add(r.widthPx); panelHs.add(r.heightPx)
            }
            if (panels.isEmpty()) return ToolResult.error("No valid view names produced renders.")
            // Compose by decoding each PNG into RGBA, blitting into a
            // bigger buffer, and re-encoding. We use the JDK ImageIO
            // for decode (this code path runs on Android too — JDK
            // classes available since API 21).
            val totalW = pw * panels.size
            val totalH = ph
            val composed = ByteArray(totalW * totalH * 4)
            for ((idx, png) in panels.withIndex()) {
                val img = decodePng(png) ?: continue
                blit(img, composed, totalW, totalH, idx * pw, 0, pw, ph)
            }
            // Fill any uncovered area with the 242,242,242 background.
            // (decodePng on a missing PNG is unlikely; this is paranoia.)
            for (off in 0 until composed.size step 4) {
                if (composed[off + 3] == 0.toByte()) {
                    composed[off] = 242.toByte()
                    composed[off + 1] = 242.toByte()
                    composed[off + 2] = 242.toByte()
                    composed[off + 3] = 255.toByte()
                }
            }
            val outPng = PngWriter.encodeRgba(composed, totalW, totalH)
            val token = AiSessionState.contentToken(
                model.id,
                "grid:${mode.name}:${(0 until viewsRaw.length()).joinToString { viewsRaw.optString(it) }}",
                AiRenderEngine.CameraSpec(FloatArray(16), FloatArray(16), totalW, totalH),
                paintContentVersion(model),
            )
            session.saveArtifact(AiSessionState.RenderArtifact(
                token = token,
                pngBytes = outPng,
                widthPx = totalW,
                heightPx = totalH,
                camera = AiRenderEngine.CameraSpec(FloatArray(16), FloatArray(16), totalW, totalH),
                triangleIdMap = null,
                createdAtMs = System.currentTimeMillis(),
            ))
            val inline = args.optBoolean("inline", false)
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("image_uri", buildResourceUri(token))
                put("render_token", token)
                put("bytes", outPng.size)
                put("width_px", totalW); put("height_px", totalH)
                put("panel_count", panels.size)
                put("panel_width_px", pw); put("panel_height_px", ph)
                if (skipped.isNotEmpty()) put("skipped_views", JSONArray().apply {
                    for (s in skipped) put(s)
                })
            }
            val text = "Rendered ${panels.size}-panel grid (${totalW}×${totalH})"
            val images = if (inline && outPng.size <= INLINE_BASE64_BYTE_CAP) {
                listOf(ToolResult.ImagePart(
                    mediaType = "image/png",
                    base64Data = Base64.getEncoder().encodeToString(outPng),
                ))
            } else emptyList()
            return ToolResult.ok(text, body, images)
        }

        private data class Decoded(val rgba: ByteArray, val w: Int, val h: Int)

        private fun decodePng(bytes: ByteArray): Decoded? {
            // JDK's ImageIO is available on the host; on Android we
            // could use BitmapFactory but for the grid composition
            // path we always have a freshly-encoded PNG, so we
            // fall back to a pure decode via a separate Bitmap when
            // ImageIO isn't there.
            return try {
                val img = javax.imageio.ImageIO.read(java.io.ByteArrayInputStream(bytes)) ?: return null
                val w = img.width; val h = img.height
                val rgba = ByteArray(w * h * 4)
                for (y in 0 until h) {
                    for (x in 0 until w) {
                        val argb = img.getRGB(x, y)
                        val o = (y * w + x) * 4
                        rgba[o] = ((argb shr 16) and 0xff).toByte()
                        rgba[o + 1] = ((argb shr 8) and 0xff).toByte()
                        rgba[o + 2] = (argb and 0xff).toByte()
                        rgba[o + 3] = ((argb shr 24) and 0xff).toByte()
                    }
                }
                Decoded(rgba, w, h)
            } catch (e: Throwable) {
                // On a real Android device javax.imageio may be absent
                // (it's not part of the Android API surface). Decode
                // via android.graphics.BitmapFactory in that case.
                decodePngAndroidFallback(bytes)
            }
        }

        /** Android-only fallback: BitmapFactory.decodeByteArray. We
         *  reflect to avoid a hard compile dep on android.graphics for
         *  unit tests running on host JVM. */
        private fun decodePngAndroidFallback(bytes: ByteArray): Decoded? {
            return try {
                val bfClass = Class.forName("android.graphics.BitmapFactory")
                val decode = bfClass.getMethod("decodeByteArray", ByteArray::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
                val bitmap = decode.invoke(null, bytes, 0, bytes.size) ?: return null
                val bClass = bitmap.javaClass
                val w = bClass.getMethod("getWidth").invoke(bitmap) as Int
                val h = bClass.getMethod("getHeight").invoke(bitmap) as Int
                val pixels = IntArray(w * h)
                bClass.getMethod("getPixels", IntArray::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType)
                    .invoke(bitmap, pixels, 0, w, 0, 0, w, h)
                val rgba = ByteArray(w * h * 4)
                for (i in 0 until w * h) {
                    val argb = pixels[i]
                    val o = i * 4
                    rgba[o] = ((argb shr 16) and 0xff).toByte()
                    rgba[o + 1] = ((argb shr 8) and 0xff).toByte()
                    rgba[o + 2] = (argb and 0xff).toByte()
                    rgba[o + 3] = ((argb shr 24) and 0xff).toByte()
                }
                Decoded(rgba, w, h)
            } catch (_: Throwable) { null }
        }

        private fun blit(src: Decoded, dst: ByteArray, dstW: Int, dstH: Int, dstX: Int, dstY: Int, dstWClip: Int, dstHClip: Int) {
            val cw = kotlin.math.min(src.w, dstWClip)
            val ch = kotlin.math.min(src.h, dstHClip)
            for (y in 0 until ch) {
                val srcRowOff = y * src.w * 4
                val dstRowOff = ((dstY + y) * dstW + dstX) * 4
                System.arraycopy(src.rgba, srcRowOff, dst, dstRowOff, cw * 4)
            }
        }
    }

    /**
     * Opinionated 6-view ortho montage. One tool call → one PNG laid
     * out as a 2×3 grid:
     *
     *     ┌────────┬────────┬────────┐
     *     │ FRONT  │  TOP   │ RIGHT  │
     *     ├────────┼────────┼────────┤
     *     │ BACK   │ BOTTOM │ LEFT   │
     *     └────────┴────────┴────────┘
     *
     * Each cell has a 1-pixel grid line; the cell's view name is burned
     * into the top-left corner so the model can read which face it's
     * looking at without separate tool calls. Use this as the FIRST
     * render call for a new model — it gives a small vision model
     * enough spatial context to pick anchors and seed paint regions
     * without iterating render_view 6 times.
     */
    class RenderMontage(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
    ) : Tool {
        override val name = "render_montage"
        override val description =
            "Render a 6-view ortho montage of the model in one PNG (2 rows × 3 columns: " +
                "front/top/right on top, back/bottom/left on bottom). Cheaper and clearer " +
                "than calling render_view six times — small vision models can read all six " +
                "faces of a 3D shape from one image. Each cell is labelled with its view " +
                "name. Pass `panel_size_px` to control per-cell resolution (default 256, " +
                "max 512). Use this BEFORE picking anchors / seeds for paint operations."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "panel_size_px" to Schemas.integer("Per-cell width=height (default 256, max 512)"),
                "inline" to Schemas.bool("If true and PNG ≤ 200 KB, also include base64 image part"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val resolved = resolveModelAndBvh(ws, args)
            if (resolved !is ResolvedModel.Found) return resolved.toError()
            val (model, bvh) = resolved.model to resolved.bvh
            val cell = args.optInt("panel_size_px", 256).coerceIn(64, 512)
            // Layout: row-major. Top row reads as "what the user sees if
            // they walk around the model clockwise"; bottom row is the
            // opposite faces.
            val views = listOf("front", "top", "right", "back", "bottom", "left")
            val cols = 3; val rows = 2
            val totalW = cell * cols
            val totalH = cell * rows
            val composed = ByteArray(totalW * totalH * 4)
            // Background fill so empty cells (rendering failures) don't
            // leak alpha=0 into the PNG.
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
            val geom = AiIntrospection.geometry(bvh, bins = 1)
            val rendered = ArrayList<String>(views.size)
            for ((idx, viewName) in views.withIndex()) {
                val cam = AiRenderEngine.namedPreset(viewName, geom.bboxCenteredPreview, cell, cell)
                val r = AiRenderEngine.render(
                    bvh = bvh,
                    camera = cam,
                    mode = AiRenderEngine.RenderMode.Paint,
                    palette = ws.previewPalette.value,
                    paintFilamentIndex = model.paintFilamentIndex,
                )
                val decoded = AiRenderEngine.decodePng(r.pngBytes) ?: continue
                val col = idx % cols
                val row = idx / cols
                blitInto(decoded, composed, totalW, col * cell, row * cell, cell, cell)
                burnLabel(composed, totalW, totalH, col * cell, row * cell, viewName.uppercase())
                rendered += viewName
            }
            // Cell separators — one-pixel lines on internal edges only.
            drawGrid(composed, totalW, totalH, cell, rows, cols)
            val outPng = dev.orcaxr.app.PngWriter.encodeRgba(composed, totalW, totalH)
            // Cache under a stable token so a re-call with the same paint
            // state hits the cache.
            val cacheCam = AiRenderEngine.CameraSpec(FloatArray(16), FloatArray(16), totalW, totalH)
            val token = AiSessionState.contentToken(
                model.id, "montage:${cell}", cacheCam, paintContentVersion(model),
            )
            session.saveArtifact(AiSessionState.RenderArtifact(
                token = token,
                pngBytes = outPng,
                widthPx = totalW,
                heightPx = totalH,
                camera = cacheCam,
                triangleIdMap = null,
                createdAtMs = System.currentTimeMillis(),
            ))
            val inline = args.optBoolean("inline", false)
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("image_uri", buildResourceUri(token))
                put("render_token", token)
                put("bytes", outPng.size)
                put("width_px", totalW)
                put("height_px", totalH)
                put("panel_size_px", cell)
                put("layout", "2x3 (rows×cols)")
                put("views", JSONArray().apply { for (v in views) put(v) })
                put("rendered_count", rendered.size)
            }
            val text = "Rendered 6-view montage (${totalW}×${totalH}, ${outPng.size} B)"
            val images = if (inline && outPng.size <= INLINE_BASE64_BYTE_CAP) {
                listOf(ToolResult.ImagePart(
                    mediaType = "image/png",
                    base64Data = Base64.getEncoder().encodeToString(outPng),
                ))
            } else emptyList()
            return ToolResult.ok(text, body, images)
        }

        private fun blitInto(
            src: AiRenderEngine.DecodedPng,
            dst: ByteArray, dstW: Int,
            dstX: Int, dstY: Int, dstWClip: Int, dstHClip: Int,
        ) {
            val cw = kotlin.math.min(src.widthPx, dstWClip)
            val ch = kotlin.math.min(src.heightPx, dstHClip)
            for (y in 0 until ch) {
                val srcRowOff = y * src.widthPx * 4
                val dstRowOff = ((dstY + y) * dstW + dstX) * 4
                System.arraycopy(src.rgba, srcRowOff, dst, dstRowOff, cw * 4)
            }
        }

        /** Draw a 1px black grid between cells. Skips outer border. */
        private fun drawGrid(buf: ByteArray, w: Int, h: Int, cell: Int, rows: Int, cols: Int) {
            for (c in 1 until cols) {
                val x = c * cell
                for (y in 0 until h) {
                    val o = (y * w + x) * 4
                    buf[o] = 32; buf[o + 1] = 32; buf[o + 2] = 32; buf[o + 3] = 255.toByte()
                }
            }
            for (r in 1 until rows) {
                val y = r * cell
                for (x in 0 until w) {
                    val o = (y * w + x) * 4
                    buf[o] = 32; buf[o + 1] = 32; buf[o + 2] = 32; buf[o + 3] = 255.toByte()
                }
            }
        }

        /**
         * Burn a 5×7 bitmap-font label into a corner of the cell. We
         * roll our own glyph table because we only need uppercase
         * letters and the PNG writer can't accept text. Letters live in
         * a 5-bit-wide × 7-row pattern; each row's bit pattern is in
         * [GLYPHS]. Scale=2 → 10×14 pixels per char, fits in a corner
         * of a 256² cell. White background pad (3 px) for legibility
         * over dark renders.
         */
        private fun burnLabel(buf: ByteArray, totalW: Int, totalH: Int, x0: Int, y0: Int, label: String) {
            val scale = 2
            val charW = 5 * scale
            val charH = 7 * scale
            val gap = scale
            val pad = 3
            val labelW = label.length * (charW + gap) - gap
            val labelH = charH
            val bx = x0 + 4
            val by = y0 + 4
            // White rounded background.
            for (yy in 0 until labelH + pad * 2) {
                for (xx in 0 until labelW + pad * 2) {
                    val px = bx + xx; val py = by + yy
                    if (px !in 0 until totalW || py !in 0 until totalH) continue
                    val o = (py * totalW + px) * 4
                    buf[o] = 255.toByte(); buf[o + 1] = 255.toByte(); buf[o + 2] = 255.toByte(); buf[o + 3] = 255.toByte()
                }
            }
            // Glyphs.
            for ((charIdx, ch) in label.withIndex()) {
                val glyph = GLYPHS[ch] ?: GLYPHS['?']!!
                val gx0 = bx + pad + charIdx * (charW + gap)
                val gy0 = by + pad
                for (row in 0 until 7) {
                    val bits = glyph[row]
                    for (col in 0 until 5) {
                        if ((bits shr (4 - col)) and 1 == 0) continue
                        for (sy in 0 until scale) for (sx in 0 until scale) {
                            val px = gx0 + col * scale + sx
                            val py = gy0 + row * scale + sy
                            if (px !in 0 until totalW || py !in 0 until totalH) continue
                            val o = (py * totalW + px) * 4
                            buf[o] = 16; buf[o + 1] = 16; buf[o + 2] = 16; buf[o + 3] = 255.toByte()
                        }
                    }
                }
            }
        }

        // 5×7 bitmap font, only the chars needed for the labels we burn:
        // FRONT, TOP, RIGHT, BACK, BOTTOM, LEFT, plus '?' as fallback.
        // Each int is a 5-bit row pattern; 7 rows per glyph, top-down.
        private companion object {
            private val GLYPHS: Map<Char, IntArray> = mapOf(
                'A' to intArrayOf(0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001),
                'B' to intArrayOf(0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110),
                'C' to intArrayOf(0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111),
                'E' to intArrayOf(0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111),
                'F' to intArrayOf(0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000),
                'G' to intArrayOf(0b01111, 0b10000, 0b10000, 0b10011, 0b10001, 0b10001, 0b01111),
                'H' to intArrayOf(0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001),
                'I' to intArrayOf(0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111),
                'K' to intArrayOf(0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001),
                'L' to intArrayOf(0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111),
                'M' to intArrayOf(0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001),
                'N' to intArrayOf(0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001),
                'O' to intArrayOf(0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110),
                'P' to intArrayOf(0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000),
                'R' to intArrayOf(0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001),
                'T' to intArrayOf(0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100),
                '?' to intArrayOf(0b01110, 0b10001, 0b00010, 0b00100, 0b00100, 0b00000, 0b00100),
            )
        }
    }

    // ---- Shared render path ----

    private suspend fun renderInternal(
        ws: WorkspaceModel,
        session: AiSessionState,
        args: JSONObject,
        defaultMode: String,
    ): ToolResult {
        if (!ws.attached.value) {
            return ToolResult.error("OrcaXR's main window isn't currently attached.")
        }
        val resolved = resolveModelAndBvh(ws, args)
        if (resolved !is ResolvedModel.Found) return resolved.toError()
        val (model, bvh) = resolved.model to resolved.bvh
        val w = args.optInt("width_px", DEFAULT_RENDER_DIM).coerceIn(16, MAX_RENDER_DIM)
        val h = args.optInt("height_px", DEFAULT_RENDER_DIM).coerceIn(16, MAX_RENDER_DIM)
        val modeRaw = args.optString("mode", defaultMode)
        val mode = parseMode(modeRaw)
            ?: return ToolResult.error("Unknown mode '$modeRaw'.")
        val camera = buildCamera(ws, session, bvh, args, w, h)
            ?: return ToolResult.error("Couldn't resolve camera (bad view_name / custom?).")
        val inline = args.optBoolean("inline", false)
        val annotate = args.optBoolean("annotate", false)
        // Cache hit? Annotate flag participates in the token so an
        // annotated render and a non-annotated render at the same
        // mode/view/paint state get distinct cache entries.
        val cacheKey = if (annotate) "${mode.name}:annot" else mode.name
        val token = AiSessionState.contentToken(model.id, cacheKey, camera, paintContentVersion(model))
        session.getArtifact(token)?.let { hit ->
            return packResult(model.id, camera, hit.pngBytes, token, inline, JSONObject().apply {
                put("cache_hit", true)
            })
        }
        val result = AiRenderEngine.render(
            bvh = bvh,
            camera = camera,
            // The on-bed renderer uses the live "as-will-print" palette
            // (Moonraker-loaded slots + mixed-filament resolution); we
            // mirror it here so Paint mode renders match what the user
            // sees on the headset. Falls back to AiRenderEngine's
            // FALLBACK_PALETTE if the workspace hasn't published one
            // yet (e.g. no printer selected).
            mode = mode,
            palette = ws.previewPalette.value,
            paintFilamentIndex = if (mode == AiRenderEngine.RenderMode.Paint) model.paintFilamentIndex else null,
            annotate = annotate,
        )
        session.saveArtifact(AiSessionState.RenderArtifact(
            token = token,
            pngBytes = result.pngBytes,
            widthPx = result.widthPx,
            heightPx = result.heightPx,
            camera = camera,
            triangleIdMap = result.triangleIdMap,
            createdAtMs = System.currentTimeMillis(),
        ))
        val extra = JSONObject().apply {
            put("cache_hit", false)
            if (mode == AiRenderEngine.RenderMode.TriangleId) {
                put("encoding", JSONObject().apply {
                    put("red_shift", 16); put("green_shift", 8); put("blue_shift", 0)
                    put("id_offset", 1)
                    put("background_rgb", JSONArray(listOf(0, 0, 0)))
                })
            }
        }
        return packResult(model.id, camera, result.pngBytes, token, inline, extra)
    }

    /** A change in any paint array bumps the model's content
     *  version implicitly via [PlacedModel] data-class equality;
     *  for the AI session cache we hash the ByteArrays themselves. */
    private fun paintContentVersion(model: PlacedModel): Int {
        var h = 0
        h = 31 * h + (model.paintFilamentIndex?.contentHashCode() ?: 0)
        h = 31 * h + (model.supportFlags?.contentHashCode() ?: 0)
        h = 31 * h + (model.seamFlags?.contentHashCode() ?: 0)
        h = 31 * h + (model.fuzzySkinFlags?.contentHashCode() ?: 0)
        return h
    }
}
