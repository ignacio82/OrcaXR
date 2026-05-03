package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.ModelVolumeType
import dev.orcaxr.app.PrimitiveKind
import dev.orcaxr.app.SlicerEngine
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * D12 — primitive shape authoring tools.
 *
 * `list_primitives` lets the LLM discover the available kinds and the
 * parameter names each one accepts. `add_primitive` builds a stock
 * primitive STL via libslic3r's `its_make_*` helpers, then routes it
 * through the same MCP actions the file-based flows use:
 *
 * - mode = "object"     ⇒ [WorkspaceAction.LoadModelFromPath] (Add)
 * - mode = "part"       ⇒ [WorkspaceAction.AddVolumeToModel] MODEL_PART
 * - mode = "negative"   ⇒ [WorkspaceAction.AddVolumeToModel] NEGATIVE_VOLUME
 * - mode = "modifier"   ⇒ [WorkspaceAction.AddVolumeToModel] PARAMETER_MODIFIER
 * - mode = "enforcer"   ⇒ [WorkspaceAction.AddVolumeToModel] SUPPORT_ENFORCER
 * - mode = "blocker"    ⇒ [WorkspaceAction.AddVolumeToModel] SUPPORT_BLOCKER
 *
 * STL output goes to `cacheDir/primitives/<kind>_<timestamp>.stl` —
 * cleared along with the rest of the cache when the user clears app
 * storage.
 */
internal object PrimitiveTools {

    fun all(ctx: ToolContext): List<Tool> {
        val workspace = WorkspaceModel.get()
        return listOf(
            ListPrimitives(),
            AddPrimitive(workspace, ctx),
        )
    }

    private fun primitiveDir(ctx: ToolContext): File {
        val dir = File(ctx.appContext.cacheDir, "primitives")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** mode string → ModelVolumeType (or null = "as object"). */
    private fun parseMode(raw: String): Mode? = when (raw.lowercase()) {
        "object", "" -> Mode.AsObject
        "part", "model_part" -> Mode.AsVolume(ModelVolumeType.MODEL_PART)
        "negative", "negative_volume" -> Mode.AsVolume(ModelVolumeType.NEGATIVE_VOLUME)
        "modifier", "parameter_modifier" -> Mode.AsVolume(ModelVolumeType.PARAMETER_MODIFIER)
        "enforcer", "support_enforcer" -> Mode.AsVolume(ModelVolumeType.SUPPORT_ENFORCER)
        "blocker", "support_blocker" -> Mode.AsVolume(ModelVolumeType.SUPPORT_BLOCKER)
        else -> null
    }

    private sealed interface Mode {
        data object AsObject : Mode
        data class AsVolume(val type: ModelVolumeType) : Mode
    }

    class ListPrimitives : Tool {
        override val name = "list_primitives"
        override val description =
            "Enumerate the primitive shapes add_primitive can build. Each entry includes " +
                "the kind name (cube/cylinder/sphere/cone/torus/disc/slab), the parameter " +
                "names in canonical order, and their default values (lengths in mm, angles " +
                "in degrees). Use this BEFORE add_primitive to know which params each kind " +
                "accepts."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val arr = JSONArray()
            for (k in PrimitiveKind.values()) {
                val obj = JSONObject().apply {
                    put("kind", k.name.lowercase())
                    put("display_name", k.displayName)
                    val names = JSONArray().also { for (n in k.paramNames) it.put(n) }
                    put("param_names", names)
                    val defaults = JSONObject()
                    for ((i, n) in k.paramNames.withIndex()) defaults.put(n, k.defaults[i])
                    put("defaults", defaults)
                }
                arr.put(obj)
            }
            val text = PrimitiveKind.values().joinToString("\n") { k ->
                "${k.name.lowercase()}: ${k.paramNames.zip(k.defaults.toList()).joinToString { "${it.first}=${it.second}" }}"
            }
            return ToolResult.ok(text, JSONObject().apply {
                put("ok", true)
                put("primitives", arr)
            })
        }
    }

    class AddPrimitive(
        private val ws: WorkspaceModel,
        private val ctx: ToolContext,
    ) : Tool {
        override val name = "add_primitive"
        override val description =
            "Build a stock primitive (cube / cylinder / sphere / cone / torus / disc / slab) " +
                "and add it to the workspace. mode=object (default) drops it on the bed as a " +
                "fresh PlacedModel; mode=part/negative/modifier/enforcer/blocker attaches it " +
                "as a volume on target_model_id (the latter four require D14's volume kinds). " +
                "params is a JSON object keyed by the names list_primitives reports for the " +
                "chosen kind — missing keys fall back to defaults. Lengths are mm, angles " +
                "are degrees."
        override val inputSchema = Schemas.obj(
            required = listOf("kind"),
            properties = mapOf(
                "kind" to Schemas.string(
                    "One of: cube, cylinder, sphere, cone, torus, disc, slab",
                ),
                "params" to Schemas.obj(
                    required = emptyList(),
                    properties = emptyMap(),
                    additionalProperties = true,
                ),
                "mode" to Schemas.string(
                    "object (default) | part | negative | modifier | enforcer | blocker",
                ),
                "target_model_id" to Schemas.string(
                    "Required when mode != object. Model to attach the volume to.",
                ),
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            val kindRaw = args.optString("kind").trim()
            val kind = PrimitiveKind.fromName(kindRaw)
                ?: return ToolResult.error(
                    "Unknown kind '$kindRaw'. Use one of: " +
                        PrimitiveKind.values().joinToString { it.name.lowercase() },
                )
            val mode = parseMode(args.optString("mode", "object").trim())
                ?: return ToolResult.error(
                    "Unknown mode '${args.optString("mode")}'. Use object|part|negative|" +
                        "modifier|enforcer|blocker.",
                )
            val targetId = args.optString("target_model_id").trim().takeIf { it.isNotEmpty() }
            if (mode is Mode.AsVolume) {
                if (targetId == null) {
                    return ToolResult.error("'target_model_id' is required when mode != object.")
                }
                if (ws.placedModels.value.none { it.id == targetId }) {
                    return ToolResult.error("No model with id '$targetId'.")
                }
            }

            // Decode params override object → kind-specific FloatArray.
            val overrides = HashMap<String, Float>()
            val paramsObj = args.optJSONObject("params")
            if (paramsObj != null) {
                val keys = paramsObj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val v = paramsObj.opt(k)
                    if (v is Number) overrides[k] = v.toFloat()
                }
            }
            for ((i, name) in kind.paramNames.withIndex()) {
                val v = overrides[name] ?: kind.defaults[i]
                if (!v.isFinite() || v <= 0f) {
                    return ToolResult.error(
                        "Param '$name' must be a positive finite number, got $v.",
                    )
                }
            }
            val params = kind.paramsFromMap(overrides)

            val outDir = primitiveDir(ctx)
            val outFile = File(
                outDir,
                "${kind.name.lowercase()}_${System.currentTimeMillis().toString(36)}.stl",
            )
            val built = SlicerEngine.buildPrimitiveStl(kind, params, outFile)
                ?: return ToolResult.error(
                    "Failed to build ${kind.name.lowercase()} primitive (see logcat).",
                )

            when (mode) {
                Mode.AsObject -> {
                    if (!ws.attached.value) {
                        return ToolResult.error(
                            "OrcaXR's main window isn't attached. Bring the app to the foreground.",
                        )
                    }
                    ws.emit(
                        WorkspaceAction.LoadModelFromPath(
                            built.absolutePath,
                            WorkspaceAction.LoadMode.Add,
                        ),
                    )
                }
                is Mode.AsVolume -> {
                    if (!ws.attached.value) {
                        return ToolResult.error(
                            "OrcaXR's main window isn't attached. Bring the app to the foreground.",
                        )
                    }
                    ws.emit(
                        WorkspaceAction.AddVolumeToModel(
                            modelId = targetId!!,
                            sourcePath = built.absolutePath,
                            type = mode.type.name,
                        ),
                    )
                }
            }

            val body = JSONObject().apply {
                put("ok", true)
                put("kind", kind.name.lowercase())
                put("mode", args.optString("mode", "object").lowercase())
                put("source_path", built.absolutePath)
                put("size_bytes", built.length())
                if (targetId != null) put("target_model_id", targetId)
                val paramsOut = JSONObject()
                for ((i, n) in kind.paramNames.withIndex()) paramsOut.put(n, params[i])
                put("params", paramsOut)
            }
            val msg = when (mode) {
                Mode.AsObject ->
                    "Adding ${kind.displayName} as a new model on the bed (${built.name})."
                is Mode.AsVolume ->
                    "Attaching ${kind.displayName} as ${mode.type.name} volume on $targetId."
            }
            return ToolResult.ok(msg, body)
        }
    }
}
