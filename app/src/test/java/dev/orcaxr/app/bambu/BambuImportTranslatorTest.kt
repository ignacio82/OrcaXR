package dev.orcaxr.app.bambu

import dev.orcaxr.app.SlicerEngine.Bambu3mfFingerprint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [BambuImportTranslator]. The translator is a pure
 * function — no I/O, no JNI, no Android-framework references — so a
 * plain JVM test covers it.
 *
 * The tests cover the four behaviors the proposal in
 * `docs/proposals/bambu-3mf-import.md` calls out:
 *
 *   1. Bambu detection via printer_model OR printer_settings_id.
 *   2. Filament-tuning strip (BAMBU_FILAMENT_TUNING_STRIP keys leave;
 *      object tunings stay).
 *   3. filament_type → U1 profile remap (PLA / PETG-HF / ABS / etc.).
 *   4. No false positives — an OrcaSlicer 3MF that just happens to
 *      look multi-color passes through unchanged.
 *
 * Plus a regression: the "Bambu PLA Basic" / "PLA Matte" / "PLA Silk"
 * label-with-finish-marker variants all collapse to the base
 * filament_type via [BambuImportTranslator.normalizeFilamentType].
 */
class BambuImportTranslatorTest {

    @Test
    fun `detect — Bambu Lab X1 Carbon by printer_model`() {
        val fp = Bambu3mfFingerprint(
            printerModel = "Bambu Lab X1 Carbon",
            printerSettingsId = "0.20mm Standard @BBL X1C",
            filamentTypes = emptyList(),
        )
        assertTrue(BambuImportTranslator.detect(fp))
    }

    @Test
    fun `detect — Bambu by settings_id alone (model field blank)`() {
        val fp = Bambu3mfFingerprint(
            printerModel = "",
            printerSettingsId = "0.20mm Standard @P1S",
            filamentTypes = emptyList(),
        )
        assertTrue(BambuImportTranslator.detect(fp))
    }

    @Test
    fun `detect — A1 and A1 Mini variants`() {
        for (marker in listOf("@A1", "@A1 Mini", "@A1M")) {
            assertTrue(
                "expected $marker to flag as Bambu",
                BambuImportTranslator.detect(
                    Bambu3mfFingerprint("", "0.20mm Standard $marker", emptyList()),
                ),
            )
        }
    }

    @Test
    fun `detect — non-Bambu (Snapmaker U1) does NOT trip`() {
        val fp = Bambu3mfFingerprint(
            printerModel = "Snapmaker U1",
            printerSettingsId = "Snapmaker U1 (0.4 nozzle)",
            filamentTypes = listOf("PLA", "PLA", "PLA", "PLA"),
        )
        assertFalse(BambuImportTranslator.detect(fp))
    }

    @Test
    fun `detect — empty fingerprint is not-Bambu`() {
        assertFalse(BambuImportTranslator.detect(Bambu3mfFingerprint("", "", emptyList())))
    }

    @Test
    fun `translate — Bambu input strips filament tunings, keeps object tunings`() {
        val raw = mapOf(
            // Object tunings — should stay.
            "sparse_infill_density" to "15%",
            "sparse_infill_pattern" to "gyroid",
            "wall_loops" to "3",
            "top_shell_layers" to "5",
            "outer_wall_speed" to "150",
            "outer_wall_acceleration" to "5000",
            // Filament tunings — Bambu values; should be stripped.
            "filament_max_volumetric_speed" to "22",
            "filament_flow_ratio" to "0.95",
            "nozzle_temperature" to "230",
            "pressure_advance" to "0.04",
            "fan_max_speed" to "80",
            "overhang_fan_threshold" to "30%",
        )
        val fp = Bambu3mfFingerprint(
            printerModel = "Bambu Lab X1 Carbon",
            printerSettingsId = "",
            filamentTypes = listOf("PLA", "PETG"),
        )

        val result = BambuImportTranslator.translate(raw, fp, slotCount = 4)

        assertTrue(result.wasBambu)
        // Object tunings retained.
        assertEquals("15%", result.translatedOverrides["sparse_infill_density"])
        assertEquals("gyroid", result.translatedOverrides["sparse_infill_pattern"])
        assertEquals("3", result.translatedOverrides["wall_loops"])
        assertEquals("150", result.translatedOverrides["outer_wall_speed"])
        // Filament tunings stripped.
        assertFalse(result.translatedOverrides.containsKey("filament_max_volumetric_speed"))
        assertFalse(result.translatedOverrides.containsKey("filament_flow_ratio"))
        assertFalse(result.translatedOverrides.containsKey("nozzle_temperature"))
        assertFalse(result.translatedOverrides.containsKey("pressure_advance"))
        assertFalse(result.translatedOverrides.containsKey("fan_max_speed"))
        assertFalse(result.translatedOverrides.containsKey("overhang_fan_threshold"))

        // dropped list matches the strip set.
        assertTrue("filament_max_volumetric_speed" in result.droppedKeys)
        assertTrue("filament_flow_ratio" in result.droppedKeys)
        assertTrue("pressure_advance" in result.droppedKeys)
        assertEquals(6, result.droppedKeys.size)
    }

    @Test
    fun `translate — filament_type → U1 profile remap for the standard four`() {
        val raw = emptyMap<String, String>()
        val fp = Bambu3mfFingerprint(
            printerModel = "Bambu Lab X1 Carbon",
            printerSettingsId = "",
            filamentTypes = listOf("PLA", "PETG-HF", "ABS", "TPU"),
        )

        val result = BambuImportTranslator.translate(raw, fp, slotCount = 4)

        assertEquals(4, result.filamentProfileSuggestion.size)
        assertEquals("Snapmaker PLA SnapSpeed @U1", result.filamentProfileSuggestion[0])
        assertEquals("Snapmaker PETG HF",           result.filamentProfileSuggestion[1])
        assertEquals("Generic ABS",                  result.filamentProfileSuggestion[2])
        assertEquals("Generic TPU",                  result.filamentProfileSuggestion[3])
    }

    @Test
    fun `translate — pads to slotCount when 3MF declares fewer filaments`() {
        val raw = emptyMap<String, String>()
        val fp = Bambu3mfFingerprint(
            printerModel = "Bambu Lab A1",
            printerSettingsId = "",
            filamentTypes = listOf("PLA", "ABS"), // only 2 slots authored
        )

        val result = BambuImportTranslator.translate(raw, fp, slotCount = 4)

        assertEquals(4, result.filamentProfileSuggestion.size)
        assertEquals("Snapmaker PLA SnapSpeed @U1", result.filamentProfileSuggestion[0])
        assertEquals("Generic ABS",                  result.filamentProfileSuggestion[1])
        // Padded slots fall back to Generic PLA (the catch-all default).
        assertEquals("Generic PLA",                  result.filamentProfileSuggestion[2])
        assertEquals("Generic PLA",                  result.filamentProfileSuggestion[3])
    }

    @Test
    fun `translate — Bambu-brand filament-type label is normalized`() {
        val raw = emptyMap<String, String>()
        val fp = Bambu3mfFingerprint(
            printerModel = "Bambu Lab P1S",
            printerSettingsId = "",
            // "Bambu PLA Basic" / "Bambu PLA Matte" both fold to PLA.
            filamentTypes = listOf("Bambu PLA Basic", "Bambu PLA Matte", "Bambu PETG-HF", "Bambu ABS"),
        )

        val result = BambuImportTranslator.translate(raw, fp, slotCount = 4)

        assertEquals("Snapmaker PLA SnapSpeed @U1", result.filamentProfileSuggestion[0])
        assertEquals("Snapmaker PLA SnapSpeed @U1", result.filamentProfileSuggestion[1])
        assertEquals("Snapmaker PETG HF",           result.filamentProfileSuggestion[2])
        assertEquals("Generic ABS",                  result.filamentProfileSuggestion[3])
    }

    @Test
    fun `translate — non-Bambu 3MF passes through unchanged`() {
        val raw = mapOf(
            "sparse_infill_density"          to "15%",
            "filament_max_volumetric_speed"  to "12",   // U1 value — must be retained
            "pressure_advance"               to "0.02", // U1 value — must be retained
            "wall_loops"                     to "2",
            "outer_wall_speed"               to "150",
        )
        val fp = Bambu3mfFingerprint(
            printerModel = "Snapmaker U1",
            printerSettingsId = "Snapmaker U1 (0.4 nozzle)",
            filamentTypes = listOf("PLA"),
        )

        val result = BambuImportTranslator.translate(raw, fp, slotCount = 4)

        assertFalse(result.wasBambu)
        assertEquals(raw, result.translatedOverrides)
        assertTrue(result.droppedKeys.isEmpty())
        assertTrue(result.filamentProfileSuggestion.isEmpty())
        assertTrue(result.bannerText.isEmpty())
    }

    @Test
    fun `translate — banner mentions printer model + dropped count`() {
        val raw = mapOf(
            "filament_flow_ratio" to "0.95",
            "wall_loops" to "2",
        )
        val fp = Bambu3mfFingerprint(
            printerModel = "Bambu Lab X1 Carbon",
            printerSettingsId = "",
            filamentTypes = listOf("PLA"),
        )
        val result = BambuImportTranslator.translate(raw, fp, slotCount = 4)

        assertTrue(result.wasBambu)
        assertTrue("banner mentions printer model", result.bannerText.contains("Bambu Lab X1 Carbon"))
        assertTrue("banner mentions Bambu Studio", result.bannerText.contains("Bambu Studio"))
        assertTrue("banner mentions dropped key count", result.bannerText.contains("1"))
    }

    @Test
    fun `normalizeFilamentType — handles common Bambu finish variants`() {
        assertEquals("PLA",     BambuImportTranslator.normalizeFilamentType("Bambu PLA Basic"))
        assertEquals("PLA",     BambuImportTranslator.normalizeFilamentType("Bambu PLA Matte"))
        assertEquals("PLA",     BambuImportTranslator.normalizeFilamentType("Bambu PLA Silk"))
        assertEquals("PETG-HF", BambuImportTranslator.normalizeFilamentType("Bambu PETG-HF"))
        assertEquals("PETG",    BambuImportTranslator.normalizeFilamentType("PETG"))
        assertEquals("ABS",     BambuImportTranslator.normalizeFilamentType("\"ABS\""))
        assertEquals("",        BambuImportTranslator.normalizeFilamentType(""))
    }
}
