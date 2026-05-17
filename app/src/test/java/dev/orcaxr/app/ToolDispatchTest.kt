package dev.orcaxr.app

import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolDispatchTest {

    private fun fakeTool(
        toolName: String = "fake",
        result: () -> ToolResult,
    ): Tool = object : Tool {
        override val name = toolName
        override val description = "fake"
        override val inputSchema = JSONObject()
        override suspend fun call(args: JSONObject): ToolResult = result()
    }

    @Test fun okResultMapsToOkTrueWithStructured() = runTest {
        val structured = JSONObject().put("source", "cascade")
        val r = ToolDispatch.call(fakeTool { ToolResult.ok("done", structured) })
        assertTrue(r.ok)
        assertEquals("done", r.message)
        assertEquals("cascade", r.structured!!.getString("source"))
        assertTrue(r.toStatus().startsWith("✓"))
    }

    @Test fun errorResultMapsToOkFalse() = runTest {
        val r = ToolDispatch.call(fakeTool { ToolResult.error("bad input") })
        assertFalse(r.ok)
        assertEquals("bad input", r.message)
        assertTrue(r.toStatus().startsWith("✗"))
    }

    @Test fun thrownExceptionIsCaughtNotPropagated() = runTest {
        val r = ToolDispatch.call(
            fakeTool("explode") { throw IllegalStateException("boom") },
        )
        assertFalse(r.ok)
        assertTrue(r.message.contains("explode failed"))
        assertTrue(r.message.contains("boom"))
        assertNull(r.structured)
    }

    @Test fun argsArePassedThrough() = runTest {
        var seen: JSONObject? = null
        val tool = object : Tool {
            override val name = "echo"
            override val description = ""
            override val inputSchema = JSONObject()
            override suspend fun call(args: JSONObject): ToolResult {
                seen = args
                return ToolResult.ok("ok", null)
            }
        }
        ToolDispatch.call(tool, JSONObject().put("k", 42))
        assertEquals(42, seen!!.getInt("k"))
    }
}
