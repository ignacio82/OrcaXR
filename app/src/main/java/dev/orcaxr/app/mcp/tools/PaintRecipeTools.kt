package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.PaintCacheStore
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * D18j — persistent paint recipes. Save the current paint state of
 * a model under a user-chosen name; replay it later (on the same
 * source mesh) to restore that paint design. Distinct from the
 * existing `PaintCacheStore` (D1, SHA-keyed local cache) — recipes
 * are NAME-keyed, user-curated, survive cache evictions, and can
 * be applied across sessions.
 *
 * Storage: `${filesDir}/paint_recipes/<name>.bin` via a sibling
 * `PaintCacheStore` instance with `dirName="paint_recipes"`. Same
 * binary format as D1 (header + 4 ByteArrays for color/support/
 * seam/fuzzy) so the same Entry round-trips losslessly.
 *
 * Tools:
 *  - `save_paint_recipe(name, model_id)` — snapshot current state
 *  - `list_paint_recipes` — enumerate saved names
 *  - `load_paint_recipe(name, model_id)` — replay (one undo step
 *    via the new `LoadPaintState` action; tri count must match)
 *  - `delete_paint_recipe(name)` — remove from disk
 */
internal object PaintRecipeTools {

    fun all(ws: WorkspaceModel, ctx: ToolContext): List<Tool> {
        val store = PaintCacheStore(
            ctx = ctx.appContext,
            dirName = "paint_recipes",
            // Recipes are user-curated; bigger cap so saving one
            // doesn't evict another. Still bounded so a runaway
            // app doesn't exhaust filesDir.
            maxEntries = 200,
        )
        return listOf(
            SavePaintRecipe(ws, store),
            ListPaintRecipes(store),
            LoadPaintRecipe(ws, store),
            DeletePaintRecipe(store),
        )
    }

    class SavePaintRecipe(
        private val ws: WorkspaceModel,
        private val store: PaintCacheStore,
    ) : Tool {
        override val name = "save_paint_recipe"
        override val description =
            "Snapshot a model's current paint state (color + support + seam + fuzzy_skin) under a " +
                "user-chosen name. Survives across app restarts; not evicted by the SHA-keyed cache. " +
                "Pair with load_paint_recipe to replay the same paint design later. Returns the " +
                "byte counts per kind for verification."
        override val inputSchema = Schemas.obj(
            required = listOf("name", "model_id"),
            properties = mapOf(
                "name" to Schemas.string("Recipe name (lowercase, no path separators)"),
                "model_id" to Schemas.string("Model id from list_placed_models"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val rawName = args.optString("name").trim()
            if (rawName.isEmpty()) return ToolResult.error("'name' is required.")
            val name = sanitizeName(rawName)
                ?: return ToolResult.error("Invalid name '$rawName' (lowercase letters/digits/underscore/dash only).")
            val modelId = args.optString("model_id").trim()
            val m = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            val triCount = m.paintFilamentIndex?.size
                ?: m.supportFlags?.size
                ?: m.seamFlags?.size
                ?: m.fuzzySkinFlags?.size
                ?: return ToolResult.error("Model '$modelId' has no paint authored — nothing to save.")
            store.save(
                sourceHash = name,
                triCount = triCount,
                entry = PaintCacheStore.Entry(
                    paintFilamentIndex = m.paintFilamentIndex,
                    supportFlags = m.supportFlags,
                    seamFlags = m.seamFlags,
                    fuzzySkinFlags = m.fuzzySkinFlags,
                ),
            )
            val body = JSONObject().apply {
                put("ok", true); put("name", name); put("model_id", modelId)
                put("tri_count", triCount)
                put("color_bytes", m.paintFilamentIndex?.size ?: 0)
                put("support_bytes", m.supportFlags?.size ?: 0)
                put("seam_bytes", m.seamFlags?.size ?: 0)
                put("fuzzy_bytes", m.fuzzySkinFlags?.size ?: 0)
            }
            return ToolResult.ok("Saved recipe '$name' for model '$modelId' (${triCount} tris).", body)
        }
    }

    class ListPaintRecipes(private val store: PaintCacheStore) : Tool {
        override val name = "list_paint_recipes"
        override val description =
            "Enumerate saved paint recipe names (oldest-mtime first). Use save_paint_recipe to add " +
                "entries; load_paint_recipe to replay one onto a model with matching triangle count."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val names = store.list()
            val arr = JSONArray()
            for (n in names) arr.put(n)
            val body = JSONObject().apply {
                put("ok", true)
                put("count", names.size)
                put("names", arr)
            }
            val text = if (names.isEmpty()) "No saved paint recipes."
                else "${names.size} recipe(s): ${names.joinToString(", ")}"
            return ToolResult.ok(text, body)
        }
    }

    class LoadPaintRecipe(
        private val ws: WorkspaceModel,
        private val store: PaintCacheStore,
    ) : Tool {
        override val name = "load_paint_recipe"
        override val description =
            "Replay a saved recipe onto a model. Tri count must match — recipes are tied to a " +
                "specific source-mesh size (the triangle index space changes after any mesh-" +
                "mutating action like repair/cut/boolean/emboss). Routes through a single " +
                "LoadPaintState action so one recipe load = one paint_undo step."
        override val inputSchema = Schemas.obj(
            required = listOf("name", "model_id"),
            properties = mapOf(
                "name" to Schemas.string("Recipe name from list_paint_recipes"),
                "model_id" to Schemas.string("Model id"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val rawName = args.optString("name").trim()
            if (rawName.isEmpty()) return ToolResult.error("'name' is required.")
            val name = sanitizeName(rawName)
                ?: return ToolResult.error("Invalid name '$rawName'.")
            val modelId = args.optString("model_id").trim()
            val m = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            // Audit H11 (2026-05-07) — we used to require existing
            // paint state on the model just to learn the tri count
            // (and tell the user "paint a single stroke first"). Gross
            // UX. The BVH is the ground truth: its `triCount` matches
            // the model's mesh exactly, regardless of whether the user
            // has touched it. Fall back to it when no paint array is
            // present yet, then let the recipe-vs-bvh tri-count guard
            // surface a real mismatch ("recipe was authored on a
            // different mesh") instead of a fake "you must paint
            // first" requirement.
            val triCount = m.paintFilamentIndex?.size
                ?: m.supportFlags?.size
                ?: m.seamFlags?.size
                ?: m.fuzzySkinFlags?.size
                ?: ws.getBvh(modelId)?.triCount
                ?: -1
            if (triCount < 0) {
                return ToolResult.error(
                    "Model '$modelId' has no paint state and no BVH built yet. Re-select the " +
                        "model in paint mode (which builds the BVH lazily) and retry, or call any " +
                        "other paint tool first to warm the BVH.",
                )
            }
            val entry = store.restore(name, triCount)
                ?: return ToolResult.error(
                    "Recipe '$name' not found, corrupt, or tri-count mismatch (expected $triCount).",
                )
            ws.emit(WorkspaceAction.LoadPaintState(
                modelId = modelId,
                paintFilamentIndex = entry.paintFilamentIndex,
                supportFlags = entry.supportFlags,
                seamFlags = entry.seamFlags,
                fuzzySkinFlags = entry.fuzzySkinFlags,
            ))
            val body = JSONObject().apply {
                put("ok", true); put("name", name); put("model_id", modelId)
                put("tri_count", triCount)
                put("color_bytes", entry.paintFilamentIndex?.size ?: 0)
                put("support_bytes", entry.supportFlags?.size ?: 0)
                put("seam_bytes", entry.seamFlags?.size ?: 0)
                put("fuzzy_bytes", entry.fuzzySkinFlags?.size ?: 0)
            }
            return ToolResult.ok("Loaded recipe '$name' onto '$modelId'.", body)
        }
    }

    class DeletePaintRecipe(private val store: PaintCacheStore) : Tool {
        override val name = "delete_paint_recipe"
        override val description = "Delete a saved paint recipe by name. Returns ok=true even if it didn't exist."
        override val inputSchema = Schemas.obj(
            required = listOf("name"),
            properties = mapOf("name" to Schemas.string("Recipe name")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val rawName = args.optString("name").trim()
            if (rawName.isEmpty()) return ToolResult.error("'name' is required.")
            val name = sanitizeName(rawName)
                ?: return ToolResult.error("Invalid name '$rawName'.")
            val deleted = store.delete(name)
            return ToolResult.ok(
                if (deleted) "Deleted recipe '$name'." else "Recipe '$name' did not exist.",
                JSONObject().apply { put("ok", true); put("name", name); put("deleted", deleted) },
            )
        }
    }

    /** Sanitize a recipe name to safe filename chars. Strict —
     *  returns null if the raw input contains anything other than
     *  lowercase [a-z], digits, underscore, or hyphen. We don't
     *  silently lowercase: the LLM should pass clean names so
     *  list_paint_recipes always matches what was saved. */
    private fun sanitizeName(raw: String): String? {
        if (raw.isEmpty() || raw.length > 64) return null
        for (c in raw) {
            if (!(c in 'a'..'z' || c in '0'..'9' || c == '_' || c == '-')) return null
        }
        return raw
    }
}
