package dev.orcaxr.renderer

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A marker's geometry, shared by every marker that draws it: facets in its
 * own millimetres, three corners each ([facetCount] of them). Markers are
 * annotations a tool draws over the project, never the project's meshes.
 */
class MarkerShape private constructor(val key: String, internal val xyz: FloatArray) {
    val facetCount get() = xyz.size / 9

    /** Corner [corner] of facet [facet], in the shape's millimetres. */
    fun corner(facet: Int, corner: Int) = (facet * 9 + corner * 3).let { Point3(xyz[it].toDouble(), xyz[it + 1].toDouble(), xyz[it + 2].toDouble()) }

    companion object {
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
            val xyz = FloatArray(facets.size * 3)
            facets.forEachIndexed { index, point ->
                xyz[index * 3] = point.x.toFloat(); xyz[index * 3 + 1] = point.y.toFloat(); xyz[index * 3 + 2] = point.z.toFloat()
            }
            return MarkerShape(key, xyz)
        }
    }
}

/**
 * A shape drawn over the project as an annotation: [shape] placed by
 * [transform] (millimetres, as a draw's), unlit in [argb] at [opacity] —
 * never picked, never highlighted and never hiding what lies behind it, as
 * three.js draws a `MeshBasicMaterial` with `depthWrite: false`.
 */
data class SceneMarker(val shape: MarkerShape, val transform: ModelTransform, val argb: Int, val opacity: Float) {
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
