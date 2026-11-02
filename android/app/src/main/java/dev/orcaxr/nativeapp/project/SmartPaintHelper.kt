package dev.orcaxr.nativeapp.project

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import dev.orcaxr.core.FilamentOption
import dev.orcaxr.core.ProjectSmartPaint
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.nativeapp.ai.ColorNames
import dev.orcaxr.nativeapp.ai.LlmModelManager
import dev.orcaxr.nativeapp.mcp.McpJson
import kotlinx.coroutines.runBlocking

object SmartPaintHelper {
    private const val TAG = "SmartPaintHelper"

    /**
     * Extracts a JSON object payload from LLM responses, stripping Markdown fences if present.
     */
    fun extractJsonPayload(text: String): String? {
        val trimmed = text.trim()
        val jsonBlockRegex = Regex("```(?:json)?\\s*([\\s\\S]*?)\\s*```")
        val match = jsonBlockRegex.find(trimmed)
        val candidate = match?.groupValues?.get(1)?.trim() ?: run {
            val firstBrace = trimmed.indexOf('{')
            val lastBrace = trimmed.lastIndexOf('}')
            if (firstBrace != -1 && lastBrace > firstBrace) {
                trimmed.substring(firstBrace, lastBrace + 1)
            } else null
        }
        return candidate
    }

    /**
     * Fallback deterministic geometric heuristic proposal generator when no LLM is available.
     * Uses normalized model bounding box [0..1] and normal vectors.
     */
    fun generateHeuristicProposalMap(prompt: String): Map<String, Any> {
        val regions = mutableListOf<Map<String, Any>>()
        val lower = prompt.lowercase()
        val isHalf = lower.contains("half")
        val isThird = lower.contains("third")
        val isQuarter = lower.contains("quarter")

        if (lower.contains("top") || lower.contains("roof") || lower.contains("upper")) {
            val zMin = when {
                isHalf -> 0.5
                isThird -> 0.67
                isQuarter -> 0.75
                else -> 0.6
            }
            regions.add(mapOf(
                "id" to "region_top",
                "label" to if (isHalf) "Top Half" else "Top / Upper Surface",
                "confidence" to 0.95,
                "shape" to mapOf(
                    "kind" to "box",
                    "min" to listOf(0.0, 0.0, zMin),
                    "max" to listOf(1.0, 1.0, 1.0),
                ),
            ))
        }
        if (lower.contains("bottom") || lower.contains("base") || lower.contains("lower")) {
            val zMax = when {
                isHalf -> 0.5
                isThird -> 0.33
                isQuarter -> 0.25
                else -> 0.4
            }
            regions.add(mapOf(
                "id" to "region_bottom",
                "label" to if (isHalf) "Bottom Half" else "Base / Lower Surface",
                "confidence" to 0.90,
                "shape" to mapOf(
                    "kind" to "box",
                    "min" to listOf(0.0, 0.0, 0.0),
                    "max" to listOf(1.0, 1.0, zMax),
                ),
            ))
        }
        if (lower.contains("overhang") || lower.contains("support")) {
            regions.add(mapOf(
                "id" to "region_overhang",
                "label" to "Downward Overhangs",
                "confidence" to 0.88,
                "shape" to mapOf(
                    "kind" to "direction",
                    "axis" to listOf(0.0, 0.0, -1.0),
                    "maxAngleDeg" to 45.0,
                ),
            ))
        }
        if (lower.contains("front")) {
            regions.add(mapOf(
                "id" to "region_front",
                "label" to "Front Face",
                "confidence" to 0.90,
                "shape" to mapOf(
                    "kind" to "box",
                    "min" to listOf(0.0, 0.0, 0.0),
                    "max" to listOf(1.0, 0.5, 1.0),
                ),
            ))
        }
        if (lower.contains("back") || lower.contains("rear")) {
            regions.add(mapOf(
                "id" to "region_back",
                "label" to "Back Face",
                "confidence" to 0.90,
                "shape" to mapOf(
                    "kind" to "box",
                    "min" to listOf(0.0, 0.5, 0.0),
                    "max" to listOf(1.0, 1.0, 1.0),
                ),
            ))
        }
        if (regions.isEmpty()) {
            regions.add(mapOf(
                "id" to "region_top",
                "label" to "Top Region",
                "confidence" to 0.92,
                "shape" to mapOf(
                    "kind" to "box",
                    "min" to listOf(0.0, 0.0, 0.5),
                    "max" to listOf(1.0, 1.0, 1.0),
                ),
            ))
            regions.add(mapOf(
                "id" to "region_bottom",
                "label" to "Bottom Region",
                "confidence" to 0.89,
                "shape" to mapOf(
                    "kind" to "box",
                    "min" to listOf(0.0, 0.0, 0.0),
                    "max" to listOf(1.0, 1.0, 0.5),
                ),
            ))
        }
        return mapOf(
            "schemaVersion" to 1,
            "regions" to regions,
        )
    }

    /**
     * Generates a proposal JSON string using on-device local LLM (TPU Gemini Nano / LiteRT Gemma)
     * if active and available, falling back to heuristic parsing if needed.
     */
    fun generateProposal(
        context: Context,
        volumeId: String,
        prompt: String,
        imageUri: Uri? = null,
        workspace: ProjectWorkspace,
    ): String {
        val lower = prompt.trim().lowercase()
        val isStandardGeometric = imageUri == null && (
            lower.contains("top") || lower.contains("bottom") ||
            lower.contains("half") || lower.contains("roof") ||
            lower.contains("base") || lower.contains("overhang") ||
            lower.contains("support") || lower.contains("front") ||
            lower.contains("back") || lower.contains("rear") ||
            lower.contains("lower") || lower.contains("upper")
        )
        if (isStandardGeometric) {
            val proposalMap = generateHeuristicProposalMap(prompt)
            val proposalJson = McpJson.stringify(proposalMap)
            val validationJson = try {
                ProjectSmartPaint.validateProposal(proposalJson)
            } catch (t: Throwable) {
                null
            }
            if (validationJson != null) {
                val parsed = McpJson.parseObject(validationJson)
                if (parsed?.get("valid") == true) {
                    Log.i(TAG, "Using fast deterministic geometric proposal for prompt: $prompt")
                    return proposalJson
                }
            }
        }

        val geomDescJson = try {
            workspace.smartPaintDescribe(volumeId).get()
        } catch (t: Throwable) {
            "{}"
        }

        val modelManager = LlmModelManager.getInstance(context)
        val engine = modelManager.activeEngine.value
        if (engine != null) {
            try {
                val bitmaps = if (imageUri != null) {
                    try {
                        context.contentResolver.openInputStream(imageUri)?.use { stream ->
                            BitmapFactory.decodeStream(stream)?.let { listOf(it) }
                        } ?: emptyList()
                    } catch (_: Throwable) {
                        emptyList()
                    }
                } else {
                    emptyList()
                }

                val systemInstruction = """
You plan colour/support regions for a 3D print model. Reply with JSON ONLY, matching exactly:
{"schemaVersion":1,"regions":[{"id":string,"label":string,"confidence":number,"shape":Shape}]}
Shape is either {"kind":"box","min":[x,y,z],"max":[x,y,z]} with every component in [0,1] in the model's own normalized bounding box, or
{"kind":"direction","axis":[x,y,z],"maxAngleDeg":number} selecting faces whose outward normal lies within maxAngleDeg of axis.
confidence is in [0,1]. Do not return polygons, colours, or filament names.
Model geometry: $geomDescJson
User prompt: $prompt
                """.trimIndent()

                val llmResponse = runBlocking { engine.runInference(systemInstruction, bitmaps) }
                val extractedJson = extractJsonPayload(llmResponse)
                if (extractedJson != null) {
                    val validationJson = ProjectSmartPaint.validateProposal(extractedJson)
                    val parsedVal = McpJson.parseObject(validationJson)
                    if (parsedVal?.get("valid") == true) {
                        Log.i(TAG, "Generated valid Smart Paint proposal using on-device ${engine.backendName}")
                        return extractedJson
                    } else {
                        Log.w(TAG, "Local LLM proposal invalid: ${parsedVal?.get("message")}")
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Local LLM proposal generation failed, falling back to heuristics", t)
            }
        }

        return McpJson.stringify(generateHeuristicProposalMap(prompt))
    }

    /**
     * Resolves human/LLM region assignments into the concrete wire format
     * expected by [ProjectSmartPaint.buildBatch].
     */
    fun resolveAssignments(
        assignmentsRaw: Map<*, *>,
        projection: SmartPaintProjectionData,
        filaments: List<FilamentOption>,
        channel: String,
    ): List<Map<String, Any>> {
        val result = mutableListOf<Map<String, Any>>()
        val isColor = channel.equals("color", ignoreCase = true)

        for (region in projection.regions) {
            var assignedValue: Any? = assignmentsRaw[region.id]
            if (assignedValue == null) {
                for ((k, v) in assignmentsRaw) {
                    val keyStr = k.toString().lowercase()
                    if (region.id.lowercase().contains(keyStr) ||
                        region.label.lowercase().contains(keyStr) ||
                        keyStr.contains(region.id.lowercase())) {
                        assignedValue = v
                        break
                    }
                }
            }

            if (assignedValue == null) continue

            val finalValue: String = if (isColor) {
                val assignedStr = assignedValue.toString().trim()
                if (assignedStr.equals("unpainted", ignoreCase = true) || assignedStr.equals("erase", ignoreCase = true)) {
                    "unpainted"
                } else {
                    ColorNames.findFilamentIdByColorOrNumber(assignedValue, filaments) ?: assignedStr
                }
            } else {
                assignedValue.toString().lowercase()
            }

            result.add(mapOf(
                "regionId" to region.id,
                "value" to finalValue,
                "excludedTriangles" to emptyList<Int>(),
            ))
        }

        return result
    }

    fun resolveAssignmentsJson(
        assignmentsRaw: Map<*, *>,
        projection: SmartPaintProjectionData,
        filaments: List<FilamentOption>,
        channel: String,
    ): String = McpJson.stringify(resolveAssignments(assignmentsRaw, projection, filaments, channel))
}
