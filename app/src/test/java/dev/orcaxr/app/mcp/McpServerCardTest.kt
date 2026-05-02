package dev.orcaxr.app.mcp

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Share button on [McpServerCard] is the user's escape hatch when
 * they want to hand the running headset's MCP endpoint to another
 * Claude / LLM client. The snippet has to be self-contained — URL,
 * token, and a `claude mcp add` command — so the receiving assistant
 * doesn't have to ask follow-ups. Lock the contract here.
 */
class McpServerCardTest {

    @Test fun snippetIncludesAllConnectInfo() {
        val out = buildShareSnippet(
            primaryUrl = "http://192.168.1.42:7080/mcp",
            token = "tok_abcdEFGHIJklmnop1234567890ZZ",
            lanIps = listOf("192.168.1.42"),
            port = 7080,
        )
        assertTrue("URL missing", out.contains("http://192.168.1.42:7080/mcp"))
        assertTrue("Token missing", out.contains("tok_abcdEFGHIJklmnop1234567890ZZ"))
        assertTrue("claude mcp add missing", out.contains("claude mcp add"))
        assertTrue("Authorization header missing", out.contains("Authorization: Bearer"))
    }

    @Test fun snippetListsAlternateLanIpsWhenMultiple() {
        val out = buildShareSnippet(
            primaryUrl = "http://10.0.0.5:7080/mcp",
            token = "k",
            lanIps = listOf("10.0.0.5", "192.168.1.42"),
            port = 7080,
        )
        assertTrue("alt URL missing", out.contains("http://192.168.1.42:7080/mcp"))
    }

    @Test fun snippetSkipsAlternateBlockWhenSingleIp() {
        val out = buildShareSnippet(
            primaryUrl = "http://10.0.0.5:7080/mcp",
            token = "k",
            lanIps = listOf("10.0.0.5"),
            port = 7080,
        )
        assertTrue("must not advertise alternates", !out.contains("Alternate LAN URLs"))
    }
}
