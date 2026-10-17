package dev.orcaxr.nativeapp.project

/**
 * Binds a printer's reported filament slot to the filament preset that actually
 * describes it, mirroring `web/src/slicer/filamentPresetMatch.ts`.
 */
data class ReportedFilamentSlot(
    val material: String,
    val subType: String? = null,
    val vendor: String? = null,
)

data class FilamentPresetCandidate(
    val presetId: String,
    val presetName: String,
    val material: String,
    val vendor: String? = null,
)

data class FilamentPresetMatch(
    val presetId: String,
    val vendorMatched: Boolean,
    val gradeMatched: Boolean,
)

object FilamentPresetMatching {
    fun fold(value: String?): String =
        (value ?: "").lowercase().filter { it.isLetterOrDigit() }

    fun words(value: String): List<String> =
        value.split("\\s+".toRegex()).filter { it.isNotEmpty() }

    fun presetHead(presetName: String): String =
        presetName.split("@")[0].trim()

    fun filamentPresetVendor(candidate: FilamentPresetCandidate): String {
        val declared = candidate.vendor?.trim()
        if (!declared.isNullOrEmpty()) return declared
        return words(presetHead(candidate.presetName)).firstOrNull().orEmpty()
    }

    fun filamentPresetGrade(candidate: FilamentPresetCandidate): String {
        var remaining = words(presetHead(candidate.presetName))
        val vendor = words(filamentPresetVendor(candidate))
        if (vendor.isNotEmpty() && vendor.size <= remaining.size && vendor.indices.all { fold(remaining[it]) == fold(vendor[it]) }) {
            remaining = remaining.drop(vendor.size)
        }
        if (remaining.isNotEmpty() && fold(remaining[0]) == fold(candidate.material)) {
            remaining = remaining.drop(1)
        }
        return remaining.joinToString(" ")
    }

    fun materialMatches(candidate: FilamentPresetCandidate, slot: ReportedFilamentSlot): Boolean {
        val wanted = fold(slot.material)
        return wanted.isNotEmpty() && fold(candidate.material) == wanted
    }

    fun filamentPresetAgreesWithSlot(candidate: FilamentPresetCandidate, slot: ReportedFilamentSlot): Boolean {
        if (!materialMatches(candidate, slot)) return false
        val vendor = fold(slot.vendor)
        if (vendor.isNotEmpty() && fold(filamentPresetVendor(candidate)) != vendor) return false
        val grade = fold(slot.subType)
        if (grade.isNotEmpty() && fold(filamentPresetGrade(candidate)) != grade) return false
        return true
    }

    private fun shorterName(a: String, b: String): Boolean =
        if (a.length != b.length) a.length < b.length else a < b

    fun matchFilamentPreset(
        candidates: List<FilamentPresetCandidate>,
        slot: ReportedFilamentSlot,
    ): FilamentPresetMatch? {
        val wantedVendor = fold(slot.vendor)
        val wantedGrade = fold(slot.subType)
        var best: FilamentPresetCandidate? = null
        var bestScore = -1
        var bestVendor = false
        var bestGrade = false

        for (candidate in candidates) {
            if (!materialMatches(candidate, slot)) continue
            val vendorMatched = wantedVendor.isNotEmpty() && fold(filamentPresetVendor(candidate)) == wantedVendor
            val presetGrade = fold(filamentPresetGrade(candidate))
            val gradeMatched = presetGrade == wantedGrade
            val score = (if (vendorMatched) 8 else 0) + (if (gradeMatched) 4 else 0) + (if (presetGrade.isEmpty()) 1 else 0)
            if (best == null || score > bestScore || (score == bestScore && shorterName(candidate.presetName, best.presetName))) {
                best = candidate
                bestScore = score
                bestVendor = vendorMatched
                bestGrade = gradeMatched
            }
        }
        return best?.let { FilamentPresetMatch(it.presetId, bestVendor, bestGrade) }
    }
}
