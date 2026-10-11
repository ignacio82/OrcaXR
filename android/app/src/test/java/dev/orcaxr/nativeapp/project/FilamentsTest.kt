package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.FilamentAssignment
import dev.orcaxr.core.FilamentOption
import dev.orcaxr.core.FilamentRef
import dev.orcaxr.core.FilamentScope
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.SlicingHead
import dev.orcaxr.core.SlicingSlot
import dev.orcaxr.core.SlicingSlots
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FilamentsTest {
    private fun physical(id: String, tool: Int, name: String, color: String = "#ff0000", enabled: Boolean = true) =
        FilamentOption(id, false, name, color, enabled, "PLA", null, tool, null, emptyList(), emptyList())
    private fun mixed(id: String, name: String, enabled: Boolean = true, warnings: List<String> = emptyList()) =
        FilamentOption(id, true, name, "#777777", enabled, "PLA", null, null, "ratio", emptyList(), warnings)
    private fun scope(kind: FilamentRef.Kind, id: String, label: String, local: String? = null) =
        FilamentScope(FilamentRef(kind, id), "object", label, local, null, local)

    private val options = listOf(
        physical("p0", 0, "Head 1 PLA"),
        physical("p1", 1, "Head 2 PLA", enabled = false),
        mixed("m0", "Blend"),
        physical("p4", 4, "Extra"),
    )
    private fun slot(color: String, type: String = "PLA") = SlicingSlot(color, type)
    private val view = ProjectView(
        filaments = FilamentAssignment(options = options),
        filamentSlots = SlicingSlots(
            listOf(SlicingHead("Head 1 PLA"), SlicingHead("Head 2 PLA"), SlicingHead("Extra")),
            listOf("0.4", "0.6", "0.4"),
            listOf(slot("#ff0000"), slot("#00ff00", "PETG"), slot("#cccccc")),
        ),
    )

    @Test
    fun theListNamesHeadsAndExtraPaletteSlotsAsTheHeadsPanel() {
        val slots = Filaments.slots(view, extruders = 2)
        assertEquals(listOf("H-1:", "H-2:", "A-3:"), slots.map { it.label })
        assertEquals(listOf("1", "2", "3"), slots.map { it.number })
        assertEquals(listOf(false, false, true), slots.map { it.removable })
        assertEquals(listOf("0.4", "0.6", "0.4"), slots.map { it.nozzle })
        assertEquals("PETG", slots[1].type)
        assertFalse("a disabled head is shown as one", slots[1].enabled)
        // A printer without a profile's heads (an opened project) has one head, as the browser's `profileExtruderCount`.
        assertEquals(listOf("H-1:", "A-2:", "A-3:"), Filaments.slots(view, extruders = 0).map { it.label })
        assertEquals(listOf("Blend"), Filaments.mixed(view).map { it.name })
    }

    @Test
    fun theBarShowsOnlyForAnAssignableSelection() {
        assertFalse(Filaments.shown(FilamentAssignment(options = options)))
        val one = FilamentAssignment(listOf(scope(FilamentRef.Kind.OBJECT, "o", "Cube")), emptyList(), options)
        assertTrue(Filaments.shown(one))
        assertEquals("Cube", Filaments.scopeLabel(one))
        // A plate in the selection hides it: the bar never applies to only part of a selection.
        assertFalse(Filaments.shown(one.copy(unsupported = listOf(FilamentRef(FilamentRef.Kind.PLATE, "p")))))
        val two = one.copy(scopes = one.scopes + scope(FilamentRef.Kind.VOLUME, "v", "Cube / Lid"))
        assertNull("several scopes are counted, not named", Filaments.scopeLabel(two))
        // Heads first, then mixed recipes; numbers are heads' own, M for a recipe.
        assertEquals(listOf("p0", "p1", "p4", "m0"), Filaments.chips(one).map { it.id })
        assertEquals(listOf("1", "2", "5", "M"), Filaments.chips(one).map(Filaments::chipIndex))
        assertFalse("a disabled filament cannot be pressed", Filaments.chipEnabled(options[1], assigning = false))
        assertFalse("nothing can be pressed while assigning", Filaments.chipEnabled(options[0], assigning = true))
    }

    @Test
    fun theSharedChoiceIsPressedOnlyWhenEveryScopeHasIt() {
        fun of(vararg locals: String?) = FilamentAssignment(locals.mapIndexed { i, local -> scope(FilamentRef.Kind.VOLUME, "v$i", "v$i", local) }, emptyList(), options)
        assertEquals(Filaments.Choice.Default, Filaments.uniform(of(null, null)))
        assertEquals(Filaments.Choice.Filament("p0"), Filaments.uniform(of("p0", "p0")))
        assertNull(Filaments.uniform(of("p0", null)))
        assertNull(Filaments.uniform(of("p0", "m0")))
        assertNull(Filaments.uniform(FilamentAssignment()))
    }

    @Test
    fun aPressSaysWhatItDid() {
        assertEquals(Filaments.Status.Assigned("Blend"), Filaments.finished("m0", "Blend", null))
        assertEquals(Filaments.Status.Cleared, Filaments.finished(null, "Default", null))
        assertEquals(
            Filaments.Status.Failed("Destination filament p1 is disabled"),
            Filaments.finished("p1", "Head 2 PLA", IllegalStateException("Destination filament p1 is disabled")),
        )
    }

    private fun units(text: String) = text.map { it.code }

    @Test
    fun treeIndicatorsFollowTheObjectsPanel() {
        val row = ProjectIntents.ObjectTreeRow(
            units("volume:v"), ProjectIntents.ObjectTreeRowKind.Volume, ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), units("Lid"),
            ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
            ProjectIntents.OptionalObjectTreeEntity.Value(ProjectIntents.ObjectTreeEntity.Volume(units("v"))),
            ProjectIntents.OptionalObjectTreeEntity.Absent(ProjectIntents.Empty),
            ProjectIntents.ObjectTreeIndicators(
                ProjectIntents.ObjectTreePrintable.NotPrintable,
                ProjectIntents.OptionalObjectTreeFilament.Value(ProjectIntents.ObjectTreeFilament(units("m0"), units("Blend"), units("#777777"), mixed = true, inherited = true)),
                ProjectIntents.OptionalObjectTreePaint.Value(ProjectIntents.ObjectTreePaint(colorFacetCount = 3, supportFacetCount = 0)),
                true,
                ProjectIntents.OptionalCounter.Value(2),
                ProjectIntents.OptionalVolumeRoleName.Value(ProjectIntents.VolumeRoleName.ParameterModifier),
            ),
            matchedFilter = true, focused = false, selected = false, level = 2, positionInSet = 1, setSize = 1,
            expansion = ProjectIntents.ObjectTreeRowExpansion.Leaf,
        )
        assertEquals(
            listOf(
                Filaments.Indicator.NotPrintable,
                Filaments.Indicator.Role("parameter-modifier"),
                Filaments.Indicator.Filament("Blend", "#777777", mixed = true, inherited = true),
                Filaments.Indicator.ColorFacets(3),
                Filaments.Indicator.Settings(2),
            ),
            Filaments.indicators(row),
        )
    }

    @Test
    fun coloursAreDrawnAndPickedAsTheBrowserTakesThem() {
        assertEquals(0xffff8800, Filaments.argb("#ff8800"))
        assertEquals(0xffff8800, Filaments.argb("#F80"))
        assertEquals(0x80ff8800, Filaments.argb("#ff880080"))
        assertNull(Filaments.argb("red"))
        assertNull(Filaments.argb("#"))
        assertNull(Filaments.argb("#\ud800ab"))
        // The colour input reports `#rrggbb` in lower case.
        assertEquals("#abcdef", Filaments.picked("ABCDEF"))
        assertEquals("#abcdef", Filaments.picked(" #AbCdEf "))
        assertNull(Filaments.picked("#abc"))
        assertNull(Filaments.picked("#abcdeg"))
        assertTrue(Filaments.SWATCHES.all { Filaments.picked(it) == it })
    }
}
