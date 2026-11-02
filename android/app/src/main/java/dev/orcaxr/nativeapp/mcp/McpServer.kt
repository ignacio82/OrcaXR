package dev.orcaxr.nativeapp.mcp

import kotlinx.coroutines.runBlocking
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Embedded HTTP/SSE and WebSocket server for the Model Context Protocol.
 * Supports:
 * - WebSocket transport: ws://127.0.0.1:8765/mcp/ws
 * - Server-Sent Events (SSE) transport: http://127.0.0.1:8765/mcp/sse
 * - Direct HTTP JSON-RPC POST: http://127.0.0.1:8765/mcp or /mcp/message
 * - Bearer capability token validation on all endpoints
 */
class McpServer(
    private val auth: McpAuth,
    private val jsonRpc: McpJsonRpc,
) : AutoCloseable {
    private val isRunning = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private val threadPool = Executors.newCachedThreadPool { task ->
        Thread(task, "OrcaXR-McpWorker").apply { isDaemon = true }
    }
    private val activeConnections = AtomicInteger(0)
    private val sseSessions = ConcurrentHashMap<String, SseSession>()

    val port: Int get() = serverSocket?.localPort ?: auth.serverPort
    val running: Boolean get() = isRunning.get()
    val clientCount: Int get() = activeConnections.get()

    private class SseSession(
        val id: String,
        val output: OutputStream,
    ) {
        fun sendEvent(event: String, data: String) {
            synchronized(output) {
                output.write("event: $event\r\ndata: $data\r\n\r\n".toByteArray(Charsets.UTF_8))
                output.flush()
            }
        }
    }

    @Synchronized
    fun start(): Boolean {
        if (isRunning.get()) return true
        val host = if (auth.allowLan) "0.0.0.0" else "127.0.0.1"
        val port = auth.serverPort
        return try {
            val socket = ServerSocket()
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(InetAddress.getByName(host), port))
            serverSocket = socket
            isRunning.set(true)
            threadPool.execute { acceptLoop(socket) }
            logI("McpServer started on $host:$port (allowLan=${auth.allowLan})")
            true
        } catch (e: Exception) {
            logE("Failed to start McpServer on $host:$port", e)
            false
        }
    }

    @Synchronized
    fun stop() {
        if (!isRunning.compareAndSet(true, false)) return
        try {
            serverSocket?.close()
        } catch (_: Exception) {}
        serverSocket = null
        sseSessions.clear()
        logI("McpServer stopped")
    }

    override fun close() {
        stop()
        threadPool.shutdownNow()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (isRunning.get() && !socket.isClosed) {
            try {
                val client = socket.accept()
                activeConnections.incrementAndGet()
                threadPool.execute {
                    try {
                        handleClient(client)
                    } catch (e: Exception) {
                        if (isRunning.get() && e !is SocketException) {
                            logW("Error handling MCP client: ${e.message}")
                        }
                    } finally {
                        activeConnections.decrementAndGet()
                        try { client.close() } catch (_: Exception) {}
                    }
                }
            } catch (e: Exception) {
                if (!isRunning.get() || socket.isClosed) break
                logW("Error accepting client: ${e.message}")
            }
        }
    }

    private fun handleClient(client: Socket) {
        client.soTimeout = 0 // Keep-alive for SSE and WebSocket
        val input = BufferedInputStream(client.getInputStream())
        val output = BufferedOutputStream(client.getOutputStream())

        // Read HTTP request line
        val requestLine = readLine(input) ?: return
        val parts = requestLine.split(" ")
        if (parts.size < 2) return
        val method = parts[0].uppercase()
        val fullPath = parts[1]

        // Parse path and query params
        val pathParts = fullPath.split("?", limit = 2)
        val path = pathParts[0]
        val query = if (pathParts.size > 1) pathParts[1] else ""
        val queryParams = parseQuery(query)

        // Read headers
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) {
                val headerName = line.substring(0, colon).trim().lowercase()
                val headerVal = line.substring(colon + 1).trim()
                headers[headerName] = headerVal
            }
        }

        // Handle CORS preflight
        if (method == "OPTIONS") {
            writeResponse(
                output,
                statusCode = 204,
                statusText = "No Content",
                contentType = "text/plain",
                body = ByteArray(0),
            )
            return
        }

        // Authenticate
        val authHeader = headers["authorization"]
        val tokenCandidate = if (!authHeader.isNullOrBlank()) {
            authHeader
        } else {
            queryParams["token"]
        }

        if (!auth.validateToken(tokenCandidate)) {
            writeResponse(
                output,
                statusCode = 401,
                statusText = "Unauthorized",
                contentType = "text/plain",
                body = "Unauthorized\n".toByteArray(Charsets.UTF_8),
            )
            return
        }

        // Routing
        when {
            path == "/mcp/status" && method == "GET" -> {
                val status = mapOf(
                    "status" to "ok",
                    "server" to "OrcaXR Android MCP",
                    "version" to "0.1.0",
                    "active_connections" to activeConnections.get(),
                )
                val bytes = McpJson.stringify(status, indent = 2).toByteArray(Charsets.UTF_8)
                writeResponse(output, 200, "OK", "application/json", bytes)
            }
            path == "/mcp/sse" && method == "GET" -> {
                handleSse(output)
            }
            (path == "/mcp" || path == "/mcp/message") && method == "POST" -> {
                handleHttpPostMessage(input, output, headers, queryParams)
            }
            (path == "/mcp/ws" || headers["upgrade"]?.equals("websocket", ignoreCase = true) == true) -> {
                handleWebSocket(input, output, headers)
            }
            else -> {
                val notFound = "Not Found: $path\n".toByteArray(Charsets.UTF_8)
                writeResponse(output, 404, "Not Found", "text/plain", notFound)
            }
        }
    }

    private fun handleSse(output: OutputStream) {
        val sessionId = UUID.randomUUID().toString()
        output.write(
            ("HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream\r\n" +
                "Cache-Control: no-cache\r\n" +
                "Connection: keep-alive\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "\r\n").toByteArray(Charsets.UTF_8),
        )
        output.flush()

        val session = SseSession(sessionId, output)
        sseSessions[sessionId] = session

        // Emit initial endpoint event pointing client to the message POST endpoint
        session.sendEvent("endpoint", "/mcp/message?sessionId=$sessionId")

        try {
            // Keep connection alive with periodic comments
            while (isRunning.get()) {
                Thread.sleep(15_000)
                synchronized(output) {
                    output.write(":\r\n\r\n".toByteArray(Charsets.UTF_8))
                    output.flush()
                }
            }
        } catch (_: Exception) {
        } finally {
            sseSessions.remove(sessionId)
        }
    }

    private fun handleHttpPostMessage(
        input: InputStream,
        output: OutputStream,
        headers: Map<String, String>,
        queryParams: Map<String, String>,
    ) {
        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        if (contentLength <= 0 || contentLength > MAX_PAYLOAD_BYTES) {
            val err = "Payload too large or invalid Content-Length\n".toByteArray(Charsets.UTF_8)
            writeResponse(output, 400, "Bad Request", "text/plain", err)
            return
        }

        val bodyBytes = ByteArray(contentLength)
        var readTotal = 0
        while (readTotal < contentLength) {
            val r = input.read(bodyBytes, readTotal, contentLength - readTotal)
            if (r < 0) break
            readTotal += r
        }
        val rawMessage = String(bodyBytes, Charsets.UTF_8)

        val responseJson = runBlocking {
            jsonRpc.handleMessage(rawMessage)
        }

        val sessionId = queryParams["sessionId"]
        val sseSession = if (sessionId != null) sseSessions[sessionId] else null

        if (sseSession != null && responseJson != null) {
            sseSession.sendEvent("message", responseJson)
            writeResponse(output, 202, "Accepted", "text/plain", ByteArray(0))
        } else if (responseJson != null) {
            val respBytes = responseJson.toByteArray(Charsets.UTF_8)
            writeResponse(output, 200, "OK", "application/json", respBytes)
        } else {
            writeResponse(output, 204, "No Content", "text/plain", ByteArray(0))
        }
    }

    private fun handleWebSocket(
        input: InputStream,
        output: OutputStream,
        headers: Map<String, String>,
    ) {
        val clientKey = headers["sec-websocket-key"]
        if (clientKey.isNullOrBlank()) {
            val err = "Missing Sec-WebSocket-Key\n".toByteArray(Charsets.UTF_8)
            writeResponse(output, 400, "Bad Request", "text/plain", err)
            return
        }

        val acceptKey = computeWebSocketAccept(clientKey)
        val handshake = "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $acceptKey\r\n" +
            "\r\n"
        output.write(handshake.toByteArray(Charsets.UTF_8))
        output.flush()

        // Read/write WebSocket frames
        while (isRunning.get()) {
            val frame = readWebSocketFrame(input) ?: break
            when (frame.opcode) {
                OPCODE_TEXT -> {
                    val message = String(frame.payload, Charsets.UTF_8)
                    val response = runBlocking {
                        jsonRpc.handleMessage(message)
                    }
                    if (response != null) {
                        sendWebSocketTextFrame(output, response)
                    }
                }
                OPCODE_PING -> {
                    sendWebSocketPongFrame(output, frame.payload)
                }
                OPCODE_CLOSE -> {
                    sendWebSocketCloseFrame(output)
                    break
                }
            }
        }
    }

    private class WsFrame(val opcode: Int, val payload: ByteArray)

    private fun readWebSocketFrame(input: InputStream): WsFrame? {
        val b0 = input.read()
        if (b0 < 0) return null
        val b1 = input.read()
        if (b1 < 0) return null

        val opcode = b0 and 0x0F
        val isMasked = (b1 and 0x80) != 0
        var payloadLen = (b1 and 0x7F).toLong()

        if (payloadLen == 126L) {
            val b2 = input.read()
            val b3 = input.read()
            if (b2 < 0 || b3 < 0) return null
            payloadLen = ((b2 and 0xFF) shl 8 or (b3 and 0xFF)).toLong()
        } else if (payloadLen == 127L) {
            var len = 0L
            for (i in 0 until 8) {
                val b = input.read()
                if (b < 0) return null
                len = (len shl 8) or (b and 0xFF).toLong()
            }
            payloadLen = len
        }

        if (payloadLen > MAX_PAYLOAD_BYTES) {
            logW("WebSocket frame payload too large: $payloadLen bytes")
            return null
        }

        val maskKey = ByteArray(4)
        if (isMasked) {
            var read = 0
            while (read < 4) {
                val r = input.read(maskKey, read, 4 - read)
                if (r < 0) return null
                read += r
            }
        }

        val payload = ByteArray(payloadLen.toInt())
        var readTotal = 0
        while (readTotal < payload.size) {
            val r = input.read(payload, readTotal, payload.size - readTotal)
            if (r < 0) return null
            readTotal += r
        }

        if (isMasked) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            }
        }

        return WsFrame(opcode, payload)
    }

    private fun sendWebSocketTextFrame(output: OutputStream, text: String) {
        val payload = text.toByteArray(Charsets.UTF_8)
        synchronized(output) {
            output.write(0x81) // FIN + text opcode
            writeWebSocketLength(output, payload.size)
            output.write(payload)
            output.flush()
        }
    }

    private fun sendWebSocketPongFrame(output: OutputStream, payload: ByteArray) {
        synchronized(output) {
            output.write(0x8A) // FIN + pong opcode
            writeWebSocketLength(output, payload.size)
            output.write(payload)
            output.flush()
        }
    }

    private fun sendWebSocketCloseFrame(output: OutputStream) {
        synchronized(output) {
            output.write(0x88) // FIN + close opcode
            output.write(0x00) // length 0
            output.flush()
        }
    }

    private fun writeWebSocketLength(output: OutputStream, length: Int) {
        when {
            length < 126 -> output.write(length)
            length <= 65535 -> {
                output.write(126)
                output.write((length shr 8) and 0xFF)
                output.write(length and 0xFF)
            }
            else -> {
                output.write(127)
                for (i in 7 downTo 0) {
                    output.write(((length.toLong() shr (i * 8)) and 0xFF).toInt())
                }
            }
        }
    }

    private fun computeWebSocketAccept(key: String): String {
        val input = key.trim() + WEBSOCKET_MAGIC_GUID
        val sha1 = MessageDigest.getInstance("SHA-1").digest(input.toByteArray(Charsets.ISO_8859_1))
        return Base64.getEncoder().encodeToString(sha1)
    }

    private fun writeResponse(
        output: OutputStream,
        statusCode: Int,
        statusText: String,
        contentType: String,
        body: ByteArray,
    ) {
        val headers = "HTTP/1.1 $statusCode $statusText\r\n" +
            "Content-Type: $contentType\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Headers: Authorization, Content-Type\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        output.write(headers.toByteArray(Charsets.UTF_8))
        if (body.isNotEmpty()) output.write(body)
        output.flush()
    }

    private fun readLine(input: InputStream): String? {
        val baos = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) {
                if (baos.size() == 0) return null
                break
            }
            if (b == '\n'.code) break
            if (b != '\r'.code) baos.write(b)
        }
        return baos.toString(Charsets.UTF_8.name())
    }

    private fun parseQuery(query: String): Map<String, String> {
        if (query.isEmpty()) return emptyMap()
        val result = mutableMapOf<String, String>()
        query.split("&").forEach { pair ->
            val eq = pair.indexOf('=')
            if (eq > 0) {
                val k = pair.substring(0, eq)
                val v = pair.substring(eq + 1)
                result[k] = v
            }
        }
        return result
    }

    companion object {
        private const val TAG = "OrcaXR-McpServer"
        private const val WEBSOCKET_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 // 4 MB
        private const val OPCODE_TEXT = 1
        private const val OPCODE_CLOSE = 8
        private const val OPCODE_PING = 9

        private fun logI(msg: String) {
            try { android.util.Log.i(TAG, msg) } catch (_: Throwable) { println("[$TAG] $msg") }
        }

        private fun logW(msg: String) {
            try { android.util.Log.w(TAG, msg) } catch (_: Throwable) { System.err.println("[$TAG] WARN: $msg") }
        }

        private fun logE(msg: String, tr: Throwable? = null) {
            try { android.util.Log.e(TAG, msg, tr) } catch (_: Throwable) { System.err.println("[$TAG] ERROR: $msg ${tr?.message ?: ""}") }
        }
    }
}
