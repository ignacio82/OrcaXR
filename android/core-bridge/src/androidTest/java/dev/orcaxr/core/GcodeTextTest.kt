package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The production browser G-code document corpus through the real JNI boundary,
 * Kotlin shape validation and relational checks. */
@RunWith(AndroidJUnit4::class)
class GcodeTextTest {
    private fun text(value: Any): String = when (value) {
        is String -> value
        is JSONArray -> String(CharArray(value.length()) { value.getInt(it).toChar() })
        else -> error("text expected")
    }
    private fun number(value: Any): Double = when (value) {
        is Number -> value.toDouble()
        "NaN" -> Double.NaN
        "-Infinity" -> Double.NEGATIVE_INFINITY
        else -> error("number expected")
    }
    private fun open(source: String): GcodeSession = GcodeSession(source.length).also { session ->
        var offset = 0
        // Odd chunks split surrogate pairs and lines across appends.
        while (offset < source.length) {
            val end = minOf(source.length, offset + 4093)
            session.append(offset, source.substring(offset, end).toCharArray())
            offset = end
        }
        session.seal()
    }

    @Test fun browserDocumentVectorsCrossTheRealJniBoundary() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val corpus = JSONObject(
            context.assets.open("gcode-document-vectors.json").bufferedReader().use { it.readText() },
        ).getJSONArray("cases")
        var windows = 0
        var searches = 0
        for (i in 0 until corpus.length()) {
            val case = corpus.getJSONObject(i)
            val name = case.getString("name")
            open(text(case.get("source"))).use { session ->
                val cases = case.getJSONArray("windows")
                for (w in 0 until cases.length()) {
                    val window = cases.getJSONObject(w)
                    val result = session.textWindow(number(window.get("from")), number(window.get("count")))
                    assertEquals(name, case.getInt("lineCount"), result.lineCount)
                    val lines = window.getJSONArray("lines")
                    assertEquals(name, lines.length(), result.lines.size)
                    for (l in 0 until lines.length()) {
                        val expected = lines.getJSONObject(l)
                        assertEquals(name, expected.getInt("number"), result.lines[l].number)
                        assertEquals(name, text(expected.get("text")), result.lines[l].text)
                    }
                    windows++
                }
                val queries = case.getJSONArray("searches")
                for (s in 0 until queries.length()) {
                    val search = queries.getJSONObject(s)
                    val result = session.search(text(search.get("query")), search.getInt("limit"))
                    val expected = search.getJSONArray("lineNumbers")
                    assertEquals(name, List(expected.length()) { expected.getInt(it) }, result.lineNumbers)
                    assertEquals(name, search.getBoolean("truncated"), result.truncated)
                    searches++
                }
            }
        }
        assertEquals(1562, windows)
        assertEquals(19035, searches)
    }

    @Test fun refusalsLeaveTheSessionUsableAndCloseIsFinal() {
        val source = "G1 X1\n".repeat(2_000)
        open(source).use { session ->
            val error = assertThrows(IllegalStateException::class.java) {
                session.textWindow(1.0, (GcodeLayout.MAX_TEXT_WINDOW_LINES + 1).toDouble())
            }
            assertEquals("resource_limit", error.message)
            assertThrows(IllegalArgumentException::class.java) {
                session.search("G1", GcodeLayout.MAX_SEARCH_LIMIT + 1)
            }
            // A native refusal is not a broken response: the session stays open.
            val exact = session.search("g1", 2_000)
            assertEquals(2_000, exact.lineNumbers.size)
            assertTrue("exactly the limit is complete", !exact.truncated)
            assertEquals(2_000, session.textWindow(1999.0, 5.0).lineCount)
            session.close()
            assertThrows(IllegalStateException::class.java) { session.search("G1") }
        }
    }
}
