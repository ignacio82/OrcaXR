package dev.orcaxr.nativeapp.mcp

import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap

class JsonRpcHandlerTest {

    private class FakeSharedPreferences : SharedPreferences {
        val map = ConcurrentHashMap<String, Any>()

        override fun getAll(): MutableMap<String, *> = HashMap(map)
        override fun getString(key: String, defValue: String?): String? = map[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
            @Suppress("UNCHECKED_CAST") (map[key] as? MutableSet<String> ?: defValues)
        override fun getInt(key: String, defValue: Int): Int = (map[key] as? Number)?.toInt() ?: defValue
        override fun getLong(key: String, defValue: Long): Long = (map[key] as? Number)?.toLong() ?: defValue
        override fun getFloat(key: String, defValue: Float): Float = (map[key] as? Number)?.toFloat() ?: defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = map[key] as? Boolean ?: defValue
        override fun contains(key: String): Boolean = map.containsKey(key)
        override fun edit(): SharedPreferences.Editor = Editor(this)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}

        class Editor(private val parent: FakeSharedPreferences) : SharedPreferences.Editor {
            private val pending = mutableMapOf<String, Any?>()
            private var clearFlag = false

            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = apply { pending[key] = values }
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply { pending[key] = value }
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply { pending[key] = value }
            override fun remove(key: String): SharedPreferences.Editor = apply { pending[key] = null }
            override fun clear(): SharedPreferences.Editor = apply { clearFlag = true }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() {
                if (clearFlag) parent.map.clear()
                pending.forEach { (k, v) ->
                    if (v == null) parent.map.remove(k) else parent.map[k] = v
                }
            }
        }
    }

    @Test
    fun mcpAuthGeneratesAndValidatesTokens() {
        val prefs = FakeSharedPreferences()
        val auth = McpAuth(prefs)

        val token1 = auth.token
        assertEquals(64, token1.length)
        assertTrue(auth.validateToken(token1))
        assertTrue(auth.validateToken("Bearer $token1"))
        assertFalse(auth.validateToken("wrong-token"))
        assertFalse(auth.validateToken(null))

        val token2 = auth.regenerateToken()
        assertEquals(64, token2.length)
        assertTrue(auth.validateToken(token2))
        assertFalse(auth.validateToken(token1)) // old token invalid

        auth.allowLan = true
        assertTrue(auth.allowLan)
        auth.serverPort = 9000
        assertEquals(9000, auth.serverPort)
        assertEquals("adb forward tcp:9000 tcp:9000", auth.adbForwardCommand())
    }

    @Test
    fun jsonRpcHandlesInitializeAndPing() = runBlocking {
        val registry = McpToolRegistry()
        val jsonRpc = McpJsonRpc(registry)

        val initReq = McpJson.stringify(
            mapOf(
                "jsonrpc" to "2.0",
                "id" to 1,
                "method" to "initialize",
                "params" to mapOf("protocolVersion" to "2024-11-05"),
            )
        )

        val initRespStr = jsonRpc.handleMessage(initReq)
        assertNotNull(initRespStr)
        @Suppress("UNCHECKED_CAST")
        val initResp = McpJson.parseObject(initRespStr!!)!!
        assertEquals(1L, (initResp["id"] as Number).toLong())
        @Suppress("UNCHECKED_CAST")
        val result = initResp["result"] as Map<String, Any?>
        assertEquals("2024-11-05", result["protocolVersion"])
        @Suppress("UNCHECKED_CAST")
        val serverInfo = result["serverInfo"] as Map<String, Any?>
        assertEquals("OrcaXR Android", serverInfo["name"])

        // notifications/initialized returns null (no reply)
        val notifReq = McpJson.stringify(
            mapOf(
                "jsonrpc" to "2.0",
                "method" to "notifications/initialized",
            )
        )
        assertNull(jsonRpc.handleMessage(notifReq))

        // ping
        val pingReq = McpJson.stringify(
            mapOf(
                "jsonrpc" to "2.0",
                "id" to 2,
                "method" to "ping",
            )
        )
        val pingResp = McpJson.parseObject(jsonRpc.handleMessage(pingReq)!!)!!
        assertEquals(2L, (pingResp["id"] as Number).toLong())
        assertNotNull(pingResp["result"])
    }

    @Test
    fun jsonRpcRegistersAndCallsTools() = runBlocking {
        val registry = McpToolRegistry()
        registry.registerTool(
            name = "echo_tool",
            description = "Echos input back",
            inputSchema = mapOf("type" to "object"),
        ) { args ->
            val msg = args["msg"] as? String ?: "none"
            McpToolResult.text("echo: $msg")
        }

        val jsonRpc = McpJsonRpc(registry)

        // tools/list
        val listReq = McpJson.stringify(
            mapOf(
                "jsonrpc" to "2.0",
                "id" to 3,
                "method" to "tools/list",
            )
        )
        val listResp = McpJson.parseObject(jsonRpc.handleMessage(listReq)!!)!!
        @Suppress("UNCHECKED_CAST")
        val toolsResult = listResp["result"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val tools = toolsResult["tools"] as List<Map<String, Any?>>
        assertEquals(1, tools.size)
        assertEquals("echo_tool", tools[0]["name"])

        // tools/call
        val callReq = McpJson.stringify(
            mapOf(
                "jsonrpc" to "2.0",
                "id" to 4,
                "method" to "tools/call",
                "params" to mapOf(
                    "name" to "echo_tool",
                    "arguments" to mapOf("msg" to "hello world"),
                ),
            )
        )
        val callResp = McpJson.parseObject(jsonRpc.handleMessage(callReq)!!)!!
        @Suppress("UNCHECKED_CAST")
        val callResult = callResp["result"] as Map<String, Any?>
        assertFalse(callResult["isError"] as Boolean)
        @Suppress("UNCHECKED_CAST")
        val content = callResult["content"] as List<Map<String, Any?>>
        assertEquals(1, content.size)
        assertEquals("echo: hello world", content[0]["text"])
    }

    @Test
    fun jsonRpcRejectsMalformedAndUnknownMethods() = runBlocking {
        val registry = McpToolRegistry()
        val jsonRpc = McpJsonRpc(registry)

        // Parse error
        val parseErr = McpJson.parseObject(jsonRpc.handleMessage("not json")!!)!!
        @Suppress("UNCHECKED_CAST")
        val parseErrObj = parseErr["error"] as Map<String, Any?>
        assertEquals(McpJsonRpc.CODE_PARSE_ERROR.toLong(), (parseErrObj["code"] as Number).toLong())

        // Invalid Request (no jsonrpc 2.0)
        val invalidReq = McpJson.parseObject(jsonRpc.handleMessage("{\"method\":\"test\",\"id\":1}")!!)!!
        @Suppress("UNCHECKED_CAST")
        val invalidErrObj = invalidReq["error"] as Map<String, Any?>
        assertEquals(McpJsonRpc.CODE_INVALID_REQUEST.toLong(), (invalidErrObj["code"] as Number).toLong())

        // Method not found
        val notFound = McpJson.parseObject(jsonRpc.handleMessage("{\"jsonrpc\":\"2.0\",\"method\":\"unknown\",\"id\":2}")!!)!!
        @Suppress("UNCHECKED_CAST")
        val notFoundErrObj = notFound["error"] as Map<String, Any?>
        assertEquals(McpJsonRpc.CODE_METHOD_NOT_FOUND.toLong(), (notFoundErrObj["code"] as Number).toLong())
    }

    @Test
    fun workspaceToolsRegistersExpectedTools() {
        val registry = McpToolRegistry()
        val fakeContext = object : McpContext {
            override val project: dev.orcaxr.nativeapp.project.ProjectModel? = null
            override val prepare: dev.orcaxr.nativeapp.prepare.PrepareModel? = null
            override val device: dev.orcaxr.nativeapp.device.DeviceModel? = null
            override val preview: dev.orcaxr.nativeapp.preview.PreviewModel? = null
            override val activeArea: String = "workspace"
            override fun navigateTo(area: String): Boolean = true
            override val activeDialog: String? = null
            override fun dismissActiveDialog(): String? = null
            override fun getRecentLogs(filter: String?, limit: Int): List<String> = emptyList()
            override fun runAction(actionId: String): Boolean = true
            override fun captureScreenshot(width: Int, height: Int, format: String) = java.util.concurrent.CompletableFuture.completedFuture("")
            override fun runOnMain(block: () -> Unit) = block()
        }

        dev.orcaxr.nativeapp.mcp.tools.WorkspaceTools.register(registry, fakeContext)
        val tools = registry.listTools().map { it.name }.toSet()

        assertTrue(tools.contains("get_workspace_state"))
        assertTrue(tools.contains("get_project_tree"))
        assertTrue(tools.contains("select_row"))
        assertTrue(tools.contains("set_gizmo_tool"))
        assertTrue(tools.contains("assign_filament"))
        assertTrue(tools.contains("remap_filaments"))
        assertTrue(tools.contains("get_preflight_diagnostics"))
        assertTrue(tools.contains("add_primitive"))
        assertTrue(tools.contains("list_recent_projects"))
        assertTrue(tools.contains("open_recent_project"))
        assertTrue(tools.contains("disable_wipe_tower"))
    }
}
