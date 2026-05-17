package dev.orcaxr.app.mobile

import dev.orcaxr.app.HeightRange
import dev.orcaxr.app.mcp.WorkspaceAction
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks the re-architected binding's per-model reducer. These actions
 * used to be silently dropped on phone; the math here must match what
 * the XR side stores on `PlacedModel` for the same call so an
 * MCP-driven agent sees identical workspace state on either shell.
 */
class MobileModelStateTest {

    @Test fun setHeightRangesReplacesList() {
        val r = listOf(
            HeightRange(0f, 5f, mapOf("layer_height" to "0.1")),
            HeightRange(5f, 10f),
        )
        val s = MobileModelState()
            .applySetHeightRanges(WorkspaceAction.SetHeightRanges("m", r))
        assertEquals(r, s.heightRanges)
        // Replace semantics: a second call wholesale-replaces.
        val s2 = s.applySetHeightRanges(WorkspaceAction.SetHeightRanges("m", emptyList()))
        assertTrue(s2.heightRanges.isEmpty())
    }

    @Test fun setObjectOverridesReplacesMap() {
        val s = MobileModelState()
            .applySetObjectOverrides(
                WorkspaceAction.SetObjectOverrides("m", mapOf("sparse_infill_density" to "25%")),
            )
        assertEquals("25%", s.configOverrides["sparse_infill_density"])
        val cleared = s.applySetObjectOverrides(WorkspaceAction.SetObjectOverrides("m", emptyMap()))
        assertTrue(cleared.configOverrides.isEmpty())
    }

    @Test fun setVolumeOverridesMergesByVolumeId() {
        val s = MobileModelState()
            .applySetVolumeOverrides(WorkspaceAction.SetVolumeOverrides("m", "v1", mapOf("a" to "1")))
            .applySetVolumeOverrides(WorkspaceAction.SetVolumeOverrides("m", "v2", mapOf("b" to "2")))
        assertEquals(mapOf("a" to "1"), s.volumeOverrides["v1"])
        assertEquals(mapOf("b" to "2"), s.volumeOverrides["v2"])
        // Same volume id replaces that volume's map only.
        val s2 = s.applySetVolumeOverrides(WorkspaceAction.SetVolumeOverrides("m", "v1", emptyMap()))
        assertTrue(s2.volumeOverrides["v1"]!!.isEmpty())
        assertEquals(mapOf("b" to "2"), s2.volumeOverrides["v2"])
    }

    @Test fun layerHeightProfileValidProfileIsKept() {
        val p = floatArrayOf(0f, 0.2f, 5f, 0.12f) // even, >=4, increasing Z
        val s = MobileModelState()
            .applySetLayerHeightProfile(WorkspaceAction.SetLayerHeightProfile("m", p))
        assertArrayEquals(p, s.layerHeightProfile!!, 0f)
    }

    @Test fun layerHeightProfileMalformedIsCleared() {
        val base = MobileModelState()
            .applySetLayerHeightProfile(
                WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf(0f, 0.2f, 5f, 0.12f)),
            )
        // null / empty / odd / too-short / non-monotonic Z → cleared.
        assertNull(base.applySetLayerHeightProfile(
            WorkspaceAction.SetLayerHeightProfile("m", null)).layerHeightProfile)
        assertNull(base.applySetLayerHeightProfile(
            WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf())).layerHeightProfile)
        assertNull(base.applySetLayerHeightProfile(
            WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf(0f, 0.2f, 5f))).layerHeightProfile)
        assertNull(base.applySetLayerHeightProfile(
            WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf(0f, 0.2f))).layerHeightProfile)
        assertNull(base.applySetLayerHeightProfile(
            WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf(5f, 0.2f, 1f, 0.1f))).layerHeightProfile)
    }

    @Test fun paintSubStateComposesUnchanged() {
        val st = MobileModelState()
        val painted = st.copy(
            paint = st.paint.applyLoadPaintState(
                WorkspaceAction.LoadPaintState("m", byteArrayOf(1, 1), null, null, null),
            ),
        )
        assertArrayEquals(byteArrayOf(1, 1), painted.paint.color)
        // Mutating paint doesn't disturb the data fields and vice-versa.
        val withRanges = painted.applySetHeightRanges(
            WorkspaceAction.SetHeightRanges("m", listOf(HeightRange(0f, 1f))),
        )
        assertArrayEquals(byteArrayOf(1, 1), withRanges.paint.color)
        assertEquals(1, withRanges.heightRanges.size)
    }

    @Test fun equalsAndHashCodeHandleFloatArrayAndAreValueBased() {
        val a = MobileModelState()
            .applySetLayerHeightProfile(WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf(0f, 0.2f, 5f, 0.1f)))
            .applySetObjectOverrides(WorkspaceAction.SetObjectOverrides("m", mapOf("k" to "v")))
        val b = MobileModelState()
            .applySetLayerHeightProfile(WorkspaceAction.SetLayerHeightProfile("m", floatArrayOf(0f, 0.2f, 5f, 0.1f)))
            .applySetObjectOverrides(WorkspaceAction.SetObjectOverrides("m", mapOf("k" to "v")))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        assertNotEquals(
            a,
            b.applySetObjectOverrides(WorkspaceAction.SetObjectOverrides("m", mapOf("k" to "x"))),
        )
    }
}
