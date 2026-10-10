package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.TransformTool
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TransformInspectorTest {
    private val shown = listOf("100.00", "95.00", "0.00")

    @Test
    fun theInspectorShowsTheBrowsersToolsAndGatesThemAsItsRegistry() {
        assertEquals(listOf(TransformTool.MOVE, TransformTool.ROTATE, TransformTool.SCALE), TransformInspector.TOOLS)
        // main.ts invokes `tool_<mode>` on dom-inspector for a field edit.
        assertEquals(listOf("tool_move", "tool_rotate", "tool_scale"), TransformInspector.TOOLS.map(TransformInspector::action))
        assertEquals(listOf("Move (mm)", "Rotate (deg)", "Scale (%)"), TransformInspector.TOOLS.map { it.title })
    }

    @Test
    fun aChangedFieldSubmitsTheThreeTextsAsTyped() {
        // The input's change event: the edited field differs from what it showed; all three texts go, as typed.
        assertEquals(listOf("50", "95.00", "0.00"), TransformInspector.change(shown, listOf("50", "95.00", "0.00"), 0))
        // Unreadable text is the core's to read (`parseFloat`, as 0), not the inspector's to refuse.
        assertEquals(listOf("100.00", "abc", "0.00"), TransformInspector.change(shown, listOf("100.00", "abc", "0.00"), 1))
        // Leaving a field unchanged is no change.
        assertNull(TransformInspector.change(shown, shown, 2))
        assertNull(TransformInspector.change(shown, listOf("100.00", "95.00", "0.00"), 0))
    }

    @Test
    fun fieldsFollowTheSelectionExceptTheOneBeingTyped() {
        val next = listOf("120.00", "95.00", "20.00")
        // The browser updates every input but the active one.
        assertEquals(listOf("120.00", "9", "20.00"), TransformInspector.follow(next, listOf("100.00", "9", "0.00"), 1))
        // After an edit (a refused one too), nothing focused: every field shows the selection's value again.
        assertEquals(next, TransformInspector.follow(next, listOf("0", "9", "x"), null))
    }
}
