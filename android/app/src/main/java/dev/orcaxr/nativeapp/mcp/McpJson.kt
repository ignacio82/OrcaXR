package dev.orcaxr.nativeapp.mcp

import dev.orcaxr.nativeapp.widget.SimpleJson

/**
 * Platform-independent JSON parser and serializer for the MCP protocol.
 * Runs identically on desktop JVM unit tests and Android runtime without
 * depending on platform org.json stubs or third-party dependencies.
 */
object McpJson {
    fun parse(text: String): Any? = SimpleJson.parse(text)

    fun parseObject(text: String): Map<String, Any?>? {
        val parsed = parse(text)
        @Suppress("UNCHECKED_CAST")
        return parsed as? Map<String, Any?>
    }

    fun stringify(value: Any?, indent: Int = 0): String {
        val sb = StringBuilder()
        serialize(value, sb, indent, 0)
        return sb.toString()
    }

    private fun serialize(value: Any?, sb: StringBuilder, indent: Int, depth: Int) {
        val pretty = indent > 0
        when (value) {
            null -> sb.append("null")
            is Boolean -> sb.append(if (value) "true" else "false")
            is Number -> sb.append(value.toString())
            is CharSequence -> {
                sb.append('"')
                for (i in 0 until value.length) {
                    when (val c = value[i]) {
                        '\\' -> sb.append("\\\\")
                        '"' -> sb.append("\\\"")
                        '\n' -> sb.append("\\n")
                        '\r' -> sb.append("\\r")
                        '\t' -> sb.append("\\t")
                        '\b' -> sb.append("\\b")
                        '\u000c' -> sb.append("\\f")
                        else -> {
                            if (c.code in 0x00..0x1F) {
                                sb.append("\\u%04x".format(c.code))
                            } else {
                                sb.append(c)
                            }
                        }
                    }
                }
                sb.append('"')
            }
            is Map<*, *> -> {
                if (value.isEmpty()) {
                    sb.append("{}")
                    return
                }
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    if (pretty) {
                        sb.append('\n')
                        sb.append(" ".repeat((depth + 1) * indent))
                    }
                    serialize(k.toString(), sb, indent, depth + 1)
                    sb.append(':')
                    if (pretty) sb.append(' ')
                    serialize(v, sb, indent, depth + 1)
                    first = false
                }
                if (pretty) {
                    sb.append('\n')
                    sb.append(" ".repeat(depth * indent))
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                val list = value.toList()
                if (list.isEmpty()) {
                    sb.append("[]")
                    return
                }
                sb.append('[')
                var first = true
                for (item in list) {
                    if (!first) sb.append(',')
                    if (pretty) {
                        sb.append('\n')
                        sb.append(" ".repeat((depth + 1) * indent))
                    }
                    serialize(item, sb, indent, depth + 1)
                    first = false
                }
                if (pretty) {
                    sb.append('\n')
                    sb.append(" ".repeat(depth * indent))
                }
                sb.append(']')
            }
            is Array<*> -> serialize(value.toList(), sb, indent, depth)
            else -> serialize(value.toString(), sb, indent, depth)
        }
    }
}
