package dev.orcaxr.app.mcp

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Cheap "is the remote server reachable + does the bearer work" probe.
 * Posts a JSON-RPC `tools/list` (which the server treats as auth-free —
 * see `McpProtocol`) so a wrong token is detectable separately from a
 * wrong URL. Returns a sealed status the Settings card can render
 * without inventing its own copy.
 */
object RemoteMcpProbe {

    sealed interface Status {
        /** Reachable and tools/list returned a non-empty registry.
         *  [toolCount] is the rough surface area to surface in the UI
         *  — useful for "Connected · 113 tools" copy. */
        data class Online(val toolCount: Int) : Status

        /** Reachable, but the server rejected our request. Token is
         *  almost certainly wrong, or the server's rotation ran. */
        data object Unauthorized : Status

        /** Couldn't reach the server (network down, port closed,
         *  user took the headset off and it slept). */
        data class Offline(val message: String) : Status
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json".toMediaType()

    suspend fun probe(endpoint: RemoteMcpEndpoint): Status =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("jsonrpc", "2.0")
                .put("id", 1)
                .put("method", "tools/list")
                .put("params", JSONObject())
            val req = Request.Builder()
                .url(endpoint.url)
                .post(body.toString().toRequestBody(JSON))
                .addHeader("Authorization", "Bearer ${endpoint.token}")
                .addHeader("Accept", "application/json")
                .build()
            try {
                client.newCall(req).execute().use { resp ->
                    if (resp.code == 401 || resp.code == 403) {
                        return@use Status.Unauthorized
                    }
                    if (!resp.isSuccessful) {
                        return@use Status.Offline("HTTP ${resp.code}")
                    }
                    val text = resp.body?.string().orEmpty()
                    val toolCount = runCatching {
                        JSONObject(text)
                            .optJSONObject("result")
                            ?.optJSONArray("tools")
                            ?.length() ?: 0
                    }.getOrDefault(0)
                    Status.Online(toolCount)
                }
            } catch (t: Throwable) {
                Status.Offline(t.message ?: t::class.java.simpleName)
            }
        }
}
