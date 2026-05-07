package dev.orcaxr.app.mcp

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * Round-trips an actual TCP socket. The MCP server's transport doesn't
 * touch any Android-only API (just ServerSocket + InputStream/Output-
 * Stream), so we can verify the full HTTP/JSON-RPC handshake from a
 * plain JVM unit test without spinning up Robolectric or a device.
 *
 * The tools registered here are tiny in-process stand-ins so the test
 * doesn't require DataStore. Real tool wiring is covered in the
 * androidTest harness once it exists.
 */
class McpServerEndToEndTest {

    private lateinit var server: McpServer
    private lateinit var http: OkHttpClient
    private var port: Int = 0

    /** Cheap stand-in: returns a fixed JSON object so we can verify the call_tool path. */
    private class HelloTool : Tool {
        override val name = "hello"
        override val description = "test tool"
        override val inputSchema = Schemas.obj(
            properties = mapOf("who" to Schemas.string("name to greet")),
        )
        override suspend fun call(args: org.json.JSONObject): ToolResult {
            val who = args.optString("who", "world")
            val body = JSONObject().apply { put("greeting", "hi $who") }
            return ToolResult.ok("hi $who", body)
        }
    }

    @Before fun setUp() {
        server = McpServer.Builder()
            .authToken("supersecret")
            .tool(HelloTool())
            .build()
        port = server.start(0)  // ephemeral port
        http = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    @After fun tearDown() {
        server.stop()
    }

    private fun rpc(body: String, withAuth: Boolean = true): JSONObject {
        val req = Request.Builder()
            .url("http://127.0.0.1:$port/mcp")
            .post(body.toRequestBody("application/json".toMediaType()))
            .also { if (withAuth) it.header("Authorization", "Bearer supersecret") }
            .build()
        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            assertEquals("HTTP body: $raw", 200, resp.code)
            return JSONObject(raw)
        }
    }

    @Test fun rootGetReturnsHumanReadable() {
        val req = Request.Builder().url("http://127.0.0.1:$port/").get().build()
        http.newCall(req).execute().use { resp ->
            assertEquals(200, resp.code)
            val body = resp.body?.string().orEmpty()
            assertTrue("should advertise endpoint: $body", body.contains("/mcp"))
        }
    }

    @Test fun initializeReturnsServerCapabilities() {
        val resp = rpc("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}""", withAuth = false)
        assertEquals("2.0", resp.getString("jsonrpc"))
        assertEquals(1, resp.getInt("id"))
        val result = resp.getJSONObject("result")
        assertEquals("2024-11-05", result.getString("protocolVersion"))
        assertNotNull(result.getJSONObject("capabilities").getJSONObject("tools"))
        assertEquals(McpServer.DEFAULT_NAME, result.getJSONObject("serverInfo").getString("name"))
    }

    @Test fun toolsListIncludesRegisteredTools() {
        val resp = rpc("""{"jsonrpc":"2.0","id":2,"method":"tools/list"}""", withAuth = false)
        val tools = resp.getJSONObject("result").getJSONArray("tools")
        var foundHello = false
        for (i in 0 until tools.length()) {
            val t = tools.getJSONObject(i)
            if (t.getString("name") == "hello") {
                foundHello = true
                assertEquals("test tool", t.getString("description"))
                assertEquals("object", t.getJSONObject("inputSchema").getString("type"))
            }
        }
        assertTrue("hello tool should be in list", foundHello)
    }

    @Test fun toolsCallRequiresAuth() {
        // First, no auth header → unauthorized.
        val resp = rpc("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hello","arguments":{"who":"x"}}}""", withAuth = false)
        val err = resp.getJSONObject("error")
        assertEquals(JsonRpc.UNAUTHORIZED, err.getInt("code"))
    }

    @Test fun toolsCallSucceedsWithCorrectAuth() {
        val resp = rpc("""{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hello","arguments":{"who":"orcaxr"}}}""")
        val result = resp.getJSONObject("result")
        // structuredContent is the machine-parseable body.
        assertEquals("hi orcaxr", result.getJSONObject("structuredContent").getString("greeting"))
        // content[0].text is the human-readable form.
        assertEquals("hi orcaxr", result.getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun unknownMethodIsMethodNotFound() {
        val resp = rpc("""{"jsonrpc":"2.0","id":5,"method":"made_up","params":{}}""")
        val err = resp.getJSONObject("error")
        assertEquals(JsonRpc.METHOD_NOT_FOUND, err.getInt("code"))
    }

    @Test fun parseErrorReturnsJsonRpcEnvelope() {
        // Even on a parse failure, the spec says respond 200 with a
        // JSON-RPC envelope (error code -32700) so the client can
        // observe the failure mode.
        val req = Request.Builder()
            .url("http://127.0.0.1:$port/mcp")
            .header("Authorization", "Bearer supersecret")
            .post("not json".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            val obj = JSONObject(raw)
            assertEquals(JsonRpc.PARSE_ERROR, obj.getJSONObject("error").getInt("code"))
        }
    }

    @Test fun unknownToolReturnsMethodNotFound() {
        val resp = rpc("""{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"does_not_exist","arguments":{}}}""")
        assertEquals(JsonRpc.METHOD_NOT_FOUND, resp.getJSONObject("error").getInt("code"))
    }

    @Test fun pingRespondsWithEmptyResult() {
        val resp = rpc("""{"jsonrpc":"2.0","id":8,"method":"ping"}""", withAuth = false)
        assertEquals("ping should be auth-free", 0, resp.getJSONObject("result").length())
    }

    /**
     * Audit H2 — the `/resources/<token>.png` route must require the
     * bearer header. A LAN attacker that scanned tokens against the
     * unauthenticated route was the original threat model.
     */
    @Test fun resourceRouteRejectsMissingBearer() {
        val req = Request.Builder()
            .url("http://127.0.0.1:$port/resources/whatever.png")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            assertEquals("expected 401 without bearer", 401, resp.code)
        }
    }

    /**
     * Audit H2 — same route with the bearer present resolves to the
     * normal 404 path when the token is unknown (instead of 401). This
     * confirms the auth gate fires before the lookup, but doesn't
     * silently swallow the bearer.
     */
    @Test fun resourceRouteWithBearerTokenStillRejectsUnknownToken() {
        val req = Request.Builder()
            .url("http://127.0.0.1:$port/resources/madeuptoken.png")
            .header("Authorization", "Bearer supersecret")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            assertEquals("authorized but unknown token → 404", 404, resp.code)
        }
    }

    /**
     * Audit H2 — content tokens are 32 hex chars (128-bit truncation
     * of SHA-256), not 16. The narrow 16-char tokens were brute-
     * forceable on a LAN; widening pushes the floor to 2^128.
     */
    @Test fun contentTokenIs128Bits() {
        val cam = dev.orcaxr.app.AiRenderEngine.CameraSpec(
            widthPx = 256,
            heightPx = 256,
            viewMatrixRowMajor = FloatArray(16) { it.toFloat() },
            projMatrixRowMajor = FloatArray(16) { (it * 2).toFloat() },
        )
        val token = AiSessionState.contentToken("model", "rgb", cam, 0)
        assertEquals("token must be 32 hex chars (128 bits)", 32, token.length)
        assertTrue("token must be lowercase hex", token.matches(Regex("^[0-9a-f]{32}$")))
    }
}
