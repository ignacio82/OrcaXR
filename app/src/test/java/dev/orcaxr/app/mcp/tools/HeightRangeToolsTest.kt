package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.HeightRange
import dev.orcaxr.app.PlacedModel
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
 * A12 — `list_height_ranges` / `add_height_range` /
 * `set_height_range_overrides` / `remove_height_range` /
 * `clear_height_ranges`. Pins the JSON ⇄ WorkspaceAction contract for
 * per-Z-band overrides. The actual JNI thread to
 * `ModelObject::layer_config_ranges` is exercised by the device-side
 * slice path that exports them via libslic3r's bbs_3mf serializer onto
 * `Metadata/layer_config_ranges.xml` inside saved 3MFs.
 */
class HeightRangeToolsTest {

    private fun ws(ranges: List<HeightRange> = emptyList()): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishPlacedModels(listOf(
            PlacedModel(
                id = "m_test",
                source = File("/dev/null"),
                label = "test",
                heightRanges = ranges,
            ),
        ))
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

    // ---- add_height_range ----

    @Test fun addAppendsRangeWithOverrides() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddHeightRange(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("z_min_mm", 0.0)
                put("z_max_mm", 5.0)
                put("overrides", JSONObject().apply {
                    put("sparse_infill_density", "100")
                    put("wall_loops", 4)
                })
            })
        }
        assertTrue(action is WorkspaceAction.SetHeightRanges)
        action as WorkspaceAction.SetHeightRanges
        assertEquals("m_test", action.modelId)
        assertEquals(1, action.ranges.size)
        val r = action.ranges[0]
        assertEquals(0f, r.zMinMm, 1e-6f)
        assertEquals(5f, r.zMaxMm, 1e-6f)
        assertEquals("100", r.overrides["sparse_infill_density"])
        // Numeric values get coerced to libslic3r's string wire format.
        assertEquals("4", r.overrides["wall_loops"])
    }

    @Test fun addRejectsInvertedBand() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddHeightRange(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("z_min_mm", 5.0)
            put("z_max_mm", 0.0)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("strictly less"))
    }

    @Test fun addRejectsDegenerateBand() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddHeightRange(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("z_min_mm", 2.0)
            put("z_max_mm", 2.0)
        })
        assertTrue(res.isError)
    }

    @Test fun addRejectsMissingBounds() = runTest {
        // org.json.JSONObject rejects NaN/Infinity at put time, so the
        // production-realistic non-finite path is "the JSON didn't carry
        // the field at all". Both `optDouble("z_min_mm", NaN)` paths
        // collapse to the same isFinite() guard inside the tool.
        val w = ws()
        val tool = WorkspaceTools.AddHeightRange(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            // z_min_mm omitted entirely → optDouble returns NaN
            put("z_max_mm", 5.0)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("finite"))
    }

    @Test fun addRejectsUnknownModel() = runTest {
        val w = ws()
        val tool = WorkspaceTools.AddHeightRange(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "ghost")
            put("z_min_mm", 0.0)
            put("z_max_mm", 5.0)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("ghost"))
    }

    @Test fun addPreservesExistingBands() = runTest {
        val w = ws(listOf(
            HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100")),
        ))
        val tool = WorkspaceTools.AddHeightRange(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("z_min_mm", 5.0)
                put("z_max_mm", 10.0)
                put("overrides", JSONObject().apply { put("layer_height", "0.16") })
            })
        }
        action as WorkspaceAction.SetHeightRanges
        assertEquals(2, action.ranges.size)
        assertEquals(0f, action.ranges[0].zMinMm, 1e-6f)
        assertEquals(5f, action.ranges[1].zMinMm, 1e-6f)
        assertEquals("0.16", action.ranges[1].overrides["layer_height"])
    }

    @Test fun addAcceptsOverlappingBands() = runTest {
        // libslic3r resolves overlaps by splitting at boundaries (later
        // band wins on collision); the MCP tool does NOT reject them.
        val w = ws(listOf(HeightRange(0f, 10f)))
        val tool = WorkspaceTools.AddHeightRange(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("z_min_mm", 5.0)
                put("z_max_mm", 7.0)
            })
        }
        action as WorkspaceAction.SetHeightRanges
        assertEquals(2, action.ranges.size)
    }

    // ---- set_height_range_overrides ----

    @Test fun setReplacesOverrides() = runTest {
        val w = ws(listOf(
            HeightRange(0f, 5f, mapOf("layer_height" to "0.20")),
        ))
        val tool = WorkspaceTools.SetHeightRangeOverrides(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("range_index", 0)
                put("overrides", JSONObject().apply {
                    put("sparse_infill_density", "100")
                })
            })
        }
        action as WorkspaceAction.SetHeightRanges
        assertEquals(1, action.ranges.size)
        // Overrides REPLACE — layer_height is gone.
        assertFalse(action.ranges[0].overrides.containsKey("layer_height"))
        assertEquals("100", action.ranges[0].overrides["sparse_infill_density"])
        // Bounds preserved.
        assertEquals(0f, action.ranges[0].zMinMm, 1e-6f)
        assertEquals(5f, action.ranges[0].zMaxMm, 1e-6f)
    }

    @Test fun setEmptyClearsOverrides() = runTest {
        val w = ws(listOf(
            HeightRange(0f, 5f, mapOf("layer_height" to "0.20")),
        ))
        val tool = WorkspaceTools.SetHeightRangeOverrides(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("range_index", 0)
                put("overrides", JSONObject())
            })
        }
        action as WorkspaceAction.SetHeightRanges
        assertTrue(action.ranges[0].overrides.isEmpty())
    }

    @Test fun setRejectsOutOfRangeIndex() = runTest {
        val w = ws(listOf(HeightRange(0f, 5f)))
        val tool = WorkspaceTools.SetHeightRangeOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("range_index", 5)
            put("overrides", JSONObject())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("out of range"))
    }

    // ---- remove_height_range ----

    @Test fun removeShiftsLaterBandsDown() = runTest {
        val w = ws(listOf(
            HeightRange(0f, 5f),
            HeightRange(5f, 10f, mapOf("layer_height" to "0.16")),
            HeightRange(10f, 20f),
        ))
        val tool = WorkspaceTools.RemoveHeightRange(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("range_index", 0)
            })
        }
        action as WorkspaceAction.SetHeightRanges
        assertEquals(2, action.ranges.size)
        assertEquals(5f, action.ranges[0].zMinMm, 1e-6f)
        assertEquals("0.16", action.ranges[0].overrides["layer_height"])
        assertEquals(10f, action.ranges[1].zMinMm, 1e-6f)
    }

    @Test fun removeRejectsNegativeIndex() = runTest {
        val w = ws(listOf(HeightRange(0f, 5f)))
        val tool = WorkspaceTools.RemoveHeightRange(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("range_index", -1)
        })
        assertTrue(res.isError)
    }

    // ---- clear_height_ranges ----

    @Test fun clearEmitsEmptyList() = runTest {
        val w = ws(listOf(HeightRange(0f, 5f), HeightRange(5f, 10f)))
        val tool = WorkspaceTools.ClearHeightRanges(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply { put("model_id", "m_test") })
        }
        action as WorkspaceAction.SetHeightRanges
        assertTrue(action.ranges.isEmpty())
    }

    @Test fun clearOnEmptyIsNoOp() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ClearHeightRanges(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertFalse(res.isError)
        assertEquals(0, res.structured!!.optInt("range_count"))
    }

    // ---- list_height_ranges ----

    @Test fun listReturnsBandsInDeclarationOrder() = runTest {
        val w = ws(listOf(
            HeightRange(0f, 5f, mapOf("sparse_infill_density" to "100")),
            HeightRange(5f, 10f, mapOf("layer_height" to "0.16")),
        ))
        val tool = WorkspaceTools.ListHeightRanges(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertFalse(res.isError)
        val body = res.structured
        assertNotNull(body)
        assertEquals(2, body!!.optInt("range_count"))
        val arr = body.optJSONArray("ranges")!!
        assertEquals(2, arr.length())
        val r0 = arr.getJSONObject(0)
        assertEquals(0.0, r0.optDouble("z_min_mm"), 1e-6)
        assertEquals(5.0, r0.optDouble("z_max_mm"), 1e-6)
        assertEquals("100", r0.optJSONObject("overrides")!!.optString("sparse_infill_density"))
        val r1 = arr.getJSONObject(1)
        assertEquals("0.16", r1.optJSONObject("overrides")!!.optString("layer_height"))
        // Recommended keys are surfaced for caller convenience.
        val recommended = body.optJSONArray("recommended_keys")!!
        assertTrue(recommended.length() > 0)
    }

    @Test fun listEmptyReturnsZeroCount() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ListHeightRanges(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertFalse(res.isError)
        assertEquals(0, res.structured!!.optInt("range_count"))
    }

    // ---- detached safety ----

    @Test fun detachedToolsFailFast() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(false)
        val res = WorkspaceTools.AddHeightRange(ws).call(JSONObject().apply {
            put("model_id", "m_test")
            put("z_min_mm", 0.0)
            put("z_max_mm", 5.0)
        })
        assertTrue(res.isError)
    }
}
