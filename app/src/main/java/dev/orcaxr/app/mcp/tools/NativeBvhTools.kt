package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiMaskProjection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.NativeBvh
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI paint pillar — Milestone 8b control surface.
 *
 * Three tools:
 *  - `set_native_bvh_enabled(enabled)` — flip the runtime toggle.
 *    Default off until on-device parity + speedup are confirmed.
 *  - `get_native_bvh_status()` — report whether the toggle is on
 *    AND whether the JNI symbol has been probed.
 *  - `benchmark_native_bvh(model_id, camera_descriptor, polygons,
 *      iterations?, depth_mode?, back_face_filter?)` — runs both
 *    the Kotlin and native paths against the same inputs, asserts
 *    the triangle sets match, and reports per-path timing. The
 *    parity assertion is the gate: if native diverges from Kotlin,
 *    the response surfaces the diff and `parity=false` so the user
 *    knows NOT to flip the toggle.
 *
 * The benchmark is the verification mechanism the design doc says
 * gates flipping the default. Run it on a real device against a
 * representative model before turning native on globally.
 */
internal object NativeBvhTools {

    fun all(ws: WorkspaceModel): List<Tool> = listOf(
        SetNativeBvhEnabled(),
        GetNativeBvhStatus(),
        BenchmarkNativeBvh(ws),
    )

    // ---- toggle ----

    class SetNativeBvhEnabled : Tool {
        override val name = "set_native_bvh_enabled"
        override val description =
            "Flip the runtime toggle for the native BVH ray-mask projection (M8b). When ON, " +
                "paint_projected_mask uses the C++ implementation; when OFF, the canonical " +
                "Kotlin path runs. Default OFF until benchmark_native_bvh confirms parity + " +
                "speedup on this device. The toggle is process-scoped and resets on app restart."
        override val inputSchema = Schemas.obj(
            required = listOf("enabled"),
            properties = mapOf(
                "enabled" to Schemas.bool("true to enable the native path; false for Kotlin"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!args.has("enabled")) return ToolResult.error("'enabled' is required")
            val want = args.optBoolean("enabled")
            val before = NativeBvh.isEnabled()
            NativeBvh.setEnabled(want)
            val body = JSONObject().apply {
                put("ok", true)
                put("enabled", want)
                put("changed", want != before)
                put("probed_available", NativeBvh.probedAvailableOrNull())
            }
            return ToolResult.ok(
                "native BVH toggle: ${if (before) "ON" else "OFF"} → ${if (want) "ON" else "OFF"}",
                body,
            )
        }
    }

    class GetNativeBvhStatus : Tool {
        override val name = "get_native_bvh_status"
        override val description =
            "Report whether the native BVH path is currently selected and whether the JNI symbol " +
                "has been probed. probed_available=null means no call has been made yet; true " +
                "means the symbol resolved at least once; false means UnsatisfiedLinkError was " +
                "caught and the path will fall back to Kotlin every time."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val body = JSONObject().apply {
                put("enabled", NativeBvh.isEnabled())
                put("probed_available", NativeBvh.probedAvailableOrNull())
                put("currently_active", NativeBvh.isEnabledAndAvailable)
            }
            return ToolResult.ok(
                "native BVH: enabled=${NativeBvh.isEnabled()}, " +
                    "probed=${NativeBvh.probedAvailableOrNull()}",
                body,
            )
        }
    }

    // ---- benchmark + parity ----

    class BenchmarkNativeBvh(private val ws: WorkspaceModel) : Tool {
        override val name = "benchmark_native_bvh"
        override val description =
            "Run paint_projected_mask's ray-mask projection through BOTH the Kotlin reference and " +
                "the native C++ path on the same inputs, assert the triangle sets are identical, " +
                "and report per-path timings. The toggle's default stays OFF; this tool is how " +
                "you decide whether to flip it. Authoring shape matches paint_projected_mask: " +
                "model_id + camera_descriptor + polygons (in pixel coords). The number of " +
                "iterations is configurable; each path runs that many times and reports min, " +
                "median, and max wall-clock ms. parity=true means native is safe to enable; " +
                "parity=false means there's a divergence the response details under " +
                "`parity_diff` (sample of triangles only in native, sample only in Kotlin)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "camera_descriptor", "polygons"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
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
                "polygons" to JSONObject().apply {
                    put("type", "array")
                    put("description", "Same shape as paint_projected_mask: list of flat [x1,y1,x2,y2,...] pixel coords")
                    put("items", JSONObject().apply {
                        put("type", "array")
                        put("items", Schemas.number(""))
                    })
                },
                "iterations" to Schemas.integer("Per-path repetitions for timing (default 5; clamped 1..50)"),
                "depth_mode" to Schemas.string(
                    "'front_facing_only' (default) | 'all_hits' | 'any_facing' | 'front_plus_thin'",
                ),
                "thickness_mm" to Schemas.number("Required when depth_mode='front_plus_thin'"),
                "back_face_filter" to Schemas.bool("Default true"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR's main window isn't attached.")
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required")
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't fetch BVH for '$modelId'.")
            val descriptor = args.optJSONObject("camera_descriptor")
                ?: return ToolResult.error("'camera_descriptor' is required")
            val view = descriptor.optJSONArray("view_matrix_4x4")
                ?: return ToolResult.error("camera_descriptor.view_matrix_4x4 missing")
            val proj = descriptor.optJSONArray("projection_matrix_4x4")
                ?: return ToolResult.error("camera_descriptor.projection_matrix_4x4 missing")
            if (view.length() != 16 || proj.length() != 16) {
                return ToolResult.error("view + proj matrices must each be 16 floats")
            }
            val w = descriptor.optInt("width_px", 0)
            val h = descriptor.optInt("height_px", 0)
            if (w <= 0 || h <= 0) return ToolResult.error("camera_descriptor.{width,height}_px > 0 required")
            val polysRaw = args.optJSONArray("polygons")
                ?: return ToolResult.error("'polygons' array required")
            val polys = ArrayList<FloatArray>(polysRaw.length())
            for (i in 0 until polysRaw.length()) {
                val p = polysRaw.optJSONArray(i) ?: continue
                if (p.length() % 2 != 0 || p.length() < 4) {
                    return ToolResult.error("polygon $i must have even coords ≥ 4")
                }
                val arr = FloatArray(p.length()) { p.optDouble(it, 0.0).toFloat() }
                polys.add(arr)
            }
            if (polys.isEmpty()) return ToolResult.error("at least one non-empty polygon required")
            val depthRaw = args.optString("depth_mode", "front_facing_only").lowercase()
            val depth: AiMaskProjection.DepthMode = when (depthRaw) {
                "", "front_facing_only", "front" -> AiMaskProjection.DepthMode.FrontFacingOnly
                "all_hits", "all" -> AiMaskProjection.DepthMode.AllHits
                "any_facing", "any", "lit" -> AiMaskProjection.DepthMode.AnyFacing
                "front_plus_thin", "thin", "shell" -> {
                    val t = (args.opt("thickness_mm") as? Number)?.toFloat()
                        ?: return ToolResult.error("'thickness_mm' required when depth_mode='front_plus_thin'")
                    if (t <= 0f) return ToolResult.error("thickness_mm must be > 0")
                    AiMaskProjection.DepthMode.FrontPlusThin(t)
                }
                else -> return ToolResult.error(
                    "depth_mode must be front_facing_only|all_hits|any_facing|front_plus_thin",
                )
            }
            val backFace = args.optBoolean("back_face_filter", true)
            val iters = args.optInt("iterations", 5).coerceIn(1, 50)

            val viewArr = FloatArray(16) { view.optDouble(it, 0.0).toFloat() }
            val projArr = FloatArray(16) { proj.optDouble(it, 0.0).toFloat() }
            val cam = AiRenderEngine.CameraSpec(viewArr, projArr, w, h)
            val mask = AiMaskProjection.rasterizePolygons(polys, w, h)
            val onPixels = mask.count { it }

            // Kotlin path — always runs.
            val kotlinTimes = LongArray(iters)
            var kotlinResult: IntArray = IntArray(0)
            for (i in 0 until iters) {
                val start = System.nanoTime()
                val r = AiMaskProjection.projectKotlin(bvh, cam, mask, depth, backFace)
                kotlinTimes[i] = System.nanoTime() - start
                if (i == 0) kotlinResult = r
            }

            // Native path — short-circuits if .so missing.
            val arrays = bvh.nativeBvhArraysView()
            val nativeTimes = LongArray(iters)
            var nativeResult: IntArray? = null
            var nativeAvailable = true
            for (i in 0 until iters) {
                val start = System.nanoTime()
                val r = NativeBvh.projectMask(arrays, cam, mask, depth, backFace)
                nativeTimes[i] = System.nanoTime() - start
                if (r == null) {
                    nativeAvailable = false
                    break
                }
                if (i == 0) nativeResult = r
            }

            // Parity: triangle SETS must match exactly.
            val parity = nativeResult != null && nativeResult!!.contentEquals(kotlinResult)
            val parityDiff = if (parity || nativeResult == null) null else {
                val nset = nativeResult!!.toHashSet()
                val kset = kotlinResult.toHashSet()
                val onlyNative = (nset - kset).sorted().take(64)
                val onlyKotlin = (kset - nset).sorted().take(64)
                JSONObject().apply {
                    put("only_in_native_count", (nset - kset).size)
                    put("only_in_kotlin_count", (kset - nset).size)
                    put("only_in_native_sample", JSONArray().apply { for (t in onlyNative) put(t) })
                    put("only_in_kotlin_sample", JSONArray().apply { for (t in onlyKotlin) put(t) })
                }
            }

            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("native_available", nativeAvailable)
                put("parity", parity)
                put("iterations", iters)
                put("mask_on_pixels", onPixels)
                put("kotlin_painted_count", kotlinResult.size)
                put("native_painted_count", nativeResult?.size ?: -1)
                put("kotlin_ms", JSONObject().apply {
                    put("min", nsToMs(kotlinTimes.min()))
                    put("median", nsToMs(median(kotlinTimes)))
                    put("max", nsToMs(kotlinTimes.max()))
                    put("mean", nsToMs(kotlinTimes.average().toLong()))
                })
                if (nativeAvailable && nativeResult != null) {
                    put("native_ms", JSONObject().apply {
                        put("min", nsToMs(nativeTimes.min()))
                        put("median", nsToMs(median(nativeTimes)))
                        put("max", nsToMs(nativeTimes.max()))
                        put("mean", nsToMs(nativeTimes.average().toLong()))
                    })
                    put("speedup_median",
                        median(kotlinTimes).toDouble() / median(nativeTimes).coerceAtLeast(1L))
                }
                if (parityDiff != null) put("parity_diff", parityDiff)
                put("hint", when {
                    !nativeAvailable -> "Native unavailable on this device — call set_native_bvh_enabled(false) and ship the Kotlin path."
                    !parity -> "Native diverges from Kotlin — DO NOT enable. Surface parity_diff to engineering."
                    else -> "Parity OK. If speedup_median > 1.5 you can call set_native_bvh_enabled(true)."
                })
            }
            val text = "benchmark_native_bvh: parity=$parity, " +
                "native_available=$nativeAvailable, iterations=$iters"
            return ToolResult.ok(text, body)
        }

        private fun nsToMs(ns: Long): Double = ns / 1_000_000.0

        private fun median(arr: LongArray): Long {
            if (arr.isEmpty()) return 0L
            val sorted = arr.sortedArray()
            val n = sorted.size
            return if (n % 2 == 1) sorted[n / 2]
            else (sorted[n / 2 - 1] + sorted[n / 2]) / 2L
        }
    }
}
