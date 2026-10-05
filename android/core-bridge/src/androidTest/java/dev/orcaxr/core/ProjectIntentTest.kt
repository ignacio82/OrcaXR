package dev.orcaxr.core

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProjectIntentTest {
    @Test fun sharedCorpusAndTypedRoundTrip() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val fixture = JSONObject(context.assets.open("project-intent-vectors.json").bufferedReader().use { it.readText() })
        val cases = fixture.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val input = case.getString("input")
            val label = case.getString("label")
            val expected = case.get("expected")
            try {
                val output = if (case.getString("kind") == "SessionRequest") ProjectIntents.encodeSessionRequest(ProjectIntents.decodeSessionRequest(input))
                    else if (case.getString("kind") == "SessionReply") ProjectIntents.encodeSessionReply(ProjectIntents.decodeSessionReply(input))
                    else if (case.getString("kind") == "Batch") ProjectIntents.encodeBatch(ProjectIntents.decodeBatch(input))
                    else ProjectIntents.encodeIntent(ProjectIntents.decodeIntent(input))
                assertNotEquals(label, JSONObject.NULL, expected)
                equivalent(expected, JSONObject(output), label)
            } catch (error: InvalidProjectIntent) {
                assertEquals(label, JSONObject.NULL, expected)
                assertEquals("Invalid project command intent", error.message)
            }
        }
    }

    @Test fun boundedWriterParserAndRecovery() {
        fun refused(block: () -> Unit) {
            try { block(); fail("Expected a bounded rejection") }
            catch (error: InvalidProjectIntent) { assertEquals("Invalid project command intent", error.message) }
        }
        refused { ProjectIntents.decodeIntent(" ".repeat(ProjectIntents.MAX_BYTES + 1)) }
        val nodes = "{\"version\":1,\"command\":{\"deletePlate\":{\"plateId\":[" + List(ProjectIntents.MAX_NODES) { "65" }.joinToString(",") + "]}}}"
        assertTrue(nodes.length < ProjectIntents.MAX_BYTES)
        refused { ProjectIntents.decodeIntent(nodes) }
        val tooMany = ProjectIntents.Intent(1, ProjectIntents.Command.DeletePlate(ProjectIntents.DeletePlate(List(ProjectIntents.MAX_NODES) { 65 })))
        refused { ProjectIntents.encodeIntent(tooMany) }
        val invalid = ProjectIntents.Intent(1, ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(listOf(65),listOf(65),Double.POSITIVE_INFINITY,true)))
        refused { ProjectIntents.encodeIntent(invalid) }
        val accepted = ProjectIntents.Intent(1, ProjectIntents.Command.DeletePlate(ProjectIntents.DeletePlate(listOf(0,55296,65535))))
        assertEquals(accepted,ProjectIntents.decodeIntent(ProjectIntents.encodeIntent(accepted)))
    }

    @Test fun allUtf16UnitsAndWideTypedPayload() {
        val intent = ProjectIntents.Intent(1, ProjectIntents.Command.DeletePlate(ProjectIntents.DeletePlate((0..65535).toList())))
        assertEquals(intent,ProjectIntents.decodeIntent(ProjectIntents.encodeIntent(intent)))
        val wide = ProjectIntents.Intent(1, ProjectIntents.Command.DuplicatePlate(ProjectIntents.DuplicatePlate(
            listOf(65),listOf(65),List(18000) { ProjectIntents.DuplicateObject(listOf(65),emptyList(),emptyList(),emptyList()) },emptyList(),emptyList()
        )))
        try { ProjectIntents.encodeIntent(wide); fail("Expected a bounded rejection") }
        catch(error: InvalidProjectIntent) { assertEquals("Invalid project command intent",error.message) }
    }

    private fun equivalent(expected: Any, actual: Any, label: String) {
        when(expected) {
            is JSONObject -> {
                assertTrue(label, actual is JSONObject)
                val objectValue = actual as JSONObject
                assertEquals(label, expected.keys().asSequence().toSet(), objectValue.keys().asSequence().toSet())
                expected.keys().forEach { equivalent(expected.get(it), objectValue.get(it), label) }
            }
            is JSONArray -> {
                assertTrue(label, actual is JSONArray)
                val array = actual as JSONArray
                assertEquals(label,expected.length(),array.length())
                for (index in 0 until expected.length()) equivalent(expected.get(index),array.get(index),label)
            }
            is Number -> { assertTrue(label,actual is Number); assertEquals(label,expected.toDouble(),(actual as Number).toDouble(),0.0) }
            else -> assertEquals(label,expected,actual)
        }
    }
}
