package dev.orcaxr.app.mcp

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM tests for the JSON-RPC parsing + envelope shape. The bigger
 * end-to-end story (server boot, HTTP I/O, real tool dispatch with
 * DataStore) lives in McpServerInstrumentedTest under androidTest/
 * because DataStore wants a real Context.
 */
class JsonRpcTest {

    @Test fun parseFailsCleanlyOnGarbage() {
        val r = JsonRpc.parse("not json at all")
        assertTrue(r.isFailure)
        val ex = r.exceptionOrNull() as JsonRpc.InvalidJsonRpc
        assertEquals(JsonRpc.PARSE_ERROR, ex.code)
    }

    @Test fun parseRejectsMissingJsonrpcVersion() {
        val r = JsonRpc.parse("""{"method":"ping","id":1}""")
        assertTrue(r.isFailure)
        val ex = r.exceptionOrNull() as JsonRpc.InvalidJsonRpc
        assertEquals(JsonRpc.INVALID_REQUEST, ex.code)
    }

    @Test fun parseRejectsMissingMethod() {
        val r = JsonRpc.parse("""{"jsonrpc":"2.0","id":1}""")
        assertTrue(r.isFailure)
        val ex = r.exceptionOrNull() as JsonRpc.InvalidJsonRpc
        assertEquals(JsonRpc.INVALID_REQUEST, ex.code)
    }

    @Test fun parseRejectsArrayParams() {
        // MCP only uses object-shaped params. Spec allows arrays for
        // positional, but accepting them silently would mask a real
        // client misconfiguration — fail loudly instead.
        val r = JsonRpc.parse("""{"jsonrpc":"2.0","id":1,"method":"ping","params":[1,2]}""")
        assertTrue(r.isFailure)
        val ex = r.exceptionOrNull() as JsonRpc.InvalidJsonRpc
        assertEquals(JsonRpc.INVALID_PARAMS, ex.code)
    }

    @Test fun parseAcceptsNoParams() {
        val r = JsonRpc.parse("""{"jsonrpc":"2.0","id":1,"method":"ping"}""")
        assertTrue(r.isSuccess)
        val req = r.getOrThrow()
        assertEquals("ping", req.method)
        assertEquals(1, req.id)
        assertFalse(req.isNotification)
        assertEquals(0, req.params.length())
    }

    @Test fun parsePreservesStringId() {
        val r = JsonRpc.parse("""{"jsonrpc":"2.0","id":"abc","method":"x"}""")
        val req = r.getOrThrow()
        assertEquals("abc", req.id)
    }

    @Test fun parseDetectsNotification() {
        val r = JsonRpc.parse("""{"jsonrpc":"2.0","method":"notifications/initialized"}""")
        val req = r.getOrThrow()
        assertNull(req.id)
        assertTrue(req.isNotification)
    }

    @Test fun okEnvelopeShape() {
        val res = JsonRpc.ok(7, JSONObject().apply { put("v", "yo") })
        assertEquals("2.0", res.getString("jsonrpc"))
        assertEquals(7, res.getInt("id"))
        assertEquals("yo", res.getJSONObject("result").getString("v"))
        assertFalse(res.has("error"))
    }

    @Test fun errorEnvelopeShape() {
        val res = JsonRpc.error(7, JsonRpc.UNAUTHORIZED, "no token")
        assertEquals("2.0", res.getString("jsonrpc"))
        assertEquals(7, res.getInt("id"))
        val err = res.getJSONObject("error")
        assertEquals(JsonRpc.UNAUTHORIZED, err.getInt("code"))
        assertEquals("no token", err.getString("message"))
        assertFalse(res.has("result"))
    }

    @Test fun errorEnvelopeWithNullId() {
        // Parse errors can produce id=null because we never got a
        // chance to read the id. Spec says use null in that case;
        // verify our envelope serializes null (not the string "null").
        val res = JsonRpc.error(null, JsonRpc.PARSE_ERROR, "boom")
        assertTrue(res.isNull("id"))
    }
}

class ToolResultTest {

    @Test fun okBuildsTextContent() {
        val r = ToolResult.ok("hello", JSONObject().apply { put("count", 1) })
        val json = r.toJson()
        val content = json.getJSONArray("content")
        assertEquals(1, content.length())
        val part = content.getJSONObject(0)
        assertEquals("text", part.getString("type"))
        assertEquals("hello", part.getString("text"))
        // structuredContent is optional but should be present here.
        assertEquals(1, json.getJSONObject("structuredContent").getInt("count"))
        // isError omitted on success.
        assertFalse(json.has("isError"))
    }

    @Test fun errorPropagatesIsErrorFlag() {
        val r = ToolResult.error("nope")
        val json = r.toJson()
        assertTrue(json.getBoolean("isError"))
    }
}

class ConstantTimeEqualsTest {

    @Test fun matchingStringsCompareEqual() {
        assertTrue(McpServer.constantTimeEquals("Bearer abc123", "Bearer abc123"))
    }

    @Test fun differentLengthStringsAreUnequal() {
        // Length difference must short-circuit to false; this is the
        // ONE branch where constant-time semantics break, but the
        // length itself isn't secret.
        assertFalse(McpServer.constantTimeEquals("a", "ab"))
    }

    @Test fun differentSameLengthStringsAreUnequal() {
        assertFalse(McpServer.constantTimeEquals("aaa", "aab"))
    }
}
