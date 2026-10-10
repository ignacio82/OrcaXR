package dev.orcaxr.core

/** The rectangle a printer's `printable_area` encloses (mm); its origin may sit off the bed corner. */
data class PrintableArea(val xMin: Double, val yMin: Double, val xMax: Double, val yMax: Double)

/**
 * The square an enabled wipe tower keeps clear when its plate is arranged or
 * filled (mm). An edge JSON cannot carry — an infinite tower width — is NaN.
 */
data class KeepOut(val minX: Double, val minY: Double, val maxX: Double, val maxY: Double)

/**
 * The bed the workspace places models on, read from the project's own
 * configuration as the browser's workspace reads it (`WorkspaceBed.ts`, in the
 * shared core as `orcaxr_project::placement::bed`): the far corner of
 * `printable_area` as the bed's size (200 mm a side without one) — the plate
 * is drawn from the bed corner to it, and models are placed, centred, scaled
 * to fit and arranged on it —, the printable rectangle the polygon encloses,
 * the printable height scale-to-fit reads, and the keep-out of one plate's
 * wipe tower.
 */
data class WorkspaceBed(
    val widthMm: Double,
    val depthMm: Double,
    val printableArea: PrintableArea? = null,
    val printableHeightMm: Double? = null,
    val keepOut: KeepOut? = null,
) {
    companion object {
        /** The browser's plate before a project is read: 200 mm a side. */
        val DEFAULT = WorkspaceBed(200.0, 200.0)
    }
}

/** The workspace bed of a configuration; a captured project answers through [ProjectSnapshot.workspaceBed]. */
object WorkspaceBeds {
    /**
     * The bed of [configJson] (a project configuration as a JSON object) and
     * the keep-out of [wipeTowerJson] (a plate's `WipeTowerState` as JSON, or
     * none). A malformed request fails with `invalid_request`.
     */
    fun of(configJson: String, wipeTowerJson: String? = null): WorkspaceBed =
        read(NativeProject.workspaceBed("{\"config\":$configJson,\"wipeTower\":${wipeTowerJson ?: "null"}}"))

    /** The canonical bed document `{"keepOut","printableArea","printableHeightMm","sizeMm"}`. */
    internal fun read(json: String): WorkspaceBed {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        fun number(value: Any): Double = value as? Double ?: Double.NaN
        val size = reply.get("sizeMm") as ProjectJsonArray
        val area = reply.get("printableArea") as? ProjectJsonObject
        val keepOut = reply.get("keepOut") as? ProjectJsonObject
        return WorkspaceBed(
            number(size.get(0)),
            number(size.get(1)),
            area?.let { PrintableArea(number(it.get("xMin")), number(it.get("yMin")), number(it.get("xMax")), number(it.get("yMax"))) },
            reply.get("printableHeightMm") as? Double,
            keepOut?.let { KeepOut(number(it.get("minX")), number(it.get("minY")), number(it.get("maxX")), number(it.get("maxY"))) },
        )
    }
}
