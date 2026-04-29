package dev.orcaxr.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [OrcaProfileLoader.flatten]. The flatten path is the gate
 * between bundled OrcaSlicer-style JSON profiles and `set_deserialize_
 * nothrow` on the JNI side: any key NOT in `SAFE_KEYS` is silently
 * dropped, libslic3r falls back to its compiled-in default, and the
 * tuned profile value is lost. Multi-color flush sizing is the live
 * regression case — the 280 mm³ off-diagonal × 0.3 multiplier default
 * inflates the wipe tower 2-3× vs desktop OrcaSlicer.
 */
class OrcaProfileLoaderTest {

    /**
     * `flush_volumes_matrix` and `flush_multiplier` are both `coFloats`
     * vectors per `PrintConfig.cpp:6417-6431`. They must survive the
     * SAFE_KEYS filter, and `jsonValueToString` must produce the
     * comma-joined form that `ConfigOptionFloatsTempl::deserialize`
     * (Config.hpp:870) accepts on the JNI side.
     */
    @Test fun flushVolumesMatrixAndMultiplierSurviveFlatten() {
        val leaf = JSONObject(
            """
            {
                "name": "test_machine",
                "type": "machine",
                "flush_volumes_matrix": ["0", "30", "30", "0"],
                "flush_multiplier": ["1.0"]
            }
            """.trimIndent(),
        )
        val out = OrcaProfileLoader.flatten(leaf, byName = mapOf("test_machine" to leaf))
        assertEquals("0,30,30,0", out["flush_volumes_matrix"])
        assertEquals("1.0", out["flush_multiplier"])
    }

    /**
     * Meta keys (`name`, `type`, `inherits`, etc.) must continue to be
     * stripped — they're book-keeping for the JSON loader, not config
     * options libslic3r recognizes. Regression guard for accidentally
     * widening META_KEYS handling.
     */
    @Test fun metaKeysAreStrippedAlongsideValidConfigKeys() {
        val leaf = JSONObject(
            """
            {
                "name": "test_machine",
                "type": "machine",
                "inherits": "fdm_machine_common",
                "version": "0.0.1",
                "flush_multiplier": ["0.7"]
            }
            """.trimIndent(),
        )
        val out = OrcaProfileLoader.flatten(leaf, byName = mapOf("test_machine" to leaf))
        assertNull("name should be stripped as a META_KEY", out["name"])
        assertNull("type should be stripped as a META_KEY", out["type"])
        assertNull("inherits should be stripped as a META_KEY", out["inherits"])
        assertNull("version should be stripped as a META_KEY", out["version"])
        assertEquals("0.7", out["flush_multiplier"])
    }

    /**
     * Keys NOT in SAFE_KEYS must be dropped silently. This is the
     * defensive whitelist that protects against the
     * ConfigOptionEnumsGeneric / nullable-enum crashes (gotcha #16).
     * If we accidentally promote an unsafe key to SAFE_KEYS, this
     * test won't catch it — but it does catch an accidental REMOVAL
     * of the whitelist gate.
     */
    @Test fun unknownKeysAreDropped() {
        val leaf = JSONObject(
            """
            {
                "name": "test_machine",
                "type": "machine",
                "definitely_not_a_real_orca_key": "42",
                "flush_multiplier": ["0.5"]
            }
            """.trimIndent(),
        )
        val out = OrcaProfileLoader.flatten(leaf, byName = mapOf("test_machine" to leaf))
        assertNull(
            "unknown keys must be dropped to keep set_deserialize_nothrow safe",
            out["definitely_not_a_real_orca_key"],
        )
        assertEquals("0.5", out["flush_multiplier"])
    }

    /**
     * Inheritance chain merge: leaf values must win over parent. This
     * is the core promise of the flatten() path — a bundled machine
     * profile inheriting `fdm_machine_common` overrides the common
     * default for its own keys, and the common default fills in the
     * rest. Regression guard for the merge order in `chain.asReversed()`.
     */
    @Test fun leafValuesOverrideInheritedValues() {
        val parent = JSONObject(
            """
            {
                "name": "fdm_machine_common",
                "type": "machine",
                "instantiation": "false",
                "flush_multiplier": ["0.3"]
            }
            """.trimIndent(),
        )
        val leaf = JSONObject(
            """
            {
                "name": "test_machine",
                "type": "machine",
                "inherits": "fdm_machine_common",
                "flush_multiplier": ["1.0"]
            }
            """.trimIndent(),
        )
        val out = OrcaProfileLoader.flatten(
            leaf,
            byName = mapOf("fdm_machine_common" to parent, "test_machine" to leaf),
        )
        assertEquals("1.0", out["flush_multiplier"])
    }

    /**
     * A 4×4 flush matrix (16 entries) for 4 filaments with 1 nozzle is
     * the BBS / OrcaSlicer canonical size. The CSV must round-trip
     * intact — `WipeTowerIntegration::plan_toolchange` (Print.cpp:3240)
     * indexes `flush_volumes_matrix[from*n + to]`, so any reordering
     * during flatten() would mis-attribute purge volumes between tool
     * pairs.
     */
    @Test fun fourByFourMatrixSurvivesIntact() {
        val matrix = listOf(
            "0", "30", "40", "50",
            "30", "0", "30", "40",
            "40", "30", "0", "30",
            "50", "40", "30", "0",
        )
        val leaf = JSONObject().apply {
            put("name", "test_machine")
            put("type", "machine")
            put("flush_volumes_matrix", org.json.JSONArray(matrix))
        }
        val out = OrcaProfileLoader.flatten(leaf, byName = mapOf("test_machine" to leaf))
        assertEquals(matrix.joinToString(","), out["flush_volumes_matrix"])
    }
}
