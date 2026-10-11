package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.SliceFigures
import dev.orcaxr.core.SliceStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PrepareFlowTest {
    private fun units(text: String) = text.map { it.code }
    private val absent = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
    private val endpoint = "http://10.0.2.2:3000"
    private val engine = AttestedEngine(cli = true, commit = "0123456789abcdef0123456789abcdef01234567")

    @Test
    fun aCheckAttestsOnlyInTheGenerationItBeganIn() {
        val probing = SlicerConnection().probing(endpoint)
        assertEquals(SlicerPhase.Probing, probing.phase)
        assertFalse("a candidate is off until it attests", probing.enabled)
        val connected = probing.probed(probing.generation, engine, "")
        assertTrue(connected.enabled)
        assertEquals(SlicerPhase.Connected, connected.phase)
        assertEquals(engine, connected.engine)
        // A token edit (or anything else) made the check moot: its answer changes nothing.
        val edited = probing.invalidate()
        assertSame(edited, edited.probed(probing.generation, engine, ""))
        assertFalse(edited.enabled)
        // An answer to a later check is ignored by an earlier generation, and twice is once.
        assertSame(connected, connected.probed(connected.generation, null, "late"))
    }

    @Test
    fun aRefusedCheckSaysWhyAndStaysOff() {
        val probing = SlicerConnection(endpoint = "http://old:3000", enabled = true, engine = engine).probing(endpoint)
        assertFalse("a replacement is off until it attests", probing.enabled)
        val failed = probing.probed(probing.generation, null, "The external slicer requires a token before it will report its engine.")
        assertEquals(SlicerPhase.Failed, failed.phase)
        assertFalse(failed.enabled)
        assertEquals("The external slicer requires a token before it will report its engine.", PrepareWords.status(failed))
        val refused = SlicerConnection().refused("Canonical external slicer URLs cannot contain credentials, query parameters, or fragments.")
        assertEquals(SlicerPhase.Failed, refused.phase)
        assertEquals(refused.reason, PrepareWords.status(refused))
    }

    @Test
    fun offKeepsTheEndpointAndRemoveForgetsIt() {
        val connected = SlicerConnection().probing(endpoint).let { it.probed(it.generation, engine, "") }
        val off = connected.disable()
        assertEquals(endpoint, off.endpoint)
        assertFalse(off.enabled)
        assertEquals(null, off.engine)
        assertTrue(off.generation > connected.generation)
        val removed = connected.clear()
        assertEquals("", removed.endpoint)
        assertFalse(removed.enabled)
        assertTrue(removed.generation > connected.generation)
        // Invalidating keeps a connected route connected.
        assertEquals(SlicerPhase.Connected, connected.invalidate().phase)
        assertTrue(connected.invalidate().enabled)
    }

    @Test
    fun consentIsPerEndpoint() {
        val none = SliceConsent()
        assertFalse(none.allows(endpoint))
        val given = none.grant(endpoint)
        assertTrue(given.allows(endpoint))
        assertFalse(given.allows("http://10.0.2.2:3001"))
        assertFalse(given.revoke(endpoint).allows(endpoint))
        assertEquals("Upload this plate to $endpoint?", PrepareWords.consentTitle(endpoint))
    }

    @Test
    fun theConnectionInTheBrowsersWords() {
        val idle = SlicerConnection()
        assertEquals("Offline", PrepareWords.status(idle))
        assertEquals(PrepareWords.OFF, PrepareWords.hint(idle))
        assertEquals("Checking engine…", PrepareWords.status(idle.probing(endpoint)))
        val connected = idle.probing(endpoint).let { it.probed(it.generation, engine, "") }
        assertEquals("Online — attested (the native Snapmaker Orca CLI at 0123456789ab)", PrepareWords.status(connected))
        assertEquals("On — models will be sliced on the external server.", PrepareWords.hint(connected))
        assertEquals(
            "Slicing route: the external slicer at $endpoint, whose engine attested as the native Snapmaker Orca CLI at 0123456789ab.",
            PrepareWords.route(connected),
        )
        assertTrue(PrepareWords.route(idle).startsWith("Slicing route: none."))
        assertEquals("slice failed: the external slicer is not an attested engine route. No.", PrepareWords.unattested("No."))
        assertEquals("Slicing: preflighting", PrepareWords.progress("preflighting"))
    }

    private fun issue(severity: ProjectIntents.PreflightSeverity, message: String, detail: String? = null) = ProjectIntents.PreflightIssue(
        units("issue:$message"), ProjectIntents.PreflightCode.InstanceOutsideBuildVolume,
        detail?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: absent, severity, units(message), units("Move it inside."),
        ProjectIntents.OptionalText.Value(units("plates[0].objects[0]")),
        listOf(ProjectIntents.PreflightEntity.Instance(units("instance-1")), ProjectIntents.PreflightEntity.Project(ProjectIntents.Empty)),
        emptyList(),
    )

    private fun summary(blocking: Long) = ProjectIntents.PreflightSummary(units("plate-1"), blocking == 0L, blocking, 2, 0, 1, 1)

    @Test
    fun aBlockedPreflightInTheBrowsersWords() {
        val warning = issue(ProjectIntents.PreflightSeverity.Warning, "Close to the edge.")
        val error = issue(ProjectIntents.PreflightSeverity.Error, "Outside the build volume.")
        assertEquals(
            "Slice preflight blocked plate plate-1 with 1 error. Outside the build volume.",
            PrepareWords.preflightBlocked(summary(1), listOf(warning, error)),
        )
        assertEquals("Slice preflight blocked plate plate-1 with 2 errors. Outside the build volume.", PrepareWords.preflightBlocked(summary(2), listOf(error)))
    }

    @Test
    fun anIssueAsTheBrowsersCardShowsIt() {
        val card = PrepareWords.card(issue(ProjectIntents.PreflightSeverity.Error, "Outside the build volume.", detail = "x-max"))
        assertTrue(card.error)
        assertEquals("Error instance-outside-build-volume / x-max", card.heading)
        assertEquals("Outside the build volume.", card.message)
        assertEquals("Move it inside.", card.help)
        assertEquals("plates[0].objects[0]", card.path)
        assertEquals(listOf("instance: instance-1", "project"), card.entities)
        assertEquals("Warning instance-outside-build-volume", PrepareWords.card(issue(ProjectIntents.PreflightSeverity.Warning, "Edge.")).heading)
        // "N hidden issues" is the browser's plural message, a resource the generator checks.
    }

    @Test
    fun everyPreflightCodeIsTheBrowsers() {
        // web/src/project/slicing/preflight.ts SlicePreflightCode.
        val browser = setOf(
            "invalid-project-state", "unknown-plate", "plate-not-printable", "no-printable-instance", "empty-model-mesh",
            "unreadable-model-mesh", "instance-outside-build-volume", "instance-below-build-plate", "instance-aabb-overlap",
            "disabled-filament-assignment", "deleted-mixed-filament-assignment", "disabled-mixed-component",
            "incompatible-mixed-components", "mixed-filament-unsupported-printer", "filament-tool-out-of-range",
            "filament-count-exceeds-engine-limit", "gradient-recipe-out-of-bounds", "filament-nozzle-mismatch",
            "unsupported-filament-material", "invalid-filament-temperature", "filament-temperature-out-of-range",
            "missing-profile-attestation", "wipe-tower-outside-build-volume", "wipe-tower-requires-physical-filament",
            "wipe-tower-requires-relative-e", "wipe-tower-ooze-prevention-conflict", "wipe-tower-mixed-extruder-diameters",
            "unsafe-custom-gcode",
        )
        assertEquals(browser, ProjectIntents.PreflightCode.entries.map(PrepareWords::code).toSet())
    }

    @Test
    fun gcodeFileNamesAreTheBrowsers() {
        // web/src/printer/__tests__/print-job-submission.test.ts
        assertEquals("Peggy_Palette_v2_.gcode", PrepareWords.gcodeFilename("Peggy Palette (v2).3mf"))
        assertEquals("plate_1.gcode", PrepareWords.gcodeFilename("/plates/plate 1.gcode"))
        assertEquals("orcaxr_print.gcode", PrepareWords.gcodeFilename("   "))
        assertEquals("hidden.gcode", PrepareWords.gcodeFilename(".hidden.txt"))
        assertEquals("Untitled_project_Plate_1.gcode", PrepareWords.slicedFilename("Untitled project", "Plate 1"))
        assertEquals("cube.gcode", PrepareWords.gcodeFilename("cube.GCODE"))
    }

    @Test
    fun aSliceSummaryInTheBrowsersWords() {
        // The figures are the core's (SliceStatusTally, replayed over JNI against the browser's corpus).
        val figures = SliceFigures(2048, "2", 10, "2", null, 2)
        assertEquals("SLICED in 1234 ms\n2 KB, 10 lines, 2 layers", SliceStatus.describe(1234, figures, 0))
        val stated = SliceFigures(100, "0", 1, "18446744073709552000", "18446744073709552000", 0)
        assertEquals("SLICED in 5 ms\n0 KB, 1 lines, 18446744073709552000 layers, 2 warning(s)", SliceStatus.describe(5, stated, 2))
    }
}
