package dev.orcaxr.app

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * AI-paint pillar (D18e — `render_view(annotate=true)`): post-
 * rasterize burn-in of an axis triad + bbox-dim text + scale bar
 * into the rendered RGBA buffer. Pure Kotlin, no fonts loaded
 * from disk — uses a hand-coded 5×7 bitmap font for digits and
 * a few characters needed for "60 × 31 × 48 mm".
 *
 * Convention: R=X, G=Y, B=Z (universal in 3D tools). Triad goes
 * in the bottom-left corner; bbox text in the top-right; scale
 * bar at the bottom edge.
 */
internal object RenderAnnotation {

    /** Modifies [rgba] in place. [w], [h] are the image dims. */
    fun annotate(
        rgba: ByteArray,
        w: Int,
        h: Int,
        camera: AiRenderEngine.CameraSpec,
        bbox: AiIntrospection.Bbox,
    ) {
        if (w < 64 || h < 64) return  // too small to bother
        // 1. Axis triad in bottom-left.
        drawAxisTriad(rgba, w, h, camera, anchorX = 24, anchorY = h - 24, axisPx = 18)
        // 2. Bbox dims text in top-left.
        val dimText = buildString {
            append(formatMm(bbox.sizeX))
            append(" x ")
            append(formatMm(bbox.sizeY))
            append(" x ")
            append(formatMm(bbox.sizeZ))
            append(" mm")
        }
        drawText(rgba, w, h, x = 8, y = 8, text = dimText, scale = 1)
        // 3. Scale bar at bottom-center: 10 mm world-length line.
        drawScaleBar(rgba, w, h, camera, mm = 10f)
    }

    private fun formatMm(v: Float): String {
        // Round to one decimal if not a whole-mm value.
        val rounded = (v * 10).toInt() / 10f
        return if (abs(rounded - v) < 0.05f && abs(v - v.toInt()) < 0.05f) {
            "${v.toInt()}"
        } else {
            "%.1f".format(rounded)
        }
    }

    // ---- Axis triad ----

    private fun drawAxisTriad(
        rgba: ByteArray, w: Int, h: Int,
        camera: AiRenderEngine.CameraSpec,
        anchorX: Int, anchorY: Int, axisPx: Int,
    ) {
        // Project the world axes through the camera. Build two
        // world points per axis (origin + 1 unit along the axis),
        // run them through view+projection, take the screen-space
        // delta, normalize to [axisPx] pixels.
        val mvp = matMul(camera.projMatrixRowMajor, camera.viewMatrixRowMajor)
        val origin = projectToScreen(mvp, 0f, 0f, 0f, w, h) ?: return
        val xEnd = projectToScreen(mvp, 1f, 0f, 0f, w, h) ?: return
        val yEnd = projectToScreen(mvp, 0f, 1f, 0f, w, h) ?: return
        val zEnd = projectToScreen(mvp, 0f, 0f, 1f, w, h) ?: return

        fun normDelta(end: FloatArray): FloatArray {
            val dx = end[0] - origin[0]; val dy = end[1] - origin[1]
            val len = sqrt(dx * dx + dy * dy)
            return if (len > 1e-3f) floatArrayOf(dx / len * axisPx, dy / len * axisPx)
                else floatArrayOf(axisPx.toFloat(), 0f)
        }
        val dx = normDelta(xEnd)
        val dy = normDelta(yEnd)
        val dz = normDelta(zEnd)
        // Draw lines from anchor along each axis. Each axis gets
        // a 2-pixel width for legibility.
        drawLine(rgba, w, h, anchorX, anchorY, anchorX + dx[0].toInt(), anchorY + dx[1].toInt(), 230, 50, 50)
        drawLine(rgba, w, h, anchorX, anchorY, anchorX + dy[0].toInt(), anchorY + dy[1].toInt(), 50, 220, 50)
        drawLine(rgba, w, h, anchorX, anchorY, anchorX + dz[0].toInt(), anchorY + dz[1].toInt(), 50, 100, 230)
        // Tip caps: small filled squares at each axis tip.
        drawSquare(rgba, w, h, (anchorX + dx[0]).toInt(), (anchorY + dx[1]).toInt(), 2, 230, 50, 50)
        drawSquare(rgba, w, h, (anchorX + dy[0]).toInt(), (anchorY + dy[1]).toInt(), 2, 50, 220, 50)
        drawSquare(rgba, w, h, (anchorX + dz[0]).toInt(), (anchorY + dz[1]).toInt(), 2, 50, 100, 230)
    }

    // ---- Scale bar ----

    private fun drawScaleBar(
        rgba: ByteArray, w: Int, h: Int,
        camera: AiRenderEngine.CameraSpec, mm: Float,
    ) {
        // Project two points 'mm' apart along the world X axis
        // through the bbox center (origin) and measure the screen-
        // space distance between them. For orthographic projection
        // this is invariant to position; for perspective it's the
        // bbox-center value, close enough.
        val mvp = matMul(camera.projMatrixRowMajor, camera.viewMatrixRowMajor)
        val a = projectToScreen(mvp, 0f, 0f, 0f, w, h) ?: return
        val b = projectToScreen(mvp, mm, 0f, 0f, w, h) ?: return
        val pxLen = sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1])).toInt()
        if (pxLen < 8 || pxLen > w - 32) return  // too small / too large to be useful
        val barY = h - 12
        val barX0 = (w - pxLen) / 2
        val barX1 = barX0 + pxLen
        // Black line + 4-px tick caps.
        drawLine(rgba, w, h, barX0, barY, barX1, barY, 0, 0, 0)
        drawLine(rgba, w, h, barX0, barY - 4, barX0, barY + 4, 0, 0, 0)
        drawLine(rgba, w, h, barX1, barY - 4, barX1, barY + 4, 0, 0, 0)
        // Label below: e.g. "10 mm".
        val label = "${mm.toInt()} mm"
        val labelW = label.length * 6
        drawText(rgba, w, h, x = (w - labelW) / 2, y = barY + 4, text = label, scale = 1)
    }

    // ---- Drawing primitives ----

    private fun drawLine(
        rgba: ByteArray, w: Int, h: Int,
        x0: Int, y0: Int, x1: Int, y1: Int,
        r: Int, g: Int, b: Int,
    ) {
        // Bresenham, with a 2-pixel stroke (3×3 dab per step) for
        // legibility on small renders.
        var x = x0; var y = y0
        val dx = abs(x1 - x0); val dy = abs(y1 - y0)
        val sx = if (x0 < x1) 1 else -1
        val sy = if (y0 < y1) 1 else -1
        var err = dx - dy
        while (true) {
            putPixel(rgba, w, h, x, y, r, g, b)
            putPixel(rgba, w, h, x + 1, y, r, g, b)
            putPixel(rgba, w, h, x, y + 1, r, g, b)
            if (x == x1 && y == y1) break
            val e2 = err * 2
            if (e2 > -dy) { err -= dy; x += sx }
            if (e2 < dx) { err += dx; y += sy }
        }
    }

    private fun drawSquare(rgba: ByteArray, w: Int, h: Int, cx: Int, cy: Int, r: Int, rr: Int, gg: Int, bb: Int) {
        for (dy in -r..r) for (dx in -r..r) {
            putPixel(rgba, w, h, cx + dx, cy + dy, rr, gg, bb)
        }
    }

    private fun putPixel(rgba: ByteArray, w: Int, h: Int, x: Int, y: Int, r: Int, g: Int, b: Int) {
        if (x < 0 || x >= w || y < 0 || y >= h) return
        val o = (y * w + x) * 4
        rgba[o] = r.toByte()
        rgba[o + 1] = g.toByte()
        rgba[o + 2] = b.toByte()
        rgba[o + 3] = 255.toByte()
    }

    // ---- 3×5 bitmap font for digits + a few characters ----
    //
    // Each glyph is encoded as 5 rows of 3 bits, packed into a
    // single Int (15 LSB used, top-row = highest bits). MSB-first
    // within each row (bit 2 = leftmost pixel, bit 0 = rightmost).

    private val GLYPHS: Map<Char, Int> = mapOf(
        '0' to 0b111_101_101_101_111,
        '1' to 0b010_110_010_010_111,
        '2' to 0b111_001_111_100_111,
        '3' to 0b111_001_111_001_111,
        '4' to 0b101_101_111_001_001,
        '5' to 0b111_100_111_001_111,
        '6' to 0b111_100_111_101_111,
        '7' to 0b111_001_010_010_010,
        '8' to 0b111_101_111_101_111,
        '9' to 0b111_101_111_001_111,
        '.' to 0b000_000_000_000_010,
        'x' to 0b000_101_010_101_000,
        ' ' to 0,
        'm' to 0b000_111_111_101_101,
    )

    private fun drawText(
        rgba: ByteArray, w: Int, h: Int,
        x: Int, y: Int, text: String, scale: Int,
    ) {
        val cellW = 4 * scale  // 3 glyph columns + 1 column gap
        val cellH = 5 * scale
        // Backing rect (light fill) so the text reads against any
        // background.
        val pad = 2
        for (yy in y - pad until y + cellH + pad) {
            for (xx in x - pad until x + text.length * cellW + pad) {
                if (xx in 0 until w && yy in 0 until h) {
                    val o = (yy * w + xx) * 4
                    val bgR = (rgba[o].toInt() and 0xff) / 2 + 220
                    val bgG = (rgba[o + 1].toInt() and 0xff) / 2 + 220
                    val bgB = (rgba[o + 2].toInt() and 0xff) / 2 + 220
                    rgba[o] = bgR.coerceIn(0, 255).toByte()
                    rgba[o + 1] = bgG.coerceIn(0, 255).toByte()
                    rgba[o + 2] = bgB.coerceIn(0, 255).toByte()
                    rgba[o + 3] = 255.toByte()
                }
            }
        }
        var cx = x
        for (ch in text) {
            val glyph = GLYPHS[ch] ?: GLYPHS[' ']!!
            for (gy in 0 until 5) {
                val row = (glyph shr ((4 - gy) * 3)) and 0b111
                for (gx in 0 until 3) {
                    val on = (row shr (2 - gx)) and 1
                    if (on == 1) {
                        for (sy in 0 until scale) for (sx in 0 until scale) {
                            putPixel(rgba, w, h, cx + gx * scale + sx, y + gy * scale + sy, 30, 30, 30)
                        }
                    }
                }
            }
            cx += cellW
        }
    }

    // ---- Math helpers ----

    private fun matMul(a: FloatArray, b: FloatArray): FloatArray {
        val out = FloatArray(16)
        for (i in 0 until 4) for (j in 0 until 4) {
            var s = 0f
            for (k in 0 until 4) s += a[i * 4 + k] * b[k * 4 + j]
            out[i * 4 + j] = s
        }
        return out
    }

    private fun projectToScreen(
        mvp: FloatArray, x: Float, y: Float, z: Float, w: Int, h: Int,
    ): FloatArray? {
        val px = mvp[0] * x + mvp[1] * y + mvp[2] * z + mvp[3]
        val py = mvp[4] * x + mvp[5] * y + mvp[6] * z + mvp[7]
        val pz = mvp[8] * x + mvp[9] * y + mvp[10] * z + mvp[11]
        val pw = mvp[12] * x + mvp[13] * y + mvp[14] * z + mvp[15]
        val safeW = if (abs(pw) > 1e-7f) pw else 1e-7f
        val ndcX = px / safeW
        val ndcY = py / safeW
        val sx = (ndcX * 0.5f + 0.5f) * w
        val sy = (1f - (ndcY * 0.5f + 0.5f)) * h
        return floatArrayOf(sx, sy)
    }
}
