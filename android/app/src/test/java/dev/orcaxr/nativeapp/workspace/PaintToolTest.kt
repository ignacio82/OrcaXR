package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.core.PaintToolSettings
import dev.orcaxr.core.ProjectIntents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PaintToolTest {
    private fun text(value: String) = ProjectIntents.PaintValueInput.Text(value.map { it.code })
    private val palette = listOf(
        PaintRow(null, "Default (inherit)", "#ff0000", emptyList(), "0", null, null, true, null),
        PaintRow("red", "Red PLA", "#ff0000", emptyList(), "T0", "PLA", 1, true, null),
        PaintRow("mix", "Off mix", "#800080", listOf("#ff0000", "#0000ff"), "Ratio", "50% T0 / 50% T1", null, false, "This virtual filament is disabled and cannot be painted."),
        PaintRow("blue", "Blue PETG", "#0000ff", emptyList(), "T1", "PETG", 2, true, null),
    )

    @Test fun enteringColourPaintTakesTheFirstFilamentAndSaysHow() {
        val (state, status) = PaintToolState().start(PaintChannel.COLOR, palette)
        assertTrue(state.active)
        assertEquals("red", state.filamentId)
        assertEquals(PaintStatus.Tool(PaintChannel.COLOR), status)
        assertEquals(PaintToolSettings.WORKSPACE, state.settings)
        assertEquals(text("red"), state.target())
        // A filament already chosen, or erasing, is kept.
        val chosen = state.chooseFilament("blue", palette).first.stop()
        assertEquals("blue", chosen.start(PaintChannel.COLOR, palette).first.filamentId)
        val erasing = state.chooseFilament(null, palette).first.stop()
        assertNull(erasing.start(PaintChannel.COLOR, palette).first.filamentId)
        // Without filaments there is nothing to take: strokes erase.
        assertNull(PaintToolState().start(PaintChannel.COLOR, palette.take(1)).first.target())
    }

    @Test fun paletteChoicesAndKeysFollowTheBrowsersWorkspace() {
        val state = PaintToolState().start(PaintChannel.COLOR, palette).first
        assertEquals(PaintStatus.Filament("Blue PETG"), state.chooseFilament("blue", palette).second)
        assertEquals(PaintStatus.EraseToDefault, state.chooseFilament(null, palette).second)
        assertEquals(PaintMode.ERASE, state.chooseFilament(null, palette).first.mode)
        assertTrue(state.chooseFilament(null, palette).first.erasing())
        assertNull(state.chooseFilament(null, palette).first.target())
        assertEquals(state to PaintStatus.NotInProject, state.chooseFilament("gone", palette))
        assertEquals(state to PaintStatus.Unavailable("This virtual filament is disabled and cannot be painted."), state.chooseFilament("mix", palette))
        // Keys follow the displayed numbers over selectable rows.
        assertEquals("blue", state.chooseNumber(2, palette)!!.first.filamentId)
        assertNull(state.chooseNumber(3, palette))
        // Choosing a filament after erasing paints again.
        assertEquals(PaintMode.PAINT, state.chooseFilament(null, palette).first.chooseFilament("red", palette).first.mode)
    }

    @Test fun channelsPaintTheirStatesAndEraseToUnpainted() {
        val support = PaintToolState().start(PaintChannel.SUPPORT, palette)
        assertEquals(PaintStatus.Tool(PaintChannel.SUPPORT), support.second)
        assertEquals(text("enforce"), support.first.target())
        val (block, said) = support.first.chooseChannelState(text("block"))!!
        assertEquals(PaintStatus.ChannelState(PaintChannel.SUPPORT, "block"), said)
        assertEquals(text("block"), block.target())
        assertNull(block.chooseMode(PaintMode.ERASE).target())
        assertEquals(ProjectIntents.PaintValueInput.Flag(true), PaintToolState().start(PaintChannel.FUZZY_SKIN, palette).first.target())
        assertEquals("true", PaintToolState.stateText(ProjectIntents.PaintValueInput.Flag(true)))
        // Colour has no channel states.
        assertNull(PaintToolState().chooseChannelState(text("enforce")))
        assertEquals(listOf("enforce", "block"), PaintToolState.CHANNEL_STATES.getValue(PaintChannel.SUPPORT).map { it.key })
    }

    @Test fun toolsAndParametersAreThePanelsWithItsLimitsAndSteps() {
        val (sphere, said) = PaintToolState().chooseTool(PaintToolKind.SPHERE)
        assertEquals(PaintStatus.ToolKind(PaintToolKind.SPHERE), said)
        assertEquals(PaintToolKind.SPHERE, sphere.settings.tool)
        assertEquals(listOf(PaintParameter.RADIUS), PaintToolState.parameters(PaintToolKind.CIRCLE))
        assertEquals(listOf(PaintParameter.SMART_FILL_ANGLE, PaintParameter.GAP_AREA), PaintToolState.parameters(PaintToolKind.GAP_FILL))
        assertEquals(emptyList<PaintParameter>(), PaintToolState.parameters(PaintToolKind.TRIANGLE))
        // The panel's fields show their defaults, clamp what is typed and keep it.
        val state = PaintToolState()
        assertEquals(4.0, state.value(PaintParameter.RADIUS), 0.0)
        assertEquals(1.0, state.value(PaintParameter.HEIGHT_RANGE), 0.0)
        assertEquals(2.0, state.value(PaintParameter.GAP_AREA), 0.0)
        assertEquals(8.0, state.chooseParameter(PaintParameter.RADIUS, 12.0).settings.radiusMm!!, 0.0)
        assertEquals(.1, state.chooseParameter(PaintParameter.HEIGHT_RANGE, 0.0).settings.heightRangeMm!!, 0.0)
        assertEquals(state, state.chooseParameter(PaintParameter.RADIUS, Double.NaN))
        // A slider holds the step: 0.4…8 by 0.1 has 75 stops between its ends.
        assertEquals(75, PaintParameter.RADIUS.steps)
        assertEquals(89, PaintParameter.SMART_FILL_ANGLE.steps)
        assertEquals(24, PaintParameter.GAP_AREA.steps)
        assertEquals(2.5, PaintParameter.RADIUS.stepped(2.53), 0.0)
        assertEquals(1.2, PaintParameter.GAP_AREA.stepped(1.29), 0.0)
        assertEquals(8.0, PaintParameter.RADIUS.stepped(9.0), 0.0)
    }

    @Test fun refusalsSayWhatTheBrowsersPainterSays() {
        assertEquals("parameter-modifier volumes cannot be colour painted",
            PaintFailures.open("unsupported_role", "v", ProjectIntents.VolumeRoleName.ParameterModifier, PaintChannel.COLOR, null, palette))
        assertEquals("Unknown filament gone",
            PaintFailures.open("unknown_filament", "v", ProjectIntents.VolumeRoleName.Model, PaintChannel.COLOR, text("gone"), palette))
        assertEquals("This virtual filament is disabled and cannot be painted.",
            PaintFailures.open("unavailable_filament", "v", null, PaintChannel.COLOR, text("mix"), palette))
        assertEquals("prefer is not a valid support state",
            PaintFailures.open("invalid_target", "v", null, PaintChannel.SUPPORT, text("prefer"), palette))
        assertEquals("Invalid facet annotations (2 issues)", PaintFailures.sample(ProjectIntents.PaintStrokeSampleReply.Invalid(List(2) {
            ProjectIntents.FacetRegionIssue(emptyList(), emptyList(), emptyList())
        })))
        assertEquals("Facet annotation result is stale (topology)", PaintFailures.sample(ProjectIntents.PaintStrokeSampleReply.Stale(ProjectIntents.Empty)))
        assertFalse(PaintFailures.sample(ProjectIntents.PaintStrokeSampleReply.Sampled(ProjectIntents.PaintStrokeSampled(1, 0, 0, 1, false))) != null)
    }

    @Test fun rowsComeFromTheCoresPalette() {
        fun units(text: String) = text.map { it.code }
        val absent = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
        val rows = PaintRow.of(
            ProjectIntents.PaintPalette(
                listOf(
                    ProjectIntents.PaintPaletteEntry(absent, ProjectIntents.PaintPaletteKind.Default, units("Default (inherit)"), units("#9aa0a6"),
                        ProjectIntents.OptionalTextList.Absent(ProjectIntents.Empty), units("0"), absent, ProjectIntents.OptionalCounter.Absent(ProjectIntents.Empty),
                        ProjectIntents.OptionalCounter.Absent(ProjectIntents.Empty), true, absent),
                    ProjectIntents.PaintPaletteEntry(ProjectIntents.OptionalText.Value(units("red")), ProjectIntents.PaintPaletteKind.Physical, units("Red"), units("#ff0000"),
                        ProjectIntents.OptionalTextList.Absent(ProjectIntents.Empty), units("T0"), ProjectIntents.OptionalText.Value(units("PLA")),
                        ProjectIntents.OptionalCounter.Value(1), ProjectIntents.OptionalCounter.Value(1), true, absent),
                ),
                1, 0,
            ),
        )
        assertEquals(listOf(null, "red"), rows.map { it.filamentId })
        assertEquals(listOf(null, 1), rows.map { it.keyboardNumber })
        assertEquals("PLA", rows[1].recipe)
    }
}
