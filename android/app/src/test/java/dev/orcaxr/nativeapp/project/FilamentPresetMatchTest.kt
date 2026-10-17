package dev.orcaxr.nativeapp.project

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FilamentPresetMatchTest {
    private val u1Pla = listOf(
        FilamentPresetCandidate("generic-pla", "Generic PLA", "PLA", "Generic"),
        FilamentPresetCandidate("generic-silk", "Generic PLA Silk", "PLA", "Generic"),
        FilamentPresetCandidate("generic-support", "Generic Support For PLA", "PLA", "Generic"),
        FilamentPresetCandidate("snap-pla", "Snapmaker PLA @U1", "PLA", "Snapmaker"),
        FilamentPresetCandidate("snap-matte", "Snapmaker PLA Matte @U1", "PLA", "Snapmaker"),
        FilamentPresetCandidate("snap-snapspeed", "Snapmaker PLA SnapSpeed @U1", "PLA", "Snapmaker"),
        FilamentPresetCandidate("snap-silk", "Snapmaker PLA Silk @U1", "PLA", "Snapmaker"),
        FilamentPresetCandidate("snap-cf", "Snapmaker PLA-CF @U1", "PLA", "Snapmaker"),
        FilamentPresetCandidate("snap-petg", "Snapmaker PETG @U1", "PETG", "Snapmaker"),
    )

    @Test
    fun theReportedVendorAndGradeChooseThePresetNotCorpusOrder() {
        assertEquals(
            "snap-matte",
            FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA", subType = "Matte", vendor = "Snapmaker"))?.presetId,
        )
        assertEquals(
            "snap-snapspeed",
            FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA", subType = "SnapSpeed", vendor = "Snapmaker"))?.presetId,
        )
        assertEquals(
            "snap-snapspeed",
            FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "pla", subType = "snap speed", vendor = "SNAPMAKER"))?.presetId,
        )
    }

    @Test
    fun anUnreportedGradePrefersTheVendorsPlainPresetOverAnyGrade() {
        assertEquals(
            "snap-pla",
            FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA", vendor = "Snapmaker"))?.presetId,
        )
        assertEquals(
            "generic-pla",
            FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA", vendor = "Generic"))?.presetId,
        )
    }

    @Test
    fun aGradeWithNoPresetOfItsOwnKeepsTheVendorAndType() {
        val match = FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA", subType = "Nebula", vendor = "Snapmaker"))
        assertEquals("snap-pla", match?.presetId)
        assertTrue(match?.vendorMatched == true)
        assertFalse(match?.gradeMatched == true)
    }

    @Test
    fun anUnreportedVendorStillLandsOnAPlainPresetOfTheReportedType() {
        assertEquals(
            "generic-pla",
            FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA"))?.presetId,
        )
    }

    @Test
    fun aMaterialNothingDeclaresIsUnmatchedRatherThanGuessed() {
        assertNull(FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "Unobtainium", vendor = "Nobody")))
        assertNull(FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "")))
    }

    @Test
    fun aCompositeNameIsNotReadAsThePlainMaterial() {
        assertEquals("PLA-CF", FilamentPresetMatching.filamentPresetGrade(u1Pla[7]))
        assertEquals("", FilamentPresetMatching.filamentPresetGrade(u1Pla[3]))
        assertEquals("Matte", FilamentPresetMatching.filamentPresetGrade(u1Pla[4]))
        assertEquals("Support For PLA", FilamentPresetMatching.filamentPresetGrade(u1Pla[2]))
        assertNotEquals("snap-cf", FilamentPresetMatching.matchFilamentPreset(u1Pla, ReportedFilamentSlot(material = "PLA", vendor = "Snapmaker"))?.presetId)
    }

    @Test
    fun theVendorFallsBackToTheLeadingNameWordWhenThePresetDeclaresNone() {
        val undeclared = FilamentPresetCandidate("undeclared", "Snapmaker PLA Matte @U1", "PLA")
        assertTrue(
            FilamentPresetMatching.matchFilamentPreset(listOf(undeclared), ReportedFilamentSlot(material = "PLA", subType = "Matte", vendor = "Snapmaker"))?.vendorMatched == true,
        )
    }

    @Test
    fun agreementIsCheckedOnlyAgainstTheFactsTheMachineReported() {
        val silk = u1Pla[6]
        assertTrue(FilamentPresetMatching.filamentPresetAgreesWithSlot(silk, ReportedFilamentSlot(material = "PLA", vendor = "Snapmaker")))
        assertFalse(FilamentPresetMatching.filamentPresetAgreesWithSlot(silk, ReportedFilamentSlot(material = "PLA", subType = "Matte", vendor = "Snapmaker")))
        assertFalse(FilamentPresetMatching.filamentPresetAgreesWithSlot(u1Pla[0], ReportedFilamentSlot(material = "PLA", vendor = "Snapmaker")))
        assertTrue(FilamentPresetMatching.filamentPresetAgreesWithSlot(u1Pla[0], ReportedFilamentSlot(material = "PLA")))
        assertFalse(FilamentPresetMatching.filamentPresetAgreesWithSlot(u1Pla[8], ReportedFilamentSlot(material = "PLA", vendor = "Snapmaker")))
    }

    @Test
    fun rankingIsDeterministicWhateverOrderTheCorpusWasCompiledIn() {
        val reversed = u1Pla.reversed()
        for (slot in listOf(
            ReportedFilamentSlot(material = "PLA", subType = "Matte", vendor = "Snapmaker"),
            ReportedFilamentSlot(material = "PLA", vendor = "Snapmaker"),
            ReportedFilamentSlot(material = "PLA"),
        )) {
            assertEquals(
                FilamentPresetMatching.matchFilamentPreset(u1Pla, slot)?.presetId,
                FilamentPresetMatching.matchFilamentPreset(reversed, slot)?.presetId,
            )
        }
    }
}
