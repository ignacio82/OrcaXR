package dev.orcaxr.app

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Perceptual color science — sRGB → CIELAB and CIEDE2000 ΔE.
 *
 * Extracted verbatim from [GamutMatcher] (commit history: "Match to my
 * filaments") so the Smart Auto-Paint projection core (M2) can quantize
 * per-triangle colors with the *same* perceptual metric the filament
 * gamut matcher uses, instead of the crude RGB-Euclidean nearest-palette
 * the older MCP paint tools use. `GamutMatcher` now delegates here;
 * `GamutMatcherTest` pins that the numbers did not move.
 *
 * D65 reference white, 2° observer. CIEDE2000 is the full Sharma et al.
 * 2005 formulation with `kL = kC = kH = 1`.
 */
object ColorScience {

    /** D65 reference white (2° observer). */
    private const val XN = 0.95047
    private const val YN = 1.00000
    private const val ZN = 1.08883
    private const val EPS = 216.0 / 24389.0
    private const val KAPPA = 24389.0 / 27.0

    data class Lab(val l: Double, val a: Double, val b: Double)

    fun srgbToLinear(c: Int): Double {
        val s = c / 255.0
        return if (s <= 0.04045) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
    }

    /** 8-bit sRGB triple → CIELAB. */
    fun rgbToLab(r: Int, g: Int, b: Int): Lab {
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

    /** Parse "#RRGGBB" (or bare "RRGGBB") → CIELAB, or null if it isn't
     *  a 6-hex color. */
    fun parseLab(hex: String): Lab? {
        val h = hex.trim().trimStart('#')
        if (h.length < 6) return null
        val r = h.substring(0, 2).toIntOrNull(16) ?: return null
        val g = h.substring(2, 4).toIntOrNull(16) ?: return null
        val b = h.substring(4, 6).toIntOrNull(16) ?: return null
        return rgbToLab(r, g, b)
    }

    /** CIEDE2000 ΔE between two CIELAB colors (Sharma et al. 2005). */
    fun ciede2000(a: Lab, b: Lab): Double {
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

    /**
     * Index into [palette] of the CIEDE2000-nearest color to [target],
     * or -1 when the palette is empty. First-match-wins on ties so the
     * result is deterministic for a given palette order.
     */
    fun nearestIndex(target: Lab, palette: List<Lab>): Int {
        var best = -1
        var bestD = Double.POSITIVE_INFINITY
        for (i in palette.indices) {
            val d = ciede2000(target, palette[i])
            if (d < bestD) { bestD = d; best = i }
        }
        return best
    }
}
