package dev.orcaxr.app

import dev.orcaxr.app.mcp.AiPaintConstraint
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.validateConstraints
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M7: declarative paint-session constraints. The validator is the
 * load-bearing piece — these tests exercise every constraint kind in
 * isolation against a known paint array, plus the session-level
 * integration (addConstraint / validateAttachedConstraints / commit
 * gating).
 */
class AiPaintConstraintsTest {

    @After fun cleanUp() {
        AiPaintSessionStore.get().clearAll()
    }

    // ---- Pure validator ----

    @Test fun mustRemainUnpaintedFlagsAnyNonZero() {
        val paint = ByteArray(8) { i ->
            // tris 2, 5 painted with tag 1; rest unpainted.
            if (i == 2 || i == 5) 1.toByte() else 0.toByte()
        }
        val c = AiPaintConstraint.MustRemainUnpainted(
            id = "c0", triangleIndices = intArrayOf(0, 2, 4, 5),
            description = "deck stays raw",
        )
        val v = validateConstraints(paint, triCount = 8, constraints = listOf(c))
        assertEquals(1, v.size)
        assertEquals(intArrayOf(2, 5).toList(), v[0].violatingTriangles.toList())
    }

    @Test fun mustBePaintedFlagsAnyZero() {
        val paint = ByteArray(8) { i ->
            if (i in 0..3) 1.toByte() else 0.toByte()
        }
        val c = AiPaintConstraint.MustBePainted(
            id = "c1", triangleIndices = intArrayOf(2, 3, 4, 5),
            description = "hull",
        )
        val v = validateConstraints(paint, triCount = 8, constraints = listOf(c))
        assertEquals(1, v.size)
        assertEquals(intArrayOf(4, 5).toList(), v[0].violatingTriangles.toList())
    }

    @Test fun mustBeTagFlagsAnyMismatch() {
        val paint = ByteArray(8) { i ->
            when (i) { 0 -> 3; 1 -> 3; 2 -> 4; 3 -> 0; else -> 0 }.toByte()
        }
        val c = AiPaintConstraint.MustBeTag(
            id = "c2", triangleIndices = intArrayOf(0, 1, 2, 3),
            tag = 3,
            description = "deck must be slot 3",
        )
        val v = validateConstraints(paint, triCount = 8, constraints = listOf(c))
        assertEquals(1, v.size)
        assertEquals(intArrayOf(2, 3).toList(), v[0].violatingTriangles.toList())
    }

    @Test fun mustNotBeTagFlagsThatTag() {
        val paint = ByteArray(8) { i ->
            when (i) { 0 -> 5; 1 -> 1; 2 -> 5; 3 -> 0; else -> 0 }.toByte()
        }
        val c = AiPaintConstraint.MustNotBeTag(
            id = "c3", triangleIndices = intArrayOf(0, 1, 2, 3),
            tag = 5,
            description = "deck must not be black",
        )
        val v = validateConstraints(paint, triCount = 8, constraints = listOf(c))
        assertEquals(1, v.size)
        assertEquals(intArrayOf(0, 2).toList(), v[0].violatingTriangles.toList())
    }

    @Test fun nullPaintArrayCountsAsAllUnpainted() {
        // No color paint at all (null array) — must_be_painted should
        // flag every triangle in the constraint set.
        val c = AiPaintConstraint.MustBePainted(
            id = "c4", triangleIndices = intArrayOf(0, 1, 2),
            description = "x",
        )
        val v = validateConstraints(paintFilamentIndex = null, triCount = 4, constraints = listOf(c))
        assertEquals(1, v.size)
        assertEquals(3, v[0].violatingTriangles.size)
    }

    @Test fun outOfRangeTriangleIdsAreSkippedNotViolations() {
        // Out-of-range ids are dropped at constraint-attach time by
        // the MCP tool, but the validator's contract is "never
        // violate on out-of-range" so a partially stale constraint
        // doesn't poison commit forever.
        val paint = ByteArray(4) { 0 }
        val c = AiPaintConstraint.MustBePainted(
            id = "c5", triangleIndices = intArrayOf(-1, 100, 1000),
            description = "stale ids",
        )
        val v = validateConstraints(paint, triCount = 4, constraints = listOf(c))
        // All three triangle ids are out of range → silently skipped
        // → no violators recorded → no entry in `out` since the
        // violators list is empty.
        assertEquals(0, v.size)
    }

    @Test fun emptyConstraintsReturnsEmptyList() {
        val v = validateConstraints(paintFilamentIndex = ByteArray(4), triCount = 4, constraints = emptyList())
        assertTrue(v.isEmpty())
    }

    // ---- Session-level integration ----

    @Test fun sessionCarriesConstraintsAcrossPaintMutations() {
        val store = AiPaintSessionStore.get()
        val s = store.begin(
            modelId = "m_test",
            triCount = 8,
            basePaintFilamentIndex = ByteArray(8),
            baseSupportFlags = null,
            baseSeamFlags = null,
            baseFuzzySkinFlags = null,
        )
        s.addConstraint(
            AiPaintConstraint.MustRemainUnpainted(
                id = "c_keep",
                triangleIndices = intArrayOf(0, 1, 2, 3),
                description = "deck",
            ),
        )
        // Paint into the constraint zone — should now violate.
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(2, 5),
            tag = 4,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        val violations = s.validateAttachedConstraints()
        assertEquals(1, violations.size)
        assertEquals(intArrayOf(2).toList(), violations[0].violatingTriangles.toList())
    }

    @Test fun removingConstraintDropsItFromValidation() {
        val store = AiPaintSessionStore.get()
        val s = store.begin(
            modelId = "m_test2",
            triCount = 4,
            basePaintFilamentIndex = ByteArray(4),
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        s.addConstraint(
            AiPaintConstraint.MustBePainted(
                id = "c_a", triangleIndices = intArrayOf(0, 1, 2, 3),
                description = "fully paint",
            ),
        )
        // Without painting anything, must_be_painted fails.
        assertEquals(1, s.validateAttachedConstraints().size)
        assertTrue(s.removeConstraint("c_a"))
        assertEquals(0, s.validateAttachedConstraints().size)
    }

    @Test fun clearConstraintsRemovesAll() {
        val store = AiPaintSessionStore.get()
        val s = store.begin(
            modelId = "m_test3",
            triCount = 4,
            basePaintFilamentIndex = ByteArray(4),
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        s.addConstraint(AiPaintConstraint.MustBePainted("a", intArrayOf(0), "x"))
        s.addConstraint(AiPaintConstraint.MustRemainUnpainted("b", intArrayOf(1), "y"))
        assertEquals(2, s.listConstraints().size)
        s.clearConstraints()
        assertEquals(0, s.listConstraints().size)
        assertTrue(s.validateAttachedConstraints().isEmpty())
    }

    @Test fun removeConstraintReturnsFalseForUnknownId() {
        val store = AiPaintSessionStore.get()
        val s = store.begin(
            modelId = "m_test4", triCount = 1,
            basePaintFilamentIndex = null, baseSupportFlags = null,
            baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        assertNotNull(s)
        assertFalse(s.removeConstraint("never-existed"))
    }
}
