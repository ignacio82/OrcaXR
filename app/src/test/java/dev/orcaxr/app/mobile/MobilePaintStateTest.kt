package dev.orcaxr.app.mobile

import dev.orcaxr.app.mcp.WorkspaceAction
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Lock the per-triangle merge math the binding uses to apply MCP
 * paint actions on mobile. The XR side runs the same algorithm
 * inline in MainActivity (under `applyPaintMutation` for
 * PaintTriangleSet); divergence between the two paths would let an
 * MCP-driven LLM see different paint counts on phone vs XR for the
 * same call sequence.
 */
class MobilePaintStateTest {

    @Test fun loadPaintStateReplacesAllFourArrays() {
        val initial = MobilePaintState(
            color = byteArrayOf(1, 2, 3),
            support = byteArrayOf(4, 5, 6),
        )
        val action = WorkspaceAction.LoadPaintState(
            modelId = "m",
            paintFilamentIndex = byteArrayOf(7, 7, 7),
            supportFlags = null,
            seamFlags = byteArrayOf(8, 8, 8),
            fuzzySkinFlags = null,
        )
        val out = initial.applyLoadPaintState(action)
        assertArrayEquals(byteArrayOf(7, 7, 7), out.color)
        assertNull(out.support)
        assertArrayEquals(byteArrayOf(8, 8, 8), out.seam)
        assertNull(out.fuzzy)
    }

    @Test fun paintTriangleSetReplaceWritesEveryTri() {
        val out = MobilePaintState().applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                modelId = "m",
                kind = WorkspaceAction.PaintKind.Color,
                triangleIndices = intArrayOf(0, 2, 4),
                tag = 5,
                mergeMode = WorkspaceAction.MergeMode.Replace,
            ),
            triCount = 6,
        )
        assertArrayEquals(byteArrayOf(5, 0, 5, 0, 5, 0), out.color)
    }

    @Test fun paintTriangleSetOnlyUnpaintedSkipsExistingTags() {
        val seeded = MobilePaintState(color = byteArrayOf(1, 0, 0, 2))
        val out = seeded.applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                modelId = "m",
                kind = WorkspaceAction.PaintKind.Color,
                triangleIndices = intArrayOf(0, 1, 2, 3),
                tag = 9,
                mergeMode = WorkspaceAction.MergeMode.OnlyUnpainted,
            ),
            triCount = 4,
        )
        // tris 0 and 3 already had a tag — must be left alone
        assertArrayEquals(byteArrayOf(1, 9, 9, 2), out.color)
    }

    @Test fun paintTriangleSetOnlyTaggedRequiresWhereTagMatch() {
        val seeded = MobilePaintState(color = byteArrayOf(1, 2, 1, 2))
        val out = seeded.applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                modelId = "m",
                kind = WorkspaceAction.PaintKind.Color,
                triangleIndices = intArrayOf(0, 1, 2, 3),
                tag = 7,
                mergeMode = WorkspaceAction.MergeMode.OnlyTagged,
                whereTag = 1,
            ),
            triCount = 4,
        )
        // only the tris currently tagged 1 should flip to 7
        assertArrayEquals(byteArrayOf(7, 2, 7, 2), out.color)
    }

    @Test fun paintTriangleSetIgnoresOutOfRangeIndices() {
        val out = MobilePaintState().applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                modelId = "m",
                kind = WorkspaceAction.PaintKind.Color,
                triangleIndices = intArrayOf(-1, 0, 5, 99),
                tag = 3,
                mergeMode = WorkspaceAction.MergeMode.Replace,
            ),
            triCount = 4,
        )
        // triCount=4 → only index 0 is valid; -1, 5, 99 are dropped
        assertArrayEquals(byteArrayOf(3, 0, 0, 0), out.color)
    }

    @Test fun paintTriangleSetAllocatesFreshArrayForUnauthoredKind() {
        // Color was authored, but support has never been touched. A
        // PaintTriangleSet for Support must allocate a fresh
        // triCount-sized buffer rather than blow up on null.
        val seeded = MobilePaintState(color = byteArrayOf(1, 1, 1, 1))
        val out = seeded.applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                modelId = "m",
                kind = WorkspaceAction.PaintKind.Support,
                triangleIndices = intArrayOf(2),
                tag = 1,
                mergeMode = WorkspaceAction.MergeMode.Replace,
            ),
            triCount = 4,
        )
        assertArrayEquals(byteArrayOf(0, 0, 1, 0), out.support)
        // Color must remain untouched
        assertArrayEquals(byteArrayOf(1, 1, 1, 1), out.color)
    }

    @Test fun clearPaintWithKindClearsOnlyThatKind() {
        val seeded = MobilePaintState(
            color = byteArrayOf(1, 2),
            support = byteArrayOf(3, 4),
            seam = byteArrayOf(5, 6),
            fuzzy = byteArrayOf(7, 8),
        )
        val out = seeded.applyClearPaint(
            WorkspaceAction.ClearPaint(
                modelId = "m",
                kind = WorkspaceAction.PaintKind.Color,
            ),
        )
        assertNull(out.color)
        assertArrayEquals(byteArrayOf(3, 4), out.support)
        assertArrayEquals(byteArrayOf(5, 6), out.seam)
        assertArrayEquals(byteArrayOf(7, 8), out.fuzzy)
    }

    @Test fun clearPaintWithoutKindClearsEverything() {
        val seeded = MobilePaintState(
            color = byteArrayOf(1),
            support = byteArrayOf(2),
            seam = byteArrayOf(3),
            fuzzy = byteArrayOf(4),
        )
        val out = seeded.applyClearPaint(
            WorkspaceAction.ClearPaint(modelId = "m", kind = null),
        )
        assertEquals(MobilePaintState(), out)
    }

    @Test fun pikachuStyleSequenceProducesExpectedFinalState() {
        // Reproduce the v6 paint flow at toy scale: base coat slot 1
        // over 8 tris, then a "feature" (slot 4) at indices 1, 3, 5
        // with replace, then a "constraint" mask (only_tagged 4 → 6)
        // at indices 1, 5 — same merge sequencing as the Pikachu run.
        var s = MobilePaintState().applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                "m", WorkspaceAction.PaintKind.Color,
                intArrayOf(0, 1, 2, 3, 4, 5, 6, 7), 1,
                WorkspaceAction.MergeMode.Replace,
            ), triCount = 8,
        )
        s = s.applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                "m", WorkspaceAction.PaintKind.Color,
                intArrayOf(1, 3, 5), 4,
                WorkspaceAction.MergeMode.Replace,
            ), triCount = 8,
        )
        s = s.applyTriangleSet(
            WorkspaceAction.PaintTriangleSet(
                "m", WorkspaceAction.PaintKind.Color,
                intArrayOf(1, 5), 6,
                WorkspaceAction.MergeMode.OnlyTagged,
                whereTag = 4,
            ), triCount = 8,
        )
        // tri 1 and 5 went 1 → 4 → 6; tri 3 stayed 4; rest stayed 1
        assertArrayEquals(byteArrayOf(1, 6, 1, 4, 1, 6, 1, 1), s.color)
    }
}
