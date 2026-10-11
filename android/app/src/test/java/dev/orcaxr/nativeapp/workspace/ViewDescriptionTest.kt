package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.ProjectSceneSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class ViewDescriptionTest {
    private val words = ViewDescription.Words(
        plate = { name, count -> "$name · $count object(s)" },
        empty = "Nothing on this plate yet.",
        selection = "Selection",
        nothingSelected = "Nothing selected",
    )

    @Test fun anEmptyPlateSaysSo() {
        assertEquals("Plate 1. Nothing on this plate yet.", ViewDescription.workspace(ProjectSceneSummary("Plate 1", 0, emptyList(), 0), words))
    }

    @Test fun thePlateItsObjectsAndTheSelectionByName() {
        assertEquals(
            "Plate 1 · 2 object(s). Selection: cube.stl, cylinder.stl",
            ViewDescription.workspace(ProjectSceneSummary("Plate 1", 2, listOf("cube.stl", "cylinder.stl"), 2), words),
        )
        assertEquals("Plate 2 · 1 object(s). Nothing selected", ViewDescription.workspace(ProjectSceneSummary("Plate 2", 1, emptyList(), 0), words))
        // A selection the session could not name is still counted.
        assertEquals("Plate 1 · 3 object(s). Selection: 2", ViewDescription.workspace(ProjectSceneSummary("Plate 1", 3, emptyList(), 2), words))
    }

    @Test fun nothingBeforeTheSessionHasAPlate() {
        assertEquals("", ViewDescription.workspace(ProjectSceneSummary(null, 0, emptyList(), 0), words))
    }
}
