package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 3 contract — [serializeMixedFilamentDefinitions] + the round-trip
 * parser in [parseMixedDefinitionsForKotlin] must match libslic3r's
 * FullSpectrum v0.9.9 wire format
 * (`MixedFilamentManager::serialize_custom_entries` /
 * `parse_row_definition` in third_party/OrcaSlicer/src/libslic3r/MixedFilament.cpp).
 *
 * No Android dependencies — pure JVM. Run via :app:testDebugUnitTest.
 */
class MixedFilamentWireFormatTest {

    @Test fun serializeEmptyListIsEmptyString() {
        assertEquals("", serializeMixedFilamentDefinitions(emptyList()))
    }

    @Test fun serializeBasicRowHasV09Format() {
        val row = MixedFilamentEntry(
            id = "row_1_2",
            componentA = 1,
            componentB = 2,
            mixBPercent = 50,
            enabled = true,
            custom = true,
        )
        val out = serializeMixedFilamentDefinitions(listOf(row))
        val fields = out.split(',')
        assertEquals("Leading A id should be 1", "1", fields[0])
        assertEquals("Leading B id should be 2", "2", fields[1])
        assertEquals("Enabled flag at position 3", "1", fields[2])
        assertEquals("Custom flag at position 4", "1", fields[3])
        assertEquals("mix_b_percent at position 5", "50", fields[4])
        // Prefixed tokens — order is fixed.
        assertTrue("Has gradient ids prefix", fields.any { it.startsWith("g") })
        assertTrue("Has gradient weights prefix", fields.any { it.startsWith("w") })
        assertTrue("Has distribution mode prefix", fields.any { it.startsWith("m") })
        assertTrue("Has local-Z max prefix", fields.any { it.startsWith("z") })
        assertTrue("Has component-A offset prefix", fields.any { it.startsWith("xa") })
        assertTrue("Has component-B offset prefix", fields.any { it.startsWith("xb") })
        assertTrue("Has deleted prefix", fields.any { it.startsWith("d") })
        assertTrue("Has origin-auto prefix", fields.any { it.startsWith("o") })
        assertTrue("Has stable-id prefix", fields.any { it.startsWith("u") })
    }

    @Test fun multipleRowsSeparatedBySemicolons() {
        val rows = listOf(
            MixedFilamentEntry(id = "row_a", componentA = 1, componentB = 2),
            MixedFilamentEntry(id = "row_b", componentA = 1, componentB = 3),
        )
        val out = serializeMixedFilamentDefinitions(rows)
        assertEquals("Two rows means one separator", 1, out.count { it == ';' })
    }

    @Test fun manualPatternAppendedAsTrailingToken() {
        val row = MixedFilamentEntry(
            id = "row_with_pattern",
            componentA = 1,
            componentB = 2,
            manualPattern = "11112222",
        )
        val out = serializeMixedFilamentDefinitions(listOf(row))
        val lastToken = out.split(',').last()
        assertEquals("Trailing token should be the manual pattern", "11112222", lastToken)
    }

    @Test fun biasPositiveOnlyOffsetsComponentB() {
        // bias=+50 → B surface offset positive, A=0.
        val row = MixedFilamentEntry(
            id = "row_bias_pos",
            componentA = 1,
            componentB = 2,
            biasPercent = 50,
        )
        val out = serializeMixedFilamentDefinitions(listOf(row))
        val aOff = out.split(',').first { it.startsWith("xa") }.removePrefix("xa")
        val bOff = out.split(',').first { it.startsWith("xb") }.removePrefix("xb")
        assertEquals("A offset zero when bias > 0", "0", aOff)
        assertTrue("B offset > 0 when bias > 0", bOff.toFloat() > 0f)
    }

    @Test fun biasNegativeOnlyOffsetsComponentA() {
        val row = MixedFilamentEntry(
            id = "row_bias_neg",
            componentA = 1,
            componentB = 2,
            biasPercent = -50,
        )
        val out = serializeMixedFilamentDefinitions(listOf(row))
        val aOff = out.split(',').first { it.startsWith("xa") }.removePrefix("xa")
        val bOff = out.split(',').first { it.startsWith("xb") }.removePrefix("xb")
        assertTrue("A offset > 0 when bias < 0", aOff.toFloat() > 0f)
        assertEquals("B offset zero when bias < 0", "0", bOff)
    }

    @Test fun parserRoundTripsCanonicalRow() {
        val original = listOf(
            MixedFilamentEntry(
                id = "rt_row",
                componentA = 1,
                componentB = 2,
                ratioA = 1,
                ratioB = 1,
                mixBPercent = 50,
                biasPercent = 30,
                distributionMode = 1, // Pointillisme
                localZMaxSublayers = 4,
                manualPattern = "121212",
                gradientComponentIds = "123",
                gradientComponentWeights = "50/25/25",
                enabled = true,
                custom = true,
                originAuto = false,
            ),
        )
        val wire = serializeMixedFilamentDefinitions(original)
        val parsed = parseMixedDefinitionsForKotlin(wire)
        assertEquals("Round-trip preserves row count", 1, parsed.size)
        val r = parsed.first()
        assertEquals("componentA preserved", 1, r.componentA)
        assertEquals("componentB preserved", 2, r.componentB)
        assertEquals("mixBPercent preserved", 50, r.mixBPercent)
        assertEquals("distributionMode preserved", 1, r.distributionMode)
        assertEquals("localZMaxSublayers preserved", 4, r.localZMaxSublayers)
        assertEquals("manualPattern preserved", "121212", r.manualPattern)
        assertEquals("gradientComponentIds preserved", "123", r.gradientComponentIds)
        assertEquals("gradientComponentWeights preserved", "50/25/25", r.gradientComponentWeights)
        assertEquals("enabled preserved", true, r.enabled)
        assertEquals("custom preserved", true, r.custom)
        // bias survives the (clamped) round-trip within ±5% of the maxBias unit.
        val biasDelta = kotlin.math.abs(r.biasPercent - 30)
        assertTrue("bias preserved within 5%, was ${r.biasPercent}", biasDelta <= 5)
    }

    @Test fun deletedRowsAreFilteredAtParseTime() {
        val rows = listOf(
            MixedFilamentEntry(id = "keep_me", componentA = 1, componentB = 2),
            MixedFilamentEntry(id = "kill_me", componentA = 1, componentB = 3, deleted = true),
        )
        val wire = serializeMixedFilamentDefinitions(rows)
        val parsed = parseMixedDefinitionsForKotlin(wire)
        // The parser drops deleted rows so downstream code doesn't see tombstones.
        // The serializer writes them (so libslic3r can keep them tombstoned too).
        assertEquals("Parser filters deleted rows", 1, parsed.size)
        assertNotNull("Live row passes through", parsed.firstOrNull { it.componentB == 2 })
        assertNull("Tombstoned row filtered", parsed.firstOrNull { it.componentB == 3 })
    }

    @Test fun gradientWeightsOmittedWhenIdsBelowThreeWay() {
        // 2-way mixes don't need gradient weights — the wire format
        // still includes the `w` prefix (empty after).
        val row = MixedFilamentEntry(
            id = "two_way",
            componentA = 1,
            componentB = 2,
            gradientComponentIds = "",
        )
        val out = serializeMixedFilamentDefinitions(listOf(row))
        val gToken = out.split(',').first { it.startsWith("g") }
        val wToken = out.split(',').first { it.startsWith("w") }
        assertEquals("Empty gradient ids → 'g'", "g", gToken)
        assertEquals("Empty gradient weights → 'w'", "w", wToken)
    }

}
