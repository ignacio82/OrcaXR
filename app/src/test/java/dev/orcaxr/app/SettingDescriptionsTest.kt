package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap B6 — verify the description data layer covers every key the
 * user-facing print-settings tabs surface today. A drift here means
 * the user opens a tab, taps `?`, and gets nothing.
 *
 * Tripwire-style: when a new SettingNumericEditor is added in
 * UiPanels.kt, this test should fail until SettingDescriptions.byKey
 * grows a matching entry.
 */
class SettingDescriptionsTest {

    /** Keys actively wired into the right-side print-settings UI as
     *  of this commit. Update in lockstep with new tabs / rows. */
    private val keysSurfaced = listOf(
        // Quality
        "layer_height",
        // Speed
        "initial_layer_speed",
        "outer_wall_speed",
        "inner_wall_speed",
        "sparse_infill_speed",
        "internal_solid_infill_speed",
        "support_speed",
        "travel_speed",
        // Support
        "support_threshold_angle",
        "support_top_z_distance",
        "support_interface_top_layers",
    )

    @Test fun every_surfaced_key_has_a_description() {
        for (k in keysSurfaced) {
            val v = SettingDescriptions.forKey(k)
            assertNotNull("missing description for $k", v)
            assertTrue("description blank for $k: \"$v\"", !v.isNullOrBlank())
        }
    }

    @Test fun forKey_returns_null_for_unknown_key() {
        // Unknown keys must return null so the caller hides the `?`
        // chip — surfacing an empty popover would be a worse UX than
        // no chip at all.
        assertNull(SettingDescriptions.forKey("not_a_real_key"))
    }

    @Test fun every_documented_description_is_non_blank() {
        // Defensive: the map can't sneak in an empty string for any
        // key. forKey filters those out to null but the underlying
        // map is the source of truth a future test or UI layer might
        // read directly.
        for ((k, v) in SettingDescriptions.byKey) {
            assertTrue("description blank for $k", v.isNotBlank())
            // Reasonable upper bound — a 320-dp wide popover at
            // typical spatial-panel scale fits ~3 lines of body
            // text. Anything longer is going to wrap awkwardly.
            assertTrue("description for $k longer than 200 chars (${v.length}): $v",
                v.length <= 200)
        }
    }

    @Test fun keys_are_libslic3r_snake_case() {
        // libslic3r config keys are snake_case. A typo like
        // "layerHeight" would silently shadow nothing because forKey
        // does an exact lookup. Lock the convention.
        for (k in SettingDescriptions.byKey.keys) {
            assertTrue("key not snake_case: $k", k == k.lowercase())
            assertTrue("key contains spaces: $k", !k.contains(' '))
        }
    }

    @Test fun map_size_matches_documented_count() {
        // Tripwire: catches accidental duplicate keys collapsing into
        // a single entry, and forces the test author to update this
        // count when a description is added or removed.
        assertEquals(18, SettingDescriptions.byKey.size)
    }
}
