package dev.orcaxr.renderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

class SceneMarkersTest {
    @Test fun aCylinderIsThreesLyingOnTheBed() {
        val disc = MarkerShape.cylinder("disc", .2, 32)
        // Each segment: two side facets and one facet of each cap.
        assertEquals(32 * 4, disc.facetCount)
        for (facet in 0 until disc.facetCount) for (corner in 0 until 3) {
            val p = disc.corner(facet, corner)
            assertTrue("within the unit radius", hypot(p.x, p.y) <= 1 + 1e-6)
            assertTrue("on one of the two faces", abs(abs(p.z) - .1) < 1e-6)
        }
        // three's first corner, (sin 0, ·, cos 0) turned a quarter about X: (0, −1).
        val first = disc.corner(0, 0)
        assertEquals(0.0, first.x, 1e-6)
        assertEquals(-1.0, first.y, 1e-6)
        assertEquals(.1, first.z, 1e-6)
        // Its outline is the 32-gon, corner u at θ = 2πu/32.
        for (u in 0 until 32) {
            val corner = disc.corner(u * 4, 0)
            assertEquals(sin(2 * PI * u / 32), corner.x, 1e-6)
            assertEquals(-cos(2 * PI * u / 32), corner.y, 1e-6)
        }
    }

    @Test fun aBoxStandsOnTheBedWithItsFacesShaded() {
        val box = MarkerShape.box("box") { normal -> PacketMeshes.shade(normal) }
        assertEquals(12, box.facetCount)
        assertEquals(36, box.pointCount)
        assertEquals(false, box.lines)
        for (facet in 0 until box.facetCount) {
            val corners = (0 until 3).map { box.corner(facet, it) }
            for (p in corners) assertTrue("inside the unit cube", listOf(p.x, p.y, p.z).all { it == 0.0 || it == 1.0 })
            // Wound outward: the facet's normal points away from the cube's centre.
            val normal = (corners[1] - corners[0]).cross(corners[2] - corners[0])
            val middle = Point3(corners.sumOf { it.x } / 3 - .5, corners.sumOf { it.y } / 3 - .5, corners.sumOf { it.z } / 3 - .5)
            assertTrue("facet $facet faces out", normal.dot(middle) > 0)
            assertEquals(PacketMeshes.shade(normal.normalized()), box.shade(facet))
        }
        // The top is lit, the underside only by the ambient light.
        assertEquals(PacketMeshes.shade(null), box.shade(0))
    }

    @Test fun aBoxsEdgesAndASquaresOutlineAreSegments() {
        val edges = MarkerShape.boxEdges("edges")
        assertTrue(edges.lines)
        assertEquals(12, edges.segmentCount)
        assertEquals(0, edges.facetCount)
        val seen = HashSet<Pair<Point3, Point3>>()
        for (segment in 0 until 12) {
            val (a, b) = edges.end(segment, 0) to edges.end(segment, 1)
            val d = b - a
            assertEquals("one unit along one axis", 1.0, abs(d.x) + abs(d.y) + abs(d.z), 0.0)
            assertTrue("each edge once", seen.add(a to b))
        }
        val square = MarkerShape.squareOutline("square")
        assertEquals(4, square.segmentCount)
        for (segment in 0 until 4) {
            assertEquals(0.0, square.end(segment, 0).z, 0.0)
            assertEquals(square.end(segment, 1), square.end((segment + 1) % 4, 0))
        }
        assertEquals(-1, square.shade(0))
    }

    @Test fun decomposedScaleIsThrees() {
        assertEquals(Point3(1.0, 1.0, 1.0), decomposedScale(ModelTransform.scaledTranslated()))
        val turned = 0.4
        val scaled = ModelTransform.of(doubleArrayOf(
            1.5 * cos(turned), 1.5 * sin(turned), 0.0, 0.0,
            -2.0 * sin(turned), 2.0 * cos(turned), 0.0, 0.0,
            0.0, 0.0, .5, 0.0,
            10.0, 20.0, 30.0, 1.0,
        ))
        val scale = decomposedScale(scaled)
        assertEquals(1.5, scale.x, 1e-12)
        assertEquals(2.0, scale.y, 1e-12)
        assertEquals(.5, scale.z, 1e-12)
        // A mirror negates the first axis, as `Matrix4.decompose` does whichever axis is mirrored.
        val mirrored = decomposedScale(ModelTransform.scaledTranslated(1.0, -3.0, 2.0))
        assertEquals(Point3(-1.0, 3.0, 2.0), mirrored)
    }
}
