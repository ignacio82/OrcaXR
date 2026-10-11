package dev.orcaxr.core

/** The rectangle a printer's `printable_area` encloses (mm); its origin may sit off the bed corner. */
data class PrintableArea(val xMin: Double, val yMin: Double, val xMax: Double, val yMax: Double) {
    /** The area as a placement request carries it. */
    fun wire(): ProjectIntents.PlacementArea = ProjectIntents.PlacementArea(xMin, yMin, xMax, yMax)
}

/** A build volume's lowest and highest corners `[x, y, z]` (mm): the box scale-to-fit fills. */
data class BuildVolume(val minMm: List<Double>, val maxMm: List<Double>) {
    /** The volume as a placement request carries it. */
    fun wire(): ProjectIntents.PlacementVolume = ProjectIntents.PlacementVolume(minMm, maxMm)
}

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
 * is drawn from the bed corner to it —, the printable rectangle the polygon
 * encloses, the printable height, the keep-out of one plate's wipe tower, and
 * where placements go: [areaMm], the printable rectangle the slice preflight
 * checks (else the printable area, else the bed from its corner), where
 * models are placed, centred, arranged and filled, and [volumeMm], that area
 * from the bed up to the printable height the preflight checks, the box
 * scale-to-fit fills (none without a height). A printer may offset its area
 * from the bed corner (the U1's starts at 0.5 × 1 mm), so a far corner is
 * never a size to centre on.
 */
data class WorkspaceBed(
    val widthMm: Double,
    val depthMm: Double,
    val printableArea: PrintableArea? = null,
    val printableHeightMm: Double? = null,
    val keepOut: KeepOut? = null,
    val areaMm: PrintableArea = PrintableArea(0.0, 0.0, widthMm, depthMm),
    val volumeMm: BuildVolume? = null,
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

    /**
     * The canonical bed document `{"areaMm","keepOut","printableArea",
     * "printableHeightMm","sizeMm","volumeMm"}` (the volume as
     * `{"maxMm","minMm"}` corners).
     */
    internal fun read(json: String): WorkspaceBed {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        fun number(value: Any): Double = value as? Double ?: Double.NaN
        fun area(value: ProjectJsonObject) =
            PrintableArea(number(value.get("xMin")), number(value.get("yMin")), number(value.get("xMax")), number(value.get("yMax")))
        fun corner(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { number(list.get(it)) } }
        val size = reply.get("sizeMm") as ProjectJsonArray
        val printable = reply.get("printableArea") as? ProjectJsonObject
        val keepOut = reply.get("keepOut") as? ProjectJsonObject
        val volume = reply.get("volumeMm") as? ProjectJsonObject
        return WorkspaceBed(
            number(size.get(0)),
            number(size.get(1)),
            printable?.let(::area),
            reply.get("printableHeightMm") as? Double,
            keepOut?.let { KeepOut(number(it.get("minX")), number(it.get("minY")), number(it.get("maxX")), number(it.get("maxY"))) },
            area(reply.get("areaMm") as ProjectJsonObject),
            volume?.let { BuildVolume(corner(it.get("minMm")), corner(it.get("maxMm"))) },
        )
    }
}
