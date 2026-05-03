package dev.orcaxr.app.mcp.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D21a — render artifact URI shape. The driving LLM relies on
 * `image_uri` being a real http URL when the MCP server is bound to
 * a LAN IP, OR an `mcp://resources/<token>.png` capability URI as a
 * fallback (offline tests, fresh boot before Wi-Fi associates). This
 * test exercises only the "no port bound" path because the unit
 * harness doesn't start a real server; the http-URL path is covered
 * by the on-device McpServerEndToEndTest.
 */
class AiVisionResourceUriTest {

    @Test fun fallsBackToMcpSchemeWhenServerNotBound() {
        // boundPortStatic() returns 0 when no McpController has
        // started — that's the unit-test default.
        val uri = AiVisionTools.buildResourceUri("abcd1234")
        assertEquals("mcp://resources/abcd1234.png", uri)
    }

    @Test fun mcpSchemeContainsTokenAndPngExtension() {
        val uri = AiVisionTools.buildResourceUri("xyz9876")
        assertTrue("token preserved", uri.contains("xyz9876"))
        assertTrue("png extension preserved", uri.endsWith(".png"))
    }
}
