package dev.orcaxr.app

import java.io.File

/**
 * Generators for B1 3D Transform Gizmo primitives.
 */
object GizmoGlb {

    fun writeRing(file: File, axis: Int, radius: Float, thickness: Float, color: FloatArray) {
        val segments = 36
        val tubeSegments = 12
        val positions = ArrayList<Float>()
        val indices = ArrayList<Int>()

        for (i in 0 until segments) {
            val u = (i.toFloat() / segments) * 2f * Math.PI.toFloat()
            val cu = kotlin.math.cos(u)
            val su = kotlin.math.sin(u)
            for (j in 0 until tubeSegments) {
                val v = (j.toFloat() / tubeSegments) * 2f * Math.PI.toFloat()
                val cv = kotlin.math.cos(v)
                val sv = kotlin.math.sin(v)

                // Torus in XY plane (Z normal)
                val px = (radius + thickness * cv) * cu
                val py = (radius + thickness * cv) * su
                val pz = thickness * sv

                // Rotate to match requested normal axis
                val vx = when (axis) { 0 -> pz; 1 -> px; else -> px }
                val vy = when (axis) { 0 -> px; 1 -> pz; else -> py }
                val vz = when (axis) { 0 -> py; 1 -> py; else -> pz }

                positions.add(vx)
                positions.add(vy)
                positions.add(vz)
            }
        }

        for (i in 0 until segments) {
            for (j in 0 until tubeSegments) {
                val nextI = (i + 1) % segments
                val nextJ = (j + 1) % tubeSegments

                val v0 = i * tubeSegments + j
                val v1 = nextI * tubeSegments + j
                val v2 = nextI * tubeSegments + nextJ
                val v3 = i * tubeSegments + nextJ

                // CCW winding
                indices.add(v0); indices.add(v1); indices.add(v2)
                indices.add(v0); indices.add(v2); indices.add(v3)
            }
        }

        val posArr = positions.toFloatArray()
        val idxArr = indices.toIntArray()
        val colorArr = FloatArray(posArr.size)
        for (i in 0 until posArr.size / 3) {
            colorArr[i * 3 + 0] = color[0]
            colorArr[i * 3 + 1] = color[1]
            colorArr[i * 3 + 2] = color[2]
        }

        GlbBuilder(
            positions = posArr,
            indices = idxArr,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colorArr,
            doubleSided = true
        ).writeTo(file)
    }

    /** [start] pushes the shaft's base out along the axis (default 0 =
     *  from the gizmo center). Input colliders use it so their volume
     *  begins OUTSIDE the model body and never shadows the body grab. */
    fun writeArrow(
        file: File,
        axis: Int,
        length: Float,
        radius: Float,
        color: FloatArray,
        start: Float = 0f,
    ) {
        val segments = 16
        val positions = ArrayList<Float>()
        val indices = ArrayList<Int>()

        val headRatio = 0.2f
        val headRadius = radius * 2.5f
        val shaftLen = start + (length - start) * (1f - headRatio)

        fun addVertex(x: Float, y: Float, z: Float) {
            val vx = when (axis) { 0 -> z; 1 -> x; else -> x }
            val vy = when (axis) { 0 -> x; 1 -> z; else -> y }
            val vz = when (axis) { 0 -> y; 1 -> y; else -> z }
            positions.add(vx); positions.add(vy); positions.add(vz)
        }

        // Shaft cylinder
        for (i in 0 until segments) {
            val u = (i.toFloat() / segments) * 2f * Math.PI.toFloat()
            val cu = kotlin.math.cos(u) * radius
            val su = kotlin.math.sin(u) * radius
            addVertex(cu, su, start)
            addVertex(cu, su, shaftLen)
        }
        for (i in 0 until segments) {
            val nextI = (i + 1) % segments
            val v0 = i * 2
            val v1 = i * 2 + 1
            val v2 = nextI * 2
            val v3 = nextI * 2 + 1
            indices.add(v0); indices.add(v1); indices.add(v2)
            indices.add(v2); indices.add(v1); indices.add(v3)
        }

        // Head cone
        val baseIdx = positions.size / 3
        addVertex(0f, 0f, length) // Tip
        val tipIdx = baseIdx
        for (i in 0 until segments) {
            val u = (i.toFloat() / segments) * 2f * Math.PI.toFloat()
            val cu = kotlin.math.cos(u) * headRadius
            val su = kotlin.math.sin(u) * headRadius
            addVertex(cu, su, shaftLen)
        }
        for (i in 0 until segments) {
            val nextI = (i + 1) % segments
            indices.add(tipIdx)
            indices.add(baseIdx + 1 + nextI)
            indices.add(baseIdx + 1 + i)
        }

        val posArr = positions.toFloatArray()
        val idxArr = indices.toIntArray()
        val colorArr = FloatArray(posArr.size)
        for (i in 0 until posArr.size / 3) {
            colorArr[i * 3 + 0] = color[0]
            colorArr[i * 3 + 1] = color[1]
            colorArr[i * 3 + 2] = color[2]
        }

        GlbBuilder(
            positions = posArr,
            indices = idxArr,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colorArr,
            doubleSided = true
        ).writeTo(file)
    }

    /** Axis-aligned box centered at the origin with per-axis extents —
     *  used for fat invisible input colliders around the model body. */
    fun writeBox(file: File, sizeX: Float, sizeY: Float, sizeZ: Float, color: FloatArray) {
        val hx = sizeX / 2f
        val hy = sizeY / 2f
        val hz = sizeZ / 2f
        val positions = floatArrayOf(
            -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz,
            -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz,
        )
        val faceTris = intArrayOf(
            0, 3, 2, 0, 2, 1,
            4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4,
            3, 7, 6, 3, 6, 2,
            0, 4, 7, 0, 7, 3,
            1, 2, 6, 1, 6, 5,
        )
        val colorArr = FloatArray(positions.size)
        for (i in 0 until positions.size / 3) {
            colorArr[i * 3 + 0] = color[0]
            colorArr[i * 3 + 1] = color[1]
            colorArr[i * 3 + 2] = color[2]
        }
        GlbBuilder(
            positions = positions,
            indices = faceTris,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colorArr,
            doubleSided = true,
        ).writeTo(file)
    }

    fun writeCube(file: File, size: Float, offset: FloatArray, color: FloatArray) {
        val s = size / 2f
        val ox = offset[0]
        val oy = offset[1]
        val oz = offset[2]

        val positions = floatArrayOf(
            ox-s, oy-s, oz-s,  ox+s, oy-s, oz-s,  ox+s, oy+s, oz-s,  ox-s, oy+s, oz-s,
            ox-s, oy-s, oz+s,  ox+s, oy-s, oz+s,  ox+s, oy+s, oz+s,  ox-s, oy+s, oz+s
        )

        val faceTris = intArrayOf(
            0, 3, 2, 0, 2, 1,   // -Z
            4, 5, 6, 4, 6, 7,   // +Z
            0, 1, 5, 0, 5, 4,   // -Y
            3, 7, 6, 3, 6, 2,   // +Y
            0, 4, 7, 0, 7, 3,   // -X
            1, 2, 6, 1, 6, 5    // +X
        )

        val colorArr = FloatArray(positions.size)
        for (i in 0 until positions.size / 3) {
            colorArr[i * 3 + 0] = color[0]
            colorArr[i * 3 + 1] = color[1]
            colorArr[i * 3 + 2] = color[2]
        }

        GlbBuilder(
            positions = positions,
            indices = faceTris,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colorArr,
            doubleSided = true
        ).writeTo(file)
    }
}
