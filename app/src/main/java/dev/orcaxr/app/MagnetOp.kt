package dev.orcaxr.app

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.sqrt

/**
 * "Add Magnets" — pure-math placement of embedded-magnet cavities.
 *
 * The feature recesses N magnet-shaped voids into a host model as
 * `ModelVolumeType.NEGATIVE_VOLUME`s (libslic3r boolean-subtracts them
 * at slice time) and auto-authors one `PausePrint` custom-gcode tick so
 * the user can drop the physical magnets into the open pockets mid-print
 * before the model bridges a roof over them.
 *
 * Coordinate frame: every primitive built by
 * [SlicerEngine.buildPrimitiveStl] is XY-centered on (0,0) and grounded
 * so its bbox min-Z is 0 (Z ∈ [0, height]). A `PlacedVolume`'s
 * translate/rot/scale are applied in the host model's **mesh-local**
 * frame (the loaded STL frame at scale 100 / rot 0 — same contract
 * [EmbossOp] documents), so footprint/height here come from the host's
 * `baseBboxXmm/Ymm/Zmm`, NOT the post-scale [PlacedModel.footprintMm].
 *
 * Embedded-magnet geometry (so the print pause is meaningful):
 *
 * ```
 *   hostHeight  ┌───────────────┐
 *               │  model above  │
 *  cavityTopZ ──┤···············│ ← pocket opening faces UP; pause here
 *               │ ▓ magnet ▓    │   (pocket fully formed, not yet roofed)
 *      floorZ ──┤───────────────┤ ← solid floor (roofThicknessMm)
 *           0 ──└───────────────┘ ← bed
 * ```
 *
 * The print builds the pocket walls + floor, pauses at `cavityTopZ`
 * (the magnet drops into the open pocket from above), resumes, and
 * bridges a roof of at least `roofThicknessMm` over it. That requires
 * `cavityTopZ + roofThicknessMm <= hostHeight` — otherwise there is no
 * material above to roof the magnet in and the geometry is degenerate
 * (surfaced as a warning + Z clamp, never a hard failure).
 */

enum class MagnetShape { DISC, BLOCK }

/**
 * What the user asked for. Dimensions are the *physical magnet*; the
 * cut cavity adds [clearanceMm] so the magnet actually drops in.
 *
 * - DISC uses [diameterMm] + [discHeightMm].
 * - BLOCK uses [blockXmm] / [blockYmm] / [blockZmm].
 * - [clearanceMm] is added radially on XY (×2 on diameter / block
 *   width+depth) and once on the pocket depth.
 * - [roofThicknessMm] is the minimum solid skin both BELOW the magnet
 *   (so it isn't exposed on the bed) and ABOVE it (the bridged roof).
 * - [edgeMarginMm] insets the placement grid from the footprint edges
 *   so a pocket never breaches a side wall.
 */
data class MagnetSpec(
    val count: Int,
    val shape: MagnetShape,
    val diameterMm: Float = 0f,
    val discHeightMm: Float = 0f,
    val blockXmm: Float = 0f,
    val blockYmm: Float = 0f,
    val blockZmm: Float = 0f,
    val clearanceMm: Float = 0.2f,
    val roofThicknessMm: Float = 0.8f,
    val edgeMarginMm: Float = 3f,
)

/** One pocket, in the host's mesh-local mm frame (footprint-centered). */
data class MagnetCavity(
    val centerXmm: Float,
    val centerYmm: Float,
)

/**
 * Resolved plan. [primitiveParams] is ready for
 * [SlicerEngine.buildPrimitiveStl]. All cavities share one primitive
 * mesh (only the per-volume translate differs). [floorZmm] is the
 * per-volume `translateZmm`. [pauseZmm] is snapped to a slice layer
 * boundary strictly above the pocket tops. [warnings] are non-fatal.
 */
data class MagnetPlacement(
    val cavities: List<MagnetCavity>,
    val primitiveKind: PrimitiveKind,
    val primitiveParams: FloatArray,
    val floorZmm: Float,
    val cavityTopZmm: Float,
    val pauseZmm: Float,
    val gridCols: Int,
    val gridRows: Int,
    val warnings: List<String>,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is MagnetPlacement) return false
        return cavities == other.cavities &&
            primitiveKind == other.primitiveKind &&
            primitiveParams.contentEquals(other.primitiveParams) &&
            floorZmm == other.floorZmm &&
            cavityTopZmm == other.cavityTopZmm &&
            pauseZmm == other.pauseZmm &&
            gridCols == other.gridCols &&
            gridRows == other.gridRows &&
            warnings == other.warnings
    }

    override fun hashCode(): Int {
        var r = cavities.hashCode()
        r = 31 * r + primitiveKind.hashCode()
        r = 31 * r + primitiveParams.contentHashCode()
        r = 31 * r + floorZmm.hashCode()
        r = 31 * r + cavityTopZmm.hashCode()
        r = 31 * r + pauseZmm.hashCode()
        r = 31 * r + gridCols
        r = 31 * r + gridRows
        r = 31 * r + warnings.hashCode()
        return r
    }
}

object MagnetOp {

    /**
     * Outer cavity bbox (X, Y, Z) including clearance. XY clearance is
     * radial (added on both sides); Z clearance is added once (the
     * magnet rests on the pocket floor).
     */
    fun cavityDims(spec: MagnetSpec): Triple<Float, Float, Float> = when (spec.shape) {
        MagnetShape.DISC -> {
            val d = spec.diameterMm + 2f * spec.clearanceMm
            Triple(d, d, spec.discHeightMm + spec.clearanceMm)
        }
        MagnetShape.BLOCK -> Triple(
            spec.blockXmm + 2f * spec.clearanceMm,
            spec.blockYmm + 2f * spec.clearanceMm,
            spec.blockZmm + spec.clearanceMm,
        )
    }

    /**
     * Primitive kind + params for a cavity of [cavityHeightMm] tall.
     * DISC → CYLINDER, BLOCK → CUBE. Param order matches
     * [PrimitiveKind] (CYLINDER: radius, height, facet_angle_deg;
     * CUBE: x, y, z).
     */
    fun primitiveFor(spec: MagnetSpec, cavityHeightMm: Float): Pair<PrimitiveKind, FloatArray> =
        when (spec.shape) {
            MagnetShape.DISC -> PrimitiveKind.CYLINDER to floatArrayOf(
                (spec.diameterMm + 2f * spec.clearanceMm) / 2f,
                cavityHeightMm,
                2f,
            )
            MagnetShape.BLOCK -> PrimitiveKind.CUBE to floatArrayOf(
                spec.blockXmm + 2f * spec.clearanceMm,
                spec.blockYmm + 2f * spec.clearanceMm,
                cavityHeightMm,
            )
        }

    /**
     * Near-square grid (cols × rows) for [n] cavities, row-major, last
     * row possibly partial. cols = ceil(√n); rows = ceil(n / cols).
     * 1→1×1, 2→2×1, 4→2×2, 6→3×2, 7→3×3 (2 empty), 9→3×3.
     */
    fun gridDims(n: Int): Pair<Int, Int> {
        val safe = max(1, n)
        val cols = max(1, ceil(sqrt(safe.toDouble())).toInt())
        val rows = max(1, ceil(safe.toDouble() / cols).toInt())
        return cols to rows
    }

    /**
     * Snap a pause Z strictly above [cavityTopZmm] to the next slice
     * layer boundary, clamped to [hostHeightMm]. Pulled out so it
     * unit-tests independently of placement.
     */
    fun pauseZForCavityTop(
        cavityTopZmm: Float,
        layerHeightMm: Float,
        hostHeightMm: Float,
    ): Float {
        val lh = if (layerHeightMm > 0f) layerHeightMm else 0.2f
        var z = ceil(cavityTopZmm / lh) * lh
        if (z <= cavityTopZmm + 1e-4f) z += lh
        return minOf(z, hostHeightMm)
    }

    /**
     * The core placement. [footprintXmm] / [footprintYmm] /
     * [hostHeightMm] are the host's mesh-local bbox (caller passes
     * `baseBboxXmm/Ymm/Zmm` — unscaled; see class doc). [spec] is the
     * user's request; [resolvedLayerHeightMm] is the slice layer height
     * resolved the same way `mergedConfig` does (gotcha #22) so the
     * pause lands on a real layer boundary.
     */
    fun placeCavities(
        footprintXmm: Float,
        footprintYmm: Float,
        hostHeightMm: Float,
        spec: MagnetSpec,
        resolvedLayerHeightMm: Float,
    ): MagnetPlacement {
        val warnings = mutableListOf<String>()
        val (cw, cd, chRaw) = cavityDims(spec)
        val roof = max(0f, spec.roofThicknessMm)

        // Embedded geometry: solid floor of `roof` below the magnet,
        // pocket of `ch`, then a bridged roof of `roof` above. The
        // total vertical budget is floor + ch + roof <= hostHeight.
        var ch = chRaw
        val maxCh = hostHeightMm - 2f * roof
        if (ch > maxCh) {
            warnings += "Model too short: magnet pocket (%.2f mm) + 2×roof (%.2f mm) exceeds model height (%.2f mm); pocket clamped."
                .format(chRaw, 2f * roof, hostHeightMm)
            ch = max(0.1f, maxCh)
        }
        val floorZ = roof
        val cavityTopZ = floorZ + ch

        // Usable region: footprint inset by edge margin on each side,
        // shrunk by a full cavity so the cavity bbox stays inside.
        val rawUsableX = footprintXmm - 2f * spec.edgeMarginMm - cw
        val rawUsableY = footprintYmm - 2f * spec.edgeMarginMm - cd
        if (rawUsableX < 0f || rawUsableY < 0f) {
            warnings += "Magnet wider than inset footprint; cavities centered and may sit close to a side wall."
        }
        val usableX = max(0f, rawUsableX)
        val usableY = max(0f, rawUsableY)

        val (cols, rows) = gridDims(spec.count)
        val pitchX = if (cols > 1) usableX / (cols - 1) else 0f
        val pitchY = if (rows > 1) usableY / (rows - 1) else 0f
        // Center the grid on the actual occupied span, not on the
        // usable region — a single column/row collapses to the origin.
        val spanX = (cols - 1) * pitchX
        val spanY = (rows - 1) * pitchY

        val cavities = ArrayList<MagnetCavity>(spec.count)
        for (k in 0 until max(1, spec.count)) {
            val r = k / cols
            val c = k % cols
            val x = -spanX / 2f + c * pitchX
            val y = -spanY / 2f + r * pitchY
            cavities += MagnetCavity(centerXmm = x, centerYmm = y)
        }

        val (kind, params) = primitiveFor(spec, ch)
        val pauseZ = pauseZForCavityTop(cavityTopZ, resolvedLayerHeightMm, hostHeightMm)

        return MagnetPlacement(
            cavities = cavities,
            primitiveKind = kind,
            primitiveParams = params,
            floorZmm = floorZ,
            cavityTopZmm = cavityTopZ,
            pauseZmm = pauseZ,
            gridCols = cols,
            gridRows = rows,
            warnings = warnings,
        )
    }
}
