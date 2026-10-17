package dev.orcaxr.nativeapp.widget

object SimpleJson {
    fun parse(text: String): Any? {
        var pos = 0
        val len = text.length

        fun skipWs() {
            while (pos < len && text[pos].isWhitespace()) pos++
        }

        fun parseString(): String {
            pos++ // skip leading '"'
            val sb = StringBuilder()
            while (pos < len) {
                val c = text[pos++]
                if (c == '"') return sb.toString()
                if (c == '\\' && pos < len) {
                    when (val esc = text[pos++]) {
                        'u' -> {
                            val hex = text.substring(pos, (pos + 4).coerceAtMost(len))
                            sb.append(hex.toIntOrNull(16)?.toChar() ?: '?')
                            pos += 4
                        }
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000c')
                        else -> sb.append(esc)
                    }
                } else {
                    sb.append(c)
                }
            }
            return sb.toString()
        }

        fun parseNumberOrKeyword(): Any? {
            val start = pos
            while (pos < len && text[pos] !in ",:]} \t\r\n") pos++
            val token = text.substring(start, pos).trim()
            return when (token) {
                "true" -> true
                "false" -> false
                "null" -> null
                else -> token.toLongOrNull() ?: token.toDoubleOrNull() ?: token
            }
        }

        fun parseValue(): Any? {
            skipWs()
            if (pos >= len) return null
            return when (text[pos]) {
                '{' -> {
                    pos++
                    val map = mutableMapOf<String, Any?>()
                    skipWs()
                    while (pos < len && text[pos] != '}') {
                        skipWs()
                        if (text[pos] == ',') { pos++; skipWs() }
                        if (pos >= len || text[pos] == '}') break
                        val key = if (text[pos] == '"') parseString() else ""
                        skipWs()
                        if (pos < len && text[pos] == ':') pos++
                        val value = parseValue()
                        map[key] = value
                        skipWs()
                        if (pos < len && text[pos] == ',') { pos++; skipWs() }
                    }
                    if (pos < len && text[pos] == '}') pos++
                    map
                }
                '[' -> {
                    pos++
                    val list = mutableListOf<Any?>()
                    skipWs()
                    while (pos < len && text[pos] != ']') {
                        skipWs()
                        if (text[pos] == ',') { pos++; skipWs() }
                        if (pos >= len || text[pos] == ']') break
                        list.add(parseValue())
                        skipWs()
                        if (pos < len && text[pos] == ',') { pos++; skipWs() }
                    }
                    if (pos < len && text[pos] == ']') pos++
                    list
                }
                '"' -> parseString()
                else -> parseNumberOrKeyword()
            }
        }

        return parseValue()
    }
}
