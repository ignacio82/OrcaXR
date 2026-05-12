package dev.orcaxr.app.mobile

import dev.orcaxr.app.mcp.WorkspaceAction

/**
 * Pure (no Compose, no Android) holder for the four per-triangle paint
 * arrays MobileWorkspaceBinding maintains in response to MCP paint
 * actions. Lives in its own class so the merge math is unit-testable.
 *
 * Threading: not thread-safe. The binding's action collector consumes
 * `WorkspaceModel.actions` on a single coroutine, so all mutations
 * arrive serialized.
 */
data class MobilePaintState(
    val color: ByteArray? = null,
    val support: ByteArray? = null,
    val seam: ByteArray? = null,
    val fuzzy: ByteArray? = null,
) {

    /**
     * Apply a `LoadPaintState` action. Replaces all four arrays
     * wholesale (mirrors the XR side's `applyPaintMutation` over
     * `LoadPaintState`).
     */
    fun applyLoadPaintState(action: WorkspaceAction.LoadPaintState): MobilePaintState =
        MobilePaintState(
            color = action.paintFilamentIndex,
            support = action.supportFlags,
            seam = action.seamFlags,
            fuzzy = action.fuzzySkinFlags,
        )

    /**
     * Apply a `PaintTriangleSet` action. Mirrors MainActivity.kt's
     * inline merge logic so the mobile path produces identical
     * paint arrays for any (action, prior-state) pair.
     */
    fun applyTriangleSet(
        action: WorkspaceAction.PaintTriangleSet,
        triCount: Int,
    ): MobilePaintState {
        if (triCount <= 0) return this
        val before: ByteArray? = bufferFor(action.kind)
        // Working buffer must cover every index referenced by the
        // action; if the kind has never been authored we allocate
        // fresh (matches XR semantics).
        val out = before?.copyOf(triCount) ?: ByteArray(triCount)
        val tagB = action.tag.toByte()
        val whereB = action.whereTag.toByte()
        for (idx in action.triangleIndices) {
            if (idx < 0 || idx >= triCount) continue
            val cur = out[idx]
            val accept = when (action.mergeMode) {
                WorkspaceAction.MergeMode.Replace -> true
                WorkspaceAction.MergeMode.OnlyUnpainted -> cur.toInt() == 0
                WorkspaceAction.MergeMode.OnlyTagged -> cur == whereB
            }
            if (accept) out[idx] = tagB
        }
        return withBufferFor(action.kind, out)
    }

    /**
     * Apply a `ClearPaint` action. Null kind clears all four; named
     * kind clears just that one. Setting to null (vs. zero-filled
     * array) means `count_painted_tris` reads back as 0 and the
     * 3MF export omits the per-triangle channel entirely.
     */
    fun applyClearPaint(action: WorkspaceAction.ClearPaint): MobilePaintState {
        val k = action.kind ?: return MobilePaintState()
        return withBufferFor(k, null)
    }

    private fun bufferFor(kind: WorkspaceAction.PaintKind): ByteArray? = when (kind) {
        WorkspaceAction.PaintKind.Color -> color
        WorkspaceAction.PaintKind.Support -> support
        WorkspaceAction.PaintKind.Seam -> seam
        WorkspaceAction.PaintKind.FuzzySkin -> fuzzy
    }

    private fun withBufferFor(kind: WorkspaceAction.PaintKind, buf: ByteArray?): MobilePaintState =
        when (kind) {
            WorkspaceAction.PaintKind.Color -> copy(color = buf)
            WorkspaceAction.PaintKind.Support -> copy(support = buf)
            WorkspaceAction.PaintKind.Seam -> copy(seam = buf)
            WorkspaceAction.PaintKind.FuzzySkin -> copy(fuzzy = buf)
        }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is MobilePaintState) return false
        return color.contentEqualsOrBothNull(other.color) &&
            support.contentEqualsOrBothNull(other.support) &&
            seam.contentEqualsOrBothNull(other.seam) &&
            fuzzy.contentEqualsOrBothNull(other.fuzzy)
    }

    override fun hashCode(): Int {
        var h = color?.contentHashCode() ?: 0
        h = 31 * h + (support?.contentHashCode() ?: 0)
        h = 31 * h + (seam?.contentHashCode() ?: 0)
        h = 31 * h + (fuzzy?.contentHashCode() ?: 0)
        return h
    }

    private fun ByteArray?.contentEqualsOrBothNull(o: ByteArray?): Boolean {
        if (this == null) return o == null
        return o != null && this.contentEquals(o)
    }
}
