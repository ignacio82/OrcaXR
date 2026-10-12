package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.LayerRangeCheck
import dev.orcaxr.core.LayerRangeEntry
import dev.orcaxr.core.LayerRangeMerge
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.SettingsPanelApply
import dev.orcaxr.core.SettingsPanelState
import dev.orcaxr.core.SettingsPanelView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InspectorPanelsTest {
    private fun units(text: String) = text.map { it.code }
    private fun row(kind: ProjectIntents.ObjectTreeRowKind, owner: ProjectIntents.ObjectTreeEntity?, entity: ProjectIntents.ObjectTreeEntity? = null) =
        ProjectIntents.ObjectTreeRow(
            units("row"), kind, ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), units("Settings"),
            ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
            entity?.let { ProjectIntents.OptionalObjectTreeEntity.Value(it) } ?: ProjectIntents.OptionalObjectTreeEntity.Absent(ProjectIntents.Empty),
            owner?.let { ProjectIntents.OptionalObjectTreeEntity.Value(it) } ?: ProjectIntents.OptionalObjectTreeEntity.Absent(ProjectIntents.Empty),
            ProjectIntents.ObjectTreeIndicators(
                ProjectIntents.ObjectTreePrintable.Printable, ProjectIntents.OptionalObjectTreeFilament.Absent(ProjectIntents.Empty),
                ProjectIntents.OptionalObjectTreePaint.Absent(ProjectIntents.Empty), true,
                ProjectIntents.OptionalCounter.Absent(ProjectIntents.Empty), ProjectIntents.OptionalVolumeRoleName.Absent(ProjectIntents.Empty),
            ),
            matchedFilter = true, focused = false, selected = false, level = 2, positionInSet = 1, setSize = 1,
            expansion = ProjectIntents.ObjectTreeRowExpansion.Leaf,
        )

    @Test
    fun settingsAndLayerRangeRowsOpenTheirNodesPanels() {
        val cube = ProjectIntents.ObjectTreeEntity.Object(units("o1"))
        val body = ProjectIntents.ObjectTreeEntity.Volume(units("v1"))
        assertEquals(InspectorPanel.Settings("object:o1"), InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.Settings, cube)))
        assertEquals(InspectorPanel.Settings("part:v1"), InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.Settings, body)))
        assertEquals(InspectorPanel.HeightRanges("o1"), InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.LayerGroup, cube)))
        // Rows of entities select; the instances group opens and closes; none opens a panel.
        assertNull(InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.Object, null, cube)))
        assertNull(InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.InstanceGroup, cube)))
        assertNull(InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.LayerRange, null, ProjectIntents.ObjectTreeEntity.LayerRange(units("r1")))))
        assertNull(InspectorRows.opens(row(ProjectIntents.ObjectTreeRowKind.Settings, null)))
    }

    private val view = SettingsPanelView(40, 4, "40 settings shown; 4 unavailable.", emptyList())
    private fun shell(drafts: Int = 0, changed: Boolean = drafts > 0, invalid: Boolean = false) =
        SettingsShell("object:o1", view = view, draft = SettingsPanelState(changed, drafts, invalid), revision = 7, loading = false)

    @Test
    fun applyWaitsForAValidChangeOnTheStateItBeganOn() {
        // The browser's `syncControlState`: a changed, valid draft, not busy, not loading, no conflict.
        assertFalse(shell().canApply)
        assertTrue(shell(drafts = 1).canApply)
        assertFalse(shell(drafts = 1, invalid = true).canApply)
        // A draft that sets what the node holds changes nothing.
        assertFalse(shell(drafts = 1, changed = false).canApply)
        assertFalse(shell(drafts = 1).copy(busy = true).canApply)
        assertFalse(shell(drafts = 1).copy(loading = true).canApply)
        assertFalse(shell(drafts = 1).copy(conflict = true).canApply)
        assertTrue(shell(drafts = 1).copy(conflict = true).canCancel)
        assertFalse(SettingsShell("object:o1").interactive)
    }

    @Test
    fun aProjectChangeReloadsACleanPanelAndKeepsADraftAsAConflict() {
        // `handleAuthorityChanged`.
        assertEquals(SettingsRefresh.None, shell().projectChanged(7))
        assertEquals(SettingsRefresh.None, shell().projectChanged(null))
        assertEquals(SettingsRefresh.Reload, shell().projectChanged(8))
        assertEquals(SettingsRefresh.Conflict, shell(drafts = 2).projectChanged(8))
        assertEquals(SettingsRefresh.Later, shell(drafts = 2).copy(busy = true).projectChanged(8))
        assertEquals(SettingsRefresh.Later, shell().copy(loading = true).projectChanged(8))
    }

    @Test
    fun applyAnswersBeforeSubmittingAsTheBrowserPanelDoes() {
        val start = shell(drafts = 1)
        // `applyDrafts`: a commit to submit goes on; the rest answer at once in the browser's words.
        assertNull(start.prepared(SettingsPanelApply.Committed(2)))
        assertEquals(SettingsNote.NothingToApply, start.prepared(SettingsPanelApply.Unchanged)?.note)
        assertEquals(
            SettingsError(SettingsErrorKind.FixHighlighted, "Settings draft contains 1 validation issue"),
            start.prepared(SettingsPanelApply.Invalid("Settings draft contains 1 validation issue"))?.error,
        )
        assertEquals(SettingsError(SettingsErrorKind.NotValidated, "boom"), start.prepared(SettingsPanelApply.Failed("boom"))?.error)
        // Validation refusals leave the operation status as it was.
        assertNull(start.copy(note = null).prepared(SettingsPanelApply.Invalid("x"))?.note)
    }

    @Test
    fun rangeFormsShowTheirWordsAsTheSemanticEditorDoes() {
        val invalid = LayerRangeCheck.Invalid("Enter finite minimum and maximum Z values.")
        val valid = LayerRangeCheck.Valid(listOf(0.0, 5.0))
        // The add form speaks once typed in; the selected range's form whenever its bounds are invalid.
        assertNull(RangeForms.boundsMessage(invalid, RangeForm(), editing = false))
        assertEquals(invalid.message, RangeForms.boundsMessage(invalid, RangeForm("x", "", touched = true), editing = false))
        assertEquals(invalid.message, RangeForms.boundsMessage(invalid, RangeForm("0", "5"), editing = true))
        assertNull(RangeForms.boundsMessage(valid, RangeForm("0", "5", touched = true), editing = true))
        // A split speaks once typed in.
        assertNull(RangeForms.splitMessage(LayerRangeCheck.Invalid("Split height must be strictly inside 0 mm–5 mm."), RangeForm()))
        assertEquals("s", RangeForms.splitMessage(LayerRangeCheck.Invalid("s"), RangeForm("9", touched = true)))
        // The edit form opens with the bounds as the browser's input writes a number.
        assertEquals(RangeForm("0", "7.300000000000001"), RangeForms.editForm(LayerRangeEntry("r", 0.0, 7.300000000000001, "0 mm–7.3 mm")))
        assertEquals(RangeForm("2.5", "1e-7"), RangeForms.editForm(LayerRangeEntry("r", 2.5, 1e-7, "")))
        // A merge names its neighbour, or says why not.
        assertEquals("r2" to null, RangeForms.merge(LayerRangeMerge(true, "r2", null)))
        assertEquals(null to "There is no previous height range.", RangeForms.merge(LayerRangeMerge(false, null, "There is no previous height range.")))
    }
}
