package dev.orcaxr.app.mcp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The receiving end of the Quick-Share-an-MCP-grant flow: the phone
 * gets a SEND intent with a `text/plain` blob and has to decide
 * whether it's an OrcaXR grant. The parser MUST refuse to act on
 * arbitrary shared text — the failure mode of "user shared a Twitter
 * link, OrcaXR silently rewrote their remote-MCP config" would be a
 * security incident — but it MUST also handle the canonical snippet
 * format the XR card emits + reasonable mangled variants.
 */
class McpShareSnippetTest {

    @Test fun parsesCanonicalSnippet() {
        val canonical = buildShareSnippet(
            primaryUrl = "http://192.168.1.42:7080/mcp",
            token = "testtoken000000000000000fixturenotsecret",
            lanIps = listOf("192.168.1.42"),
            port = 7080,
        )
        val parsed = McpShareSnippet.parse(canonical)
        assertNotNull("canonical snippet should parse", parsed)
        assertEquals("http://192.168.1.42:7080/mcp", parsed!!.url)
        assertEquals("testtoken000000000000000fixturenotsecret", parsed.token)
    }

    @Test fun rejectsTextWithoutSignature() {
        // Plausible-looking URL + bearer but no OrcaXR signature.
        val text = """
            http://192.168.1.42:7080/mcp
            Bearer testtoken000000000000000fixturenotsecret
        """.trimIndent()
        assertNull(
            "no-signature text must NOT silently configure the phone",
            McpShareSnippet.parse(text),
        )
    }

    @Test fun rejectsNullAndEmpty() {
        assertNull(McpShareSnippet.parse(null))
        assertNull(McpShareSnippet.parse(""))
        assertNull(McpShareSnippet.parse("   \n  "))
    }

    @Test fun appendsMcpPathWhenMissing() {
        val text = """
            OrcaXR MCP server (running on my Android XR headset).
            Endpoint: http://10.0.0.5:7080
            Bearer token: testtoken000000000000000fixturenotsecret
        """.trimIndent()
        val parsed = McpShareSnippet.parse(text)
        assertNotNull(parsed)
        assertEquals("http://10.0.0.5:7080/mcp", parsed!!.url)
    }

    @Test fun toleratesSingleLineConcatenation() {
        // Some Quick Share previews flatten newlines.
        val text = "OrcaXR MCP server: http://10.0.0.5:7080/mcp Bearer testtoken000000000000000fixturenotsecret"
        val parsed = McpShareSnippet.parse(text)
        assertNotNull(parsed)
        assertEquals("testtoken000000000000000fixturenotsecret", parsed!!.token)
    }

    @Test fun acceptsHttpsEndpoint() {
        val text = """
            OrcaXR MCP server.
            Endpoint: https://orcaxr.local:7080/mcp
            Bearer token: testtoken000000000000000fixturenotsecret
        """.trimIndent()
        val parsed = McpShareSnippet.parse(text)
        assertNotNull(parsed)
        assertEquals("https://orcaxr.local:7080/mcp", parsed!!.url)
    }

    @Test fun canonicalSnippetCarriesAllThreeCliRecipes() {
        // The snippet must include paste-and-go recipes for every CLI
        // we publicly support, so a user who shared from XR doesn't
        // have to look up "how do I register this with Gemini" on
        // their phone with the share sheet still open.
        val snippet = buildShareSnippet(
            primaryUrl = "http://192.168.1.42:7080/mcp",
            token = "testtoken000000000000000fixturenotsecret",
            lanIps = listOf("192.168.1.42"),
            port = 7080,
        )
        assertEquals(
            "claude mcp add line missing",
            true,
            snippet.contains("claude mcp add --transport http orcaxr"),
        )
        assertEquals(
            "gemini mcp add line missing",
            true,
            snippet.contains("gemini mcp add --transport http orcaxr"),
        )
        assertEquals(
            "codex TOML stanza missing",
            true,
            snippet.contains("[mcp_servers.orcaxr]") &&
                snippet.contains("bearer_token_env_var = \"ORCAXR_BEARER\""),
        )
        // And the parser still extracts the right URL/token even
        // though they each appear three times now (once in the
        // Endpoint/Bearer block, once in claude, once in gemini).
        val parsed = McpShareSnippet.parse(snippet)
        assertNotNull(parsed)
        assertEquals("http://192.168.1.42:7080/mcp", parsed!!.url)
        assertEquals("testtoken000000000000000fixturenotsecret", parsed.token)
    }
}
