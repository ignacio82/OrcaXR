package dev.orcaxr.core

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** One readable source line. [text] keeps every UTF-16 unit, including lone
 * surrogates, and excludes the newline and one trailing carriage return (a
 * second one before it remains). */
data class GcodeTextLine(val number: Int, val text: String)

/** Lines from one sealed source; [lineCount] is the whole program's count. */
data class GcodeTextWindow(val lineCount: Int, val lines: List<GcodeTextLine>)

/** Matching line numbers in order. [truncated] means at least one further line
 * matched beyond the requested limit; exactly `limit` matches is complete. */
data class GcodeTextSearch(val lineNumbers: List<Int>, val truncated: Boolean)

/** Relational checks after the generated shape validators. The native core is
 * the computation authority; these reject responses no correct core produces. */
internal object GcodeText {
    private fun text(units: JSONArray, active: () -> Unit): String {
        val chars = CharArray(units.length())
        for (i in chars.indices) {
            if (i and 4095 == 0) active()
            chars[i] = units.getInt(i).toChar()
        }
        return String(chars)
    }

    fun window(
        value: JSONObject,
        from: Double,
        count: Double,
        sourceUnits: Int,
        knownLineCount: Int,
        active: () -> Unit,
    ): GcodeTextWindow {
        val lineCount = value.getInt("lineCount")
        require(lineCount <= max(1, sourceUnits)) { "Invalid G-code text window" }
        require(knownLineCount == 0 || lineCount == knownLineCount) { "Invalid G-code text window" }
        // The browser viewer's clamping, recomputed independently of the core.
        val expected = if (!from.isFinite() || !count.isFinite() || count <= 0.0) IntRange.EMPTY else {
            val start = max(1.0, min(floor(from), lineCount.toDouble()))
            val end = min(lineCount.toDouble(), start + floor(count) - 1.0)
            if (end < start) IntRange.EMPTY else start.toInt()..end.toInt()
        }
        val lines = value.getJSONArray("lines")
        val size = if (expected.isEmpty()) 0 else expected.last - expected.first + 1
        require(lines.length() == size) { "Invalid G-code text window" }
        var units = 0L
        val result = ArrayList<GcodeTextLine>(lines.length())
        for ((i, number) in expected.withIndex()) {
            val line = lines.getJSONObject(i)
            require(line.getInt("number") == number) { "Invalid G-code text window" }
            val content = text(line.getJSONArray("text"), active)
            units += content.length
            require(units <= GcodeLayout.MAX_TEXT_WINDOW_UNITS) { "Invalid G-code text window" }
            // Only one carriage return before the newline is dropped, so a line
            // ending "\r\r\n" keeps one; no line holds a newline.
            require('\n' !in content) { "Invalid G-code text window" }
            result += GcodeTextLine(number, content)
        }
        return GcodeTextWindow(lineCount, result)
    }

    fun search(value: JSONObject, limit: Int, sourceUnits: Int, knownLineCount: Int): GcodeTextSearch {
        val numbers = value.getJSONArray("lineNumbers")
        val truncated = value.getBoolean("truncated")
        val bound = if (knownLineCount > 0) knownLineCount else max(1, sourceUnits)
        require(numbers.length() <= limit && (!truncated || numbers.length() == limit)) {
            "Invalid G-code text search"
        }
        val result = ArrayList<Int>(numbers.length())
        var previous = 0
        for (i in 0 until numbers.length()) {
            val number = numbers.getInt(i)
            require(number > previous && number <= bound) { "Invalid G-code text search" }
            result += number
            previous = number
        }
        return GcodeTextSearch(result, truncated)
    }
}
