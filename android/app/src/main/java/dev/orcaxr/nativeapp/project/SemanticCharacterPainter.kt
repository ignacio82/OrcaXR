package dev.orcaxr.nativeapp.project

import android.content.Context
import android.util.Log
import dev.orcaxr.core.FilamentOption
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectSmartPaint
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.nativeapp.ai.ColorNames
import dev.orcaxr.nativeapp.ai.LlmModelManager
import dev.orcaxr.nativeapp.mcp.McpJson
import kotlinx.coroutines.runBlocking
import java.util.UUID

data class SemanticRegion(
    val id: String,
    val label: String,
    val targetHex: String,
    val shape: Map<String, Any>,
)

data class SemanticCharacterPreset(
    val name: String,
    val keywords: List<String>,
    val regions: List<SemanticRegion>,
)

data class SemanticPaintResult(
    val character: String,
    val paletteMode: String,
    val regionsPainted: Int,
    val colorBreakdown: String,
    val spokenSummary: String,
)

object SemanticCharacterPainter {
    private const val TAG = "SemanticPainter"

    val PRESETS = listOf(
        SemanticCharacterPreset(
            name = "Pikachu",
            keywords = listOf("pikachu", "pika", "electric mouse"),
            regions = listOf(
                SemanticRegion(
                    id = "pikachu_body",
                    label = "Yellow Body",
                    targetHex = "#FFDE00",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.0),
                        "max" to listOf(1.0, 1.0, 0.82),
                    ),
                ),
                SemanticRegion(
                    id = "pikachu_cheeks",
                    label = "Red Cheeks",
                    targetHex = "#E22B22",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.35),
                        "max" to listOf(1.0, 0.45, 0.65),
                    ),
                ),
                SemanticRegion(
                    id = "pikachu_ears",
                    label = "Black Ear Tips",
                    targetHex = "#161616",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.82),
                        "max" to listOf(1.0, 1.0, 1.0),
                    ),
                ),
            ),
        ),
        SemanticCharacterPreset(
            name = "Pumpkin",
            keywords = listOf("pumpkin", "jack-o-lantern", "jackolantern", "fidget cube"),
            regions = listOf(
                SemanticRegion(
                    id = "pumpkin_body",
                    label = "Orange Body",
                    targetHex = "#FF6A13",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.0),
                        "max" to listOf(1.0, 1.0, 0.86),
                    ),
                ),
                SemanticRegion(
                    id = "pumpkin_face",
                    label = "Black Cutout Face",
                    targetHex = "#161616",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.15, 0.0, 0.25),
                        "max" to listOf(0.85, 0.35, 0.75),
                    ),
                ),
                SemanticRegion(
                    id = "pumpkin_stem",
                    label = "Green Stem",
                    targetHex = "#2E7D32",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.35, 0.35, 0.86),
                        "max" to listOf(0.65, 0.65, 1.0),
                    ),
                ),
            ),
        ),
        SemanticCharacterPreset(
            name = "Frog",
            keywords = listOf("frog", "toad", "amphibian"),
            regions = listOf(
                SemanticRegion(
                    id = "frog_body",
                    label = "Green Body",
                    targetHex = "#388E3C",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.0),
                        "max" to listOf(1.0, 1.0, 1.0),
                    ),
                ),
                SemanticRegion(
                    id = "frog_belly",
                    label = "Cream Belly",
                    targetHex = "#FFF59D",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.2, 0.0, 0.0),
                        "max" to listOf(0.8, 0.45, 0.55),
                    ),
                ),
                SemanticRegion(
                    id = "frog_eyes",
                    label = "Red Eyes",
                    targetHex = "#D32F2F",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.1, 0.1, 0.75),
                        "max" to listOf(0.9, 0.6, 1.0),
                    ),
                ),
            ),
        ),
        SemanticCharacterPreset(
            name = "Fox",
            keywords = listOf("fox", "kitsune"),
            regions = listOf(
                SemanticRegion(
                    id = "fox_body",
                    label = "Rust Orange Body",
                    targetHex = "#D84315",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.0),
                        "max" to listOf(1.0, 1.0, 0.85),
                    ),
                ),
                SemanticRegion(
                    id = "fox_chest",
                    label = "White Chest",
                    targetHex = "#FFFFFF",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.2, 0.0, 0.1),
                        "max" to listOf(0.8, 0.45, 0.6),
                    ),
                ),
                SemanticRegion(
                    id = "fox_tips",
                    label = "Black Ear Tips & Paws",
                    targetHex = "#161616",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.85),
                        "max" to listOf(1.0, 1.0, 1.0),
                    ),
                ),
            ),
        ),
        SemanticCharacterPreset(
            name = "Benchy",
            keywords = listOf("benchy", "boat", "tugboat", "ship"),
            regions = listOf(
                SemanticRegion(
                    id = "benchy_hull",
                    label = "Blue Hull",
                    targetHex = "#1565C0",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.0),
                        "max" to listOf(1.0, 1.0, 0.50),
                    ),
                ),
                SemanticRegion(
                    id = "benchy_cabin",
                    label = "White Cabin & Deck",
                    targetHex = "#FFFFFF",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.0, 0.0, 0.45),
                        "max" to listOf(1.0, 1.0, 0.82),
                    ),
                ),
                SemanticRegion(
                    id = "benchy_chimney",
                    label = "Red Chimney",
                    targetHex = "#C62828",
                    shape = mapOf(
                        "kind" to "box",
                        "min" to listOf(0.35, 0.35, 0.82),
                        "max" to listOf(0.65, 0.65, 1.0),
                    ),
                ),
            ),
        ),
    )

    fun findPreset(query: String): SemanticCharacterPreset? {
        val lower = query.trim().lowercase()
        for (preset in PRESETS) {
            if (preset.name.lowercase().contains(lower) || lower.contains(preset.name.lowercase())) {
                return preset
            }
            if (preset.keywords.any { lower.contains(it) }) {
                return preset
            }
        }
        return null
    }

    fun buildProposalMap(plan: SemanticCharacterPreset): Map<String, Any> {
        return mapOf(
            "schemaVersion" to 1,
            "regions" to plan.regions.map { r ->
                mapOf(
                    "id" to r.id,
                    "label" to r.label,
                    "confidence" to 0.95,
                    "shape" to r.shape,
                )
            },
        )
    }

    fun parseLlmPlanJson(rawOutput: String, fallbackName: String): SemanticCharacterPreset? {
        val json = SmartPaintHelper.extractJsonPayload(rawOutput) ?: return null
        val parsed = McpJson.parseObject(json) ?: return null
        @Suppress("UNCHECKED_CAST")
        val regionsRaw = parsed["regions"] as? List<Map<String, Any>> ?: return null
        if (regionsRaw.isEmpty()) return null
        val regions = regionsRaw.mapNotNull { r ->
            val id = r["id"] as? String ?: return@mapNotNull null
            val label = r["label"] as? String ?: id
            val targetHex = (r["targetHex"] as? String)?.let { ColorMath.normalizeHex(it) } ?: "#FFFFFF"
            @Suppress("UNCHECKED_CAST")
            val shape = r["shape"] as? Map<String, Any> ?: return@mapNotNull null
            SemanticRegion(id, label, targetHex, shape)
        }
        if (regions.isEmpty()) return null
        val name = parsed["name"] as? String ?: fallbackName
        return SemanticCharacterPreset(
            name = name,
            keywords = listOf(name.lowercase()),
            regions = regions,
        )
    }

    /**
     * Resolves the semantic plan for a character or theme, either from tuned presets
     * or by querying the on-device LLM (Gemini Nano / LiteRT Gemma).
     */
    fun resolvePlan(
        context: Context,
        characterOrTheme: String,
        workspace: ProjectWorkspace,
        volumeId: String,
    ): SemanticCharacterPreset {
        val preset = findPreset(characterOrTheme)
        if (preset != null) {
            return preset
        }

        // Query local LLM for unknown characters/themes
        val modelManager = LlmModelManager.getInstance(context)
        val engine = modelManager.activeEngine.value
        if (engine != null) {
            val prompt = """
You are an expert 3D model painter. Plan a color scheme for the model '$characterOrTheme'.
Return JSON ONLY matching:
{
  "name": "$characterOrTheme",
  "regions": [
    {
      "id": "string",
      "label": "Short description",
      "targetHex": "#RRGGBB",
      "shape": {"kind": "box", "min": [x,y,z], "max": [x,y,z]}
    }
  ]
}
Coordinates are normalized in [0,1], where z=0 is bed and z=1 is highest point.
            """.trimIndent()

            try {
                val raw = runBlocking { engine.runInference(prompt) }
                val parsed = parseLlmPlanJson(raw, characterOrTheme)
                if (parsed != null) {
                    return parsed
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Local LLM plan generation failed for '$characterOrTheme', falling back", t)
            }
        }

        // Generic fallback preset if LLM is unavailable or failed
        return SemanticCharacterPreset(
            name = characterOrTheme,
            keywords = listOf(characterOrTheme.lowercase()),
            regions = listOf(
                SemanticRegion(
                    id = "top_accent",
                    label = "Top Accent",
                    targetHex = "#E22B22",
                    shape = mapOf("kind" to "box", "min" to listOf(0.0, 0.0, 0.7), "max" to listOf(1.0, 1.0, 1.0)),
                ),
                SemanticRegion(
                    id = "main_body",
                    label = "Main Body",
                    targetHex = "#FFDE00",
                    shape = mapOf("kind" to "box", "min" to listOf(0.0, 0.0, 0.0), "max" to listOf(1.0, 1.0, 0.7)),
                ),
            ),
        )
    }

    /**
     * Executes semantic character painting on the model.
     *
     * @param paletteMode "available_only" (maps to closest loaded filaments via CIEDE2000 Delta-E)
     *                    or "full_spectrum" (auto-provisions exact physical/virtual filaments).
     */
    fun paintModel(
        context: Context,
        workspace: ProjectWorkspace,
        volumeId: String,
        characterOrTheme: String,
        paletteMode: String,
        currentFilaments: List<FilamentOption>,
    ): SemanticPaintResult {
        val plan = resolvePlan(context, characterOrTheme, workspace, volumeId)
        val isFullSpectrum = paletteMode.equals("full_spectrum", ignoreCase = true) ||
                paletteMode.equals("auto_provision", ignoreCase = true)

        var activeFilaments = currentFilaments

        // If Full Spectrum / auto-provision: sync missing target colors into project
        if (isFullSpectrum) {
            val neededColors = mutableListOf<Pair<String, String>>()
            for (region in plan.regions) {
                val hex = ColorMath.normalizeHex(region.targetHex) ?: region.targetHex
                val closestDelta = activeFilaments.minOfOrNull {
                    ColorMath.deltaE2000(hex, it.color)
                } ?: 100.0

                if (closestDelta > 12.0 && neededColors.none { it.first.equals(hex, ignoreCase = true) }) {
                    val colorName = ColorNames.nameOf(hex)
                    neededColors.add(hex to colorName)
                }
            }

            if (neededColors.isNotEmpty()) {
                val nextToolId = (activeFilaments.maxOfOrNull { it.toolId ?: 0 } ?: (activeFilaments.size - 1)) + 1
                val slots = neededColors.mapIndexed { i, (hex, _) ->
                    ProjectIntents.PrinterSlot(
                        toolId = (nextToolId + i).toLong(),
                        color = hex.map { it.code },
                        material = "PLA".map { it.code },
                        subType = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                        vendor = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                    )
                }
                val newIds = List(slots.size) { UUID.randomUUID().toString() }
                try {
                    workspace.syncPhysicalFilaments(slots, newIds).get()
                    // Re-query updated filaments
                    activeFilaments = activeFilaments + neededColors.mapIndexed { i, (hex, name) ->
                        FilamentOption(
                            id = newIds[i],
                            mixed = false,
                            name = "$name (PLA)",
                            color = hex,
                            enabled = true,
                            material = "PLA",
                            presetId = null,
                            toolId = nextToolId + i,
                            distributionMode = null,
                            recipe = emptyList(),
                            warnings = emptyList(),
                        )
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "Could not provision full-spectrum filaments: ${t.message}")
                }
            }
        }

        // Map each region to best filament ID
        val assignmentsMap = mutableMapOf<String, String>()
        for (region in plan.regions) {
            val targetHex = ColorMath.normalizeHex(region.targetHex) ?: region.targetHex
            val bestFilament = activeFilaments.minByOrNull {
                ColorMath.deltaE2000(targetHex, it.color)
            } ?: activeFilaments.firstOrNull()

            if (bestFilament != null) {
                assignmentsMap[region.id] = bestFilament.id
            }
        }

        var regionsPainted = 0
        val breakdownList = mutableListOf<String>()

        // Apply each region stroke sequentially with fresh guards
        for (region in plan.regions) {
            val filId = assignmentsMap[region.id] ?: continue
            val singleProposalMap = mapOf(
                "schemaVersion" to 1,
                "regions" to listOf(
                    mapOf(
                        "id" to region.id,
                        "label" to region.label,
                        "confidence" to 0.95,
                        "shape" to region.shape,
                    ),
                ),
            )
            val singleProposalJson = McpJson.stringify(singleProposalMap)

            // Validate
            val validationJson = ProjectSmartPaint.validateProposal(singleProposalJson)
            val validation = McpJson.parseObject(validationJson)
            if (validation?.get("valid") != true) {
                Log.w(TAG, "Proposal for ${region.label} invalid, skipping: ${validation?.get("message")}")
                continue
            }

            // Project onto mesh
            val projectionJson = try {
                workspace.smartPaintProject(volumeId, singleProposalJson).get()
            } catch (t: Throwable) {
                Log.w(TAG, "Projection for ${region.label} failed: ${t.message}")
                continue
            }

            val projection = parseSmartPaintProjection(projectionJson)
            val firstRegion = projection.regions.firstOrNull()
            if (firstRegion == null || firstRegion.triangleIndices.isEmpty()) {
                Log.i(TAG, "Region ${region.label} matched 0 triangles, skipping")
                continue
            }

            // Build single-region assignment with the projected region's ID ("ai-region-1")
            val singleAssignment = listOf(
                mapOf(
                    "regionId" to firstRegion.id,
                    "value" to filId,
                    "excludedTriangles" to emptyList<Int>(),
                ),
            )
            val singleAssignmentJson = McpJson.stringify(singleAssignment)

            try {
                val batchIntentJson = workspace.smartPaintBuildBatch(
                    volumeId,
                    "color",
                    singleProposalJson,
                    singleAssignmentJson,
                ).get()
                workspace.applySmartPaintBatch(batchIntentJson).get()

                regionsPainted++
                val filamentColor = activeFilaments.find { it.id == filId }?.color ?: region.targetHex
                val colorLabel = ColorNames.nameOf(filamentColor)
                breakdownList.add("${region.label} with $colorLabel")
                Log.i(TAG, "Successfully painted ${region.label} (${firstRegion.triangleIndices.size} facets) with $colorLabel")
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to apply paint for ${region.label}: ${t.message}")
            }
        }

        if (regionsPainted == 0) {
            throw IllegalStateException("No geometric regions matched the 3D model facets.")
        }

        val modeLabel = if (isFullSpectrum) "Full Spectrum" else "available filaments"
        val breakdown = breakdownList.joinToString(", ")
        val spoken = "Painted ${plan.name} using $modeLabel: $breakdown."

        return SemanticPaintResult(
            character = plan.name,
            paletteMode = if (isFullSpectrum) "full_spectrum" else "available_only",
            regionsPainted = regionsPainted,
            colorBreakdown = breakdown,
            spokenSummary = spoken,
        )
    }
}
