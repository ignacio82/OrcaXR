package dev.orcaxr.core

/** JsonReader owns JSON structure; callers detect duplicate keys. This lexical
 * check rejects token forms its strict mode accepts on some Android releases.
 * Unicode string contents remain untouched; each caller owns its byte limits. */
internal object StrictJsonTokens {
    fun valid(text: String, active: () -> Unit = {}): Boolean {
        // Android JsonReader accepts some non-JSON numbers (for example 1.)
        // even with leniency disabled. Validate lexical tokens independently.
        var offset = 0
        var lastActive = -4096
        fun checkActive() { if (offset - lastActive >= 4096) { active(); lastActive = offset } }
        val number = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
        while (offset < text.length) {
            checkActive()
            when (text[offset]) {
                ' ', '\t', '\r', '\n', '{', '}', '[', ']', ':', ',' -> offset++
                '"' -> {
                    offset++
                    var closed = false
                    while (offset < text.length) {
                        checkActive()
                        val character = text[offset++]
                        if (character == '"') { closed = true; break }
                        if (character.code < 32) return false
                        if (character == '\\') {
                            if (offset >= text.length) return false
                            when(text[offset++]) {
                                '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
                                'u' -> {
                                    if (offset + 4 > text.length) return false
                                    repeat(4) { if (text[offset++] !in "0123456789abcdefABCDEF") return false }
                                }
                                else -> return false
                            }
                        }
                    }
                    if (!closed) return false
                }
                else -> {
                    val start = offset
                    while (offset < text.length && text[offset] !in " \t\r\n{}[]:,\"") { checkActive(); offset++ }
                    val token = text.substring(start, offset)
                    if ((token != "true" && token != "false" && token != "null") && !number.matches(token)) return false
                }
            }
        }
        active()
        return true
    }
}
