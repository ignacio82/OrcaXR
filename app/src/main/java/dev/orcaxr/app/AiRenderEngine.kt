package dev.orcaxr.app

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * AI-driven paint pillar (C9 milestone 2) — pure-Kotlin software
 * rasterizer + camera presets. Emits PNGs the LLM can reason about.
 *
 * Why pure Kotlin (not JNI)? The shipping pressure is "the LLM can
 * SEE the model end-to-end" — a Kotlin rasterizer gets there in one
 * commit with no native rebuild cycle and no Robolectric dependency.
 * For 768×768 renders on a Benchy-class mesh (~40 K tris) it's fast
 * enough (~250 ms on the host JVM, expected under 1 s on Galaxy XR
 * arm64). Migration to a JNI rasterizer is mechanical if profiling
 * later shows the renders are the bottleneck.
 *
 * Coordinate frame: input is centered_preview_mm (the BVH frame).
 * The camera presets here all live in centered_preview_mm too — the
 * LLM points at coordinates from `get_model_geometry` and they line
 * up with what's drawn.
 *
 * Render modes: solid color | paint color | triangle ID encoded
 * | normal sphere | depth.
 */
internal object AiRenderEngine {

    /** Default palette when no per-printer palette is plumbed. Distinct
     *  visually-recognizable colors matching the canonical OrcaXR slot
     *  defaults (yellow/red/brown/black, then blue/green/cyan/magenta…)
     *  so a render_view in Paint mode shows the paint structure even
     *  when the tool layer didn't pass a real palette. */
    private val FALLBACK_PALETTE: List<ByteArray> = listOf(
        byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x00),  // 1 yellow
        byteArrayOf(0xFF.toByte(), 0x00, 0x00),           // 2 red
        byteArrayOf(0x80.toByte(), 0x40, 0x00),           // 3 brown
        byteArrayOf(0x20, 0x20, 0x20),                    // 4 black-ish
        byteArrayOf(0x00, 0x66, 0xFF.toByte()),           // 5 blue
        byteArrayOf(0x00, 0xC0.toByte(), 0x00),           // 6 green
        byteArrayOf(0x00, 0xCC.toByte(), 0xCC.toByte()),  // 7 cyan
        byteArrayOf(0xCC.toByte(), 0x00, 0xCC.toByte()),  // 8 magenta
        byteArrayOf(0xFF.toByte(), 0x80.toByte(), 0x00),  // 9 orange
        byteArrayOf(0xC0.toByte(), 0xC0.toByte(), 0xC0.toByte()),  // 10 silver
    )

    enum class RenderMode {
        /** Per-volume tint from [palette], with a soft directional shade. */
        Solid,
        /** Per-triangle paint color (paintFilamentIndex slot palette).
         *  Unpainted triangles use a neutral gray. */
        Paint,
        /** RGB packs the triangle ID: red=(id+1)>>16, green=>>8, blue=&0xff.
         *  Background is (0,0,0); +1 offset so a hit-pixel reading
         *  (0,0,0) is unambiguously background. No anti-aliasing. */
        TriangleId,
        /** RGB = (n.x*0.5+0.5, n.y*0.5+0.5, n.z*0.5+0.5). */
        NormalSphere,
        /** Linear depth in [0..1] mapped to grayscale RGB. */
        Depth,
    }

    /** Camera spec. View matrix maps mesh-local → camera; projection
     *  maps camera → clip. All matrices are row-major 4x4 floats. */
    data class CameraSpec(
        val viewMatrixRowMajor: FloatArray,
        val projMatrixRowMajor: FloatArray,
        val widthPx: Int,
        val heightPx: Int,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is CameraSpec) return false
            return widthPx == other.widthPx
                && heightPx == other.heightPx
                && viewMatrixRowMajor.contentEquals(other.viewMatrixRowMajor)
                && projMatrixRowMajor.contentEquals(other.projMatrixRowMajor)
        }
        override fun hashCode(): Int {
            var h = widthPx * 31 + heightPx
            h = h * 31 + viewMatrixRowMajor.contentHashCode()
            h = h * 31 + projMatrixRowMajor.contentHashCode()
            return h
        }
    }

    /** Auxiliary metadata per render. */
    data class RenderResult(
        val pngBytes: ByteArray,
        val widthPx: Int,
        val heightPx: Int,
        /** For RenderMode.TriangleId: the per-pixel decoded triangle
         *  ID array (-1 = background). Same width × height as the PNG.
         *  Used by `resolve_image_pixel`. */
        val triangleIdMap: IntArray? = null,
    )

    // ---- Camera presets ----

    /**
     * Presets named "iso", "front", "back", "left", "right", "top",
     * "bottom", "iso_back". Each computes a view matrix looking at
     * the bbox center from a direction defined by the preset name,
     * and an orthographic projection sized to fit the bbox with a 10%
     * margin.
     */
    fun namedPreset(
        name: String,
        bbox: AiIntrospection.Bbox,
        widthPx: Int,
        heightPx: Int,
    ): CameraSpec {
        val cx = bbox.centerX; val cy = bbox.centerY; val cz = bbox.centerZ
        val diag = bbox.diagonal.coerceAtLeast(1f)
        val dist = diag * 1.5f
        val (ex, ey, ez) = when (name.lowercase()) {
            "iso" -> Triple(1.0f, -1.0f, 0.7f)
            "iso_back" -> Triple(-1.0f, 1.0f, 0.7f)
            "front" -> Triple(0.0f, -1.0f, 0.0f)
            "back" -> Triple(0.0f, 1.0f, 0.0f)
            "left" -> Triple(-1.0f, 0.0f, 0.0f)
            "right" -> Triple(1.0f, 0.0f, 0.0f)
            "top" -> Triple(0.0f, 0.0f, 1.0f)
            "bottom" -> Triple(0.0f, 0.0f, -1.0f)
            else -> Triple(1.0f, -1.0f, 0.7f)  // default to iso
        }
        val len = sqrt(ex * ex + ey * ey + ez * ez)
        val nxe = ex / len; val nye = ey / len; val nze = ez / len
        val eye = floatArrayOf(cx + nxe * dist, cy + nye * dist, cz + nze * dist)
        val target = floatArrayOf(cx, cy, cz)
        val up = floatArrayOf(0f, 0f, 1f)
        // Special-case top/bottom: world-up collinear with view dir.
        val upActual = if (name.equals("top", true) || name.equals("bottom", true))
            floatArrayOf(0f, 1f, 0f) else up
        val view = lookAtRowMajor(eye, target, upActual)
        // Orthographic projection sized to bbox (with margin) so the
        // model fills the frame regardless of which preset we picked.
        val orthoSize = diag * 1.2f
        val proj = orthographicRowMajor(
            -orthoSize / 2f, orthoSize / 2f,
            -orthoSize / 2f, orthoSize / 2f,
            -dist - diag * 2f, dist + diag * 2f,
        )
        return CameraSpec(view, proj, widthPx, heightPx)
    }

    val NAMED_PRESETS = listOf(
        "iso", "iso_back", "front", "back", "left", "right", "top", "bottom",
    )

    // ---- Rasterizer ----

    /**
     * Software-rasterize [bvh] from [camera] in [mode]. [palette] is
     * a list of "#RRGGBB" hex strings indexed by 1-based filament
     * slot (slot 0 is background / unpainted). [paintFilamentIndex]
     * carries the per-triangle paint slot for Paint mode; ignored for
     * other modes.
     */
    fun render(
        bvh: MeshBvh,
        camera: CameraSpec,
        mode: RenderMode,
        palette: List<String> = emptyList(),
        paintFilamentIndex: ByteArray? = null,
        backgroundRgb: IntArray = intArrayOf(242, 242, 242),
    ): RenderResult {
        val w = camera.widthPx
        val h = camera.heightPx
        require(w > 0 && h > 0) { "camera dims must be positive" }
        val rgba = ByteArray(w * h * 4)
        // Background fill (alpha 255).
        var i = 0
        while (i < rgba.size) {
            rgba[i] = backgroundRgb[0].toByte()
            rgba[i + 1] = backgroundRgb[1].toByte()
            rgba[i + 2] = backgroundRgb[2].toByte()
            rgba[i + 3] = 255.toByte()
            i += 4
        }
        // For TriangleId mode, fill background as (0,0,0) and seed the
        // triangleIdMap.
        val triIdMap: IntArray? = if (mode == RenderMode.TriangleId) {
            val a = IntArray(w * h) { -1 }
            i = 0
            while (i < rgba.size) {
                rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0
                i += 4
            }
            a
        } else null

        val zbuf = FloatArray(w * h) { Float.POSITIVE_INFINITY }
        val mvp = matMulRowMajor(camera.projMatrixRowMajor, camera.viewMatrixRowMajor)

        // Project all vertices to NDC then to screen.
        val n = bvh.triCount
        if (n == 0) {
            return RenderResult(PngWriter.encodeRgba(rgba, w, h), w, h, triIdMap)
        }

        // Light direction for Solid / Paint modes.
        val lightDir = normalize3(floatArrayOf(-0.4f, 0.6f, 1.0f))

        // Slot palette parsed once (RGB bytes); 0..MAX_PAINT_SLOTS.
        val slotRgb = if (palette.isNotEmpty()) parsePalette(palette) else FALLBACK_PALETTE
        val unpaintedRgb = byteArrayOf(180.toByte(), 180.toByte(), 180.toByte())

        for (tri in 0 until n) {
            val v0 = bvh.triangleVertex(tri, 0)
            val v1 = bvh.triangleVertex(tri, 1)
            val v2 = bvh.triangleVertex(tri, 2)

            val p0 = projectAndScreen(v0, mvp, w, h)
            val p1 = projectAndScreen(v1, mvp, w, h)
            val p2 = projectAndScreen(v2, mvp, w, h)

            // Skip triangles entirely behind the camera or fully outside the frame.
            if (p0[3] < 0f && p1[3] < 0f && p2[3] < 0f) continue

            val minX = max(0f, min(min(p0[0], p1[0]), p2[0]))
            val maxX = min((w - 1).toFloat(), max(max(p0[0], p1[0]), p2[0]))
            val minY = max(0f, min(min(p0[1], p1[1]), p2[1]))
            val maxY = min((h - 1).toFloat(), max(max(p0[1], p1[1]), p2[1]))
            if (maxX < minX || maxY < minY) continue

            // Pineda edge function.
            val area = edge(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1])
            if (kotlin.math.abs(area) < 1e-6f) continue
            val invArea = 1f / area
            val cw = area < 0f

            val nrm = bvh.triangleNormal(tri)

            // Per-triangle color (computed once for triangle-fill
            // modes; for triangle-id and depth/normal we recompute per
            // pixel).
            val triColor: ByteArray = when (mode) {
                RenderMode.Solid -> shadeTri(unpaintedRgb, nrm, lightDir)
                RenderMode.Paint -> {
                    val slot = paintFilamentIndex?.getOrNull(tri)?.toInt()?.and(0xff) ?: 0
                    val base = if (slot in 1..MAX_PAINT_SLOTS) slotRgb.getOrNull(slot - 1) ?: unpaintedRgb
                        else unpaintedRgb
                    shadeTri(base, nrm, lightDir)
                }
                RenderMode.TriangleId -> {
                    // (id+1) packed into RGB.
                    val id = tri + 1
                    byteArrayOf(((id shr 16) and 0xff).toByte(), ((id shr 8) and 0xff).toByte(), (id and 0xff).toByte())
                }
                RenderMode.NormalSphere -> byteArrayOf(
                    ((nrm.x * 0.5f + 0.5f) * 255f).toInt().coerceIn(0, 255).toByte(),
                    ((nrm.y * 0.5f + 0.5f) * 255f).toInt().coerceIn(0, 255).toByte(),
                    ((nrm.z * 0.5f + 0.5f) * 255f).toInt().coerceIn(0, 255).toByte(),
                )
                RenderMode.Depth -> byteArrayOf(0, 0, 0)  // recomputed per pixel
            }

            val ix0 = minX.toInt()
            val ix1 = maxX.toInt()
            val iy0 = minY.toInt()
            val iy1 = maxY.toInt()
            for (iy in iy0..iy1) {
                for (ix in ix0..ix1) {
                    val fx = ix + 0.5f; val fy = iy + 0.5f
                    val w0 = edge(p1[0], p1[1], p2[0], p2[1], fx, fy)
                    val w1 = edge(p2[0], p2[1], p0[0], p0[1], fx, fy)
                    val w2 = edge(p0[0], p0[1], p1[0], p1[1], fx, fy)
                    val inside = if (cw) (w0 <= 0 && w1 <= 0 && w2 <= 0)
                        else (w0 >= 0 && w1 >= 0 && w2 >= 0)
                    if (!inside) continue
                    val bw0 = w0 * invArea
                    val bw1 = w1 * invArea
                    val bw2 = w2 * invArea
                    val depth = bw0 * p0[2] + bw1 * p1[2] + bw2 * p2[2]
                    val pIdx = iy * w + ix
                    if (depth >= zbuf[pIdx]) continue
                    zbuf[pIdx] = depth
                    val outOff = pIdx * 4
                    when (mode) {
                        RenderMode.Depth -> {
                            // depth in NDC ~ [-1, 1]; map to [0, 1] then to gray.
                            val d = ((depth + 1f) * 0.5f).coerceIn(0f, 1f)
                            val gray = (d * 255f).toInt().coerceIn(0, 255).toByte()
                            rgba[outOff] = gray
                            rgba[outOff + 1] = gray
                            rgba[outOff + 2] = gray
                            rgba[outOff + 3] = 255.toByte()
                        }
                        RenderMode.TriangleId -> {
                            rgba[outOff] = triColor[0]
                            rgba[outOff + 1] = triColor[1]
                            rgba[outOff + 2] = triColor[2]
                            rgba[outOff + 3] = 255.toByte()
                            triIdMap!![pIdx] = tri
                        }
                        else -> {
                            rgba[outOff] = triColor[0]
                            rgba[outOff + 1] = triColor[1]
                            rgba[outOff + 2] = triColor[2]
                            rgba[outOff + 3] = 255.toByte()
                        }
                    }
                }
            }
        }

        val pngBytes = PngWriter.encodeRgba(rgba, w, h)
        return RenderResult(pngBytes, w, h, triIdMap)
    }

    // ---- Math helpers ----

    /** [view] = lookAt(eye, target, up) row-major 4x4. */
    private fun lookAtRowMajor(eye: FloatArray, target: FloatArray, up: FloatArray): FloatArray {
        // Right-handed: forward = normalize(target - eye); right =
        // normalize(cross(forward, up)); upN = cross(right, forward).
        val fx = target[0] - eye[0]; val fy = target[1] - eye[1]; val fz = target[2] - eye[2]
        val fLen = sqrt(fx * fx + fy * fy + fz * fz).coerceAtLeast(1e-7f)
        val fxn = fx / fLen; val fyn = fy / fLen; val fzn = fz / fLen
        // right = cross(forward, up) normalized
        val rx = fyn * up[2] - fzn * up[1]
        val ry = fzn * up[0] - fxn * up[2]
        val rz = fxn * up[1] - fyn * up[0]
        val rLen = sqrt(rx * rx + ry * ry + rz * rz).coerceAtLeast(1e-7f)
        val rxn = rx / rLen; val ryn = ry / rLen; val rzn = rz / rLen
        // upN = cross(right, forward)
        val uxn = ryn * fzn - rzn * fyn
        val uyn = rzn * fxn - rxn * fzn
        val uzn = rxn * fyn - ryn * fxn
        // The camera looks along -Z in OpenGL convention, so forward
        // → -Z. Camera basis: X=right, Y=up, Z=-forward.
        return floatArrayOf(
            rxn, ryn, rzn, -(rxn * eye[0] + ryn * eye[1] + rzn * eye[2]),
            uxn, uyn, uzn, -(uxn * eye[0] + uyn * eye[1] + uzn * eye[2]),
            -fxn, -fyn, -fzn, (fxn * eye[0] + fyn * eye[1] + fzn * eye[2]),
            0f, 0f, 0f, 1f,
        )
    }

    /** Symmetric orthographic projection (right-handed, OpenGL). */
    private fun orthographicRowMajor(
        l: Float, r: Float, b: Float, t: Float, n: Float, f: Float,
    ): FloatArray {
        return floatArrayOf(
            2f / (r - l), 0f, 0f, -(r + l) / (r - l),
            0f, 2f / (t - b), 0f, -(t + b) / (t - b),
            0f, 0f, -2f / (f - n), -(f + n) / (f - n),
            0f, 0f, 0f, 1f,
        )
    }

    /** Symmetric perspective projection (right-handed, OpenGL). */
    fun perspectiveRowMajor(
        fovYDeg: Float, aspect: Float, near: Float, far: Float,
    ): FloatArray {
        val fovYRad = (fovYDeg * PI / 180.0).toFloat()
        val tanHalf = tan(fovYRad / 2f)
        return floatArrayOf(
            1f / (aspect * tanHalf), 0f, 0f, 0f,
            0f, 1f / tanHalf, 0f, 0f,
            0f, 0f, -(far + near) / (far - near), -2f * far * near / (far - near),
            0f, 0f, -1f, 0f,
        )
    }

    /** A * B for 4x4 row-major matrices. */
    private fun matMulRowMajor(a: FloatArray, b: FloatArray): FloatArray {
        val out = FloatArray(16)
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var s = 0f
                for (k in 0 until 4) s += a[i * 4 + k] * b[k * 4 + j]
                out[i * 4 + j] = s
            }
        }
        return out
    }

    /** Project a mesh-local point through MVP, do perspective divide,
     *  return [screenX, screenY, ndcZ, w_clip]. */
    private fun projectAndScreen(p: Vec3f, mvp: FloatArray, width: Int, height: Int): FloatArray {
        val x = mvp[0] * p.x + mvp[1] * p.y + mvp[2] * p.z + mvp[3]
        val y = mvp[4] * p.x + mvp[5] * p.y + mvp[6] * p.z + mvp[7]
        val z = mvp[8] * p.x + mvp[9] * p.y + mvp[10] * p.z + mvp[11]
        val w = mvp[12] * p.x + mvp[13] * p.y + mvp[14] * p.z + mvp[15]
        // Avoid divide-by-zero — 1e-7 is well below anything physical
        // we'd see.
        val safeW = if (kotlin.math.abs(w) > 1e-7f) w else 1e-7f
        val ndcX = x / safeW
        val ndcY = y / safeW
        val ndcZ = z / safeW
        // Window: NDC [-1, 1] → screen [0, w]/[0, h]. Y flipped so
        // top-left origin matches PNG layout.
        val sx = (ndcX * 0.5f + 0.5f) * width
        val sy = (1f - (ndcY * 0.5f + 0.5f)) * height
        return floatArrayOf(sx, sy, ndcZ, safeW)
    }

    private fun edge(ax: Float, ay: Float, bx: Float, by: Float, cx: Float, cy: Float): Float =
        (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

    private fun shadeTri(base: ByteArray, n: Vec3f, light: FloatArray): ByteArray {
        val dot = kotlin.math.abs(n.x * light[0] + n.y * light[1] + n.z * light[2])
        val lit = (0.45f + 0.65f * dot).coerceAtMost(1f)
        return byteArrayOf(
            ((base[0].toInt() and 0xff) * lit).toInt().coerceIn(0, 255).toByte(),
            ((base[1].toInt() and 0xff) * lit).toInt().coerceIn(0, 255).toByte(),
            ((base[2].toInt() and 0xff) * lit).toInt().coerceIn(0, 255).toByte(),
        )
    }

    private fun normalize3(v: FloatArray): FloatArray {
        val len = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).coerceAtLeast(1e-7f)
        return floatArrayOf(v[0] / len, v[1] / len, v[2] / len)
    }

    private fun parsePalette(palette: List<String>): List<ByteArray> {
        val out = ArrayList<ByteArray>(palette.size)
        for (hex in palette) {
            val s = hex.trim().removePrefix("#")
            if (s.length < 6) {
                out.add(byteArrayOf(180.toByte(), 180.toByte(), 180.toByte()))
                continue
            }
            val r = s.substring(0, 2).toIntOrNull(16) ?: 180
            val g = s.substring(2, 4).toIntOrNull(16) ?: 180
            val b = s.substring(4, 6).toIntOrNull(16) ?: 180
            out.add(byteArrayOf(r.toByte(), g.toByte(), b.toByte()))
        }
        return out
    }
}
