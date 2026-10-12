package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.SliceFigures

/**
 * The browser's "Slice All Plates" (`slice_all_plates`, `OrcaWorkspace.sliceAllPlates`)
 * as Prepare runs it: every printable plate holding a model sliced in plate
 * order on the route the rule chose, each plate's G-code kept as its own
 * result, published as one set only while the project is the state they were
 * all sliced from — a change discards them all rather than publishing a mix.
 * Preview and Send take the active plate's result, or the first one's, as the
 * browser's published G-code does.
 */
object SliceAll {
    /** The browser's status while a job runs (`renderCanonicalSliceStatus`): the route's
     * percent when it reports one, else the share of plates done. */
    fun percent(completed: Int, total: Int, route: Double?): Double? = when {
        route != null -> route
        total <= 0 -> null
        else -> Math.round(completed.toDouble() / total * 100).toDouble()
    }

    /** The result Preview and Send take: the active plate's, else the first one's. */
    fun <T> published(results: List<T>, plateOf: (T) -> String, activePlateId: String?): T? =
        results.firstOrNull { plateOf(it) == activePlateId } ?: results.firstOrNull()

    /** The browser's count of a job's warnings: each distinct sentence once, across every plate. */
    fun warnings(perPlate: List<Collection<String>>): Int = perPlate.flatten().toSet().size

    /** A plate's warnings as the browser's coordinator collects them: its
     * archive's (the serializer's) and its preflight's warning-severity issues. */
    fun plateWarnings(archive: List<String>, issues: List<ProjectIntents.PreflightIssue>): Set<String> {
        val words = LinkedHashSet<String>(archive)
        for (issue in issues) {
            if (issue.severity == ProjectIntents.PreflightSeverity.Warning) {
                words += String(CharArray(issue.message.size) { issue.message[it].toChar() })
            }
        }
        return words
    }

    /** Whole kilobytes of [bytes] as `toFixed(0)` rounds `bytes / 1024` (half up; the quotient is exact). */
    fun kilobytes(bytes: Long): Long = (bytes + 512) / 1024

    /** The browser's status after every plate was sliced (`sliceAllPlates`). */
    fun describe(plates: Int, elapsedMs: Long, totalBytes: Long, warnings: Int): String =
        "SLICED $plates plate(s) in $elapsedMs ms\n${kilobytes(totalBytes)} KB total" + if (warnings > 0) ", $warnings warning(s)" else ""

    /** One plate's row of the results: its name, then what the status line says of its file. */
    fun row(plateName: String, figures: SliceFigures, warnings: Int): String =
        "$plateName: ${figures.kilobytes} KB, ${figures.lines} lines, ${figures.layers} layers" +
            if (warnings > 0) ", $warnings warning(s)" else ""

    /** The browser's words when the project changed while every plate was sliced. */
    const val STALE = "The project changed while slicing; the stale results were discarded. Slice again."
}
