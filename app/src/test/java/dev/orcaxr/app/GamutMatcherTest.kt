package dev.orcaxr.app

import dev.orcaxr.app.GamutMatcher.GamutRecipe
import dev.orcaxr.app.GamutMatcher.MatchQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the "Match to my filaments" engine. The matcher is
 * injected with the gamma-correct sRGB blender (the same fallback
 * [resolveMixedRowDisplayColor] uses when the native pigment mixer is
 * not on the classpath) so these run without the .so.
 */
class GamutMatcherTest {

    /** Deterministic, native-free blender. */
    private val blend: (List<Pair<String, Float>>) -> String =
        { comps -> blendComponentsHex(comps) }

    private fun match(
        sources: List<String>,
        physical: List<String>,
        step: Int = 10,
    ) = GamutMatcher.matchModelColors(
        sourceColors = sources,
        physicalColors = physical,
        mixStepPercent = step,
        blend = blend,
    )

    @Test
    fun exactlyLoadedColorMapsToThatPhysicalSlotWithNearZeroError() {
        val physical = listOf("#FF0000", "#00FF00", "#0000FF", "#FFFFFF")
        val m = match(listOf("#00FF00"), physical).single()
        assertEquals(GamutRecipe.Physical(1), m.recipe)
        assertTrue("expected ~0 ΔE, got ${m.deltaE}", m.deltaE < 1.0)
        assertEquals(MatchQuality.EXACT, m.quality)
        assertEquals("#00FF00", m.targetHex)
    }

    @Test
    fun colorBetweenTwoFilamentsPrefersABlendThatBeatsNearestPhysical() {
        // White + black loaded; a mid gray is reachable only as a blend.
        val physical = listOf("#FFFFFF", "#000000")
        val m = match(listOf("#7A7A7A"), physical).single()
        val recipe = m.recipe
        assertTrue("expected a Blend recipe, got $recipe", recipe is GamutRecipe.Blend)
        recipe as GamutRecipe.Blend
        // 1-based, ordered (a < b).
        assertEquals(1, recipe.componentA1)
        assertEquals(2, recipe.componentB1)
        assertTrue("mixB should be a real blend", recipe.mixBPercent in 10..90)

        // Sanity: the blend really is closer than either pure spool.
        val nearestPhysical = GamutMatcher.matchModelColors(
            sourceColors = listOf("#7A7A7A"),
            physicalColors = physical,
            mixStepPercent = 10,
            // Force "physical only" by asking for an absurd blend margin.
            blendDeltaEMargin = Double.MAX_VALUE,
            blend = blend,
        ).single()
        assertTrue(
            "blend ΔE ${m.deltaE} should beat best physical ${nearestPhysical.deltaE}",
            m.deltaE < nearestPhysical.deltaE,
        )
    }

    @Test
    fun vividColorOnDullFilamentsIsFlaggedOutOfGamut() {
        val physical = listOf("#202020", "#808080", "#C0C0C0", "#FFFFFF")
        val m = match(listOf("#FF0000"), physical).single()
        assertEquals(
            "saturated red on a grayscale palette must be honest about the error",
            MatchQuality.OUT_OF_GAMUT, m.quality,
        )
        assertTrue("expected a large ΔE, got ${m.deltaE}", m.deltaE > 8.0)
    }

    @Test
    fun marginTieBreakPrefersTheSimplerPhysicalRecipe() {
        // The exact color is loaded; a blend can only ever tie, never
        // clear the margin, so the simpler physical recipe must win.
        val physical = listOf("#3366CC", "#FFFFFF", "#000000")
        val m = match(listOf("#3366CC"), physical).single()
        assertEquals(GamutRecipe.Physical(0), m.recipe)
        assertEquals(MatchQuality.EXACT, m.quality)
    }

    @Test
    fun enumerateGamutHasOnePhysicalPlusFullBlendGridPerPair() {
        val physical = listOf("#FF0000", "#00FF00", "#0000FF")
        val gamut = GamutMatcher.enumerateGamut(physical, mixStepPercent = 10, blend = blend)
        val physicalCount = gamut.count { it.recipe is GamutRecipe.Physical }
        val blendCount = gamut.count { it.recipe is GamutRecipe.Blend }
        assertEquals(3, physicalCount)
        // C(3,2) pairs × 9 mix steps (10..90).
        assertEquals(3 * 9, blendCount)
        // Every blend recipe is 1-based and ordered a < b.
        gamut.mapNotNull { it.recipe as? GamutRecipe.Blend }.forEach {
            assertTrue(it.componentA1 in 1..3)
            assertTrue(it.componentB1 in 1..3)
            assertTrue("expected a<b, got $it", it.componentA1 < it.componentB1)
        }
    }

    @Test
    fun applyWritesPhysicalSlotAndCreatesReusableBlendRows() {
        val filaments = listOf(
            FilamentEntry(id = "f0", color = "#00FF00", slotIndex = 0),
            FilamentEntry(id = "f1", color = "#7A7A7A", slotIndex = 1),
            FilamentEntry(id = "f2", color = "#7B7B7B", slotIndex = 2),
        )
        val matches = listOf(
            GamutMatcher.GamutMatch(
                0, "#00FF00", "#00FF00", GamutRecipe.Physical(1), 0.0,
                MatchQuality.EXACT,
            ),
            GamutMatcher.GamutMatch(
                1, "#7A7A7A", "#7A7A7A", GamutRecipe.Blend(1, 2, 50), 1.0,
                MatchQuality.CLOSE,
            ),
            // Same blend recipe as #f1 — must reuse the row, not duplicate.
            GamutMatcher.GamutMatch(
                2, "#7B7B7B", "#7B7B7B", GamutRecipe.Blend(1, 2, 50), 1.2,
                MatchQuality.CLOSE,
            ),
        )
        val result = GamutMatcher.applyGamutMatches(filaments, emptyList(), matches)

        // Physical match.
        assertEquals(1, result.filaments[0].physicalSlot)
        assertNull(result.filaments[0].virtualSlot)

        // Exactly one blend row created and shared by both gray sources.
        assertEquals(1, result.virtualRows.size)
        val row = result.virtualRows.single()
        assertEquals(1, row.componentA)
        assertEquals(2, row.componentB)
        assertEquals(50, row.mixBPercent)
        assertTrue("blend rows should be user-authored/custom", row.custom)
        assertEquals(1, result.filaments[1].virtualSlot) // 1-based row index
        assertEquals(1, result.filaments[2].virtualSlot)
        assertNull(result.filaments[1].physicalSlot)
    }

    @Test
    fun applyReusesAnExistingEquivalentVirtualRow() {
        val filaments = listOf(
            FilamentEntry(id = "f0", color = "#7A7A7A", slotIndex = 0),
        )
        val existing = listOf(
            MixedFilamentEntry(id = "auto_1_2", componentA = 1, componentB = 2, mixBPercent = 50),
        )
        val matches = listOf(
            GamutMatcher.GamutMatch(
                0, "#7A7A7A", "#7A7A7A", GamutRecipe.Blend(1, 2, 50), 1.0,
                MatchQuality.CLOSE,
            ),
        )
        val result = GamutMatcher.applyGamutMatches(filaments, existing, matches)
        assertEquals("must not duplicate an equivalent row", 1, result.virtualRows.size)
        assertEquals("auto_1_2", result.virtualRows.single().id)
        assertEquals(1, result.filaments[0].virtualSlot)
    }

    @Test
    fun unparseableSourceColorIsKeptUntouched() {
        // A garbage color string can't be matched — apply must leave the
        // entry's color and mapping exactly as-is, never guess a slot.
        val filaments = listOf(
            FilamentEntry(id = "f0", color = "not-a-color", slotIndex = 0, physicalSlot = 3),
        )
        val m = match(listOf("not-a-color"), listOf("#FF0000"))
        assertEquals(GamutRecipe.Keep, m.single().recipe)
        assertEquals(MatchQuality.OUT_OF_GAMUT, m.single().quality)
        val result = GamutMatcher.applyGamutMatches(filaments, emptyList(), m)
        assertNotNull(result.filaments.single())
        assertEquals("mapping must be untouched", 3, result.filaments.single().physicalSlot)
        assertEquals("color must be untouched", "not-a-color", result.filaments.single().color)
    }
}
