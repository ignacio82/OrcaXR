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
        // The input's change event: the edited field differs from what it held when focused; all three texts go, as typed.
        assertEquals(listOf("50", "95.00", "0.00"), TransformInspector.change("100.00", listOf("50", "95.00", "0.00"), 0))
        // Unreadable text is the core's to read (`parseFloat`, as 0), not the inspector's to refuse.
        assertEquals(listOf("100.00", "abc", "0.00"), TransformInspector.change("95.00", listOf("100.00", "abc", "0.00"), 1))
        // Leaving a field unchanged is no change.
        assertNull(TransformInspector.change("0.00", shown, 2))
        assertNull(TransformInspector.change("100.00", listOf("100.00", "95.00", "0.00"), 0))
    }

    @Test
    fun aChangeFiresOnceForEachNewText() {
        // Enter changed the field to "50" and kept the focus; the selection now shows "50.00" elsewhere. Leaving
        // the field fires no second change for the same "50", as the browser's input does not.
        assertNull(TransformInspector.change("50", listOf("50", "95.00", "0.00"), 0))
        // Typing on after Enter is a new change.
        assertEquals(listOf("55", "95.00", "0.00"), TransformInspector.change("50", listOf("55", "95.00", "0.00"), 0))
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
