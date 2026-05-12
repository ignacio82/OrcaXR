package dev.orcaxr.app.mcp

/**
 * Parser for the Quick-Share / clipboard / SMS-style snippet that
 * `McpServerCard.buildShareSnippet` builds on the XR side. The
 * canonical form is:
 *
 *   OrcaXR MCP server (running on my Android XR headset).
 *
 *   Endpoint:
 *     http://192.168.1.42:7080/mcp
 *   Bearer token (Authorization: Bearer …):
 *     <32-char alphanumeric>
 *
 * but real-world cleartext tends to lose its formatting once it has
 * passed through a Quick Share preview, an SMS, or a clipboard with
 * trim-on-paste. The parser is therefore tolerant of:
 *
 *   - Surrounding chrome (signature lines, instructions to register
 *     with `claude mcp add …`).
 *   - Indentation, extra whitespace, single-line concatenation of the
 *     URL and token on one line.
 *   - Endpoint URLs without `/mcp` (we add it back).
 *
 * It rejects any text that does not contain BOTH (a) a parseable
 * `http(s)://…` URL pointing at port-style host:port and (b) a 24-128
 * char alphanumeric token. The dual requirement is what keeps a
 * stray Bambu Handy paste from being misread as an MCP grant.
 *
 * Returns null on no-match; the caller decides what to do.
 */
object McpShareSnippet {

    /**
     * Magic substring proving the sender intended this as an OrcaXR
     * MCP grant. Without it we won't pull URL + token out of arbitrary
     * shared text, even if they look right — the failure mode of
     * "user shared a regular http link with a sentence and we
     * silently rewrote their remote-MCP config" would be terrible.
     */
    private const val SIGNATURE = "OrcaXR MCP server"

    /** http(s) URL with explicit host:port — anything without an
     *  explicit port is unlikely to be the MCP server (its default
     *  is :7080). Path is optional and not captured (we re-attach
     *  /mcp ourselves). */
    private val URL_REGEX =
        Regex("""https?://[A-Za-z0-9.\-_]+:\d{2,5}(?:/[^\s]*)?""")

    /** 24 - 128 alphanumeric chars. The bearer the XR card generates
     *  is exactly 32, but we leave headroom for future rotations to
     *  longer keys without breaking the parser. */
    private val TOKEN_REGEX = Regex("""\b[A-Za-z0-9]{24,128}\b""")

    /**
     * Parse [text] as an OrcaXR MCP grant. Requires the [SIGNATURE]
     * substring; returns the URL+token pair if both can be extracted.
     */
    fun parse(text: String?): RemoteMcpEndpoint? {
        if (text.isNullOrBlank()) return null
        if (!text.contains(SIGNATURE, ignoreCase = false)) return null

        val urlMatch = URL_REGEX.find(text) ?: return null
        var url = urlMatch.value
        // Normalize: append /mcp if the user shared an "endpoint root"
        // URL. The MCP server only listens on /mcp, so this matches the
        // canonical format the share button emits.
        if (!url.endsWith("/mcp")) {
            // Strip a trailing slash before appending so we don't
            // produce //mcp.
            url = url.trimEnd('/') + "/mcp"
        }

        // Look for tokens AFTER the URL match, since the snippet
        // format always lists the token below the endpoint. This
        // dodges the false positive of treating a long alphanumeric
        // chunk in the preamble (e.g. a build hash) as the bearer.
        val haystack = text.substring(urlMatch.range.last + 1)
        // Skip "Bearer" itself if it appears as a literal word — it
        // matches \b[A-Za-z0-9]{24,128}\b only if 24+ chars long, so
        // we're safe — but skip any tokens that match a URL shape
        // (just in case someone pastes the URL twice).
        val token = TOKEN_REGEX.findAll(haystack)
            .map { it.value }
            .firstOrNull { candidate ->
                // Reject candidates that are part of a URL we already
                // extracted (defensive against a multi-line snippet
                // where the URL appears below the token).
                candidate !in urlMatch.value
            } ?: return null

        return RemoteMcpEndpoint(
            url = url,
            token = token,
            label = RemoteMcpStore.defaultLabelForUrl(url),
            receivedAt = System.currentTimeMillis(),
        )
    }
}
