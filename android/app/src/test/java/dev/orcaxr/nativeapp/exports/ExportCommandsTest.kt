package dev.orcaxr.nativeapp.exports

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.StlExport
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.shell.AppActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExportCommandsTest {
    private val download = ProjectActionState(ExportCommands.DOWNLOAD, "Download", false, "Slice successfully first.")
    private val stl = ProjectActionState(ExportCommands.EXPORT_STL, "Export as one STL…", true)

    @Test fun theExportsAreTheAppsAndRunWhereverTheyAreChosen() {
        assertEquals(
            listOf("file_export_gcode", "file_export_all_plates", "file_export_stl", "file_export_all_stls", "save_gcode_to_downloads", "save_all_plate_gcode"),
            ExportCommands.IDS,
        )
        ExportCommands.IDS.forEach {
            assertTrue(it, it in AppActions.PERFORMED)
            assertTrue(it, AppActions.needsExport(it))
            // Neither the Prepare area's buttons nor the Project area's pickers: the shell's export host takes the file.
            assertFalse(it, AppActions.needsPrepare(it) || AppActions.needsProject(it) || AppActions.needsWorkspace(it))
        }
        // The File menu's export section, Download All Plates in it as the browser's menu has it.
        assertEquals(ExportCommands.IDS - ExportCommands.DOWNLOAD, ExportCommands.MENU)
        assertTrue(ExportCommands.isGcode(ExportCommands.DOWNLOAD) && ExportCommands.isGcode(ExportCommands.EXPORT_GCODE))
        assertTrue(ExportCommands.isPlates(ExportCommands.DOWNLOAD_ALL) && ExportCommands.isPlates(ExportCommands.EXPORT_ALL_PLATES))
        assertFalse(ExportCommands.isGcode(ExportCommands.EXPORT_STL) || ExportCommands.isPlates(ExportCommands.EXPORT_ALL_STLS))
    }

    @Test fun eachIsEnabledAsTheCoresGateJudgesItOneAtATime() {
        val core = mapOf(download.id to download, stl.id to stl)
        // The core's gate with the Prepare area's facts: its reason when it refuses.
        assertEquals(download, ExportCommands.state(download.copy(reason = null), core, busy = false))
        assertEquals(stl, ExportCommands.state(stl, core, busy = false))
        // Another export being written: none starts, and it says why.
        assertEquals(stl.copy(enabled = false, reason = ExportCommands.BUSY), ExportCommands.state(stl, core, busy = true))
        // Not read yet: not offered.
        assertFalse(ExportCommands.state(ProjectActionState(ExportCommands.EXPORT_ALL_STLS, "x", true), core, busy = false).enabled)
        // Any other action is not the exports' to judge.
        val undo = ProjectActionState("edit_undo", "Undo", true)
        assertEquals(undo, ExportCommands.state(undo, core, busy = true))
    }

    @Test fun theStatusIsTheBrowsers() {
        val written = StlExport.Written("cube.stl", "model/stl", 1234, 2, listOf("a", "b"))
        val group = { n: Long -> "%,d".format(java.util.Locale.US, n) }
        assertEquals(
            ExportWords(text = "Exported 2 models as 1,234 STL triangles."),
            ExportCommands.stlWritten(ExportCommands.EXPORT_STL, written, group),
        )
        assertEquals(
            ExportWords(text = "Exported 1 model as 1 STL triangle."),
            ExportCommands.stlWritten(ExportCommands.EXPORT_STL, written.copy(triangleCount = 1, instanceCount = 1), group),
        )
        assertEquals(ExportWords(R.string.export_all_stls_done), ExportCommands.stlWritten(ExportCommands.EXPORT_ALL_STLS, written, group))
        assertEquals(ExportWords(text = "STL export failed: No models"), ExportCommands.stlRefused(ExportCommands.EXPORT_STL, "No models"))
        assertEquals(ExportWords(R.string.export_stl_failed), ExportCommands.stlRefused(ExportCommands.EXPORT_ALL_STLS, "No models to export"))
        assertEquals(ExportWords(text = "Downloaded 2 plate G-code file(s)."), ExportCommands.downloaded(2))
        assertEquals(R.string.export_slice_all_first, ExportCommands.SLICE_ALL_FIRST.message)
        assertEquals(R.string.export_stale, ExportCommands.STALE.message)
        assertEquals(R.string.export_nothing_to_slice, ExportCommands.NOTHING_TO_SLICE.message)
        // A catalogued message is read in the operator's language; literal words are shown as they are.
        assertEquals("translated", ExportCommands.text(ExportCommands.STALE) { "translated" })
        assertEquals("Downloaded 1 plate G-code file(s).", ExportCommands.text(ExportCommands.downloaded(1)) { error("no resource") })
        assertNull(ExportCommands.downloaded(1).message)
    }

    @Test fun aProvidersFailureIsSaidInWords() {
        assertEquals("There is no room left for a.stl. Free some space or choose another place.", ExportCommands.failed("a.stl", "document_storage_full").text)
        assertEquals("OrcaXR can no longer write to a.stl. Choose the place again.", ExportCommands.failed("a.stl", "document_permission").text)
        assertEquals("OrcaXR can no longer write to a.stl. Choose the place again.", ExportCommands.failed("a.stl", "document_unavailable").text)
        assertEquals("a.stl cannot be written there. Choose another place.", ExportCommands.failed("a.stl", "document_not_writable").text)
        assertEquals("a.stl could not be written.", ExportCommands.failed("a.stl", null).text)
        assertEquals("Saved orcaxr.gcode.", ExportCommands.saved("orcaxr.gcode").text)
        // A document's type is the one the device associates with its extension, else one that keeps any name.
        val known = mapOf("zip" to "application/zip", "json" to "application/json")
        assertEquals("application/zip", ExportCommands.documentType("Untitled_project_stls.zip", known::get))
        assertEquals("application/json", ExportCommands.documentType("orcaxr_config.JSON", known::get))
        assertEquals("application/octet-stream", ExportCommands.documentType("orcaxr.gcode", known::get))
        assertEquals("application/octet-stream", ExportCommands.documentType("noextension", known::get))
    }
}
