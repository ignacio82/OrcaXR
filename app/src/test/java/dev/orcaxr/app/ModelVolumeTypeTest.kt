package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Phase XR_OBJ_4 regression — pin [ModelVolumeType.nativeOrdinal]
 * against `Slic3r::ModelVolumeType` in libslic3r's
 * `Model.hpp:341-348`. The values pass straight through the JNI
 * (no translation table on the C++ side), so a Kotlin-side typo
 * silently miscategorizes a volume — a NEGATIVE_VOLUME meant to
 * subtract instead becomes a SUPPORT_BLOCKER, the slice succeeds,
 * the gcode is wrong. (gotcha #65 cost real time when this slipped
 * during the multi-volume bridge work.)
 *
 * If this test fails, the libslic3r enum has been renumbered
 * upstream — check the upstream Model.hpp commit log and update
 * the Kotlin enum to match BEFORE editing this test.
 */
class ModelVolumeTypeTest {

    @Test fun modelPartIsZero() {
        assertEquals(0, ModelVolumeType.MODEL_PART.nativeOrdinal)
    }

    @Test fun negativeVolumeIsOne() {
        assertEquals(1, ModelVolumeType.NEGATIVE_VOLUME.nativeOrdinal)
    }

    @Test fun parameterModifierIsTwo() {
        assertEquals(2, ModelVolumeType.PARAMETER_MODIFIER.nativeOrdinal)
    }

    @Test fun supportBlockerIsThree() {
        assertEquals(3, ModelVolumeType.SUPPORT_BLOCKER.nativeOrdinal)
    }

    @Test fun supportEnforcerIsFour() {
        assertEquals(4, ModelVolumeType.SUPPORT_ENFORCER.nativeOrdinal)
    }

    @Test fun allFiveOrdinalsAreUnique() {
        // Defensive: catch any future addition that accidentally
        // shares an ordinal with an existing variant.
        val ordinals = ModelVolumeType.values().map { it.nativeOrdinal }
        assertEquals(ordinals.size, ordinals.toSet().size)
    }

    @Test fun ordinalsCoverContiguousRangeZeroToFour() {
        // libslic3r's enum is contiguous 0..4 for the user-author-able
        // set; a gap would mean we forgot to expose a kind.
        val ordinals = ModelVolumeType.values().map { it.nativeOrdinal }.toSet()
        assertEquals((0..4).toSet(), ordinals)
    }
}
