package dev.orcaxr.app.mcp.tools

import android.content.Context
import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.cbrt
import kotlin.math.log2
import kotlin.math.sqrt

/**
 * Recipe recommendation + palette suggestion. Two tools that turn the
 * "I just loaded a model — what can I do with it" cold-start problem
 * into a single round-trip.
 *
 * `find_similar_recipe` ranks the bundled paint templates against the
 * loaded model's geometric fingerprint and returns the top-k by
 * cosine similarity. The fingerprint dimensions are deliberately
 * coarse (bbox aspect ratio sorted, area/volume^(2/3) shape factor,
 * component count log-bucket, recess count log-bucket) so STL imports
 * with cosmetic vertex differences still cluster with their canonical
 * source. Recipes are tagged with a fingerprint block in their JSON.
 *
 * `suggest_palette_for_recipe` reads a recipe's `default_palette`
 * (tag-name → slot-int) and remaps each tag to the user's actual
 * filament inventory by RGB-distance match. Lets the LLM say
 * `paint_template(model_kind="...", palette_remap={"auto": true})` and
 * have the recipe paint with the user's nearest-available colors
 * instead of erroring out when slot 4 is configured for blue.
 */
internal object RecipeRecommendTools {

    fun all(ws: WorkspaceModel, ctx: ToolContext): List<Tool> = listOf(
        FindSimilarRecipe(ws, ctx),
        SuggestPaletteForRecipe(ws, ctx),
    )

    private const val ASSETS_DIR = "paint_templates"

    /** Common tag names → canonical RGB so the LLM's "yellow" /
     *  "black" / "red" tag names in a recipe map to filament colors
     *  the user has loaded. Keep small + obvious. */
    private val NAMED_COLOR_HEX: Map<String, String> = mapOf(
        "white" to "#FFFFFF",
        "black" to "#000000",
        "red" to "#FF0000",
        "green" to "#008000",
        "lime" to "#00FF00",
        "blue" to "#0000FF",
        "yellow" to "#FFFF00",
        "orange" to "#FF8000",
        "cyan" to "#00FFFF",
        "magenta" to "#FF00FF",
        "pink" to "#FFC0CB",
        "purple" to "#800080",
        "violet" to "#8A2BE2",
        "brown" to "#8B4513",
        "gray" to "#808080",
        "grey" to "#808080",
        "silver" to "#C0C0C0",
        "gold" to "#FFD700",
    )

    private fun listTemplateNames(ctx: Context): List<String> {
        val files = ctx.assets.list(ASSETS_DIR) ?: return emptyList()
        return files.filter { it.endsWith(".json") && it != "index.json" }
            .map { it.removeSuffix(".json") }
            .sorted()
    }

    private fun readTemplate(ctx: Context, name: String): JSONObject? {
        val safe = name.takeIf { it.matches(Regex("[a-z0-9_-]+")) } ?: return null
        return runCatching {
            ctx.assets.open("$ASSETS_DIR/$safe.json").bufferedReader().use { it.readText() }
        }.getOrNull()?.let { JSONObject(it) }
    }

    /**
     * Compute a 4-dim fingerprint of a mesh:
     *  - aspect[0..2]: bbox sizes / max(size), sorted ASCENDING. Always
     *    in [0, 1]; aspect[2] = 1 by construction.
     *  - shapeFactor: `surfaceArea / volume^(2/3)`, dimensionless.
     *    Sphere ≈ 4.84, cube = 6, plate-like → very high.
     *  - log2ComponentCount: log2(max(1, components)).
     *  - log2RecessCount: log2(1 + recesses).
     *
     * The vector is non-negative; cosine similarity over the
     * concatenation gives a stable similarity score.
     */
    data class Fingerprint(
        val aspectAscending: FloatArray,    // 3-vec, sorted ascending
        val shapeFactor: Float,
        val log2ComponentCount: Float,
        val log2RecessCount: Float,
    ) {
        fun toVec(): FloatArray = floatArrayOf(
            aspectAscending[0],
            aspectAscending[1],
            aspectAscending[2],
            (shapeFactor / 12f).coerceIn(0f, 2f),  // squash to a friendly range; sphere=0.4
            log2ComponentCount.coerceAtMost(6f) / 6f,
            log2RecessCount.coerceAtMost(5f) / 5f,
        )

        fun toJson(): JSONObject = JSONObject().apply {
            put("aspect_ascending", JSONArray().apply { for (v in aspectAscending) put(v.toDouble()) })
            put("shape_factor", shapeFactor.toDouble())
            put("log2_component_count", log2ComponentCount.toDouble())
            put("log2_recess_count", log2RecessCount.toDouble())
        }
    }

    fun computeFingerprint(bvh: MeshBvh): Fingerprint {
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val sizes = floatArrayOf(
            geom.bboxCenteredPreview.sizeX,
            geom.bboxCenteredPreview.sizeY,
            geom.bboxCenteredPreview.sizeZ,
        ).also { it.sort() }
        val maxSize = sizes[2].coerceAtLeast(1e-6f)
        val aspect = floatArrayOf(sizes[0] / maxSize, sizes[1] / maxSize, 1f)
        val v23 = cbrt(geom.volumeMm3.toDouble().coerceAtLeast(1e-9))
            .let { it * it }.toFloat()
        val shape = (geom.surfaceAreaMm2 / v23.coerceAtLeast(1e-6f)).coerceAtMost(64f)
        val components = AiIntrospection.components(bvh)
        val recesses = AiIntrospection.findRecessedFeatures(bvh, maxFeatures = 16)
            .filter { it.areaMm2 >= 5f }
        return Fingerprint(
            aspectAscending = aspect,
            shapeFactor = shape,
            log2ComponentCount = log2(components.size.coerceAtLeast(1).toFloat()),
            log2RecessCount = log2((recesses.size + 1).toFloat()),
        )
    }

    private fun cosineSim(a: FloatArray, b: FloatArray): Float {
        if (a.size != b.size) return 0f
        var dot = 0.0; var na = 0.0; var nb = 0.0
        for (i in a.indices) {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        if (na <= 0.0 || nb <= 0.0) return 0f
        return (dot / (sqrt(na) * sqrt(nb))).toFloat()
    }

    class FindSimilarRecipe(
        private val ws: WorkspaceModel,
        private val ctx: ToolContext,
    ) : Tool {
        override val name = "find_similar_recipe"
        override val description =
            "Rank bundled paint recipes by similarity to the loaded model. Computes a coarse " +
                "geometric fingerprint (bbox aspect ratio sorted, area/volume^(2/3) shape factor, " +
                "component-count bucket, recess-count bucket) and scores each recipe whose JSON " +
                "carries a fingerprint block. Returns top-k by cosine similarity (0..1). Use this " +
                "BEFORE paint_template when you don't know which recipe applies — e.g. user " +
                "loaded a generic 'cute_creature.stl', this surfaces 'funko_pop_pikachu' if it's " +
                "the closest match. Recipes without a fingerprint block are skipped (the legacy " +
                "filename-alias path in paint_template auto=true still covers those by name)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "k" to Schemas.integer("Top-k recipes to return (default 3, max 16)"),
                "min_similarity" to Schemas.number(
                    "Drop matches below this score (default 0.7). Lower for exploratory " +
                        "ranking; raise for high-confidence auto-apply.",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            val k = args.optInt("k", 3).coerceIn(1, 16)
            val minSim = (optFloat(args, "min_similarity") ?: 0.7f).coerceIn(0f, 1f)

            val modelFp = computeFingerprint(bvh)
            val modelVec = modelFp.toVec()

            val recipes = listTemplateNames(ctx.appContext)
                .mapNotNull { name -> readTemplate(ctx.appContext, name)?.let { name to it } }

            data class Scored(val name: String, val display: String, val sim: Float, val fp: JSONObject)
            val scored = ArrayList<Scored>()
            for ((name, json) in recipes) {
                val fpObj = json.optJSONObject("fingerprint") ?: continue
                val recipeFp = parseFingerprintFromJson(fpObj) ?: continue
                val sim = cosineSim(modelVec, recipeFp.toVec())
                if (sim < minSim) continue
                scored.add(Scored(
                    name = name,
                    display = json.optString("display_name", name),
                    sim = sim,
                    fp = fpObj,
                ))
            }
            scored.sortByDescending { it.sim }
            val top = scored.take(k)

            val arr = JSONArray()
            for (s in top) {
                arr.put(JSONObject().apply {
                    put("name", s.name)
                    put("display_name", s.display)
                    put("similarity", s.sim.toDouble())
                    put("recipe_fingerprint", s.fp)
                })
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("model_fingerprint", modelFp.toJson())
                put("k", k)
                put("min_similarity", minSim.toDouble())
                put("considered_count", recipes.size)
                put("matched_count", top.size)
                put("matches", arr)
                put("hint",
                    if (top.isEmpty())
                        "No recipe scored above $minSim. Try lowering min_similarity or pick manually via list_paint_templates."
                    else
                        "Apply the top match with paint_template(model_kind=\"${top.first().name}\", palette_remap={...}) " +
                            "or call suggest_palette_for_recipe to get an auto-mapped palette.")
            }
            return ToolResult.ok(
                "find_similar_recipe: ${top.size} match(es) above $minSim",
                body,
            )
        }

        private fun parseFingerprintFromJson(o: JSONObject): Fingerprint? {
            val aspectArr = o.optJSONArray("aspect_ascending") ?: return null
            if (aspectArr.length() != 3) return null
            val a = FloatArray(3) { aspectArr.optDouble(it, 0.0).toFloat() }
            val shape = optFloatJ(o, "shape_factor") ?: return null
            val lc = optFloatJ(o, "log2_component_count") ?: 0f
            val lr = optFloatJ(o, "log2_recess_count") ?: 0f
            return Fingerprint(a, shape, lc, lr)
        }
    }

    class SuggestPaletteForRecipe(
        private val ws: WorkspaceModel,
        private val ctx: ToolContext,
    ) : Tool {
        override val name = "suggest_palette_for_recipe"
        override val description =
            "Map a recipe's named palette tags to the user's actual filament slots by RGB-distance. " +
                "Reads the recipe's default_palette (e.g. {\"yellow\": 2, \"black\": 1}), looks up " +
                "each tag name in a small named-color table, and finds the closest hex match in " +
                "the live previewPalette. Returns a palette_remap suitable to pass to paint_template " +
                "verbatim. Falls back to the recipe's default slot when no filament is plausibly " +
                "close (no orange spool loaded, recipe wants orange → keep recipe default; the " +
                "user can override). Use this so paint_template works on a printer whose loaded " +
                "spools differ from the recipe's reference setup."
        override val inputSchema = Schemas.obj(
            required = listOf("recipe_name"),
            properties = mapOf(
                "recipe_name" to Schemas.string("Recipe name from list_paint_templates"),
                "max_color_distance" to Schemas.number(
                    "Maximum acceptable RGB distance (sqrt of sum-of-squared-channel-diffs, " +
                        "0..441). Beyond this the tag falls back to the recipe default. " +
                        "Default 96 — picks 'close enough' colors and leaves cosmetic differences.",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val recipeName = args.optString("recipe_name").trim()
            if (recipeName.isEmpty()) return ToolResult.error("'recipe_name' is required.")
            val recipe = readTemplate(ctx.appContext, recipeName)
                ?: return ToolResult.error("No recipe named '$recipeName'.")
            val defaultPalette = recipe.optJSONObject("default_palette")
                ?: return ToolResult.error("Recipe '$recipeName' has no default_palette.")
            val palette = ws.previewPalette.value
            val maxDist = (optFloat(args, "max_color_distance") ?: 96f).coerceIn(1f, 442f)

            val remap = JSONObject()
            val perTag = JSONArray()
            var matched = 0
            var fallback = 0
            for (key in defaultPalette.keys()) {
                val recipeSlot = defaultPalette.optInt(key, -1)
                val targetHex = NAMED_COLOR_HEX[key.lowercase()]
                    ?: key.takeIf { it.startsWith("#") || it.length == 6 }
                if (targetHex == null) {
                    // No reference RGB for this tag (an unusual name);
                    // pass through the recipe default.
                    remap.put(key, recipeSlot)
                    fallback++
                    perTag.put(JSONObject().apply {
                        put("tag", key)
                        put("recipe_slot", recipeSlot)
                        put("resolved_slot", recipeSlot)
                        put("matched", false)
                        put("reason", "no_named_color_for_tag")
                    })
                    continue
                }
                val target = parseHex(targetHex)
                if (target == null) {
                    remap.put(key, recipeSlot)
                    fallback++
                    continue
                }
                var bestSlot = -1
                var bestDistSq = Int.MAX_VALUE
                var bestHex = ""
                for ((idx, hex) in palette.withIndex()) {
                    val rgb = parseHex(hex) ?: continue
                    val d2 = colorDistanceSq(target, rgb)
                    if (d2 < bestDistSq) {
                        bestDistSq = d2; bestSlot = idx; bestHex = hex
                    }
                }
                val bestDist = sqrt(bestDistSq.toFloat())
                if (bestSlot >= 0 && bestDist <= maxDist) {
                    val tag = bestSlot + 1  // tags are 1-indexed (0 = unpainted)
                    remap.put(key, tag)
                    matched++
                    perTag.put(JSONObject().apply {
                        put("tag", key)
                        put("recipe_slot", recipeSlot)
                        put("resolved_slot", tag)
                        put("matched_filament_hex", bestHex)
                        put("color_distance", bestDist.toDouble())
                        put("matched", true)
                    })
                } else {
                    remap.put(key, recipeSlot)
                    fallback++
                    perTag.put(JSONObject().apply {
                        put("tag", key)
                        put("recipe_slot", recipeSlot)
                        put("resolved_slot", recipeSlot)
                        put("color_distance",
                            if (bestSlot >= 0) bestDist.toDouble() else JSONObject.NULL)
                        put("matched", false)
                        put("reason",
                            if (bestSlot < 0) "palette_empty"
                            else "no_filament_within_max_color_distance")
                    })
                }
            }

            val body = JSONObject().apply {
                put("ok", true)
                put("recipe_name", recipeName)
                put("palette_size", palette.size)
                put("matched_count", matched)
                put("fallback_count", fallback)
                put("palette_remap", remap)
                put("per_tag", perTag)
                put("hint",
                    "Pass `palette_remap` verbatim to paint_template. Tags marked matched=false " +
                        "kept the recipe default — set the user's expectation that those slots " +
                        "may not exist on this printer.")
            }
            return ToolResult.ok(
                "suggest_palette_for_recipe '$recipeName': $matched matched, $fallback fallback",
                body,
            )
        }

        private fun parseHex(s: String): IntArray? {
            val h = s.removePrefix("#").trim()
            if (h.length != 6) return null
            return runCatching {
                intArrayOf(
                    h.substring(0, 2).toInt(16),
                    h.substring(2, 4).toInt(16),
                    h.substring(4, 6).toInt(16),
                )
            }.getOrNull()
        }

        private fun colorDistanceSq(a: IntArray, b: IntArray): Int {
            val dr = a[0] - b[0]; val dg = a[1] - b[1]; val db = a[2] - b[2]
            return dr * dr + dg * dg + db * db
        }
    }

    private fun optFloat(o: JSONObject, key: String): Float? {
        if (!o.has(key)) return null
        return when (val v = o.opt(key)) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull()
            else -> null
        }
    }

    private fun optFloatJ(o: JSONObject, key: String): Float? = optFloat(o, key)
}
