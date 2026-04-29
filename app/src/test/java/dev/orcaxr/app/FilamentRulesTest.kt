package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests the Phase E filament-vs-bed compatibility rules. Mirrors the
 * Snapmaker/OrcaSlicer fork's
 * [`filament_hot_bed_nozzles.json`](https://github.com/Snapmaker/OrcaSlicer/blob/main/resources/profiles/Snapmaker/filament/filament_hot_bed_nozzles.json)
 * — bed `btPEI` supports PLA and warns on TPU; bed `btGESP` supports
 * PLA and TPU.
 */
class FilamentRulesTest {

    private val sampleJson = """
        {
            "btPEI": {
                "support": ["PLA"],
                "warning": ["TPU"]
            },
            "btGESP": {
                "support": ["PLA", "TPU"]
            }
        }
    """.trimIndent()

    private val rules = FilamentRules.parse(sampleJson)

    @Test fun parseExtractsSupportAndWarningSetsPerBed() {
        assertEquals(setOf("PLA"), rules.supportByBed["btPEI"])
        assertEquals(setOf("TPU"), rules.warningByBed["btPEI"])
        assertEquals(setOf("PLA", "TPU"), rules.supportByBed["btGESP"])
        assertEquals(null, rules.warningByBed["btGESP"])
    }

    @Test fun bedKeyForRecognizesPeiVariants() {
        assertEquals("btPEI", FilamentRules.bedKeyFor("Textured PEI Plate"))
        assertEquals("btPEI", FilamentRules.bedKeyFor("PEI Plate"))
        assertEquals("btPEI", FilamentRules.bedKeyFor("Smooth PEI Plate"))
    }

    @Test fun bedKeyForRecognizesEngineeringPlate() {
        assertEquals("btGESP", FilamentRules.bedKeyFor("Engineering Plate"))
        assertEquals("btGESP", FilamentRules.bedKeyFor("Textured Engineering Plate"))
    }

    @Test fun bedKeyForReturnsNullForUnknownBed() {
        assertEquals(null, FilamentRules.bedKeyFor("Cool Plate"))
        assertEquals(null, FilamentRules.bedKeyFor(""))
        assertEquals(null, FilamentRules.bedKeyFor(null))
    }

    @Test fun plaOnPeiIsOk() {
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("PLA"))
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun plaCfOnPeiIsOkBySubstring() {
        // The fork's contains_token_ci semantics: "PLA-CF" contains
        // "PLA" → supported. Same for "PLA Silk", "PLA Matte".
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("PLA-CF", "PLA Silk"))
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun tpuOnPeiIsWarning() {
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("TPU"))
        assertTrue("Expected Warning, got $r", r is FilamentRules.Result.Warning)
        assertTrue((r as FilamentRules.Result.Warning).message.contains("TPU"))
    }

    @Test fun petgOnPeiIsForbidden() {
        // PETG is in NEITHER support nor warning list for btPEI → unsupported.
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("PETG"))
        assertTrue("Expected Forbidden, got $r", r is FilamentRules.Result.Forbidden)
        assertTrue((r as FilamentRules.Result.Forbidden).message.contains("PETG"))
    }

    @Test fun absOnPeiIsForbidden() {
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("ABS"))
        assertTrue("Expected Forbidden, got $r", r is FilamentRules.Result.Forbidden)
    }

    @Test fun forbiddenWinsOverWarning() {
        // Mixed project: ABS (forbidden) + TPU (warning) on PEI. The
        // user-visible state must be Forbidden so slice is blocked.
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("ABS", "TPU"))
        assertTrue("Expected Forbidden, got $r", r is FilamentRules.Result.Forbidden)
        assertTrue((r as FilamentRules.Result.Forbidden).message.contains("ABS"))
    }

    @Test fun plaAndTpuOnGespAreOk() {
        val r = FilamentRules.evaluate(rules, "btGESP", listOf("PLA", "TPU"))
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun unknownBedKeyReturnsOk() {
        // No rule entry → no opinion. Slicing is allowed.
        val r = FilamentRules.evaluate(rules, "btCool", listOf("PETG"))
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun nullBedKeyReturnsOk() {
        val r = FilamentRules.evaluate(rules, null, listOf("PETG"))
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun emptyFilamentListReturnsOk() {
        val r = FilamentRules.evaluate(rules, "btPEI", emptyList())
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun blankFilamentTypesAreIgnored() {
        // FilamentEntry's default filamentType is "PLA"; a blank string
        // shouldn't promote to forbidden. Empty entries get skipped.
        val r = FilamentRules.evaluate(rules, "btPEI", listOf("", "  ", "PLA"))
        assertEquals(FilamentRules.Result.Ok, r)
    }

    @Test fun nozzleBandKeysAreSkippedSilently() {
        // A future Snapmaker JSON could add per-nozzle-diameter entries
        // ("0.4mm": { ... }). We don't act on them here; bed rules still
        // load and evaluate normally.
        val withNozzle = """
            {
                "btPEI": { "support": ["PLA"] },
                "0.4mm": { "type": "all", "forbidden": ["Generic PETG-CF"] }
            }
        """.trimIndent()
        val r = FilamentRules.parse(withNozzle)
        assertEquals(setOf("PLA"), r.supportByBed["btPEI"])
        // Nozzle band entry doesn't leak into bed rules.
        assertEquals(null, r.supportByBed["0.4mm"])
    }

    @Test fun malformedJsonProducesEmptyRules() {
        // The loadFromAssets path uses runCatching → Rules.EMPTY for any
        // throwable. Simulate by feeding parse() something that throws,
        // wrapped the same way the loader does.
        val rules = runCatching { FilamentRules.parse("{ not valid json") }
            .getOrElse { FilamentRules.Rules.EMPTY }
        assertEquals(FilamentRules.Rules.EMPTY, rules)
        // Still safe to evaluate: empty rules → Ok.
        assertEquals(
            FilamentRules.Result.Ok,
            FilamentRules.evaluate(rules, "btPEI", listOf("PETG")),
        )
    }
}
