package dev.orcaxr.app

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Maps a model's authored colors onto the colors the active printer can
 * actually produce — the loaded physical filaments PLUS the apparent
 * colors FullSpectrum can synthesize by blending two of them.
 *
 * This is the engine behind the user-triggered "Match to my filaments"
 * button. It is deliberately a pure function with no Android / DataStore
 * dependency so it unit-tests like [serializeMixedFilamentDefinitions]:
 * the caller injects the blender (the native pigment-aware mixer in the
 * app, the gamma-correct sRGB fallback in tests).
 *
 * Honest scope notes:
 *  - Filament mixing is subtractive: you cannot reproduce a color
 *    brighter or more saturated than your loaded filaments. The matcher
 *    reports the perceptual error ([GamutMatch.deltaE], CIEDE2000) and a
 *    [MatchQuality] band so the UI can say "best effort" instead of
 *    pretending the match is faithful.
 *  - A blended recipe only reads as a third color at viewing distance /
 *    on flat top surfaces; on vertical walls it shows as banding. The
 *    matcher does not model geometry — the swatch is an idealization.
 *  - Per project notes, FullSpectrum LayerCycle emission is not yet
 *    landed. A [GamutRecipe.Blend] match is forward-correct (it prints
 *    as the nearest physical until the engine ships, then becomes the
 *    true blend with no re-match) — the UI must flag this.
 */
object GamutMatcher {

    /** CIEDE2000 perceptual-distance bands. Tuned for filament swatches,
     *  not display calibration: 1.0 ≈ imperceptible side-by-side, 3.0 ≈
     *  noticeable only on close inspection, 8.0 ≈ clearly a different
     *  shade but the same color family, beyond that it is a best-effort
     *  substitution the user should sign off on. */
    private const val DELTA_E_EXACT = 1.0
    private const val DELTA_E_CLOSE = 3.0
    private const val DELTA_E_APPROXIMATE = 8.0

    /** How a model color maps onto the achievable gamut. */
    sealed interface GamutRecipe {
        /** Print directly from one loaded physical slot (0-based, T0=0). */
        data class Physical(val physicalSlot0: Int) : GamutRecipe

        /**
         * Print as a FullSpectrum blend of two physical filaments.
         * [componentA1]/[componentB1] are 1-based physical filament ids
         * (matching [MixedFilamentEntry.componentA]); [mixBPercent] is
         * the blend weight of B in [0..100], the same knob
         * [resolveMixedRowDisplayColor] reads.
         */
        data class Blend(
            val componentA1: Int,
            val componentB1: Int,
            val mixBPercent: Int,
        ) : GamutRecipe

        /** No usable match (unparseable source, or no loaded filaments).
         *  Apply leaves the project filament's authored color and mapping
         *  exactly as-is rather than guessing. */
        data object Keep : GamutRecipe
    }

    enum class MatchQuality { EXACT, CLOSE, APPROXIMATE, OUT_OF_GAMUT }

    /** A reachable color and the recipe that produces it. */
    data class GamutCandidate(val hex: String, val recipe: GamutRecipe)

    /** The chosen match for one project filament. */
    data class GamutMatch(
        /** Index into the project filament list this match is for. */
        val sourceIndex: Int,
        val sourceHex: String,
        val targetHex: String,
        val recipe: GamutRecipe,
        val deltaE: Double,
        val quality: MatchQuality,
    )

    /** Result of [applyGamutMatches]: the rewritten project palette plus
     *  the virtual-row list with any blend rows the matches needed. */
    data class ApplyResult(
        val filaments: List<FilamentEntry>,
        val virtualRows: List<MixedFilamentEntry>,
    )

    /** Default blender — routes through libslic3r's pigment-aware mixer
     *  when the native hook is wired (production), else the gamma-correct
     *  sRGB midpoint (unit tests). Same path the slice preview uses, so
     *  the matched swatch equals what the slicer will emit. */
    private val defaultBlender: (List<Pair<String, Float>>) -> String =
        ::blendComponentsHexPigmentAware

    /**
     * Enumerate the colors this printer can produce.
     *
     * @param physicalColors loaded slot colors, indexed by 0-based
     *   physical slot. Entries that fail to parse are skipped.
     * @param mixStepPercent quantization of the blend weight. 10 → blend
     *   candidates at B = 10,20,…,90 % for every unordered pair (the
     *   0 / 100 ends are dropped: they are the pure-physical candidates
     *   already in the set).
     * @param blend injected mixer; defaults to the app/test shared path.
     */
    fun enumerateGamut(
        physicalColors: List<String>,
        mixStepPercent: Int = 10,
        blend: (List<Pair<String, Float>>) -> String = defaultBlender,
    ): List<GamutCandidate> {
        val out = ArrayList<GamutCandidate>()
        physicalColors.forEachIndexed { i, hex ->
            if (parseLab(hex) != null) {
                out += GamutCandidate(normalizeHex(hex), GamutRecipe.Physical(i))
            }
        }
        val step = mixStepPercent.coerceIn(5, 50)
        val n = physicalColors.size
        for (a in 0 until n) {
            val ah = physicalColors[a]
            if (parseLab(ah) == null) continue
            for (b in (a + 1) until n) {
                val bh = physicalColors[b]
                if (parseLab(bh) == null) continue
                var mixB = step
                while (mixB <= 100 - step) {
                    val wB = mixB / 100f
                    val hex = blend(listOf(ah to (1f - wB), bh to wB))
                    if (parseLab(hex) != null) {
                        out += GamutCandidate(
                            normalizeHex(hex),
                            // 1-based physical filament ids.
                            GamutRecipe.Blend(a + 1, b + 1, mixB),
                        )
                    }
                    mixB += step
                }
            }
        }
        return out
    }

    /**
     * For each color in [sourceColors] pick the perceptually nearest
     * member of the achievable gamut. [sourceColors] is one entry per
     * project filament, in project order, so [GamutMatch.sourceIndex]
     * lines up with the [FilamentEntry] list.
     *
     * A blend candidate is only preferred over the nearest pure physical
     * when it is meaningfully closer ([blendDeltaEMargin]) — a marginal
     * blend is not worth the extra toolchanges / banding, so ties go to
     * the simpler physical recipe.
     */
    fun matchModelColors(
        sourceColors: List<String>,
        physicalColors: List<String>,
        mixStepPercent: Int = 10,
        blendDeltaEMargin: Double = 0.5,
        blend: (List<Pair<String, Float>>) -> String = defaultBlender,
    ): List<GamutMatch> {
        val gamut = enumerateGamut(physicalColors, mixStepPercent, blend)
        val physicalLab = physicalColors.map { parseLab(it) }
        return sourceColors.mapIndexed { idx, src ->
            val srcLab = parseLab(src)
            if (srcLab == null || gamut.isEmpty()) {
                return@mapIndexed GamutMatch(
                    idx, normalizeHex(src), normalizeHex(src),
                    GamutRecipe.Keep, Double.MAX_VALUE,
                    MatchQuality.OUT_OF_GAMUT,
                )
            }
            // Best pure-physical option, used as the tie-break baseline.
            var bestPhysical: Pair<GamutCandidate, Double>? = null
            var bestOverall: Pair<GamutCandidate, Double>? = null
            for (c in gamut) {
                val lab = parseLab(c.hex) ?: continue
                val d = ciede2000(srcLab, lab)
                if (bestOverall == null || d < bestOverall.second) {
                    bestOverall = c to d
                }
                if (c.recipe is GamutRecipe.Physical &&
                    (bestPhysical == null || d < bestPhysical.second)
                ) {
                    bestPhysical = c to d
                }
            }
            val phys = bestPhysical
            val overall = bestOverall!!
            val chosen = when {
                phys == null -> overall
                overall.first.recipe is GamutRecipe.Physical -> overall
                // Prefer the blend only if it clears the margin.
                phys.second - overall.second > blendDeltaEMargin -> overall
                else -> phys
            }
            GamutMatch(
                sourceIndex = idx,
                sourceHex = normalizeHex(src),
                targetHex = chosen.first.hex,
                recipe = chosen.first.recipe,
                deltaE = chosen.second,
                quality = classify(chosen.second),
            )
        }
    }

    fun classify(deltaE: Double): MatchQuality = when {
        deltaE <= DELTA_E_EXACT -> MatchQuality.EXACT
        deltaE <= DELTA_E_CLOSE -> MatchQuality.CLOSE
        deltaE <= DELTA_E_APPROXIMATE -> MatchQuality.APPROXIMATE
        else -> MatchQuality.OUT_OF_GAMUT
    }

    /**
     * Apply [matches] to the project palette without mutating the slice
     * path: physical matches set [FilamentEntry.physicalSlot]; blend
     * matches reuse an existing equivalent [MixedFilamentEntry] (same
     * components + mix, not deleted) or append a new one, then point the
     * filament's [FilamentEntry.virtualSlot] at it. Pure — the caller
     * persists the two returned lists to their stores.
     *
     * Unlike the single-pick `applyMapToPhysical`, this intentionally
     * does NOT enforce physical-slot uniqueness: several model colors
     * legitimately collapsing onto one loaded filament is the whole
     * point of a gamut remap.
     *
     * @param distributionMode mode stamped on freshly created blend rows
     *   (0 = LayerCycle — forward-correct per the project's chosen
     *   "create blend rows, flag honestly" behavior).
     */
    fun applyGamutMatches(
        filaments: List<FilamentEntry>,
        virtualRows: List<MixedFilamentEntry>,
        matches: List<GamutMatch>,
        distributionMode: Int = 0,
    ): ApplyResult {
        val rows = virtualRows.toMutableList()

        fun ensureBlendRow(a1: Int, b1: Int, mixB: Int): Int {
            val existing = rows.indexOfFirst {
                !it.deleted &&
                    it.gradientComponentIds.isEmpty() &&
                    it.manualPattern.isNullOrBlank() &&
                    it.componentA == a1 && it.componentB == b1 &&
                    it.mixBPercent == mixB
            }
            if (existing >= 0) return existing + 1 // 1-based
            rows += MixedFilamentEntry(
                id = "match_${a1}_${b1}_${mixB}",
                componentA = a1,
                componentB = b1,
                mixBPercent = mixB,
                distributionMode = distributionMode,
                enabled = true,
                custom = true,
            )
            return rows.size // 1-based index of the row just appended
        }

        val byIndex = matches.associateBy { it.sourceIndex }
        val updated = filaments.mapIndexed { i, f ->
            when (val recipe = byIndex[i]?.recipe) {
                is GamutRecipe.Physical ->
                    f.copy(physicalSlot = recipe.physicalSlot0, virtualSlot = null)
                is GamutRecipe.Blend -> {
                    val slot1 = ensureBlendRow(
                        recipe.componentA1, recipe.componentB1, recipe.mixBPercent,
                    )
                    f.copy(physicalSlot = null, virtualSlot = slot1)
                }
                GamutRecipe.Keep, null -> f
            }
        }
        return ApplyResult(updated, rows)
    }

    // ---- color science -------------------------------------------------

    /** D65 reference white (2° observer). */
    private const val XN = 0.95047
    private const val YN = 1.00000
    private const val ZN = 1.08883
    private const val EPS = 216.0 / 24389.0
    private const val KAPPA = 24389.0 / 27.0

    private data class Lab(val l: Double, val a: Double, val b: Double)

    private fun normalizeHex(s: String): String {
        val h = s.trim().trimStart('#').padStart(6, '0').take(6)
        return "#${h.uppercase()}"
    }

    private fun srgbToLinear(c: Int): Double {
        val s = c / 255.0
        return if (s <= 0.04045) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
    }

    /** Parse "#RRGGBB" → CIELAB, or null if it isn't a 6-hex color. */
    private fun parseLab(hex: String): Lab? {
        val h = hex.trim().trimStart('#')
        if (h.length < 6) return null
        val r = h.substring(0, 2).toIntOrNull(16) ?: return null
        val g = h.substring(2, 4).toIntOrNull(16) ?: return null
        val b = h.substring(4, 6).toIntOrNull(16) ?: return null
        val rl = srgbToLinear(r)
        val gl = srgbToLinear(g)
        val bl = srgbToLinear(b)
        // linear sRGB → XYZ (D65)
        val x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / XN
        val y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / YN
        val z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / ZN
        fun f(t: Double) = if (t > EPS) Math.cbrt(t) else (KAPPA * t + 16.0) / 116.0
        val fx = f(x); val fy = f(y); val fz = f(z)
        return Lab(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
    }

    /** CIEDE2000 ΔE between two CIELAB colors (Sharma et al. 2005). */
    private fun ciede2000(a: Lab, b: Lab): Double {
        val kL = 1.0; val kC = 1.0; val kH = 1.0
        val c1 = sqrt(a.a * a.a + a.b * a.b)
        val c2 = sqrt(b.a * b.a + b.b * b.b)
        val cBar = (c1 + c2) / 2.0
        val cBar7 = cBar.pow(7.0)
        val g = 0.5 * (1.0 - sqrt(cBar7 / (cBar7 + 25.0.pow(7.0))))
        val a1p = (1.0 + g) * a.a
        val a2p = (1.0 + g) * b.a
        val c1p = sqrt(a1p * a1p + a.b * a.b)
        val c2p = sqrt(a2p * a2p + b.b * b.b)
        fun hp(ap: Double, bb: Double): Double {
            if (ap == 0.0 && bb == 0.0) return 0.0
            var h = Math.toDegrees(atan2(bb, ap))
            if (h < 0) h += 360.0
            return h
        }
        val h1p = hp(a1p, a.b)
        val h2p = hp(a2p, b.b)
        val dLp = b.l - a.l
        val dCp = c2p - c1p
        val dhp = when {
            c1p * c2p == 0.0 -> 0.0
            kotlin.math.abs(h2p - h1p) <= 180.0 -> h2p - h1p
            h2p - h1p > 180.0 -> h2p - h1p - 360.0
            else -> h2p - h1p + 360.0
        }
        val dHp = 2.0 * sqrt(c1p * c2p) * sin(Math.toRadians(dhp / 2.0))
        val lBarp = (a.l + b.l) / 2.0
        val cBarp = (c1p + c2p) / 2.0
        val hBarp = when {
            c1p * c2p == 0.0 -> h1p + h2p
            kotlin.math.abs(h1p - h2p) <= 180.0 -> (h1p + h2p) / 2.0
            h1p + h2p < 360.0 -> (h1p + h2p + 360.0) / 2.0
            else -> (h1p + h2p - 360.0) / 2.0
        }
        val t = 1.0 -
            0.17 * cos(Math.toRadians(hBarp - 30.0)) +
            0.24 * cos(Math.toRadians(2.0 * hBarp)) +
            0.32 * cos(Math.toRadians(3.0 * hBarp + 6.0)) -
            0.20 * cos(Math.toRadians(4.0 * hBarp - 63.0))
        val dTheta = 30.0 * exp(-(((hBarp - 275.0) / 25.0).pow(2.0)))
        val cBarp7 = cBarp.pow(7.0)
        val rc = 2.0 * sqrt(cBarp7 / (cBarp7 + 25.0.pow(7.0)))
        val sl = 1.0 + (0.015 * (lBarp - 50.0).pow(2.0)) /
            sqrt(20.0 + (lBarp - 50.0).pow(2.0))
        val sc = 1.0 + 0.045 * cBarp
        val sh = 1.0 + 0.015 * cBarp * t
        val rt = -sin(Math.toRadians(2.0 * dTheta)) * rc
        val termL = dLp / (kL * sl)
        val termC = dCp / (kC * sc)
        val termH = dHp / (kH * sh)
        return sqrt(
            termL * termL + termC * termC + termH * termH +
                rt * termC * termH,
        )
    }
}
