package dev.orcaxr.nativeapp.mcp

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * In-memory thread-safe ring buffer capturing recent application logs,
 * Moonraker transport events, print workflow steps, and slicing status
 * so AI agents can debug directly via MCP without needing logcat or screenshots.
 */
object McpLogBuffer {
    private const val CAPACITY = 400
    private val entries = ArrayDeque<String>(CAPACITY)
    private val dateFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    @Synchronized
    fun log(tag: String, message: String) {
        val time = dateFormat.format(Date())
        val formatted = "$time [$tag] $message"
        if (entries.size >= CAPACITY) {
            entries.removeFirst()
        }
        entries.addLast(formatted)
    }

    @Synchronized
    fun get(filter: String? = null, limit: Int = 50): List<String> {
        val clampedLimit = limit.coerceIn(1, CAPACITY)
        val filtered = if (filter.isNullOrBlank()) {
            entries.toList()
        } else {
            val needle = filter.lowercase()
            entries.filter { it.lowercase().contains(needle) }
        }
        return filtered.takeLast(clampedLimit)
    }

    @Synchronized
    fun clear() {
        entries.clear()
    }
}
