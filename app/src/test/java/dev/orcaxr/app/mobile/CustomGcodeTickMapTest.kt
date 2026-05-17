package dev.orcaxr.app.mobile

import dev.orcaxr.app.SlicerEngine
import dev.orcaxr.app.mcp.WorkspaceAction
import org.junit.Assert.assertEquals
import org.junit.Test

/** Locks the AddCustomGcodeTick → CustomGcodeTick mapping the
 *  re-architected binding uses (must match the XR handler's kinds). */
class CustomGcodeTickMapTest {

    private fun act(kind: String) = WorkspaceAction.AddCustomGcodeTick(
        plateId = 1, zMm = 3.5f, kind = kind, extruder = 2, color = "#FF0000", extra = "M600",
    )

    @Test fun knownKindsMapByName() {
        assertEquals(SlicerEngine.CustomGcodeKind.ColorChange, customGcodeTickOf(act("ColorChange")).kind)
        assertEquals(SlicerEngine.CustomGcodeKind.PausePrint, customGcodeTickOf(act("PausePrint")).kind)
        assertEquals(SlicerEngine.CustomGcodeKind.ToolChange, customGcodeTickOf(act("ToolChange")).kind)
        assertEquals(SlicerEngine.CustomGcodeKind.Template, customGcodeTickOf(act("Template")).kind)
        assertEquals(SlicerEngine.CustomGcodeKind.Custom, customGcodeTickOf(act("Custom")).kind)
    }

    @Test fun unknownKindFallsBackToCustom() {
        assertEquals(SlicerEngine.CustomGcodeKind.Custom, customGcodeTickOf(act("nonsense")).kind)
        assertEquals(SlicerEngine.CustomGcodeKind.Custom, customGcodeTickOf(act("")).kind)
    }

    @Test fun scalarFieldsPassThrough() {
        val t = customGcodeTickOf(act("ColorChange"))
        assertEquals(3.5f, t.printZmm, 0f)
        assertEquals(2, t.extruder)
        assertEquals("#FF0000", t.color)
        assertEquals("M600", t.extra)
    }
}
