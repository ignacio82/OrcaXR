package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Roadmap B13 — pure-JVM tests for the parts of [SettingsBackup] that
 * don't touch Android's Context. The full Context-driven round-trip
 * lives in `androidTest/SettingsBackupInstrumentedTest` because
 * SharedPreferences + DataStore both need a real Android runtime.
 */
class SettingsBackupTest {

    @Test
    fun `DATASTORE_NAMES list matches the source-tree grep tripwire`() {
        // If a new DataStore lands without being added to
        // SettingsBackup.DATASTORE_NAMES, an export silently drops it
        // — and the user's import comes back empty for that store.
        // Walk the source tree, collect every preferencesDataStore("…")
        // call site, and confirm the canonical list covers them.
        val srcRoot = File("src/main/java")
        val collected = mutableSetOf<String>()
        srcRoot.walkTopDown()
            // SettingsBackup.kt's KDoc has illustrative `orcaxr.X` text;
            // skip the file itself so the tripwire only captures real
            // call sites.
            .filter { it.isFile && it.name.endsWith(".kt") && it.name != "SettingsBackup.kt" }
            .forEach { f ->
                val text = f.readText()
                val regex = Regex("""preferencesDataStore\(\s*"([^"]+)"\s*\)""")
                for (m in regex.findAll(text)) collected += m.groupValues[1]
            }
        assertEquals(
            "DATASTORE_NAMES drifted vs source — backup will silently drop new stores. " +
                "Add the missing name(s) to SettingsBackup.DATASTORE_NAMES " +
                "(found in source: $collected, declared: ${SettingsBackup.DATASTORE_NAMES.toSet()}).",
            collected,
            SettingsBackup.DATASTORE_NAMES.toSet(),
        )
    }

    @Test
    fun `encodeSpValue covers every SharedPreferences-supported type`() {
        // The SharedPreferences API only persists six types
        // (Boolean, Int, Long, Float, String, Set<String>). Every one
        // must round-trip through the encoder cleanly so a UserPreferences
        // edit can survive an export+import cycle.
        val cases = listOf(
            true to "bool",
            42 to "int",
            (1234567890123L) to "long",
            3.14f to "float",
            "hello" to "string",
            setOf("a", "b") to "set",
        )
        for ((value, expectedType) in cases) {
            val encoded = SettingsBackup.encodeSpValueForTest(value)
            assertEquals(
                "type tag wrong for $value (${value::class.simpleName})",
                expectedType,
                encoded.optString("type"),
            )
            // value field is type-specific
            when (expectedType) {
                "bool" -> assertEquals(value, encoded.optBoolean("value"))
                "int" -> assertEquals(value, encoded.optInt("value"))
                "long" -> assertEquals(value, encoded.optLong("value"))
                "float" -> assertEquals(
                    (value as Float).toDouble(), encoded.optDouble("value"), 1e-6,
                )
                "string" -> assertEquals(value, encoded.optString("value"))
                "set" -> {
                    val arr = encoded.optJSONArray("value")
                    val collected = (0 until (arr?.length() ?: 0))
                        .map { arr!!.getString(it) }.toSet()
                    assertEquals(value, collected)
                }
            }
        }
    }

    @Test
    fun `encodeSpValue tags unknown types as 'unknown' and preserves toString form`() {
        // Sanity check the fall-through — a value of an unsupported type
        // (e.g. Double, which SharedPreferences doesn't persist) gets
        // tagged "unknown" so the import skips it cleanly instead of
        // silently corrupting the editor.
        val encoded = SettingsBackup.encodeSpValueForTest(2.71828)
        assertEquals("unknown", encoded.optString("type"))
        assertTrue(encoded.optString("value").startsWith("2.71"))
    }

    @Test
    fun `version pin is stable`() {
        // If we bump VERSION, every existing export written before the
        // bump still imports under the V<= n contract. Pinning the
        // current value here forces a deliberate update + migration
        // story when a future change needs a non-additive field.
        assertEquals(1, SettingsBackup.VERSION)
    }
}
