package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.renderer.filament.FilamentScene
import org.junit.Assert.assertEquals
import org.junit.Test

class ToolPickTest {
    private fun pick(volumeId: String) = FilamentScene.Pick("draw:$volumeId", "instance", 3, .5, volumeId)

    @Test fun aPickOnNothingMissed() {
        assertEquals(ToolPick.Missed, ToolPick.of(null, setOf("sphere")))
    }

    @Test fun aPickOnAPreviewedPartIsRefused() {
        assertEquals(ToolPick.Previewed, ToolPick.of(pick("sphere"), setOf("sphere")))
    }

    @Test fun aPickOnAPartThePreviewLeavesAloneIsThePart() {
        val other = pick("cube")
        assertEquals(ToolPick.Part(other), ToolPick.of(other, setOf("sphere")))
        // Without a preview every part is the project's.
        assertEquals(ToolPick.Part(other), ToolPick.of(other, emptySet()))
    }
}
