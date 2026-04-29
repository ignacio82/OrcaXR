package dev.orcaxr.app

/**
 * Phase H.2 (Snapmaker fork PR #284 port) — evaluates whether the
 * active slicer profile's `requires_top_cover` array signals that
 * any project filament wants the U1's magnetic top cover installed.
 *
 * The libslic3r side just registers the `coBools` key (patch 0026);
 * the user-visible warning lives Compose-side, mirroring the Phase E
 * `FilamentRules` pattern (gotcha #28). When the rule data is small
 * and the trigger is data the UI already tracks (the active profile),
 * Kotlin is the shorter path than threading a libslic3r
 * Print::validate() hook + a JNI surface.
 *
 * Behavior:
 *  - `Result.Ok` — no slot has the flag set; banner stays hidden.
 *  - `Result.Warning` — at least one slot has the flag set; banner
 *    surfaces a "Top cover recommended" amber banner in
 *    LeftProjectPanel. Slice button stays enabled — this is a hint,
 *    not a hard block (unlike Phase E forbidden filaments).
 *
 * Bed-type / open-frame detection is deliberately out of scope: we
 * don't yet model per-printer "enclosed" state. Once that lands the
 * `evaluate(...)` signature can take a bedHint arg and return Ok
 * when the bed is already enclosed.
 */
object TopCoverRule {
    sealed interface Result {
        data object Ok : Result
        /** [slots] are the 0-based slot indices that demand the cover. */
        data class Warning(val slots: List<Int>, val message: String) : Result
    }

    /**
     * Read the merged profile's `requires_top_cover` value (a
     * coBools rendered as comma- or semicolon-separated "1"/"0"
     * tokens — both separators are tolerated since we don't know
     * what mergedConfig produced) and decide.
     *
     * Returns [Result.Ok] when the key is absent, empty, or all
     * slots are 0. Returns [Result.Warning] listing the slot
     * indices when any slot has it set.
     */
    fun evaluate(profileConfig: Map<String, String>): Result {
        val raw = profileConfig["requires_top_cover"]?.trim() ?: return Result.Ok
        if (raw.isEmpty()) return Result.Ok
        // libslic3r parses coBools with comma; mergedConfig also
        // joins per-tool coBools with comma. Tolerate semicolons
        // too in case a future flatten path produces them.
        val tokens = raw
            .split(',', ';')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        val flagged = tokens.withIndex()
            .filter { (_, v) -> v == "1" || v.equals("true", ignoreCase = true) }
            .map { it.index }
        if (flagged.isEmpty()) return Result.Ok
        val slotsLabel = flagged.joinToString(", ") { "T${it + 1}" }
        return Result.Warning(
            slots = flagged,
            message = "Filament on $slotsLabel benefits from the U1's magnetic top cover. Install it to avoid warping on ABS/ASA/PA/PC.",
        )
    }
}
