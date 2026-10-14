package dev.orcaxr.nativeapp.shell

import dev.orcaxr.nativeapp.project.parseSmartPaintProjection
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmartPaintActionsTest {
    @Test
    fun smartPaintActionsAreCompleteAndConfigured() {
        val tools = listOf("tool_smart_paint", "tool_smart_paint_image")
        val panelActions = listOf(
            "paint_smart_configure", "paint_smart_request", "paint_smart_apply", "paint_smart_cancel"
        )
        val all = tools + panelActions

        for (action in all) {
            assertTrue(action, action in AppActions.PERFORMED)
            assertTrue(action, action in ActionTexts.LABELS)
            assertTrue(action, action in ActionTexts.HINTS)
            assertTrue(action, action in OrcaActionGlyphs.actions)
        }

        for (action in tools) {
            assertTrue(action, AppActions.isTool(action))
            assertTrue(action, AppActions.needsWorkspace(action))
            assertFalse(action, AppActions.needsPrepare(action))
            assertFalse(action, AppActions.needsExport(action))
        }

        for (action in panelActions) {
            assertTrue(action, action in AppActions.PANELS)
            assertFalse(action, AppActions.isTool(action))
            assertFalse(action, AppActions.needsPrepare(action))
            assertFalse(action, AppActions.needsExport(action))
        }
    }

    @Test
    fun smartPaintProjectionDataParsing() {
        val sampleJson = """
            {
                "volumeId": "vol-123",
                "topologyRevision": 42,
                "triangleCount": 12,
                "regions": [
                    {
                        "id": "r1",
                        "label": "Roof",
                        "confidence": 0.95,
                        "triangleIndices": [0, 1, 2, 3],
                        "coverage": 0.333
                    },
                    {
                        "id": "r2",
                        "label": "Base",
                        "confidence": 0.88,
                        "triangleIndices": [4, 5],
                        "coverage": 0.167
                    }
                ],
                "coverage": 0.5,
                "unassignedTriangleCount": 6,
                "confidence": 0.915
            }
        """.trimIndent()

        val parsed = parseSmartPaintProjection(sampleJson)
        assertEquals("vol-123", parsed.volumeId)
        assertEquals(42L, parsed.topologyRevision)
        assertEquals(12, parsed.triangleCount)
        assertEquals(2, parsed.regions.size)
        assertEquals("Roof", parsed.regions[0].label)
        assertEquals(listOf(0, 1, 2, 3), parsed.regions[0].triangleIndices)
        assertEquals(0.95, parsed.regions[0].confidence, 0.001)
        assertEquals("Base", parsed.regions[1].label)
        assertEquals(listOf(4, 5), parsed.regions[1].triangleIndices)
        assertEquals(6, parsed.unassignedTriangleCount)
        assertEquals(0.5, parsed.coverage, 0.001)
    }
}
