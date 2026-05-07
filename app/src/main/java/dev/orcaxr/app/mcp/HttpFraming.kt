package dev.orcaxr.app.mcp

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.nio.charset.StandardCharsets

/**
 * Minimal HTTP/1.1 request reader + response writer. We keep this
 * hand-rolled (instead of pulling in NanoHTTPD or Netty) for two
 * reasons: (a) we only ever speak one route — POST /mcp with a JSON
 * body and a bearer header — and (b) the rest of the stack already
 * deals with raw sockets when it has to (`SubnetScanner.kt`,
 * `MoonrakerClient.isPortOpen`), so the team is comfortable at this
 * layer. ~150 lines total beats a 1 MB transitive dependency.
 *
 * Limits: Content-Length only (no chunked request bodies), 1 MiB max
 * body, header-line cap of 8 KiB. These are loose enough for the
 * largest tool args we'll ever send (a few hundred KB of base64 in the
 * worst case) and tight enough that a malformed client can't OOM us.
 */
internal object HttpFraming {

    private const val MAX_HEADER_BYTES: Int = 8 * 1024
    private const val MAX_BODY_BYTES: Int = 1 * 1024 * 1024

    /**
     * Audit H6 — `extraHeaders` keys are echoed straight into the
     * response, so any caller-controlled value must be validated to
     * prevent header-injection / response-splitting. The regex matches
     * the RFC 7230 token set restricted to portable ASCII; values are
     * checked separately against any CR/LF.
     */
    private val HEADER_NAME_REGEX = Regex("^[A-Za-z0-9-]+$")

    data class Request(
        val method: String,
        val path: String,
        val headers: Map<String, String>,  // header name lowercased
        val body: String,
    )

    /**
     * Read one HTTP request off the socket. Returns null on EOF before
     * any bytes were read (clean close). Throws IOException for
     * protocol-level malformations the caller should respond to with a
     * 400 — we never throw for a request that's well-formed but says
     * something the server can't satisfy.
     */
    @Throws(IOException::class)
    fun readRequest(stream: InputStream): Request? {
        val reader = BufferedReader(InputStreamReader(stream, StandardCharsets.US_ASCII))
        // Request line. readLine on EOF returns null; we treat that as
        // a clean close (the client opened the socket and bailed
        // without sending anything — common for port probes, not an
        // error).
        val requestLine = reader.readLine() ?: return null
        val parts = requestLine.split(' ', limit = 3)
        if (parts.size != 3) {
            throw IOException("Malformed request line: $requestLine")
        }
        val method = parts[0]
        val path = parts[1]
        // parts[2] is the HTTP version; we don't enforce it — both
        // HTTP/1.0 and HTTP/1.1 are fine for our one-shot model.

        val headers = LinkedHashMap<String, String>()
        var headerBytes = 0
        while (true) {
            val line = reader.readLine() ?: throw IOException("Unexpected EOF in headers")
            if (line.isEmpty()) break
            headerBytes += line.length + 2
            if (headerBytes > MAX_HEADER_BYTES) {
                throw IOException("Header section exceeded ${MAX_HEADER_BYTES} bytes")
            }
            val colon = line.indexOf(':')
            if (colon <= 0) continue  // skip malformed continuation lines
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            headers[name] = value
        }

        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        if (contentLength < 0 || contentLength > MAX_BODY_BYTES) {
            throw IOException("Invalid Content-Length: $contentLength")
        }
        val body = if (contentLength == 0) "" else {
            // BufferedReader's already drained the headers above. We
            // can keep reading characters from it for the body — UTF-8
            // through ASCII-decoded BufferedReader is wrong in
            // general, but JSON bodies are tested below for their
            // actual UTF-8 byte length; the protocol layer only cares
            // that what we hand to JSONObject is the same Unicode
            // text the client sent. Switching to a byte-level read
            // here would be cleaner; revisit if we ever ship binary
            // tool args.
            val buf = CharArray(contentLength)
            var off = 0
            while (off < contentLength) {
                val n = reader.read(buf, off, contentLength - off)
                if (n < 0) throw IOException("Unexpected EOF in body at $off/$contentLength")
                off += n
            }
            String(buf, 0, off)
        }

        return Request(method.uppercase(), path, headers, body)
    }

    /**
     * Write a complete HTTP/1.1 response. We always close the
     * connection after one exchange (Connection: close in headers) so
     * the per-request acceptor loop doesn't have to track keepalives.
     * Performance is fine — MCP is request/reply at human-typing rates,
     * not high-throughput.
     */
    @Throws(IOException::class)
    fun writeResponse(
        out: OutputStream,
        statusCode: Int,
        statusText: String,
        contentType: String,
        body: String,
        extraHeaders: Map<String, String> = emptyMap(),
    ) {
        writeResponseBytes(
            out, statusCode, statusText, contentType,
            body.toByteArray(StandardCharsets.UTF_8),
            includeCharsetUtf8 = true,
            extraHeaders = extraHeaders,
        )
    }

    /**
     * Binary response body — used by C9 milestone 2's
     * `GET /resources/<token>.png` route to stream PNG bytes back to
     * the LLM client. We omit the `; charset=utf-8` Content-Type
     * suffix since the body isn't text.
     */
    @Throws(IOException::class)
    fun writeBinaryResponse(
        out: OutputStream,
        statusCode: Int,
        statusText: String,
        contentType: String,
        body: ByteArray,
        extraHeaders: Map<String, String> = emptyMap(),
    ) {
        writeResponseBytes(
            out, statusCode, statusText, contentType, body,
            includeCharsetUtf8 = false,
            extraHeaders = extraHeaders,
        )
    }

    @Throws(IOException::class)
    private fun writeResponseBytes(
        out: OutputStream,
        statusCode: Int,
        statusText: String,
        contentType: String,
        bodyBytes: ByteArray,
        includeCharsetUtf8: Boolean,
        extraHeaders: Map<String, String>,
    ) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(statusCode).append(' ').append(statusText).append("\r\n")
        if (includeCharsetUtf8) {
            sb.append("Content-Type: ").append(contentType).append("; charset=utf-8\r\n")
        } else {
            sb.append("Content-Type: ").append(contentType).append("\r\n")
        }
        sb.append("Content-Length: ").append(bodyBytes.size).append("\r\n")
        sb.append("Connection: close\r\n")
        sb.append("Cache-Control: no-store\r\n")
        // CORS so a browser-hosted MCP client (web LLM playground, the
        // Anthropic web tools console, the user's own browser-side
        // experiments) can reach the server without preflight pain.
        // The on-device server is only ever exposed on the user's LAN,
        // and the auth header check still applies to mutating tools.
        sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n")
        sb.append("Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id\r\n")
        for ((k, v) in extraHeaders) {
            // Audit H6 — defend against response-splitting / header-
            // injection. Names must be portable-ASCII tokens; values
            // may not contain CR or LF (which would otherwise let a
            // caller forge new response headers or even a body).
            if (!HEADER_NAME_REGEX.matches(k)) {
                throw IllegalArgumentException("invalid extraHeader name: $k")
            }
            if (v.contains('\r') || v.contains('\n')) {
                throw IllegalArgumentException("CR/LF in extraHeader value for $k")
            }
            sb.append(k).append(": ").append(v).append("\r\n")
        }
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(StandardCharsets.US_ASCII))
        out.write(bodyBytes)
        out.flush()
    }
}
