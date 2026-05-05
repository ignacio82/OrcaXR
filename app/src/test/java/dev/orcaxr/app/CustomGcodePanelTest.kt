package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A11 — pure-Kotlin contract tests for the CustomGcodePanel's data layer.
 * The Compose host is integration-tested via the existing
 * BindWorkspaceModel path (CustomGcodeStore → WorkspaceAction round-trip).
 * These tests pin the validator + summary-line copy + engine-kind
 * mapping so a copy edit doesn't silently break the panel UX.
 */
class CustomGcodePanelTest {

    // -----------------------------------------------------------------
    // CustomGcodeAuthoring.validate
    // -----------------------------------------------------------------

    @Test fun rejectsNonPositiveZ() {
        val v = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.PausePrint,
            zMm = 0f,
            extruder = 0,
            color = "",
            extra = "stop",
        )
        assertFalse(v.ok)
        assertNotNull(v.reason)
        assertTrue(v.reason!!.contains("Z", ignoreCase = true))
    }

    @Test fun rejectsZAboveMaxCeiling() {
        val v = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.PausePrint,
            zMm = 50f,
            extruder = 0,
            color = "",
            extra = "stop",
            maxZmm = 30f,
        )
        assertFalse(v.ok)
        assertTrue(v.reason!!.contains("exceeds", ignoreCase = true))
    }

    @Test fun pauseRequiresMessage() {
        val v = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.PausePrint,
            zMm = 5f,
            extruder = 0,
            color = "",
            extra = "",
        )
        assertFalse(v.ok)
        assertTrue(v.reason!!.contains("Operator note"))
    }

    @Test fun templateRequiresSnippet() {
        val v = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.Template,
            zMm = 5f,
            extruder = 0,
            color = "",
            extra = "  ",
        )
        assertFalse(v.ok)
        assertTrue(v.reason!!.contains("snippet", ignoreCase = true))
    }

    @Test fun colorChangeRequiresValidHex() {
        val bad = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.ColorChange,
            zMm = 5f,
            extruder = 1,
            color = "red",
            extra = "",
        )
        assertFalse(bad.ok)
        val good = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.ColorChange,
            zMm = 5f,
            extruder = 1,
            color = "#FF0000",
            extra = "",
        )
        assertTrue(good.ok)
        assertNull(good.reason)
        // Lowercase hex must also pass.
        val low = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.ColorChange,
            zMm = 5f,
            extruder = 2,
            color = "#abc123",
            extra = "",
        )
        assertTrue(low.ok)
        // Wrong length / missing hash both fail.
        assertFalse(
            CustomGcodeAuthoring.validate(
                kind = CustomGcodeAuthoring.Kind.ColorChange,
                zMm = 5f, extruder = 1, color = "FF0000", extra = "",
            ).ok,
        )
        assertFalse(
            CustomGcodeAuthoring.validate(
                kind = CustomGcodeAuthoring.Kind.ColorChange,
                zMm = 5f, extruder = 1, color = "#FFF", extra = "",
            ).ok,
        )
    }

    @Test fun toolChangeRequiresPositiveExtruder() {
        val bad = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.ToolChange,
            zMm = 5f, extruder = 0, color = "", extra = "",
        )
        assertFalse(bad.ok)
        val good = CustomGcodeAuthoring.validate(
            kind = CustomGcodeAuthoring.Kind.ToolChange,
            zMm = 5f, extruder = 1, color = "", extra = "",
        )
        assertTrue(good.ok)
    }

    // -----------------------------------------------------------------
    // Engine-kind round-trip
    // -----------------------------------------------------------------

    @Test fun engineKindRoundTripIsIdentity() {
        for (panelKind in CustomGcodeAuthoring.Kind.values()) {
            val engine = CustomGcodeAuthoring.toEngineKind(panelKind)
            val back = CustomGcodeAuthoring.fromEngineKind(engine)
            assertEquals(panelKind, back)
        }
    }

    @Test fun customEngineKindFoldsIntoTemplate() {
        // The engine still understands legacy `Custom` ticks; fold into
        // Template so a 3MF authored elsewhere reads cleanly here.
        assertEquals(
            CustomGcodeAuthoring.Kind.Template,
            CustomGcodeAuthoring.fromEngineKind(SlicerEngine.CustomGcodeKind.Custom),
        )
    }

    // -----------------------------------------------------------------
    // tickSummaryLine
    // -----------------------------------------------------------------

    @Test fun colorChangeSummaryShowsHex() {
        val s = tickSummaryLine(
            SlicerEngine.CustomGcodeTick(
                printZmm = 5f,
                kind = SlicerEngine.CustomGcodeKind.ColorChange,
                extruder = 2,
                color = "#FF0000",
            ),
        )
        assertTrue(s.contains("#FF0000"))
        assertTrue(s.contains("T1"))
    }

    @Test fun pauseSummaryShowsExtraOrFallsBack() {
        val with = tickSummaryLine(
            SlicerEngine.CustomGcodeTick(
                printZmm = 5f,
                kind = SlicerEngine.CustomGcodeKind.PausePrint,
                extra = "Insert magnet",
            ),
        )
        assertEquals("Insert magnet", with)
        val without = tickSummaryLine(
            SlicerEngine.CustomGcodeTick(
                printZmm = 5f,
                kind = SlicerEngine.CustomGcodeKind.PausePrint,
            ),
        )
        assertEquals("Pause", without)
    }

    @Test fun templateSummaryClampsToFirstLine() {
        val multiline = "M0 ; pause\nG28\nM117 done"
        val s = tickSummaryLine(
            SlicerEngine.CustomGcodeTick(
                printZmm = 5f,
                kind = SlicerEngine.CustomGcodeKind.Template,
                extra = multiline,
            ),
        )
        assertEquals("M0 ; pause", s)
    }

    // -----------------------------------------------------------------
    // nearestLayerIndex
    // -----------------------------------------------------------------

    @Test fun nearestLayerIndexHitsExact() {
        val zs = listOf(0.2f, 0.4f, 0.6f, 0.8f, 1.0f)
        assertEquals(0, nearestLayerIndex(zs, 0.2f))
        assertEquals(2, nearestLayerIndex(zs, 0.6f))
        assertEquals(4, nearestLayerIndex(zs, 1.0f))
    }

    @Test fun nearestLayerIndexSnapsToClosest() {
        val zs = listOf(0.2f, 0.4f, 0.6f, 0.8f, 1.0f)
        assertEquals(1, nearestLayerIndex(zs, 0.39f))
        assertEquals(2, nearestLayerIndex(zs, 0.51f))
        // Above max snaps to last.
        assertEquals(4, nearestLayerIndex(zs, 5.0f))
        // Below min snaps to first.
        assertEquals(0, nearestLayerIndex(zs, -1.0f))
    }

    @Test fun nearestLayerIndexHandlesEmpty() {
        assertEquals(0, nearestLayerIndex(emptyList(), 5f))
    }
}
