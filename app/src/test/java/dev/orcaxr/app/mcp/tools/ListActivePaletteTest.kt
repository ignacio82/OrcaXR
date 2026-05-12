package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ListActivePaletteTest {

    @Test fun emptyPaletteReturnsCountZero() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        val tool = AiVisionTools.ListActivePalette(ws)
        val res = tool.call(JSONObject())
        assertFalse(res.isError)
        val s = res.structured!!
        assertEquals(0, s.getInt("count"))
        assertEquals(0, s.getJSONArray("entries").length())
    }

    @Test fun publishedPaletteEnumeratesWithTagsAndHex() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPreviewPalette(listOf("#000000", "#FFFF00", "#FFFFFF", "#FF0000"))
        ws.publishSelectedPrinterId("printer_test")
        val res = AiVisionTools.ListActivePalette(ws).call(JSONObject())
        val s = res.structured!!
        assertEquals(4, s.getInt("count"))
        assertEquals("printer_test", s.getString("printer_id"))
        val arr = s.getJSONArray("entries")
        assertEquals(4, arr.length())
        // First entry: tag=1 maps to slot 0, hex matches.
        val e0 = arr.getJSONObject(0)
        assertEquals(1, e0.getInt("tag"))
        assertEquals(0, e0.getInt("slot_index"))
        assertEquals("#000000", e0.getString("hex"))
        // Tag 2 → yellow.
        assertEquals(2, arr.getJSONObject(1).getInt("tag"))
        assertEquals("#FFFF00", arr.getJSONObject(1).getString("hex"))
    }

    @Test fun textOutputIncludesAllSlots() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPreviewPalette(listOf("#000000", "#FFFFFF"))
        val res = AiVisionTools.ListActivePalette(ws).call(JSONObject())
        assertTrue("text contains tag 1", res.text.contains("tag 1"))
        assertTrue("text contains tag 2", res.text.contains("tag 2"))
        assertTrue("text contains #000000", res.text.contains("#000000"))
    }
}
