package dev.orcaxr.app

import java.io.File

/**
 * D4 — direction the boolean operation runs.
 *
 * [ADD] (UNION) raises the emboss geometry on top of the host (the
 * "raised letters / icon" feel of a stamped logo). [SUB] (A_NOT_B)
 * cuts the emboss geometry out of the host (the "engraved letters" feel
 * of a recessed inscription). The native ordinals match the JNI's
 * `mcut::make_boolean` operand strings: 0=UNION, 1=A_NOT_B.
 */
enum class EmbossMode(val nativeOrdinal: Int) {
    ADD(0),
    SUB(1),
}

/**
 * D4 — what kind of emboss source the user is building.
 *
 * - [Text] uses a bundled or user-picked TTF font + a string. The
 *   native side calls libslic3r `Emboss::text2shapes` (stb_truetype
 *   under the hood) to convert glyph outlines to ExPolygons before
 *   extrusion.
 * - [Svg] uses an .svg file. Only filled paths are extruded —
 *   pure-stroke icons need to be converted to fill in the authoring
 *   tool first.
 *
 * Fields:
 * - [sizeMm] — for [Text], the line height in millimeters; for [Svg],
 *   the desired max XY dimension (the larger of bboxX / bboxY) of the
 *   result. Pass `0f` for [Svg] to keep the SVG's own (mm-parsed)
 *   units.
 * - [depthMm] — Z-extrusion depth, applied identically to both kinds.
 */
sealed interface EmbossSpec {
    val sizeMm: Float
    val depthMm: Float

    data class Text(
        val fontFile: File,
        val text: String,
        override val sizeMm: Float,
        override val depthMm: Float,
    ) : EmbossSpec

    data class Svg(
        val svgFile: File,
        override val sizeMm: Float,
        override val depthMm: Float,
    ) : EmbossSpec
}

/**
 * D4 — geometry helpers for placing an emboss mesh on a host.
 *
 * The emboss meshes built by `SlicerEngine.buildTextMesh` /
 * `buildSvgMesh` are XY-centered around (0, 0) with Z = 0..depthMm.
 * The "transform" passed to `applyEmboss` is responsible for moving
 * that mesh into the host's printer-mm coordinate system (which after
 * `Model::add_object` is the model's mesh-local frame, not bed-world
 * space — `nativeApplyEmboss` already pre-applies the host instance
 * transform if any).
 */
object EmbossOp {
    /**
     * Identity 4×4 in row-major flat layout.
     *
     * Useful for tests where the emboss mesh is already positioned
     * exactly where the boolean should run.
     */
    fun identityTransform(): FloatArray = floatArrayOf(
        1f, 0f, 0f, 0f,
        0f, 1f, 0f, 0f,
        0f, 0f, 1f, 0f,
        0f, 0f, 0f, 1f,
    )

    /**
     * Build a row-major 4×4 transform that places the emboss mesh on
     * the **top face** of the host model's bbox, centered in XY.
     *
     * For ADD (raised letters), the emboss bottom plane lands exactly
     * on the host's top surface, so the union grafts the letters above.
     *
     * For SUB (engrave), pass [sinkDepthMm] > 0 to push the emboss
     * down into the host before the boolean, otherwise an A_NOT_B with
     * the emboss sitting flat on the surface would carve almost
     * nothing (only the bottom epsilon layer of the emboss would
     * intersect the host's top face). A typical value is the emboss
     * depth itself, so the engraving carves a recess of [depthMm] into
     * the host. For ADD this should be 0.
     *
     * [host*] are the host's mesh-local axis-aligned bbox (you
     * typically read these from `PlacedModel.baseBboxXmm/Ymm/Zmm`).
     * The bbox is assumed to start at z = 0 (libslic3r meshes load
     * with their bottom on the bed plane); if your host's mesh has a
     * non-zero min-Z, pass the full bounding box's max-Z as
     * [hostBboxMaxZmm].
     *
     * [embossDepthMm] is the depth of the emboss mesh; combined with
     * [sinkDepthMm] it determines the Z origin of the emboss block:
     * - top of emboss = hostBboxMaxZmm + embossDepthMm − sinkDepthMm
     * - bottom of emboss = hostBboxMaxZmm − sinkDepthMm
     *
     * [translateXmm] / [translateYmm] let the user nudge the emboss
     * around on the top face (e.g. to position a logo on the front
     * half of a phone case). Default (0, 0) puts the emboss bbox
     * center at the host bbox center in XY.
     *
     * The result is laid out row-major (suitable for the
     * `applyEmboss(transform4x4)` parameter).
     */
    fun transformForTopOfBbox(
        hostBboxMaxZmm: Float,
        embossDepthMm: Float,
        sinkDepthMm: Float = 0f,
        translateXmm: Float = 0f,
        translateYmm: Float = 0f,
    ): FloatArray {
        // Emboss mesh has Z = 0..embossDepthMm, XY-centered.
        // We want bottom plane at (hostBboxMaxZmm - sinkDepthMm).
        val tz = hostBboxMaxZmm - sinkDepthMm
        return floatArrayOf(
            1f, 0f, 0f, translateXmm,
            0f, 1f, 0f, translateYmm,
            0f, 0f, 1f, tz,
            0f, 0f, 0f, 1f,
        )
    }

    /**
     * Compose two row-major 4×4 transforms. Returns A × B as a flat
     * 16-float row-major array.
     *
     * Use to chain a top-of-bbox placement with an additional rotation
     * or offset. `transformForTopOfBbox` followed by a Z rotation, for
     * instance:
     * ```
     * val placement = EmbossOp.transformForTopOfBbox(...)
     * val rot = EmbossOp.rotationZ(45f)
     * val combined = EmbossOp.compose(placement, rot)
     * ```
     */
    fun compose(a: FloatArray, b: FloatArray): FloatArray {
        require(a.size == 16 && b.size == 16) {
            "compose expects two 16-float matrices, got ${a.size} and ${b.size}"
        }
        val out = FloatArray(16)
        for (row in 0..3) {
            for (col in 0..3) {
                var s = 0f
                for (k in 0..3) {
                    s += a[row * 4 + k] * b[k * 4 + col]
                }
                out[row * 4 + col] = s
            }
        }
        return out
    }

    /**
     * Build a row-major 4×4 rotation matrix around the Z axis by
     * [degrees]. Used to rotate text/SVG around the placement anchor
     * before the boolean.
     */
    fun rotationZ(degrees: Float): FloatArray {
        val r = Math.toRadians(degrees.toDouble())
        val c = Math.cos(r).toFloat()
        val s = Math.sin(r).toFloat()
        return floatArrayOf(
            c, -s, 0f, 0f,
             s,  c, 0f, 0f,
            0f, 0f, 1f, 0f,
            0f, 0f, 0f, 1f,
        )
    }
}
