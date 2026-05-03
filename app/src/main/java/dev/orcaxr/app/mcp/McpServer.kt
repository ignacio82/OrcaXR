package dev.orcaxr.app.mcp

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device MCP HTTP server. Lifecycle:
 * - [start] — bind a [ServerSocket] on `port` and launch the acceptor
 *   coroutine. Idempotent (calling twice returns the running instance's
 *   bound port).
 * - [stop] — close the socket (which makes accept() throw, ending the
 *   acceptor) and cancel the supervisor scope (which kills any
 *   in-flight handlers).
 *
 * Concurrency model: one acceptor coroutine on Dispatchers.IO + a
 * forked handler coroutine per request, also on IO. We don't bother
 * with a thread pool — Dispatchers.IO is one. Each request is short
 * (a JSON-RPC round-trip; tools that do real work hand back to the
 * caller immediately and run async) so accept latency stays low even
 * under bursty LLM clients.
 *
 * The acceptor never throws to its parent on routine I/O failure —
 * malformed clients, sockets dying mid-read, the network going away
 * are all logged + swallowed so a single misbehaving client can't
 * tear down the server. The only way the acceptor ends is [stop] or
 * the JVM going away.
 */
class McpServer internal constructor(
    private val registry: ToolRegistry,
    private val authToken: String?,
    private val serverName: String,
    private val serverVersion: String,
) {
    private val tag: String = "OrcaXR/mcp"

    private val running = AtomicBoolean(false)
    private var socket: ServerSocket? = null
    private var scope: CoroutineScope? = null

    /** The bound port, or 0 if not running. Useful in tests where we bind to port 0. */
    @Volatile var boundPort: Int = 0
        private set

    /**
     * Bind to the given port and start accepting. Pass 0 to ask the OS
     * for an ephemeral port (tests do this). Returns the actual bound
     * port. Throws [IOException] if the bind fails (port in use, etc.)
     * — the caller handles the user-visible error from the settings
     * panel.
     */
    @Throws(IOException::class)
    fun start(port: Int): Int {
        if (running.get()) return boundPort
        // Bind to 0.0.0.0 so the LAN can reach us. The auth token
        // gate is what actually keeps drive-by access out.
        val s = ServerSocket(port)
        socket = s
        boundPort = s.localPort
        val supervisor = SupervisorJob()
        val cs = CoroutineScope(Dispatchers.IO + supervisor)
        scope = cs
        running.set(true)
        Log.i(tag, "Listening on 0.0.0.0:$boundPort")
        cs.launch { acceptLoop(s, cs) }
        return boundPort
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        Log.i(tag, "Stopping (was on port $boundPort)")
        try {
            socket?.close()
        } catch (e: IOException) {
            Log.w(tag, "Socket close threw", e)
        }
        socket = null
        boundPort = 0
        scope?.cancel("McpServer.stop")
        scope = null
    }

    fun isRunning(): Boolean = running.get()

    private suspend fun acceptLoop(s: ServerSocket, cs: CoroutineScope) {
        val protocol = McpProtocol(registry, serverName, serverVersion)
        while (running.get()) {
            val client: Socket = try {
                s.accept()
            } catch (e: IOException) {
                if (running.get()) Log.w(tag, "accept() threw", e)
                return  // socket closed, end the loop
            }
            // Hand off to a child coroutine. SupervisorJob means a
            // failure here doesn't kill the acceptor.
            cs.launch { handleConnection(client, protocol) }
        }
    }

    private suspend fun handleConnection(client: Socket, protocol: McpProtocol) {
        client.use { sock ->
            val request: HttpFraming.Request? = try {
                withContext(Dispatchers.IO) { HttpFraming.readRequest(sock.getInputStream()) }
            } catch (e: IOException) {
                writeStatus(sock, 400, "Bad Request", "{\"error\":\"${escape(e.message ?: "")}\"}")
                return
            }
            if (request == null) return  // clean disconnect, nothing to do

            // CORS preflight — let browser-hosted clients negotiate.
            if (request.method == "OPTIONS") {
                writeStatus(sock, 204, "No Content", "")
                return
            }

            // Route. We only serve POST /mcp (the JSON-RPC entry
            // point); GET / answers a tiny health/discovery payload so
            // the user can curl the URL to verify the server is up.
            // C9 M2 added GET /resources/<token>.png for streaming
            // rendered views back to the LLM (see AiSessionState).
            when {
                request.method == "GET" && request.path == "/" ->
                    handleRoot(sock)
                request.method == "GET" && request.path.startsWith("/resources/") ->
                    handleResourceGet(sock, request)
                request.method == "POST" && (request.path == "/mcp" || request.path == "/") ->
                    handleMcpPost(sock, request, protocol)
                else ->
                    writeStatus(sock, 404, "Not Found", "{\"error\":\"unknown route\"}")
            }
        }
    }

    /**
     * Serve a render artifact by token. Path is
     * `/resources/<token>.png`; the token is the content-hash key
     * AiSessionState used when the rendering tool stored the artifact.
     *
     * **Auth (D21a):** the token is itself the capability — a 64-bit
     * SHA-256 prefix the caller can't guess without already having
     * called a render tool. Skipping the bearer check here lets the
     * driving LLM fetch the rendered PNG via `WebFetch(absolute url)`
     * without OrcaXR having to round-trip the bearer token through the
     * client. The trade-off is that anyone on the LAN who has the
     * token can fetch the PNG; that's the same blast radius as the
     * other LAN side-channels (CIFS shares, mDNS) and the rendered
     * mesh isn't sensitive in the way an API key is.
     */
    private fun handleResourceGet(sock: Socket, request: HttpFraming.Request) {
        // Parse "/resources/<token>.png" — strip the prefix + extension.
        val rest = request.path.removePrefix("/resources/")
        val token = rest.substringBeforeLast('.').takeIf { it.isNotEmpty() }
        if (token == null) {
            writeStatus(sock, 400, "Bad Request", "{\"error\":\"missing token\"}")
            return
        }
        val art = AiSessionState.get().getArtifact(token)
        if (art == null) {
            writeStatus(sock, 404, "Not Found", "{\"error\":\"unknown render token\"}")
            return
        }
        try {
            HttpFraming.writeBinaryResponse(
                sock.getOutputStream(),
                200, "OK", "image/png",
                art.pngBytes,
            )
        } catch (e: IOException) {
            Log.w(tag, "writeBinaryResponse failed", e)
        }
    }

    private fun handleRoot(sock: Socket) {
        // Plain text so it renders well in a browser tab. Includes
        // the bound version + endpoint so a user pointing Claude
        // Desktop at it can verify the URL is right.
        val body = """
            OrcaXR MCP server
            POST $JSON_RPC_ENDPOINT
            ${if (authToken != null) "Authorization: Bearer <key>" else "(no auth required)"}

            Server: $serverName $serverVersion
        """.trimIndent()
        HttpFraming.writeResponse(sock.getOutputStream(), 200, "OK", "text/plain", body)
    }

    private suspend fun handleMcpPost(
        sock: Socket,
        request: HttpFraming.Request,
        protocol: McpProtocol,
    ) {
        // Auth. We allow `initialize` and `tools/list` without a token
        // so an LLM client can discover the server before being
        // configured with credentials. Anything that mutates state
        // requires the bearer token.
        val authorized = checkAuth(request)
        val parsed = JsonRpc.parse(request.body)

        // Parse failure: 200 OK with a JSON-RPC error envelope (per
        // spec). A missing/non-200 here would confuse some clients.
        if (parsed.isFailure) {
            val ex = parsed.exceptionOrNull() as? JsonRpc.InvalidJsonRpc
            val body = JsonRpc.error(
                id = null,
                code = ex?.code ?: JsonRpc.PARSE_ERROR,
                message = ex?.message ?: "Parse error",
            )
            writeJson(sock, body)
            return
        }
        val req = parsed.getOrThrow()

        // Notifications get no body back. JSON-RPC § 4.1: "A
        // Notification is a Request object without an "id" member …
        // the Server MUST NOT reply to a Notification".
        if (req.isNotification && req.method == "notifications/initialized") {
            // Common case: client acks initialize. 204 keeps the wire
            // semantics clean.
            HttpFraming.writeResponse(sock.getOutputStream(), 204, "No Content", "application/json", "")
            return
        }

        if (!authorized && requiresAuth(req.method)) {
            writeJson(sock, JsonRpc.error(req.id, JsonRpc.UNAUTHORIZED, "Unauthorized: missing or wrong bearer token"))
            return
        }

        val response = try {
            protocol.dispatch(req)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            JsonRpc.error(req.id, JsonRpc.INTERNAL_ERROR, e.message ?: e::class.simpleName ?: "internal error")
        }
        if (response == null) {
            // Notification: no body. 204 is correct.
            HttpFraming.writeResponse(sock.getOutputStream(), 204, "No Content", "application/json", "")
        } else {
            writeJson(sock, response)
        }
    }

    private fun checkAuth(request: HttpFraming.Request): Boolean {
        if (authToken == null) return true  // server configured open
        val auth = request.headers["authorization"] ?: return false
        val expected = "Bearer $authToken"
        // Constant-time compare so timing-leak doesn't reveal the
        // token byte-by-byte. The header is short enough that this
        // doesn't matter in practice on a LAN, but free defense in
        // depth.
        return constantTimeEquals(auth, expected)
    }

    private fun requiresAuth(method: String): Boolean {
        // Discovery is open; everything else needs the token.
        return when (method) {
            "initialize", "ping", "tools/list", "resources/list", "prompts/list",
            "notifications/initialized" -> false
            else -> true
        }
    }

    private fun writeJson(sock: Socket, payload: JSONObject) {
        try {
            HttpFraming.writeResponse(
                sock.getOutputStream(),
                200,
                "OK",
                "application/json",
                payload.toString(),
            )
        } catch (e: IOException) {
            Log.w(tag, "writeJson failed", e)
        }
    }

    private fun writeStatus(sock: Socket, code: Int, text: String, body: String) {
        try {
            HttpFraming.writeResponse(sock.getOutputStream(), code, text, "application/json", body)
        } catch (e: IOException) {
            // Client gone — no recovery, just move on.
        }
    }

    companion object {
        const val JSON_RPC_ENDPOINT: String = "/mcp"
        const val DEFAULT_NAME: String = "OrcaXR"
        const val DEFAULT_VERSION: String = "0.1.0"

        /** Constant-time string equality. Returns false on length mismatch. */
        internal fun constantTimeEquals(a: String, b: String): Boolean {
            if (a.length != b.length) return false
            var diff = 0
            for (i in a.indices) {
                diff = diff or (a[i].code xor b[i].code)
            }
            return diff == 0
        }

        /**
         * Best-effort enumeration of the device's IPv4 LAN addresses
         * — useful for the settings UI to show a copy-paste base URL.
         * Skips loopback and link-local (169.254.x.x) addresses; on a
         * Galaxy XR with no Wi-Fi this returns an empty list and the
         * UI falls back to "no network".
         */
        fun lanAddresses(): List<String> = runCatching {
            val out = mutableListOf<String>()
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback || iface.isVirtual) continue
                for (addr in iface.inetAddresses) {
                    if (addr is InetAddress && !addr.isLoopbackAddress && !addr.isLinkLocalAddress) {
                        val host = addr.hostAddress ?: continue
                        // IPv6 literals look ugly in the UI and most
                        // home routers' DHCP gives a routable v4
                        // anyway — surface only v4 for now.
                        if (':' !in host) out += host
                    }
                }
            }
            out
        }.getOrDefault(emptyList())

        private fun escape(s: String): String =
            s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ")
    }

    /**
     * Builder for assembling the registry + auth before [start]. We
     * keep the builder separate from the runtime instance so the
     * registry is final once the server boots — adding a tool while
     * a request is mid-flight would be a race we don't need.
     */
    class Builder {
        private val registry = ToolRegistry()
        private var token: String? = null
        private var name: String = DEFAULT_NAME
        private var version: String = DEFAULT_VERSION

        fun tool(t: Tool): Builder { registry.register(t); return this }
        fun authToken(t: String?): Builder { token = t; return this }
        fun serverName(n: String): Builder { name = n; return this }
        fun serverVersion(v: String): Builder { version = v; return this }

        fun build(): McpServer = McpServer(registry, token, name, version)
    }
}
