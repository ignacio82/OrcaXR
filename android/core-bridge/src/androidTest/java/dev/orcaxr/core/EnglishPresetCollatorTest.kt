package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The device's ICU English collator orders preset text as the browser's
 * `localeCompare(…, 'en')` does (`preset-catalog-vectors.json`'s pairs), and
 * builds the real catalog in the browser's preset order. */
@RunWith(AndroidJUnit4::class)
class EnglishPresetCollatorTest {
    private val corpus by lazy {
        JSONObject(
            InstrumentationRegistry.getInstrumentation().context.assets.open("preset-catalog-vectors.json")
                .bufferedReader().use { it.readText() },
        )
    }

    @Test fun ordersPresetTextAsTheBrowser() {
        val pairs = JSONArray(corpus.getString("collationJson"))
        val collator = EnglishPresetCollator()
        for (i in 0 until pairs.length()) {
            val pair = pairs.getJSONArray(i)
            val left = pair.getString(0)
            val right = pair.getString(1)
            assertEquals("$left | $right", pair.getInt(2), Integer.signum(collator.compare(left.toCharArray(), right.toCharArray())))
        }
        assertTrue(pairs.length() > 0)
    }

    @Test fun buildsTheBundledCatalogInTheBrowsersOrder() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val bytes = context.assets.open("catalog.json").use { it.readBytes() }
        val real = corpus.getJSONObject("real")
        val expected = JSONArray(real.getString("profilesJson"))
        ProfileCatalogs.build(bytes).use { catalog ->
            assertEquals(JSONArray(real.getString("diagnosticsJson")).length().toLong(), catalog.diagnosticCount())
            assertEquals(expected.length().toLong(), catalog.profileCount())
            for (i in 0 until expected.length()) {
                val profile = catalog.profile(i.toLong())
                assertEquals(expected.getJSONObject(i).getString("id"), String(CharArray(profile.id.size) { profile.id[it].toChar() }))
            }
        }
    }
}
