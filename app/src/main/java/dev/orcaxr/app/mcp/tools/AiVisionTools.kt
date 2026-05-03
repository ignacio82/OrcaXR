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
 * structuredContent (resolves to `/resources/<token>.png` on the MCP
 * server) and, if the PNG is small enough (< 200 KB), also inlines a
 * base64 image content part. The dispatcher streams the binary PNG
 * via the GET route added to [dev.orcaxr.app.mcp.McpServer].
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
     *  threaded; 1024² on a Benchy is ~600 ms on host JVM, expected
     *  ~2 s on Galaxy XR arm64. Larger renders are clamped down. */
    private const val MAX_RENDER_DIM = 1024
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
    )

    // ---- Helpers ----

    private suspend fun resolveModelAndBvh(
        ws: WorkspaceModel,
        args: JSONObject,
    ): Pair<PlacedModel, MeshBvh>? {
        val id = args.optString("model_id").trim()
        if (id.isEmpty()) return null
        val model = ws.placedModels.value.firstOrNull { it.id == id } ?: return null
        val bvh = ws.getBvh(id) ?: return null
        return model to bvh
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

    private fun packResult(
        modelId: String,
        camera: AiRenderEngine.CameraSpec,
        png: ByteArray,
        token: String,
        inlineRequested: Boolean,
        extra: JSONObject = JSONObject(),
    ): ToolResult {
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", modelId)
            put("image_uri", "mcp://resources/$token.png")
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
        val text = "Rendered ${camera.widthPx}×${camera.heightPx} png (${png.size} B); token=$token"
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
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH.")
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
                "includes image_uri the LLM can fetch via GET /resources/<token>.png; if inline=true " +
                "and the PNG is < 200 KB, also includes an inline base64 image content part."
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
                "id you can pass to paint_surface_region or paint_triangle_list."
        override val inputSchema = Schemas.obj(
            required = listOf("render_token", "x_px", "y_px"),
            properties = mapOf(
                "render_token" to Schemas.string("Token from render_triangle_id_map"),
                "x_px" to Schemas.integer("0..width-1"),
                "y_px" to Schemas.integer("0..height-1 (top-down origin)"),
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
            val body = JSONObject().apply {
                put("ok", true)
                put("render_token", token)
                put("x_px", x); put("y_px", y)
                put("tri_id", tri)
                put("hit", tri >= 0)
            }
            return ToolResult.ok(
                if (tri >= 0) "tri_id $tri at ($x, $y)" else "no triangle at ($x, $y) — pixel is background",
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
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH.")
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
                put("image_uri", "mcp://resources/$token.png")
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
        val (model, bvh) = resolveModelAndBvh(ws, args)
            ?: return ToolResult.error("Couldn't resolve model + BVH.")
        val w = args.optInt("width_px", DEFAULT_RENDER_DIM).coerceIn(16, MAX_RENDER_DIM)
        val h = args.optInt("height_px", DEFAULT_RENDER_DIM).coerceIn(16, MAX_RENDER_DIM)
        val modeRaw = args.optString("mode", defaultMode)
        val mode = parseMode(modeRaw)
            ?: return ToolResult.error("Unknown mode '$modeRaw'.")
        val camera = buildCamera(ws, session, bvh, args, w, h)
            ?: return ToolResult.error("Couldn't resolve camera (bad view_name / custom?).")
        val inline = args.optBoolean("inline", false)
        // Cache hit?
        val token = AiSessionState.contentToken(model.id, mode.name, camera, paintContentVersion(model))
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
