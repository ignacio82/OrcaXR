package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.ProjectIntents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmartPaintHelperTest {
    @Test
    fun testExtractJsonPayload() {
        val markdown = """
            Here is the proposal:
            ```json
            {
              "schemaVersion": 1,
              "regions": [
                {
                  "id": "region_top",
                  "label": "Top Region",
                  "confidence": 0.95,
                  "shape": { "kind": "box", "min": [0.0, 0.0, 0.5], "max": [1.0, 1.0, 1.0] }
                }
              ]
            }
            ```
            Hope this helps!
        """.trimIndent()

        val json = SmartPaintHelper.extractJsonPayload(markdown)
        assertNotNull(json)
        assertTrue(json!!.contains("\"schemaVersion\": 1"))
        assertTrue(json.contains("\"region_top\""))
    }

    @Test
    fun testHeuristicProposalGeneration() {
        val proposalTop = SmartPaintHelper.generateHeuristicProposalMap("Paint the top half and overhangs")
        assertEquals(1, proposalTop["schemaVersion"])
        @Suppress("UNCHECKED_CAST")
        val regions = proposalTop["regions"] as List<Map<String, Any>>
        assertTrue(regions.size >= 2)

        val ids = regions.map { it["id"] }
        assertTrue(ids.contains("region_top"))
        assertTrue(ids.contains("region_overhang"))

        val topRegion = regions.first { it["id"] == "region_top" }
        @Suppress("UNCHECKED_CAST")
        val shape = topRegion["shape"] as Map<String, Any>
        assertEquals("box", shape["kind"])
        @Suppress("UNCHECKED_CAST")
        val minList = shape["min"] as List<Double>
        assertEquals(0.5, minList[2], 0.001)
    }

    @Test
    fun testResolveAssignments() {
        val projection = SmartPaintProjectionData(
            volumeId = "vol_1",
            topologyRevision = 1L,
            triangleCount = 1000,
            regions = listOf(
                SmartPaintRegionData("region_top", "Top / Upper Surface", 0.95, listOf(1, 2, 3), 0.5),
                SmartPaintRegionData("region_bottom", "Base / Lower Surface", 0.90, listOf(4, 5, 6), 0.5),
            ),
            coverage = 1.0,
            unassignedTriangleCount = 0,
            confidence = 0.92,
        )

        val filaments = listOf(
            dev.orcaxr.core.FilamentOption("fil_1", false, "Bambu White PLA", "#FFFFFF", true, "PLA", null, 0, null, emptyList(), emptyList()),
            dev.orcaxr.core.FilamentOption("fil_2", false, "Bambu Blue PLA", "#1E88E5", true, "PLA", null, 1, null, emptyList(), emptyList()),
        )

        val assignmentsRaw = mapOf("top" to "blue", "bottom" to 1)
        val resolved = SmartPaintHelper.resolveAssignments(assignmentsRaw, projection, filaments, "color")

        assertEquals(2, resolved.size)
        val first = resolved[0]
        assertEquals("region_top", first["regionId"])
        assertEquals("fil_2", first["value"]) // blue is fil_2

        val second = resolved[1]
        assertEquals("region_bottom", second["regionId"])
        assertEquals("fil_1", second["value"])
    }
}
