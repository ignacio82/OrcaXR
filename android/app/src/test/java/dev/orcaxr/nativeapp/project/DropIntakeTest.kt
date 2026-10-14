package dev.orcaxr.nativeapp.project

import dev.orcaxr.nativeapp.shell.ShellArea
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DropIntakeTest {
    private fun dropped(name: String, mimeType: String? = null, shared: Boolean = true) =
        DropIntake.Dropped("content://files/$name", name, mimeType, shared)

    @Test
    fun extensionsAreTheBrowsersFileExtension() {
        // web/src/project/import/formats/detect.ts `fileExtension`.
        assertEquals("stl", DropIntake.extension("Cube.STL"))
        assertEquals("gz", DropIntake.extension("part.tar.gz"))
        assertEquals("3mf", DropIntake.extension("folder/sub\\plate.3mf"))
        assertEquals("", DropIntake.extension(".3mf"))
        assertEquals("", DropIntake.extension("model."))
        assertEquals("", DropIntake.extension("model"))
        assertEquals("", DropIntake.extension("archive.3mf/model"))
    }

    @Test
    fun modelsImportProjectsOpenAndGcodeIsPreviewedByTheBrowsersExtensions() {
        for (name in listOf("a.stl", "a.obj", "a.amf", "a.amfz", "a.zip", "A.STL")) {
            assertEquals(name, DropIntake.Kind.Model, DropIntake.kind(name, "application/octet-stream"))
        }
        assertEquals(DropIntake.Kind.Project, DropIntake.kind("plate.3mf", null))
        for (name in listOf("a.gcode", "a.gco", "a.g")) assertEquals(name, DropIntake.Kind.Gcode, DropIntake.kind(name, "text/plain"))
        // A known extension decides over what a provider reports.
        assertEquals(DropIntake.Kind.Model, DropIntake.kind("cube.stl", "model/3mf"))
        for (name in listOf("a.step", "a.stp", "a.svg", "A.SVG")) assertNull(name, DropIntake.kind(name, "model/3mf"))
        for (name in listOf("photo.png", "notes.txt", "a.3mf.bak", "plate")) assertNull(name, DropIntake.kind(name, "text/plain"))
    }

    @Test
    fun anExtensionTheBrowserDoesNotKnowGoesByTheReportedType() {
        // The browser's content signature wins over such a name; the provider's type stands in for it.
        assertEquals(DropIntake.Kind.Project, DropIntake.kind("plate", "model/3mf"))
        assertEquals(DropIntake.Kind.Project, DropIntake.kind("plate.3mf.bak", "model/3mf"))
        assertEquals(DropIntake.Kind.Project, DropIntake.kind("plate", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"))
        assertEquals(DropIntake.Kind.Model, DropIntake.kind("cube", "MODEL/STL; charset=binary"))
        assertEquals(DropIntake.Kind.Model, DropIntake.kind("cube", "application/sla"))
        assertEquals(DropIntake.Kind.Model, DropIntake.kind("parts", "application/zip"))
        assertEquals(DropIntake.Kind.Gcode, DropIntake.kind("print", "text/x-gcode"))
        assertNull(DropIntake.kind("cube", "application/octet-stream"))
        assertNull(DropIntake.kind("cube", null))
        assertNull(DropIntake.kind("cube", ""))
    }

    @Test
    fun refusalsAreTheBrowsersStatusLine() {
        // web/src/main.ts `intakeFiles` prefixes formats/index.ts `unsupportedMessage` and detect.ts's reason.
        assertEquals("Failed to load photo.png: photo.png is not a recognised model format", DropIntake.refusal("photo.png"))
        assertEquals("Failed to load bracket.step: bracket.step is a STEP file, which this build cannot convert to a mesh",
            DropIntake.refusal("bracket.step"))
        assertEquals("Failed to load bracket.STP: bracket.STP is a STEP file, which this build cannot convert to a mesh",
            DropIntake.refusal("bracket.STP"))
        assertEquals("Failed to load logo.svg: logo.svg is an SVG; import it through the SVG/emboss workflow", DropIntake.refusal("logo.svg"))
        assertEquals("Failed to load logo: logo is an SVG; import it through the SVG/emboss workflow", DropIntake.refusal("logo", "image/svg+xml"))
        assertEquals("Failed to load part: part is a STEP file, which this build cannot convert to a mesh", DropIntake.refusal("part", "model/step"))
        // The browser would find the SVG in a file it does not know by name.
        assertEquals("Failed to load logo.png: logo.png is an SVG; import it through the SVG/emboss workflow",
            DropIntake.refusal("logo.png", "image/svg+xml"))
        assertEquals("Failed to load logo.svg: logo.svg is an SVG; import it through the SVG/emboss workflow",
            DropIntake.refusal("logo.svg", "model/step"))
    }

    @Test
    fun aDropLoadsInOrderTheLastGcodeIsShownAndTheRestIsRefused() {
        val plan = DropIntake.plan(listOf(
            dropped("a.stl"), dropped("first.gcode"), dropped("photo.png"), dropped("plate.3mf"),
            dropped("last.gcode"), dropped("b.obj"), dropped("logo.svg"),
        ))
        assertEquals(listOf("a.stl", "plate.3mf", "b.obj"), plan.project.map { it.name })
        assertEquals(listOf(DropIntake.Kind.Model, DropIntake.Kind.Project, DropIntake.Kind.Model), plan.project.map { it.kind })
        assertEquals("content://files/plate.3mf", plan.project[1].uri)
        assertEquals("last.gcode", plan.gcode?.name)
        assertEquals(
            listOf(
                "Failed to load photo.png: photo.png is not a recognised model format",
                "Failed to load logo.svg: logo.svg is an SVG; import it through the SVG/emboss workflow",
            ),
            plan.refusals,
        )
        // The import preview and the unsaved-changes question are the Project area's.
        assertEquals(ShellArea.Project, plan.area)
    }

    @Test
    fun theDropTurnsToPreviewForGcodeAloneAndStaysPutWhenEverythingIsRefused() {
        assertEquals(ShellArea.Preview, DropIntake.plan(listOf(dropped("a.gcode"))).area)
        val refused = DropIntake.plan(listOf(dropped("photo.png")))
        assertNull(refused.area)
        assertNull(refused.gcode)
        assertEquals(emptyList<DropIntake.Item>(), refused.project)
        assertNull(DropIntake.plan(emptyList()).area)
    }

    @Test
    fun aFileTheSystemDoesNotShareIsRefusedOnceAsAHandedOverDocumentIs() {
        val plan = DropIntake.plan(listOf(
            dropped("a.stl", shared = false), dropped("b.stl", shared = false), dropped("c.stl"),
        ))
        assertEquals(listOf("c.stl"), plan.project.map { it.name })
        assertEquals(listOf("OrcaXR opens only documents shared through the system."), plan.refusals)
    }

    @Test
    fun projectViewObjectCountsDetectPresenceOfModels() {
        val emptyView = dev.orcaxr.core.ProjectView(plateList = emptyList())
        org.junit.Assert.assertFalse(emptyView.hasObjects)
        assertEquals(0, emptyView.objectCount)

        val plateEmpty = dev.orcaxr.core.ProjectPlateState(id = "p1", name = "Plate 1", printable = true, objects = 0)
        val viewNoModels = dev.orcaxr.core.ProjectView(plateList = listOf(plateEmpty))
        org.junit.Assert.assertFalse(viewNoModels.hasObjects)
        assertEquals(0, viewNoModels.objectCount)

        val plateWithModels = dev.orcaxr.core.ProjectPlateState(id = "p1", name = "Plate 1", printable = true, objects = 2)
        val viewWithModels = dev.orcaxr.core.ProjectView(plateList = listOf(plateWithModels))
        org.junit.Assert.assertTrue(viewWithModels.hasObjects)
        assertEquals(2, viewWithModels.objectCount)
    }

    @Test
    fun threeMfChoiceEnumeratesAllDecisions() {
        assertEquals(listOf(ThreeMfChoice.Project, ThreeMfChoice.Geometry, ThreeMfChoice.Cancel), ThreeMfChoice.entries)
    }
}
