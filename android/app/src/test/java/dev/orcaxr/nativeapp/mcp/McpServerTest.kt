package dev.orcaxr.nativeapp.mcp

import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class McpServerTest {

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

    private fun findFreePort(): Int {
        ServerSocket(0).use { return it.localPort }
    }

    @Test
    fun mcpServerHandlesAuthAndRpcOverHttp() {
        val prefs = FakeSharedPreferences()
        val auth = McpAuth(prefs)
        auth.serverPort = findFreePort()

        val registry = McpToolRegistry()
        registry.registerTool(
            name = "ping_tool",
            description = "Returns pong",
            inputSchema = mapOf("type" to "object"),
        ) {
            McpToolResult.text("pong")
        }

        val jsonRpc = McpJsonRpc(registry)
        val server = McpServer(auth, jsonRpc)

        assertTrue(server.start())
        assertTrue(server.running)

        val port = server.port
        val token = auth.token

        try {
            // 1. Unauthorized request should get 401
            val unauthUrl = URL("http://127.0.0.1:$port/mcp/status")
            val conn1 = unauthUrl.openConnection() as HttpURLConnection
            conn1.connectTimeout = 3000
            conn1.readTimeout = 3000
            val code1 = conn1.responseCode
            assertEquals(401, code1)
            conn1.disconnect()

            // 2. Authorized status query
            val authUrl = URL("http://127.0.0.1:$port/mcp/status")
            val conn2 = authUrl.openConnection() as HttpURLConnection
            conn2.setRequestProperty("Authorization", "Bearer $token")
            conn2.connectTimeout = 3000
            conn2.readTimeout = 3000
            assertEquals(200, conn2.responseCode)
            val statusBody = conn2.inputStream.bufferedReader().readText()
            val statusMap = McpJson.parseObject(statusBody)
            assertNotNull(statusMap)
            assertEquals("ok", statusMap!!["status"])
            conn2.disconnect()

            // 3. Authorized tool call over POST /mcp
            val rpcUrl = URL("http://127.0.0.1:$port/mcp")
            val conn3 = rpcUrl.openConnection() as HttpURLConnection
            conn3.requestMethod = "POST"
            conn3.doOutput = true
            conn3.setRequestProperty("Authorization", "Bearer $token")
            conn3.setRequestProperty("Content-Type", "application/json")

            val rpcRequest = McpJson.stringify(
                mapOf(
                    "jsonrpc" to "2.0",
                    "id" to 42,
                    "method" to "tools/call",
                    "params" to mapOf(
                        "name" to "ping_tool",
                        "arguments" to emptyMap<String, Any>(),
                    ),
                )
            )

            conn3.outputStream.use { it.write(rpcRequest.toByteArray(Charsets.UTF_8)) }
            assertEquals(200, conn3.responseCode)

            val rpcResponseBody = conn3.inputStream.bufferedReader().readText()
            val rpcResponse = McpJson.parseObject(rpcResponseBody)
            assertNotNull(rpcResponse)
            assertEquals(42L, (rpcResponse!!["id"] as Number).toLong())
            @Suppress("UNCHECKED_CAST")
            val result = rpcResponse["result"] as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val content = result["content"] as List<Map<String, Any?>>
            assertEquals("pong", content[0]["text"])
            conn3.disconnect()

        } finally {
            server.stop()
            assertFalse(server.running)
        }
    }
}
