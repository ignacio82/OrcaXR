package dev.orcaxr.app.mcp.tools

import android.content.Context
import dev.orcaxr.app.PaintTemplateResolver
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * D18i — paint templates. Bundled JSON recipes that paint canonical
 * model kinds (Funko Pop Pikachu, Benchy as a pirate ship, …) with
 * a single tool call. Each recipe is a list of paint primitive
 * invocations the tool dispatches in sequence; tags reference
 * named slots ("yellow", "black", "red", "white") which the
 * `palette_remap` argument or the recipe's `default_palette` maps
 * to numeric tags 1..MAX_PAINT_SLOTS.
 *
 * Distinct from D18j (persistent paint recipes):
 *  - D18i recipes are immutable assets, work on any tri count
 *    (paint primitives compute their own triangle sets), reusable
 *    across models of the same shape.
 *  - D18j recipes are user-saved snapshots, tied to a specific
 *    source mesh tri count.
 */
internal object PaintTemplateTools {

    fun all(ws: WorkspaceModel, ctx: ToolContext, paintTools: List<Tool>): List<Tool> = listOf(
        PaintTemplate(ws, ctx, paintTools),
        ListPaintTemplates(ctx),
    )

    private const val ASSETS_DIR = "paint_templates"

    private fun listTemplateNames(ctx: Context): List<String> {
        val files = ctx.assets.list(ASSETS_DIR) ?: return emptyList()
        return files.filter { it.endsWith(".json") }.map { it.removeSuffix(".json") }.sorted()
    }

    private fun readTemplate(ctx: Context, name: String): JSONObject? {
        val safe = name.takeIf { it.matches(Regex("[a-z0-9_-]+")) } ?: return null
        return runCatching {
            ctx.assets.open("$ASSETS_DIR/$safe.json").bufferedReader().use { it.readText() }
        }.getOrNull()?.let { JSONObject(it) }
    }

    class ListPaintTemplates(private val ctx: ToolContext) : Tool {
        override val name = "list_paint_templates"
        override val description =
            "List bundled paint templates (canonical recipes for known model kinds). Use " +
                "paint_template(model_kind=<name>) to apply one. Each entry includes the recipe's " +
                "display_name + description + step_count + axis-up convention so the LLM can pick " +
                "the right recipe for the loaded model."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val names = listTemplateNames(ctx.appContext)
            val arr = JSONArray()
            for (n in names) {
                val obj = readTemplate(ctx.appContext, n) ?: continue
                arr.put(JSONObject().apply {
                    put("name", n)
                    put("display_name", obj.optString("display_name", n))
                    put("description", obj.optString("description", ""))
                    put("step_count", obj.optJSONArray("steps")?.length() ?: 0)
                    put("model_axis_up", obj.optString("model_axis_up", "z"))
                    obj.optJSONObject("default_palette")?.let { put("default_palette", it) }
                })
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("count", names.size)
                put("templates", arr)
            }
            return ToolResult.ok(
                "${names.size} paint template(s): ${names.joinToString(", ")}",
                body,
            )
        }
    }

    class PaintTemplate(
        private val ws: WorkspaceModel,
        private val ctx: ToolContext,
        private val paintTools: List<Tool>,
    ) : Tool {
        override val name = "paint_template"
        override val description =
            "Apply a bundled paint template to a model. Two ways to pick the recipe: pass " +
                "model_kind=<name> from list_paint_templates explicitly, OR pass auto=true and " +
                "OrcaXR fingerprints the model's source file (3MF MakerWorld design id, then " +
                "SHA-256, then filename alias from the bundled `index.json`). When auto=true " +
                "doesn't find a match the tool returns a structured 'no recipe — pick manually " +
                "or try find_feature_anchors / get_curvature_segmentation / get_mask_for_text' " +
                "hint instead of erroring. The recipe's named tags (e.g. 'yellow', 'black') " +
                "resolve via palette_remap (caller-supplied) or the recipe's default_palette, " +
                "mapping each name to a numeric paint slot 1..MAX_PAINT_SLOTS. Most recipes " +
                "assume a specific orientation (model_axis_up); the LLM should verify the loaded " +
                "model matches before applying."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_kind" to Schemas.string(
                    "Recipe name from list_paint_templates (omit when auto=true)",
                ),
                "model_id" to Schemas.string("Model id"),
                "palette_remap" to Schemas.obj(),
                "auto" to Schemas.bool(
                    "If true and model_kind is omitted, fingerprint the loaded model and look " +
                        "up the recipe in the bundled index. Default false.",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val placed = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")

            // Resolve the recipe name. Explicit model_kind always
            // wins; auto=true falls back to the fingerprint resolver.
            val explicitKind = args.optString("model_kind").trim().takeIf { it.isNotEmpty() }
            val auto = args.optBoolean("auto", false)
            val resolution: PaintTemplateResolver.Resolution? = when {
                explicitKind != null -> null  // explicit path; no auto-resolution metadata
                auto -> {
                    val source = placed.originalSource ?: placed.source
                    PaintTemplateResolver.resolve(ctx.appContext, source)
                }
                else -> null
            }
            val kind = explicitKind ?: resolution?.recipeName
            if (kind == null) {
                val source = placed.originalSource ?: placed.source
                val body = JSONObject().apply {
                    put("ok", false)
                    put("auto", auto)
                    put("model_id", modelId)
                    put("source_filename", source.name)
                    put("hint", "no_recipe")
                    put("available", JSONArray().apply {
                        for (n in listTemplateNames(ctx.appContext)) put(n)
                    })
                    put("next_steps", JSONArray().apply {
                        put("Pass model_kind=<name> explicitly from list_paint_templates")
                        put("Run find_feature_anchors / get_curvature_segmentation to derive a custom paint")
                        put("Save a recipe via save_paint_recipe after a manual paint pass")
                    })
                }
                val text = if (auto) {
                    "No bundled recipe matched '${source.name}'. Pick manually via list_paint_templates."
                } else {
                    "Pass model_kind=<name> or auto=true."
                }
                return ToolResult.error(text, body)
            }
            val recipe = readTemplate(ctx.appContext, kind)
                ?: return ToolResult.error("No paint template named '$kind'. Try list_paint_templates.")
            // Resolve the palette: caller's remap takes precedence,
            // then the recipe's default_palette.
            val palette = HashMap<String, Int>()
            recipe.optJSONObject("default_palette")?.let { dp ->
                for (k in dp.keys()) palette[k] = dp.optInt(k, 0)
            }
            args.optJSONObject("palette_remap")?.let { rm ->
                for (k in rm.keys()) palette[k] = rm.optInt(k, 0)
            }
            val steps = recipe.optJSONArray("steps")
                ?: return ToolResult.error("Recipe '$kind' has no steps.")
            val resultsArr = JSONArray()
            var totalPainted = 0
            var firstError: String? = null
            for (i in 0 until steps.length()) {
                val step = steps.optJSONObject(i) ?: continue
                val toolName = step.optString("tool")
                val rawArgs = step.optJSONObject("arguments") ?: continue
                val tool = paintTools.firstOrNull { it.name == toolName }
                if (tool == null) {
                    val msg = "Step $i: unknown tool '$toolName'"
                    if (firstError == null) firstError = msg
                    resultsArr.put(JSONObject().apply { put("step", i); put("error", msg) })
                    continue
                }
                // Resolve named tags within this step's args.
                val resolvedArgs = resolveTags(rawArgs, palette, modelId)
                val r = tool.call(resolvedArgs)
                val stepObj = JSONObject().apply {
                    put("step", i)
                    put("tool", toolName)
                    if (step.has("comment")) put("comment", step.optString("comment"))
                }
                if (r.isError) {
                    stepObj.put("error", r.text)
                    if (firstError == null) firstError = "Step $i: ${r.text}"
                } else {
                    val pc = r.structured?.optInt("painted_count", -1) ?: -1
                    if (pc >= 0) { stepObj.put("painted_count", pc); totalPainted += pc }
                }
                resultsArr.put(stepObj)
            }
            val body = JSONObject().apply {
                put("ok", firstError == null)
                put("model_kind", kind)
                put("model_id", modelId)
                put("step_count", steps.length())
                put("total_painted", totalPainted)
                put("steps", resultsArr)
                if (firstError != null) put("first_error", firstError)
                if (resolution != null) {
                    put("auto_resolved", true)
                    put("matched_by", resolution.matchedBy.name.lowercase())
                    put("matched_key", resolution.key)
                }
            }
            val resolvedNote = if (resolution != null) {
                " (auto-resolved via ${resolution.matchedBy.name.lowercase()})"
            } else ""
            val text = "Applied template '$kind'$resolvedNote to '$modelId': " +
                "${steps.length()} steps, $totalPainted total painted" +
                if (firstError != null) " (first error: $firstError)" else ""
            return if (firstError == null) ToolResult.ok(text, body)
                else ToolResult.error(text, body)
        }

        /** Walk the args tree and replace any string-valued `tag` /
         *  `where_tag` field with the palette's numeric mapping.
         *  Modifies a deep clone, doesn't mutate the recipe. */
        private fun resolveTags(args: JSONObject, palette: Map<String, Int>, modelId: String): JSONObject {
            val out = JSONObject(args.toString())
            out.put("model_id", modelId)
            for (key in listOf("tag", "where_tag")) {
                if (out.has(key)) {
                    val v = out.opt(key)
                    if (v is String) {
                        val mapped = palette[v]
                            ?: throw IllegalArgumentException(
                                "tag '$v' missing from palette (provide palette_remap)",
                            )
                        out.put(key, mapped)
                    }
                }
            }
            return out
        }
    }
}
