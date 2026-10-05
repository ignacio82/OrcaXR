package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeCoreTest {
    @Test fun rawRequestEnvelopesCrossTheRealJniBoundary() {
        CoreCompatibility.verify()
        val context = InstrumentationRegistry.getInstrumentation().context
        val corpus = JSONObject(context.assets.open("canonical-requests.json").bufferedReader().use { it.readText() })
        val cases = corpus.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val encoded = NativeCore.evaluate(case.getString("request"))
            val response = JSONObject(encoded)
            val id = case.getString("id")
            assertEquals(id, case.getString("type"), response.getString("type"))
            assertEquals(id, case.get("requestId"), response.get("requestId"))
            if (case.getString("type") == "canonicalized") {
                assertEquals(id, case.getString("canonical"), response.getString("canonical"))
            } else {
                assertEquals(id, case.getString("code"), response.getJSONObject("error").getString("code"))
                assertTrue(id, !encoded.contains("PRIVATE_MARKER"))
            }
        }
    }

    @Test fun canonicalVectorsCrossTheRealJniBoundary() {
        CoreCompatibility.verify()
        val context = InstrumentationRegistry.getInstrumentation().context
        val corpus = JSONObject(context.assets.open("canonical-vectors.json").bufferedReader().use { it.readText() })
        val vectors = corpus.getJSONArray("vectors")
        for (index in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(index)
            val response = JSONObject(NativeCore.evaluate(JSONObject()
                .put("protocolVersion", CoreProtocol.PROTOCOL_VERSION)
                .put("requestId", vector.getString("id"))
                .put("operation", "canonicalize")
                .put("input", vector.getString("input")).toString()))
            assertEquals("canonicalized", response.getString("type"))
            for (field in listOf("canonical", "semanticHash", "sha256")) {
                assertEquals(vector.getString("id") + ":" + field, vector.getString(field), response.getString(field))
            }
        }
        val invalid = corpus.getJSONArray("invalid")
        for (index in 0 until invalid.length()) {
            val vector = invalid.getJSONObject(index)
            val response = JSONObject(NativeCore.evaluate(JSONObject()
                .put("protocolVersion", 1).put("requestId", vector.getString("id"))
                .put("operation", "canonicalize").put("input", vector.getString("input")).toString()))
            assertEquals(vector.getString("code"), response.getJSONObject("error").getString("code"))
        }
    }

    @Test fun refusesMismatchedProtocolAndDoesNotEchoPrivatePayloads() {
        val response = NativeCore.evaluate("""{"protocolVersion":99,"requestId":"probe","operation":"canonicalize","input":"private model"}""")
        assertEquals("unsupported_protocol", JSONObject(response).getJSONObject("error").getString("code"))
        assertTrue(!response.contains("private model"))
    }

    @Test fun malformedHandshakeAndOversizedJavaInputsFailClosed() {
        for (info in listOf("broken", "{}", NativeCore.coreInfo().replace("\"protocolVersion\":1", "\"protocolVersion\":1.5"))) {
            assertThrows(IllegalStateException::class.java) { CoreCompatibility.verify(info) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            NativeCore.evaluate("x".repeat(CoreProtocol.MAX_REQUEST_BYTES + 1))
        }
        // A supplementary character crosses JNI as a surrogate pair, while the
        // inner escaped lone-surrogate vectors above must remain unchanged.
        val response = JSONObject(NativeCore.evaluate(JSONObject()
            .put("protocolVersion", 1).put("requestId", "unicode")
            .put("operation", "canonicalize").put("input", "\"🐳\"").toString()))
        assertEquals("\"🐳\"", response.getString("canonical"))
    }

    @Test fun kotlinAndRustRejectTheSameRequestIds() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val corpus = JSONObject(context.assets.open("request-ids.json").bufferedReader().use { it.readText() })
        for (kind in listOf("valid", "invalid")) {
            val ids = corpus.getJSONArray(kind)
            for (index in 0 until ids.length()) {
                val id = ids.getString(index)
                val request = CanonicalRequest(1, id, "canonicalize", "null")
                val acceptedByKotlin = try { request.validate(); true } catch (_: IllegalArgumentException) { false }
                assertEquals(kind == "valid", acceptedByKotlin)
                val response = JSONObject(NativeCore.evaluate(JSONObject()
                    .put("protocolVersion", 1).put("requestId", id)
                    .put("operation", "canonicalize").put("input", "null").toString()))
                assertEquals(kind == "valid", response.getString("type") == "canonicalized")
            }
        }
    }
}
