package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.io.File

/**
 * Tests for [PlacedModel] / [autoArrangeModels] / [PlacedModel.footprintMm].
 * Phase G's slice-time correctness depends on the XY layout these
 * helpers produce — `nativeSliceMulti` re-centers the group bbox on
 * the printable area, but does NOT space individual models out, so
 * if [autoArrangeModels] returns overlapping placements the slicer
 * happily plates them on top of each other.
 */
class PlacedModelTest {

    private fun model(
        id: String,
        bboxX: Float = 50f,
        bboxY: Float = 50f,
        bboxZ: Float = 20f,
        rotZ: Int = 0,
        scale: Int = 100,
    ) = PlacedModel(
        id = id,
        source = File("/tmp/$id.stl"),
        label = id,
        baseBboxXmm = bboxX,
        baseBboxYmm = bboxY,
        baseBboxZmm = bboxZ,
        rotZDeg = rotZ,
        scalePct = scale,
    )

    @Test fun emptyListIsAlreadyArranged() {
        assertEquals(emptyList<PlacedModel>(), autoArrangeModels(emptyList()))
    }

    @Test fun singleModelGetsReturnedAtOriginUnchangedWhenAlreadyThere() {
        val m = model("a")
        // Same object so the .map allocation is skipped on the
        // common one-model-arrange-button path.
        assertEquals(listOf(m), autoArrangeModels(listOf(m)))
    }

    @Test fun singleModelOffOriginIsRecenteredToOrigin() {
        val m = model("a").copy(translateXmm = 90f, translateYmm = 30f)
        val arranged = autoArrangeModels(listOf(m))
        assertEquals(0f, arranged.first().translateXmm)
        assertEquals(0f, arranged.first().translateYmm)
    }

    @Test fun twoEqualWidthModelsSpaceAroundOriginWithGap() {
        // Two 50mm-wide models with 5mm gap → centers at -27.5, +27.5.
        val a = model("a")
        val b = model("b")
        val arranged = autoArrangeModels(listOf(a, b))
        assertEquals(-27.5f, arranged[0].translateXmm)
        assertEquals(27.5f, arranged[1].translateXmm)
        assertEquals(0f, arranged[0].translateYmm)
        assertEquals(0f, arranged[1].translateYmm)
    }

    @Test fun threeAsymmetricModelsLayOutByActualFootprint() {
        val a = model("a", bboxX = 10f)        // 10
        val b = model("b", bboxX = 50f)        // 50
        val c = model("c", bboxX = 30f)        // 30
        val arranged = autoArrangeModels(listOf(a, b, c))
        // total = 10+50+30 + 5*2 gaps = 100; left = -50.
        // a center = -50 + 5 = -45
        // b center = -50 + 10 + 5 + 25 = -10
        // c center = -50 + 10 + 5 + 50 + 5 + 15 = +35
        assertEquals(-45f, arranged[0].translateXmm)
        assertEquals(-10f, arranged[1].translateXmm)
        assertEquals(35f, arranged[2].translateXmm)
    }

    @Test fun scaleAffectsLayoutSpacing() {
        // 50mm box at 200% takes 100mm of footprint; 50mm box at 100%
        // takes 50mm. With 5mm gap between, the centers should reflect
        // the larger footprint.
        val big = model("big", bboxX = 50f, scale = 200)
        val small = model("small", bboxX = 50f, scale = 100)
        val arranged = autoArrangeModels(listOf(big, small))
        // total = 100 + 50 + 5 = 155; left = -77.5.
        // big center = -77.5 + 50 = -27.5
        // small center = -77.5 + 100 + 5 + 25 = +52.5
        assertEquals(-27.5f, arranged[0].translateXmm)
        assertEquals(52.5f, arranged[1].translateXmm)
    }

    @Test fun rotation90SwapsBboxAxesForLayout() {
        // 80x40 box rotated 90° has effective footprint 40x80 — the
        // X width drops from 80 to 40 and the Y depth grows from 40
        // to 80. Auto-arrange uses the X width.
        val m = model("rotated", bboxX = 80f, bboxY = 40f, rotZ = 90)
        val (w, d) = m.footprintMm()
        assertEquals(40f, w)
        assertEquals(80f, d)
    }

    @Test fun rotation180LeavesFootprintUnchanged() {
        val m = model("flipped", bboxX = 80f, bboxY = 40f, rotZ = 180)
        val (w, d) = m.footprintMm()
        assertEquals(80f, w)
        assertEquals(40f, d)
    }

    @Test fun negativeRotationDegreesNormalize() {
        // -270° == +90° — we test both produce the same swap.
        val a = model("a", bboxX = 80f, bboxY = 40f, rotZ = 90)
        val b = model("b", bboxX = 80f, bboxY = 40f, rotZ = -270)
        assertEquals(a.footprintMm(), b.footprintMm())
    }

    @Test fun arrangeAtCapacityProducesNonOverlappingFootprints() {
        // 16 boxes 30mm wide with 5mm gap → no overlap.
        val ms = (0 until MAX_PLACED_MODELS).map { i -> model("m$i", bboxX = 30f) }
        val arranged = autoArrangeModels(ms)
        for (i in 1 until arranged.size) {
            val prev = arranged[i - 1]
            val cur = arranged[i]
            val prevRightEdge = prev.translateXmm + 30f / 2f
            val curLeftEdge = cur.translateXmm - 30f / 2f
            // Gap of 5mm between footprints.
            assertEquals(5f, curLeftEdge - prevRightEdge, 1e-3f)
        }
    }

    @Test fun maxPlacedModelsIs16() {
        // Sentinel — if the cap moves, the SNAPMAKER_PARITY_PLAN.md
        // Phase G note's "~16" reasoning needs re-stating in the
        // commit that bumps it.
        assertEquals(16, MAX_PLACED_MODELS)
    }

    @Test fun rotatedModelAffectsLayoutFootprint() {
        val a = model("a", bboxX = 80f, bboxY = 40f, rotZ = 0)   // X=80
        val b = model("b", bboxX = 80f, bboxY = 40f, rotZ = 90)  // X=40
        val arranged = autoArrangeModels(listOf(a, b))
        // total = 80 + 40 + 5 = 125; left = -62.5.
        // a center = -62.5 + 40 = -22.5
        // b center = -62.5 + 80 + 5 + 20 = +42.5
        assertEquals(-22.5f, arranged[0].translateXmm)
        assertEquals(42.5f, arranged[1].translateXmm)
        // Sanity: the rotated model has different X than before.
        assertNotEquals(arranged[0].translateXmm, arranged[1].translateXmm)
    }

    // Phase XR_OBJ_4 — defaults.
    @Test fun newPlacedModelHasNoVolumesByDefault() {
        // The implicit MODEL_PART of the source mesh is enough to
        // slice; volumes is an opt-in list of *additional* parts/
        // modifiers/etc. A regression that defaulted to a non-empty
        // list would force the multi-volume JNI path on every load.
        assertEquals(emptyList<PlacedVolume>(), model("a").volumes)
    }

    @Test fun newPlacedModelHasNoConfigOverridesByDefault() {
        // Empty map = "fall through to the global profile / right-
        // settings overrides". Non-empty default would silently
        // override profile defaults across all loads.
        assertEquals(emptyMap<String, String>(), model("a").configOverrides)
    }

    // Phase XR_OBJ_4 (final) — configOverrides upsert/remove pattern.
    // The Object Settings panel writes via the host callback
    //   if (value.isBlank()) m.copy(configOverrides = m.configOverrides - key)
    //   else                  m.copy(configOverrides = m.configOverrides + (key to value))
    // The tests below pin that contract so a future refactor that
    // unifies the two branches doesn't accidentally turn empty
    // strings into stored-but-empty overrides (which would BLOCK the
    // global default — exactly what the user sees as "removing" the
    // override means).
    @Test fun configOverrideUpsertAddsKey() {
        val m = model("a")
        val updated = m.copy(configOverrides = m.configOverrides + ("layer_height" to "0.2"))
        assertEquals("0.2", updated.configOverrides["layer_height"])
    }

    @Test fun configOverrideUpsertReplacesExistingKey() {
        val m = model("a").copy(configOverrides = mapOf("layer_height" to "0.2"))
        val updated = m.copy(configOverrides = m.configOverrides + ("layer_height" to "0.3"))
        assertEquals("0.3", updated.configOverrides["layer_height"])
        assertEquals(1, updated.configOverrides.size)
    }

    @Test fun configOverrideRemoveStripsKey() {
        val m = model("a").copy(configOverrides = mapOf("layer_height" to "0.2", "wall_loops" to "3"))
        val updated = m.copy(configOverrides = m.configOverrides - "layer_height")
        assertEquals(null, updated.configOverrides["layer_height"])
        assertEquals("3", updated.configOverrides["wall_loops"])
    }

    @Test fun configOverrideRemoveOfMissingKeyIsNoOp() {
        val m = model("a").copy(configOverrides = mapOf("wall_loops" to "3"))
        val updated = m.copy(configOverrides = m.configOverrides - "layer_height")
        assertEquals(m.configOverrides, updated.configOverrides)
    }

    // Phase XR_OBJ_8 — supportFlags / seamFlags reach equality + hashCode
    // through the same paintArraysEqual path as paintFilamentIndex.
    // The existing PaintBrushTest already covers paintFilamentIndex.
    // These two cases pin the parallel handling for the support/seam
    // arrays so they don't regress to identity comparison (which would
    // make every Compose .map() recomposition see the model as "changed").
    @Test fun placedModelEqualsTreatsEqualSupportFlagsAsEqual() {
        val flags1 = byteArrayOf(0, 1, 2, 0)
        val flags2 = byteArrayOf(0, 1, 2, 0)
        val a = model("a").copy(supportFlags = flags1)
        val b = model("a").copy(supportFlags = flags2)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test fun placedModelEqualsTreatsEqualSeamFlagsAsEqual() {
        val flags1 = byteArrayOf(0, 1, 2, 0)
        val flags2 = byteArrayOf(0, 1, 2, 0)
        val a = model("a").copy(seamFlags = flags1)
        val b = model("a").copy(seamFlags = flags2)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test fun placedModelEqualsDistinguishesDifferentSupportFlags() {
        val a = model("a").copy(supportFlags = byteArrayOf(0, 1, 0))
        val b = model("a").copy(supportFlags = byteArrayOf(0, 2, 0))
        assertNotEquals(a, b)
    }

    @Test fun modelsWithDifferentGroupIdsAreUnequal() {
        val a = model("a").copy(groupId = "g1", groupOrdinal = 0)
        val b = model("a").copy(groupId = "g2", groupOrdinal = 0)
        assertNotEquals(a, b)
        assertNotEquals(a.hashCode(), b.hashCode())
    }

    @Test fun modelsWithDifferentGroupOrdinalsAreUnequal() {
        val a = model("a").copy(groupId = "g1", groupOrdinal = 0)
        val b = model("a").copy(groupId = "g1", groupOrdinal = 1)
        assertNotEquals(a, b)
        assertNotEquals(a.hashCode(), b.hashCode())
    }
}
