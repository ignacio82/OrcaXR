package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** The production browser's artifact summaries (`gcode-summary-vectors.json`,
 * from `GcodeArtifactSummary.ts`) through the real JNI session, the generated
 * validator and the Kotlin types: each artifact's bytes decoded as the app
 * decodes a file, sealed, and stated and worded exactly as the browser does. */
@RunWith(AndroidJUnit4::class)
class GcodeSummaryTest {
    private fun bytes(parts: JSONArray): ByteArray = ByteArrayOutputStream().apply {
        for (i in 0 until parts.length()) {
            val part = parts.getJSONObject(i)
            when {
                part.has("text") -> write(part.getString("text").toByteArray())
                part.has("repeat") -> write(part.getString("repeat").repeat(part.getInt("times")).toByteArray())
                part.has("repeatBytes") -> {
                    val unit = part.getJSONArray("repeatBytes").let { list -> ByteArray(list.length()) { list.getInt(it).toByte() } }
                    repeat(part.getInt("times")) { write(unit) }
                }
                else -> part.getJSONArray("bytes").let { list -> for (b in 0 until list.length()) write(list.getInt(b)) }
            }
        }
    }.toByteArray()

    @Test fun browserSummariesCrossTheRealJniBoundary() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val corpusJson = context.assets.open("gcode-summary-vectors.json").bufferedReader().use { it.readText() }
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        // The corpus writes numbers as JavaScript does ("-0" kept): the same double, sign and all.
        fun same(actual: Double?, expected: JSONObject, key: String, label: String) = check(
            if (expected.has(key)) actual != null && java.lang.Double.compare(actual, expected.getString(key).toDouble()) == 0 else actual == null,
            "$label.$key",
        )
        fun same(actual: String?, expected: JSONObject, key: String, label: String) =
            check(actual == expected.optString(key).takeIf { expected.has(key) }, "$label.$key")
        val cases = JSONObject(corpusJson).getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val units = GcodeSession.decodeUtf8(bytes(case.getJSONArray("parts")))
            val statement = GcodeSession(units.size).use { session ->
                var at = 0
                while (at < units.size) {
                    val count = minOf(GcodeLayout.MAX_CHUNK_UNITS, units.size - at)
                    session.append(at, units.copyOfRange(at, at + count))
                    at += count
                }
                session.seal()
                session.summary()
            }
            val expected = case.getJSONObject("summary")
            val summary = statement.summary
            check(summary.empty == expected.getBoolean("empty"), "$name.empty")
            same(summary.totalWeightG, expected, "totalWeightG", name)
            same(summary.totalCost, expected, "totalCost", name)
            same(summary.toolChanges, expected, "toolChanges", name)
            same(summary.layerCount, expected, "layerCount", name)
            same(summary.estimatedSeconds, expected, "estimatedSeconds", name)
            same(summary.firstLayerSeconds, expected, "firstLayerSeconds", name)
            val tools = expected.getJSONArray("perTool")
            check(summary.perTool.size == tools.length(), "$name.perTool")
            summary.perTool.forEachIndexed { index, tool ->
                val want = tools.getJSONObject(index)
                val label = "$name.perTool[$index]"
                check(tool.toolIndex == want.getInt("toolIndex"), "$label.toolIndex")
                same(tool.lengthMm, want, "lengthMm", label)
                same(tool.volumeCm3, want, "volumeCm3", label)
                same(tool.weightG, want, "weightG", label)
                same(tool.colorHex, want, "colorHex", label)
                same(tool.material, want, "material", label)
            }
            val description = case.getJSONObject("description")
            check(statement.text.totals == description.getString("totals"), "$name.totals")
            val lines = description.getJSONArray("tools")
            check(statement.text.tools.size == lines.length(), "$name.tools")
            statement.text.tools.forEachIndexed { index, line ->
                val want = lines.getJSONObject(index)
                check(line.toolIndex == want.getInt("toolIndex") && line.text == want.getString("text"), "$name.tools[$index]")
                same(line.colorHex, want, "colorHex", "$name.tools[$index]")
            }
        }
        // Every field of every artifact and panel line was compared.
        assertEquals(4040L, checks)
    }
}
