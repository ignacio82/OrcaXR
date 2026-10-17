package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.FilamentOption
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.VirtualFilamentLibraryResult
import dev.orcaxr.core.VirtualFilamentSearchRequest
import dev.orcaxr.core.VirtualFilaments
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Distinct color usage extracted from scene objects, volumes, source material, and painted facets. */
data class ModelColorUsage(
    val color: String,
    val sourceFilamentIds: List<String>,
    val sourceMaterialName: String?,
    val sampleNames: List<String>,
    val usageCount: Int,
)

/** Matched destination for a model color: physical slot or Full-Spectrum recipe. */
data class ModelColorMatchDestination(
    val kind: String, // "physical", "existing-mixed", or "new-mixed"
    val filamentId: String?,
    val displayColor: String,
    val name: String,
    val deltaE2000: Double,
    val draftJson: String? = null,
)

/** One color matching row. */
data class ModelColorMatchRow(
    val source: ModelColorUsage,
    val destination: ModelColorMatchDestination,
)

/** A complete plan for recreating model colors. */
data class RecreateModelColorsPlan(
    val matches: List<ModelColorMatchRow>,
    val availablePhysicalCount: Int,
    val canGenerateFullSpectrum: Boolean,
    val averageDeltaE2000: Double,
    val maxDeltaE2000: Double,
    val printerSlotsToAdopt: List<ProjectIntents.PrinterSlot> = emptyList(),
)

object ColorMath {
    data class Lab(val l: Double, val a: Double, val b: Double)

    fun normalizeHex(hex: String): String? {
        val trimmed = hex.trim().removePrefix("#")
        if (trimmed.length != 6) return null
        return if (trimmed.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
            "#${trimmed.uppercase()}"
        } else null
    }

    private fun hexToRgb(hex: String): IntArray? {
        val norm = normalizeHex(hex) ?: return null
        val raw = norm.removePrefix("#")
        return try {
            intArrayOf(
                raw.substring(0, 2).toInt(16),
                raw.substring(2, 4).toInt(16),
                raw.substring(4, 6).toInt(16),
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun pivotRgb(v: Double): Double =
        if (v > 0.04045) Math.pow((v + 0.055) / 1.055, 2.4) * 100.0 else (v / 12.92) * 100.0

    private fun pivotXyz(v: Double): Double =
        if (v > 0.008856) Math.cbrt(v) else 7.787 * v + 16.0 / 116.0

    fun srgbToLab(hex: String): Lab? {
        val rgb = hexToRgb(hex) ?: return null
        val r = rgb[0] / 255.0
        val g = rgb[1] / 255.0
        val b = rgb[2] / 255.0
        val lr = pivotRgb(r)
        val lg = pivotRgb(g)
        val lb = pivotRgb(b)
        val x = 0.412453 * lr + 0.357580 * lg + 0.180423 * lb
        val y = 0.212671 * lr + 0.715160 * lg + 0.072169 * lb
        val z = 0.019334 * lr + 0.119193 * lg + 0.950227 * lb
        val px = pivotXyz(x / 95.047)
        val py = pivotXyz(y / 100.0)
        val pz = pivotXyz(z / 108.883)
        return Lab(116.0 * py - 16.0, 500.0 * (px - py), 200.0 * (py - pz))
    }

    fun deltaE2000(hex1: String, hex2: String): Double {
        val lab1 = srgbToLab(hex1) ?: return 100.0
        val lab2 = srgbToLab(hex2) ?: return 100.0
        val l1 = lab1.l; val a1 = lab1.a; val b1 = lab1.b
        val l2 = lab2.l; val a2 = lab2.a; val b2 = lab2.b
        val avgL = (l1 + l2) / 2.0
        val c1 = Math.hypot(a1, b1)
        val c2 = Math.hypot(a2, b2)
        val avgC = (c1 + c2) / 2.0
        val avgC7 = Math.pow(avgC, 7.0)
        val g = 0.5 * (1.0 - Math.sqrt(avgC7 / (avgC7 + 6103515625.0)))
        val a1p = a1 * (1.0 + g)
        val a2p = a2 * (1.0 + g)
        val c1p = Math.hypot(a1p, b1)
        val c2p = Math.hypot(a2p, b2)
        val avgCp = (c1p + c2p) / 2.0
        var h1p = Math.toDegrees(Math.atan2(b1, a1p))
        if (h1p < 0) h1p += 360.0
        var h2p = Math.toDegrees(Math.atan2(b2, a2p))
        if (h2p < 0) h2p += 360.0
        val avgHp = if (Math.abs(h1p - h2p) > 180.0) (h1p + h2p + 360.0) / 2.0 else (h1p + h2p) / 2.0
        val t = 1.0 - 0.17 * Math.cos(Math.toRadians(avgHp - 30.0)) +
                0.24 * Math.cos(Math.toRadians(2.0 * avgHp)) +
                0.32 * Math.cos(Math.toRadians(3.0 * avgHp + 6.0)) -
                0.20 * Math.cos(Math.toRadians(4.0 * avgHp - 63.0))
        var deltaHp = h2p - h1p
        if (Math.abs(deltaHp) > 180.0) deltaHp += if (h2p <= h1p) 360.0 else -360.0
        val deltaLp = l2 - l1
        val deltaCp = c2p - c1p
        val deltaHpVal = 2.0 * Math.sqrt(c1p * c2p) * Math.sin(Math.toRadians(deltaHp / 2.0))
        val lMinus50 = avgL - 50.0
        val sL = 1.0 + (0.015 * lMinus50 * lMinus50) / Math.sqrt(20.0 + lMinus50 * lMinus50)
        val sC = 1.0 + 0.045 * avgCp
        val sH = 1.0 + 0.015 * avgCp * t
        val deltaTheta = 30.0 * Math.exp(-Math.pow((avgHp - 275.0) / 25.0, 2.0))
        val avgCp7 = Math.pow(avgCp, 7.0)
        val rC = 2.0 * Math.sqrt(avgCp7 / (avgCp7 + 6103515625.0))
        val rT = -rC * Math.sin(Math.toRadians(2.0 * deltaTheta))
        val lTerm = deltaLp / sL
        val cTerm = deltaCp / sC
        val hTerm = deltaHpVal / sH
        return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rT * cTerm * hTerm)
    }
}

object RecreateModelColorsEngine {
    private fun units(text: String) = text.map { it.code }

    /** Extract distinct colors from the project JSON state. */
    fun extractModelColorUsages(stateJson: String): List<ModelColorUsage> {
        val root = try { JSONObject(stateJson) } catch (_: Exception) { return emptyList() }
        val filamentsObj = root.optJSONObject("filaments")
        val physicalMap = HashMap<String, Pair<String, String>>() // id -> (name, color)
        val mixedMap = HashMap<String, Pair<String, String>>() // id -> (name, displayColor)

        filamentsObj?.optJSONArray("physical")?.let { arr ->
            for (i in 0 until arr.length()) {
                val f = arr.optJSONObject(i) ?: continue
                val id = f.optString("id")
                val name = f.optString("name")
                val color = ColorMath.normalizeHex(f.optString("color")) ?: f.optString("color")
                if (id.isNotEmpty()) physicalMap[id] = name to color
            }
        }
        filamentsObj?.optJSONArray("mixed")?.let { arr ->
            for (i in 0 until arr.length()) {
                val f = arr.optJSONObject(i) ?: continue
                val id = f.optString("id")
                val name = f.optString("name")
                val color = ColorMath.normalizeHex(f.optString("displayColor")) ?: f.optString("displayColor")
                if (id.isNotEmpty()) mixedMap[id] = name to color
            }
        }

        fun getFilamentColor(id: String): String? = physicalMap[id]?.second ?: mixedMap[id]?.second
        fun getFilamentName(id: String): String? = physicalMap[id]?.first ?: mixedMap[id]?.first

        class Intermediate(
            val color: String,
            val sourceIds: MutableSet<String> = LinkedHashSet(),
            var materialName: String? = null,
            val sampleNames: MutableSet<String> = LinkedHashSet(),
            var count: Int = 0,
        )

        val usages = LinkedHashMap<String, Intermediate>()

        fun record(rawColor: String?, sourceFilamentId: String?, materialName: String?, entityName: String?, weight: Int = 1) {
            val norm = ColorMath.normalizeHex(rawColor ?: return) ?: return
            val entry = usages.getOrPut(norm) { Intermediate(norm) }
            if (sourceFilamentId != null && sourceFilamentId.isNotEmpty()) entry.sourceIds.add(sourceFilamentId)
            if (materialName != null && entry.materialName == null) entry.materialName = materialName
            if (entityName != null) entry.sampleNames.add(entityName)
            entry.count += weight
        }

        val stateExt = root.optJSONObject("extensionData")
        val stateOriginals = stateExt?.optJSONObject("orcaxr:originalFilamentColors")

        val plates = root.optJSONArray("plates")
        if (plates != null) {
            for (p in 0 until plates.length()) {
                val plate = plates.optJSONObject(p) ?: continue
                val objects = plate.optJSONArray("objects") ?: continue
                for (o in 0 until objects.length()) {
                    val obj = objects.optJSONObject(o) ?: continue
                    val objName = obj.optString("name", "Object")
                    val objFilamentId = obj.optString("filamentId").takeIf { it.isNotEmpty() }
                    val volumes = obj.optJSONArray("volumes") ?: JSONArray()
                    for (v in 0 until volumes.length()) {
                        val vol = volumes.optJSONObject(v) ?: continue
                        val volName = vol.optString("name").ifEmpty { objName }
                        val volFilamentId = vol.optString("filamentId").takeIf { it.isNotEmpty() }
                        val volExt = vol.optJSONObject("extensionData")
                        val sourceMat = volExt?.optJSONObject("orcaxr:sourceMaterial")
                        val sourceMatColor = sourceMat?.optString("color")
                        val sourceMatName = sourceMat?.optString("name")

                        if (!sourceMatColor.isNullOrEmpty()) {
                            record(sourceMatColor, volFilamentId ?: objFilamentId, sourceMatName, volName, 1)
                        } else if (volFilamentId != null) {
                            getFilamentColor(volFilamentId)?.let { record(it, volFilamentId, getFilamentName(volFilamentId), volName, 1) }
                        } else if (objFilamentId != null) {
                            getFilamentColor(objFilamentId)?.let { record(it, objFilamentId, getFilamentName(objFilamentId), objName, 1) }
                        }

                        // Painted facets
                        val annotations = vol.optJSONObject("annotations")
                        val colorAnnotations = annotations?.optJSONArray("color")
                        if (colorAnnotations != null) {
                            val volOriginals = volExt?.optJSONObject("orcaxr:originalFilamentColors") ?: stateOriginals
                            for (c in 0 until colorAnnotations.length()) {
                                val item = colorAnnotations.optJSONObject(c) ?: continue
                                val value = item.optString("value")
                                val triangles = item.optJSONArray("triangles")?.length() ?: 1
                                val directHex = ColorMath.normalizeHex(value)
                                if (directHex != null) {
                                    record(directHex, null, null, volName, triangles)
                                } else {
                                    val origHex = volOriginals?.optString(value)?.takeIf { it.isNotEmpty() }
                                    val filColor = (origHex?.let { ColorMath.normalizeHex(it) }) ?: getFilamentColor(value)
                                    if (filColor != null) {
                                        record(filColor, value, getFilamentName(value), volName, triangles)
                                    }
                                }
                            }
                        }
                    }

                    // Layer ranges
                    val ranges = obj.optJSONArray("layerRanges") ?: JSONArray()
                    for (r in 0 until ranges.length()) {
                        val range = ranges.optJSONObject(r) ?: continue
                        val rangeFilamentId = range.optString("filamentId").takeIf { it.isNotEmpty() }
                        if (rangeFilamentId != null) {
                            getFilamentColor(rangeFilamentId)?.let { record(it, rangeFilamentId, getFilamentName(rangeFilamentId), objName, 1) }
                        }
                    }
                }
            }
        }

        return usages.values.map {
            ModelColorUsage(
                color = it.color,
                sourceFilamentIds = it.sourceIds.toList(),
                sourceMaterialName = it.materialName,
                sampleNames = it.sampleNames.toList(),
                usageCount = it.count,
            )
        }.sortedWith(compareByDescending<ModelColorUsage> { it.usageCount }.thenBy { it.color })
    }

    /** Compute the best physical and Full-Spectrum mixed filament matches for the extracted colors. */
    fun planRecreateModelColors(
        view: ProjectView,
        stateJson: String,
        printerSlotsToAdopt: List<ProjectIntents.PrinterSlot> = emptyList(),
    ): RecreateModelColorsPlan {
        val usages = extractModelColorUsages(stateJson)
        val physicalChoices = view.filaments.options.filter { !it.mixed && it.enabled }
        val existingMixed = view.filaments.options.filter { it.mixed && it.enabled }

        val library = (view.virtualFilaments as? VirtualFilamentLibraryResult.Shown)?.library
        val canGenerateFullSpectrum = library != null && library.selectable.size >= 2

        val matches = ArrayList<ModelColorMatchRow>()

        for (source in usages) {
            var bestDest: ModelColorMatchDestination? = null

            // 1. Search physical filaments
            for (p in physicalChoices) {
                val delta = ColorMath.deltaE2000(source.color, p.color)
                if (bestDest == null || delta < bestDest.deltaE2000) {
                    bestDest = ModelColorMatchDestination(
                        kind = "physical",
                        filamentId = p.id,
                        displayColor = p.color,
                        name = p.name,
                        deltaE2000 = delta,
                    )
                }
            }

            // 2. Search existing mixed filaments
            for (m in existingMixed) {
                val delta = ColorMath.deltaE2000(source.color, m.color)
                if (bestDest == null || delta < bestDest.deltaE2000) {
                    bestDest = ModelColorMatchDestination(
                        kind = "existing-mixed",
                        filamentId = m.id,
                        displayColor = m.color,
                        name = m.name,
                        deltaE2000 = delta,
                    )
                }
            }

            // 3. Search Full-Spectrum recipe generation if DeltaE > 1.0 and mixing is available
            if (canGenerateFullSpectrum && (bestDest == null || bestDest.deltaE2000 > 1.0)) {
                try {
                    val searchJson = VirtualFilaments.search(library, VirtualFilamentSearchRequest(source.color, 20))
                    val candidatesArr = JSONArray(searchJson)
                    if (candidatesArr.length() > 0) {
                        val top = candidatesArr.getJSONObject(0)
                        val delta = top.optDouble("deltaE2000", 100.0)
                        val preview = top.optString("previewColor")
                        val title = top.optString("title")
                        if (bestDest == null || delta < bestDest.deltaE2000 - 0.2) {
                            bestDest = ModelColorMatchDestination(
                                kind = "new-mixed",
                                filamentId = null,
                                displayColor = ColorMath.normalizeHex(preview) ?: preview,
                                name = title,
                                deltaE2000 = delta,
                                draftJson = top.toString(),
                            )
                        }
                    }
                } catch (_: Exception) {
                    // Fall back to best physical or existing match
                }
            }

            if (bestDest != null) {
                matches.add(ModelColorMatchRow(source, bestDest))
            }
        }

        val deltaEs = matches.map { it.destination.deltaE2000 }
        val avgDeltaE = if (deltaEs.isNotEmpty()) deltaEs.average() else 0.0
        val maxDeltaE = if (deltaEs.isNotEmpty()) deltaEs.maxOrNull() ?: 0.0 else 0.0

        return RecreateModelColorsPlan(
            matches = matches,
            availablePhysicalCount = physicalChoices.size,
            canGenerateFullSpectrum = canGenerateFullSpectrum,
            averageDeltaE2000 = avgDeltaE,
            maxDeltaE2000 = maxDeltaE,
            printerSlotsToAdopt = printerSlotsToAdopt,
        )
    }

    /** Builds the ProjectIntents.RecreateModelColors command for execution. */
    fun buildRecreateCommand(
        plan: RecreateModelColorsPlan,
        overrides: Map<String, String>, // sourceColor -> destinationFilamentId
    ): ProjectIntents.RecreateModelColors {
        val mappings = ArrayList<ProjectIntents.ColorMapping>()
        val newFilamentIds = ArrayList<String>()

        for (match in plan.matches) {
            val chosenId = overrides[match.source.color] ?: match.destination.filamentId ?: run {
                val newId = UUID.randomUUID().toString()
                newFilamentIds.add(newId)
                newId
            }
            mappings.add(
                ProjectIntents.ColorMapping(
                    sourceColor = units(match.source.color),
                    destinationFilamentId = units(chosenId),
                    sourceFilamentIds = if (match.source.sourceFilamentIds.isNotEmpty()) {
                        ProjectIntents.OptionalIds.Value(match.source.sourceFilamentIds.map(::units))
                    } else {
                        ProjectIntents.OptionalIds.Absent(ProjectIntents.Empty)
                    },
                ),
            )
        }

        return ProjectIntents.RecreateModelColors(
            mappings = mappings,
            newMixedFilaments = emptyList(),
            printerSlots = plan.printerSlotsToAdopt,
            candidateTools = emptyList(),
            newFilamentIds = if (newFilamentIds.isNotEmpty()) {
                ProjectIntents.OptionalIds.Value(newFilamentIds.map(::units))
            } else {
                ProjectIntents.OptionalIds.Absent(ProjectIntents.Empty)
            },
        )
    }
}
