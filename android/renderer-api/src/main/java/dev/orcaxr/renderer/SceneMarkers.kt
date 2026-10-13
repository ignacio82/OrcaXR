package dev.orcaxr.renderer

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A marker's geometry, shared by every marker that draws it: facets in its
 * own millimetres, three corners each ([facetCount] of them), or — for a
 * shape of [lines] — segments, two ends each ([segmentCount] of them). Each
 * facet may carry a baked shade ([shades], ARGB grey), which the marker's
 * colour tints as a model's tints its baked shading; without one a facet
 * shows the colour itself. Markers are annotations a tool draws over the
 * project, never the project's meshes.
 */
class MarkerShape private constructor(
    val key: String,
    internal val xyz: FloatArray,
    val lines: Boolean = false,
    internal val shades: IntArray? = null,
) {
    val facetCount get() = if (lines) 0 else xyz.size / 9
    val segmentCount get() = if (lines) xyz.size / 6 else 0
    /** Points the shape draws: three per facet, or two per segment. */
    val pointCount get() = xyz.size / 3

    /** Corner [corner] of facet [facet], in the shape's millimetres. */
    fun corner(facet: Int, corner: Int) = point(facet * 3 + corner)

    /** End [end] (0 or 1) of segment [segment], in the shape's millimetres. */
    fun end(segment: Int, end: Int) = point(segment * 2 + end)

    /** Point [index] in drawing order. */
    fun point(index: Int) = (index * 3).let { Point3(xyz[it].toDouble(), xyz[it + 1].toDouble(), xyz[it + 2].toDouble()) }

    /** Facet [facet]'s baked shade (opaque ARGB), white when the shape bakes none. */
    fun shade(facet: Int): Int = shades?.get(facet) ?: WHITE

    companion object {
        private const val WHITE = 0xffffffff.toInt()

        private fun packed(points: List<Point3>): FloatArray {
            val xyz = FloatArray(points.size * 3)
            points.forEachIndexed { index, point ->
                xyz[index * 3] = point.x.toFloat(); xyz[index * 3 + 1] = point.y.toFloat(); xyz[index * 3 + 2] = point.z.toFloat()
            }
            return xyz
        }

        /** The unit cube's corners, from (0, 0, 0) to (1, 1, 1): bit 0 is x, bit 1 y, bit 2 z. */
        private fun cubeCorner(bits: Int) = Point3((bits and 1).toDouble(), (bits shr 1 and 1).toDouble(), (bits shr 2 and 1).toDouble())

        /** The unit cube's faces, each as four corners wound outward, with its outward normal. */
        private val CUBE_FACES = listOf(
            intArrayOf(0, 2, 3, 1) to Point3(0.0, 0.0, -1.0),
            intArrayOf(4, 5, 7, 6) to Point3(0.0, 0.0, 1.0),
            intArrayOf(0, 1, 5, 4) to Point3(0.0, -1.0, 0.0),
            intArrayOf(2, 6, 7, 3) to Point3(0.0, 1.0, 0.0),
            intArrayOf(0, 4, 6, 2) to Point3(-1.0, 0.0, 0.0),
            intArrayOf(1, 3, 7, 5) to Point3(1.0, 0.0, 0.0),
        )

        /**
         * The unit box standing on the bed, from (0, 0, 0) to (1, 1, 1): a
         * marker's transform scales it to its width, depth and height. Each
         * face is shaded by [shade] from its outward normal (the bed's Z up),
         * as the scene bakes a model's light, so it reads as a box.
         */
        fun box(key: String, shade: (Point3) -> Int): MarkerShape {
            require(key.isNotBlank())
            val points = ArrayList<Point3>(36)
            val shades = IntArray(12)
            CUBE_FACES.forEachIndexed { face, (corners, normal) ->
                val (a, b, c, d) = corners.map(::cubeCorner)
                points += listOf(a, b, c, a, c, d)
                shades[face * 2] = shade(normal); shades[face * 2 + 1] = shade(normal)
            }
            return MarkerShape(key, packed(points), shades = shades)
        }

        /** The unit box's twelve edges, as three.js's `EdgesGeometry` of a box draws them. */
        fun boxEdges(key: String): MarkerShape {
            require(key.isNotBlank())
            val points = ArrayList<Point3>(24)
            for (from in 0 until 8) for (axis in 0 until 3) {
                val bit = 1 shl axis
                if (from and bit == 0) points += listOf(cubeCorner(from), cubeCorner(from or bit))
            }
            return MarkerShape(key, packed(points), lines = true)
        }

        /** The unit square's outline on the bed, from (0, 0) to (1, 1), as `EdgesGeometry` of a plane draws it. */
        fun squareOutline(key: String): MarkerShape {
            require(key.isNotBlank())
            val corners = listOf(Point3(0.0, 0.0, 0.0), Point3(1.0, 0.0, 0.0), Point3(1.0, 1.0, 0.0), Point3(0.0, 1.0, 0.0))
            return MarkerShape(key, packed(corners.indices.flatMap { listOf(corners[it], corners[(it + 1) % 4]) }), lines = true)
        }

        /**
         * three.js's `CylinderGeometry(1, 1, height, segments)` lying on the
         * bed: unit radius about Z, [height] millimetres tall, centred on
         * its origin, its side and both caps, the side's corners where
         * three's are (a corner at θ is three's `(sin θ, ·, cos θ)` turned a
         * quarter about X, so `(sin θ, −cos θ)`).
         */
        fun cylinder(key: String, height: Double, segments: Int): MarkerShape {
            require(key.isNotBlank() && height.isFinite() && height > 0 && segments in 3..256)
            val ring = List(segments + 1) { u -> (2 * PI * u / segments).let { theta -> sin(theta) to -cos(theta) } }
            val top = height / 2
            val facets = ArrayList<Point3>(segments * 12)
            for (u in 0 until segments) {
                val (ax, ay) = ring[u]
                val (bx, by) = ring[u + 1]
                // The side: two facets per segment.
                facets += listOf(Point3(ax, ay, top), Point3(ax, ay, -top), Point3(bx, by, top))
                facets += listOf(Point3(ax, ay, -top), Point3(bx, by, -top), Point3(bx, by, top))
                // The caps: a fan about each centre.
                facets += listOf(Point3(0.0, 0.0, top), Point3(ax, ay, top), Point3(bx, by, top))
                facets += listOf(Point3(0.0, 0.0, -top), Point3(bx, by, -top), Point3(ax, ay, -top))
            }
            return MarkerShape(key, packed(facets))
        }
    }
}

/**
 * A shape drawn over the project as an annotation: [shape] placed by
 * [transform] (millimetres, as a draw's), unlit in [argb] at [opacity] —
 * never picked, never highlighted and never hiding what lies behind it, as
 * three.js draws a `MeshBasicMaterial` with `depthWrite: false`. A
 * [frontOnly] marker shows only its facets' outer sides, as three.js draws a
 * material's default `FrontSide`: a translucent box is one layer deep.
 */
data class SceneMarker(
    val shape: MarkerShape,
    val transform: ModelTransform,
    val argb: Int,
    val opacity: Float,
    val frontOnly: Boolean = false,
) {
    init { require(opacity.isFinite() && opacity > 0f && opacity <= 1f) }
}

/**
 * three.js's `Matrix4.decompose` scale of [transform]: each axis column's
 * length, the first negated when the transform mirrors. A marker of a fixed
 * printed size undoes it under an instance that scales.
 */
fun decomposedScale(transform: ModelTransform): Point3 {
    val x = transform.vector(Point3(1.0, 0.0, 0.0))
    val y = transform.vector(Point3(0.0, 1.0, 0.0))
    val z = transform.vector(Point3(0.0, 0.0, 1.0))
    fun length(p: Point3) = sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
    val determinant = x.x * (y.y * z.z - z.y * y.z) - y.x * (x.y * z.z - z.y * x.z) + z.x * (x.y * y.z - y.y * x.z)
    return Point3(if (determinant < 0) -length(x) else length(x), length(y), length(z))
}
