package dev.orcaxr.app

import kotlin.math.max

/**
 * Roadmap A13 — wipe-tower auto-positioning.
 *
 * Pure-Kotlin scorer. Given the bed extents, the wipe tower's
 * footprint, and the XY footprints of every part on the active plate,
 * evaluates a small fixed grid of candidate tower positions and
 * picks the one with the largest minimum L∞ clearance to every part.
 *
 * The 8-candidate grid mirrors u1-slicer-for-android's strategy:
 *   - 4 corners (back-left, back-right, front-left, front-right)
 *   - 4 cardinal mid-edges (back-mid, left-mid, right-mid, front-mid)
 *
 * "Back-left" is preferred when ties occur because it's outside the
 * user's typical gaze direction (the headset's rendered camera looks
 * front-down at the bed). Override with [Bias].
 *
 * Coordinate convention matches libslic3r:
 *   - bed origin at (0, 0); +X = right, +Y = back.
 *   - `wipe_tower_x` / `wipe_tower_y` is the LEFT-FRONT corner of the
 *     tower's AABB (PrintConfig.cpp:6442-6456). The scorer returns
 *     coordinates in the same convention so the picked values can be
 *     written verbatim into the slice config.
 */
object WipeTowerPlacement {

    /** A 2D axis-aligned rectangle in printer-frame mm. */
    data class AabbXY(val xMin: Float, val yMin: Float, val xMax: Float, val yMax: Float) {
        val width: Float get() = xMax - xMin
        val depth: Float get() = yMax - yMin

        companion object {
            fun of(cx: Float, cy: Float, w: Float, d: Float): AabbXY =
                AabbXY(cx - w / 2f, cy - d / 2f, cx + w / 2f, cy + d / 2f)
        }
    }

    /**
     * Tie-breaking preference. `BackLeft` is the default: the headset's
     * gaze typically looks front-down at the bed, so back-left is the
     * least-obscuring corner.
     */
    enum class Bias {
        BackLeft, BackRight, FrontLeft, FrontRight, LargestClearance;

        companion object {
            fun parse(name: String?): Bias {
                if (name == null) return BackLeft
                return when (name.lowercase().replace("-", "_")) {
                    "back_left" -> BackLeft
                    "back_right" -> BackRight
                    "front_left" -> FrontLeft
                    "front_right" -> FrontRight
                    "largest_clearance", "largest", "max" -> LargestClearance
                    else -> BackLeft
                }
            }
        }
    }

    /** A picked candidate, with its scoring metadata. */
    data class Pick(
        /** wipe_tower_x — printer-frame X of the tower's left-front corner, mm. */
        val xMm: Float,
        /** wipe_tower_y — printer-frame Y of the tower's left-front corner, mm. */
        val yMm: Float,
        /** Minimum L∞ distance (mm) to any part's XY bbox at this position. */
        val clearanceMm: Float,
        /** Human-readable label of which candidate won (e.g. "back-left"). */
        val label: String,
    )

    /**
     * Score the 8 candidates and return the best.
     *
     * @param parts   AABBs of every part footprint on the active plate
     *                (printer-frame mm).
     * @param towerW  Tower width in X (mm). Default 60 mm matches the
     *                Snapmaker U1's bundled `prime_tower_width=60`.
     * @param towerD  Tower depth in Y (mm). Defaults to `towerW` because
     *                libslic3r's wipe-tower is square-ish.
     * @param safetyMm Extra clearance margin appended to the tower's
     *                AABB during scoring. Larger values prefer positions
     *                farther from any part.
     * @param bedW    Bed extent in X (mm).
     * @param bedD    Bed extent in Y (mm).
     * @param bias    Tie-breaking preference (default back-left).
     */
    fun score(
        parts: List<AabbXY>,
        bedW: Float,
        bedD: Float,
        towerW: Float = 60f,
        towerD: Float = 60f,
        safetyMm: Float = 5f,
        bias: Bias = Bias.BackLeft,
    ): Pick {
        // Inflate the tower's footprint by the safety margin when
        // scoring — a part that's exactly `safetyMm` from the tower
        // surface counts as zero clearance.
        val tw = (towerW + 2 * safetyMm).coerceAtLeast(1f)
        val td = (towerD + 2 * safetyMm).coerceAtLeast(1f)

        // Candidate left-front corners. Each is a (label, x, y) triple.
        // Inset from bed edges by 1 mm so the tower doesn't touch the
        // skirt; libslic3r will reject a tower that overflows the bed.
        val inset = 1f
        val xLeft = inset
        val xRight = (bedW - towerW - inset).coerceAtLeast(0f)
        val xMid = ((bedW - towerW) / 2f).coerceAtLeast(0f)
        val yFront = inset
        val yBack = (bedD - towerD - inset).coerceAtLeast(0f)
        val yMid = ((bedD - towerD) / 2f).coerceAtLeast(0f)

        val candidates = listOf(
            "back-left" to (xLeft to yBack),
            "back-right" to (xRight to yBack),
            "front-left" to (xLeft to yFront),
            "front-right" to (xRight to yFront),
            "back-mid" to (xMid to yBack),
            "front-mid" to (xMid to yFront),
            "left-mid" to (xLeft to yMid),
            "right-mid" to (xRight to yMid),
        )

        // Bias index: when two candidates are within COMPARE_EPS_MM mm
        // of each other on clearance, prefer the bias's preferred
        // candidate. LargestClearance disables the bias path so the
        // strict argmax wins.
        val biasOrder: List<String> = when (bias) {
            Bias.BackLeft -> listOf("back-left", "back-mid", "back-right", "left-mid", "right-mid", "front-left", "front-mid", "front-right")
            Bias.BackRight -> listOf("back-right", "back-mid", "back-left", "right-mid", "left-mid", "front-right", "front-mid", "front-left")
            Bias.FrontLeft -> listOf("front-left", "front-mid", "front-right", "left-mid", "right-mid", "back-left", "back-mid", "back-right")
            Bias.FrontRight -> listOf("front-right", "front-mid", "front-left", "right-mid", "left-mid", "back-right", "back-mid", "back-left")
            Bias.LargestClearance -> emptyList()
        }

        // Score each candidate by minimum L∞ distance to every part.
        // Empty parts list → infinite clearance; any candidate wins.
        val ranked = candidates.map { (label, xy) ->
            val (x, y) = xy
            val tower = AabbXY(x, y, x + tw, y + td)
            val minClearance = if (parts.isEmpty()) Float.POSITIVE_INFINITY
            else parts.minOf { aabbLInfClearance(tower, it) }
            Triple(label, Pair(x, y), minClearance)
        }

        val best = if (bias == Bias.LargestClearance) {
            ranked.maxByOrNull { it.third }!!
        } else {
            // Sort by clearance desc, then by bias-preferred order.
            val byBias = biasOrder.withIndex().associate { (i, lbl) -> lbl to i }
            ranked.sortedWith(
                compareByDescending<Triple<String, Pair<Float, Float>, Float>> {
                    // Bucket clearances within 5 mm so the bias has room to win.
                    (it.third / COMPARE_EPS_MM).toInt()
                }.thenBy { byBias[it.first] ?: Int.MAX_VALUE },
            ).first()
        }

        val (label, xy, clearance) = best
        return Pick(
            xMm = xy.first,
            yMm = xy.second,
            clearanceMm = if (clearance.isInfinite()) Float.POSITIVE_INFINITY else clearance,
            label = label,
        )
    }

    /**
     * L∞ ("Chebyshev") distance between two AABBs. Negative if they
     * overlap (interpenetration depth). Positive equals the larger of
     * the X-gap and Y-gap; we use L∞ rather than Euclidean because
     * the wipe-tower clearance constraint is "stay this many mm away
     * along EACH axis", not "stay this many mm away in radial sum".
     */
    fun aabbLInfClearance(a: AabbXY, b: AabbXY): Float {
        val dx = max(a.xMin - b.xMax, b.xMin - a.xMax)
        val dy = max(a.yMin - b.yMax, b.yMin - a.yMax)
        // If both are negative (overlap on both axes), use the
        // less-negative one (smallest interpenetration depth).
        return max(dx, dy)
    }

    /** Within this many mm we treat two clearances as a tie and let
     *  [Bias] break the tie. Coarse enough that "back-left vs
     *  back-mid both clear" lands at back-left, fine enough that a
     *  10 mm difference is still preferred. */
    private const val COMPARE_EPS_MM = 5f
}
