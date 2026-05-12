package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.SlicerEngine
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A11 — `add_custom_gcode_tick`, `list_custom_gcode_ticks`,
 * `remove_custom_gcode_tick`, `clear_custom_gcode_ticks`. Pins the
 * JSON ⇄ WorkspaceAction wire shape so a typo in the dispatcher
 * surfaces here. The actual JNI thread to
 * `Model::plates_custom_gcodes` is exercised by a device-side slice
 * test that verifies emitted G-code contains the expected pause /
 * color-change blocks at the right Z.
 */
class CustomGcodeToolsTest {

    private fun ws(
        ticks: Map<Int, List<SlicerEngine.CustomGcodeTick>> = emptyMap(),
        plateId: Int = 1,
    ): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(
            PlacedModel(id = "m_test", source = File("/dev/null"), label = "test"),
        ))
        ws.publishActivePlateId(plateId)
        ws.publishCustomGcodeTicks(ticks)
        return ws
    }

    private suspend fun captureNextAction(
        ws: WorkspaceModel,
        block: suspend () -> Unit,
    ): WorkspaceAction {
        val collected = kotlinx.coroutines.GlobalScope.async(
            start = CoroutineStart.UNDISPATCHED,
        ) { ws.actions.first() }
        block()
        return collected.await()
    }

    // ---- add_custom_gcode_tick ----

    @Test fun addEmitsActionWithDefaults() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddCustomGcodeTick(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("z_mm", 5.0)
                put("kind", "pause_print")
                put("extra", "insert magnet")
            })
        }
        assertTrue(action is WorkspaceAction.AddCustomGcodeTick)
        action as WorkspaceAction.AddCustomGcodeTick
        assertEquals(1, action.plateId)        // active plate (default)
        assertEquals(5f, action.zMm, 1e-6f)
        assertEquals("PausePrint", action.kind)
        assertEquals(0, action.extruder)
        assertEquals("insert magnet", action.extra)
    }

    @Test fun addAcceptsAllKindAliases() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddCustomGcodeTick(w)
        val pairs = listOf(
            "pause_print" to "PausePrint",
            "pause" to "PausePrint",
            "PausePrint" to "PausePrint",
            "color_change" to "ColorChange",
            "ColorChange" to "ColorChange",
            "tool_change" to "ToolChange",
            "template" to "Template",
            "custom" to "Custom",
        )
        for ((alias, expected) in pairs) {
            val action = captureNextAction(w) {
                tool.call(JSONObject().apply {
                    put("z_mm", 1.0)
                    put("kind", alias)
                })
            }
            assertEquals(
                "alias=$alias",
                expected,
                (action as WorkspaceAction.AddCustomGcodeTick).kind,
            )
        }
    }

    @Test fun addRejectsUnknownKind() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddCustomGcodeTick(w)
        val res = tool.call(JSONObject().apply {
            put("z_mm", 5.0)
            put("kind", "spaghetti")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("Unknown 'kind'"))
    }

    @Test fun addRejectsZeroOrNegativeZ() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddCustomGcodeTick(w)
        val res = tool.call(JSONObject().apply {
            put("z_mm", -1.0)
            put("kind", "pause_print")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("z_mm"))
    }

    @Test fun addRespectsExplicitPlateId() = runTest {
        val w = ws(plateId = 1)
        val tool = WorkspaceTools.AddCustomGcodeTick(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("z_mm", 5.0)
                put("kind", "pause_print")
                put("plate_id", 7)
            })
        }
        assertEquals(7, (action as WorkspaceAction.AddCustomGcodeTick).plateId)
    }

    // ---- list_custom_gcode_ticks ----

    @Test fun listReturnsTicksForActivePlate() = runTest {
        val ticks = mapOf(
            1 to listOf(
                SlicerEngine.CustomGcodeTick(
                    printZmm = 5f,
                    kind = SlicerEngine.CustomGcodeKind.PausePrint,
                    extra = "magnet",
                ),
            ),
            2 to listOf(
                SlicerEngine.CustomGcodeTick(
                    printZmm = 10f,
                    kind = SlicerEngine.CustomGcodeKind.ColorChange,
                    extruder = 2,
                    color = "#ff0000",
                ),
            ),
        )
        val w = ws(ticks, plateId = 1)
        val tool = WorkspaceTools.ListCustomGcodeTicks(w)
        val res = tool.call(JSONObject())
        assertFalse(res.isError)
        val body = res.structured
        assertNotNull(body)
        assertEquals(1, body!!.optInt("plate_id"))
        assertEquals(1, body.optInt("tick_count"))
        val arr = body.optJSONArray("ticks")
        assertEquals(1, arr!!.length())
        assertEquals(5.0, arr.getJSONObject(0).getDouble("z_mm"), 1e-6)
        assertEquals("PausePrint", arr.getJSONObject(0).getString("kind"))
    }

    @Test fun listReturnsEmptyForUnknownPlate() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ListCustomGcodeTicks(w)
        val res = tool.call(JSONObject().apply { put("plate_id", 99) })
        assertFalse(res.isError)
        assertEquals(0, res.structured!!.optInt("tick_count"))
    }

    // ---- remove_custom_gcode_tick ----

    @Test fun removeEmitsAction() = runTest {
        val ticks = mapOf(1 to listOf(
            SlicerEngine.CustomGcodeTick(5f, SlicerEngine.CustomGcodeKind.PausePrint),
            SlicerEngine.CustomGcodeTick(10f, SlicerEngine.CustomGcodeKind.ColorChange),
        ))
        val w = ws(ticks, plateId = 1)
        val tool = WorkspaceTools.RemoveCustomGcodeTick(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply { put("index", 1) })
        }
        action as WorkspaceAction.RemoveCustomGcodeTick
        assertEquals(1, action.plateId)
        assertEquals(1, action.index)
    }

    @Test fun removeRejectsOutOfRangeIndex() = runTest {
        val w = ws()
        val tool = WorkspaceTools.RemoveCustomGcodeTick(w)
        val res = tool.call(JSONObject().apply { put("index", 5) })
        assertTrue(res.isError)
        assertTrue(res.text.contains("out of range"))
    }

    // ---- clear_custom_gcode_ticks ----

    @Test fun clearEmitsAction() = runTest {
        val w = ws(plateId = 3)
        val tool = WorkspaceTools.ClearCustomGcodeTicks(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject())
        }
        action as WorkspaceAction.ClearCustomGcodeTicks
        assertEquals(3, action.plateId)
    }
}
