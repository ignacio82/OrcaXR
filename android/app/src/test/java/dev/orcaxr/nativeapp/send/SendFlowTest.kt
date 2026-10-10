package dev.orcaxr.nativeapp.send

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.nativeapp.prepare.SlicedPlate
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SendFlowTest {
    private fun units(text: String) = text.map { it.code }
    private val absent = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
    private val revision = ProjectRevision(7, "semantic", "assets")
    private fun slice() = SlicedPlate(File("cube_Plate_1.gcode"), "cube_Plate_1.gcode", "plate-1", "Plate 1", revision, "http://10.0.2.2:3000", "SLICED")

    @Test
    fun onlyThePublishedSliceOfTheActivePlateAndUnchangedProjectIsCurrent() {
        val sent = slice()
        assertTrue(SendGuard.current(sent, sent, "plate-1", revision))
        // A newer slice was published (even one alike), or the output withdrawn.
        assertFalse(SendGuard.current(slice(), sent, "plate-1", revision))
        assertFalse(SendGuard.current(null, sent, "plate-1", revision))
        // Another plate is active, or the project changed since it was sliced.
        assertFalse(SendGuard.current(sent, sent, "plate-2", revision))
        assertFalse(SendGuard.current(sent, sent, "plate-1", revision.copy(revision = 8)))
        assertFalse(SendGuard.current(sent, sent, "plate-1", null))
    }

    @Test
    fun progressAndOutcomesInTheBrowsersWords() {
        // web/src/main.ts, onRequestPrintSubmission.
        val name = "cube_Plate_1.gcode"
        assertEquals(
            listOf(
                "Checking the printer…", "Confirm the send options…", "Uploading cube_Plate_1.gcode…", "Verifying the stored file…",
                "Preparing the printer with the confirmed options…", "Starting the print…", "Send completed.",
            ),
            ProjectIntents.PrintSubmissionPhase.entries.map { SendWords.phase(it, name) },
        )
        assertEquals(
            "Uploading cube_Plate_1.gcode (1.5 MB) — 1m 05s elapsed. Press Cancel send to stop.",
            SendWords.uploadElapsed(name, 65_999, 1_572_864),
        )
        assertEquals("Uploading a.gcode (0.0 MB) — 0m 00s elapsed. Press Cancel send to stop.", SendWords.uploadElapsed("a.gcode", 999, 643))
        fun result(started: Boolean, bytes: Long) =
            ProjectIntents.PrintSubmissionResult(units("cube_Plate_1_0f.gcode"), units("gcodes"), bytes, bytes, started, absent)
        assertEquals("Printing cube_Plate_1_0f.gcode — 1 KB verified on the printer.", SendWords.result(result(true, 643)))
        assertEquals(
            "Uploaded cube_Plate_1_0f.gcode — 2 KB verified; start it from the printer when ready.",
            SendWords.result(result(false, 1536)),
        )
        // toFixed(0) takes the larger of two equally near integers.
        assertEquals("Printing cube_Plate_1_0f.gcode — 1 KB verified on the printer.", SendWords.result(result(true, 512)))
        assertEquals("Send failed: Upload cancelled.", SendWords.failed("Upload cancelled."))
        assertEquals("Send cancelled; nothing was uploaded.", SendWords.DECLINED)
        assertEquals("Cancelling the send…", SendWords.CANCELLING)
        assertEquals("A send is already in progress; cancel it before starting another.", SendWords.BUSY)
        // web/src/workspace/OrcaWorkspace.ts, sendToPrinter; web/src/actions/groups/output.ts.
        assertEquals("Slice the active plate before sending it to the printer.", SendWords.SLICE_FIRST)
        assertEquals("Send to Printer", SendWords.ACTION)
        assertEquals("Cancel send", SendWords.CANCEL)
    }

    @Test
    fun sizesAsTheDialogFormatsThem() {
        assertEquals("643 B", SendWords.bytes(643))
        assertEquals("1023 B", SendWords.bytes(1023))
        assertEquals("1 KB", SendWords.bytes(1024))
        assertEquals("1024 KB", SendWords.bytes(1_048_575))
        assertEquals("1.0 MB", SendWords.bytes(1_048_576))
        assertEquals("5.1 MB", SendWords.bytes(5_400_000))
    }

    private fun overwrite(allowed: Boolean, size: Double? = null, modified: Double = 1_700_000_000.0, reason: String? = null) =
        ProjectIntents.PrintOverwrite(
            allowed,
            size?.let { ProjectIntents.OptionalPrintFileIdentity.Value(ProjectIntents.PrintFileIdentity(units("part.gcode"), it, modified)) }
                ?: ProjectIntents.OptionalPrintFileIdentity.Absent(ProjectIntents.Empty),
            reason?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: absent,
            units("part.gcode"),
        )

    @Test
    fun theExactNameChoiceAsTheBrowserLabelsIt() {
        // web/src/ui/PrintSubmissionLabels.ts printOverwriteLabel.
        assertEquals("Use exact name part.gcode (new file)", SendWords.overwrite(overwrite(true)))
        assertEquals(
            "Use exact name part.gcode, replacing 2048 bytes modified 2023-11-14T22:13:20.000Z",
            SendWords.overwrite(overwrite(true, 2048.0)),
        )
        assertEquals("An active file cannot be replaced.", SendWords.overwrite(overwrite(false, 2048.0, reason = "An active file cannot be replaced.")))
        assertEquals("Replacing this file is unavailable.", SendWords.overwrite(overwrite(false)))
        // Date#toISOString: milliseconds always, expanded years, and the number itself past a date's range.
        assertEquals("2023-11-14T22:13:20.500Z", SendWords.modified(1_700_000_000.5))
        assertEquals("1969-12-31T23:59:59.000Z", SendWords.modified(-1.0))
        assertEquals("+010000-01-01T00:00:00.000Z", SendWords.modified(253_402_300_800.0))
        assertEquals("10000000000000", SendWords.modified(1e13))
        // Number#toString.
        assertEquals("1.5", SendWords.jsNumber(1.5))
        assertEquals("0.001", SendWords.jsNumber(0.001))
        assertEquals("1e-7", SendWords.jsNumber(1e-7))
        assertEquals("1e+21", SendWords.jsNumber(1e21))
        assertEquals("-42", SendWords.jsNumber(-42.0))
    }

    private fun option(id: ProjectIntents.PrintStartOptionId, available: Boolean, defaultEnabled: Boolean = false) = ProjectIntents.PrintStartOption(
        id, units("Label $id"), units("Detail $id"), available, units("Reason $id"), defaultEnabled, absent,
    )

    private fun confirmation(
        stored: Boolean = false,
        blockers: List<String> = emptyList(),
        options: List<ProjectIntents.PrintStartOption> = emptyList(),
        target: ProjectIntents.PrintOverwrite = overwrite(true),
    ) = ProjectIntents.PrintWorkflowConfirmation(
        stored, units("part_0123.gcode"), units("Plate 1"), 2048, units("Toolchanger"), units("ready (standby)"),
        units("2 tools (T0, T1) · H1: PLA #FF0000"), blockers.map(::units), listOf(units("T0 was sliced as #00FF00, but slot 1 holds #FF0000.")),
        options, target,
    )

    @Test
    fun theDialogShowsWhatTheBrowsersShows() {
        // web/src/ui/dom/PrintSubmissionDialog.ts.
        val view = SendDialogView(confirmation())
        assertEquals("Send to printer", view.title)
        assertEquals(
            listOf(
                "Printer" to "Toolchanger — ready (standby)", "Plate" to "Plate 1", "File" to "part_0123.gcode (2 KB)",
                "Filaments" to "2 tools (T0, T1) · H1: PLA #FF0000",
            ),
            view.facts(overwrite = false),
        )
        // Choosing the exact name names that file.
        assertEquals("File" to "part.gcode (2 KB)", view.facts(overwrite = true)[2])
        assertEquals(listOf("T0 was sliced as #00FF00, but slot 1 holds #FF0000."), view.warnings)
        assertEquals("Use exact name part.gcode (new file)", view.overwriteLabel)
        assertEquals("Upload and start print", view.startLabel)
        assertEquals("Upload only", view.uploadLabel)
        assertEquals("Cancel", view.cancelLabel)
        assertTrue(view.startEnabled)
        assertNull(view.startRefusal)
        assertNull("no options, no heading", view.optionsHeading)
    }

    @Test
    fun aMappingBlockerDisablesOnlyStarting() {
        val view = SendDialogView(confirmation(blockers = listOf("The artifact prints with tool T1, but the printer reports no filament loaded in slot 2.")))
        assertFalse(view.startEnabled)
        assertEquals("Resolve the filament mapping problems above before starting this print", view.startRefusal)
        assertEquals("Upload only", view.uploadLabel)
    }

    @Test
    fun startOptionsKeepUnavailableOnesWithTheirReason() {
        val leveling = ProjectIntents.PrintStartOptionId.BedLeveling
        val timelapse = ProjectIntents.PrintStartOptionId.Timelapse
        val view = SendDialogView(confirmation(options = listOf(option(leveling, true, defaultEnabled = true), option(timelapse, false, defaultEnabled = true))))
        assertEquals("Before printing", view.optionsHeading)
        assertEquals(
            listOf(
                SendOption(leveling, "Label BedLeveling", "Detail BedLeveling", available = true, checked = true),
                // Unavailable: why not, and never on.
                SendOption(timelapse, "Label Timelapse", "Reason Timelapse", available = false, checked = false),
            ),
            view.options,
        )
        // Only enabled choices count, in the printer's order.
        assertEquals(
            ProjectIntents.PrintWorkflowDecision(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint, true, listOf(leveling)),
            view.decide(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint, overwrite = true, chosen = setOf(timelapse, leveling)),
        )
        assertEquals(SendDialogView.CANCEL, view.decide(ProjectIntents.PrintWorkflowDecisionChoice.Cancel, overwrite = true, chosen = setOf(leveling)))
    }

    @Test
    fun anUnavailableExactNameIsNeverChosen() {
        val view = SendDialogView(confirmation(target = overwrite(false, 2048.0, reason = "An active file cannot be replaced.")))
        assertFalse(view.overwriteAllowed)
        assertEquals("An active file cannot be replaced.", view.overwriteLabel)
        assertEquals("File" to "part_0123.gcode (2 KB)", view.facts(overwrite = true)[2])
        assertFalse(view.decide(ProjectIntents.PrintWorkflowDecisionChoice.Upload, overwrite = true).overwrite)
    }

    @Test
    fun aStoredFileOnlyStarts() {
        val view = SendDialogView(confirmation(stored = true))
        assertEquals("Start stored file", view.title)
        assertEquals("Start print", view.startLabel)
        assertNull(view.uploadLabel)
        assertNull(view.overwriteLabel)
        assertFalse(view.decide(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint, overwrite = true).overwrite)
    }
}
