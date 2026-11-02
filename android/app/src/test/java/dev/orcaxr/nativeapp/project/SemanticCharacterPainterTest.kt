package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.FilamentOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SemanticCharacterPainterTest {

    @Test
    fun testPikachuPresetLookup() {
        val preset = SemanticCharacterPainter.findPreset("pikachu")
        assertNotNull(preset)
        assertEquals("Pikachu", preset!!.name)
        assertEquals(3, preset.regions.size)

        val earTips = preset.regions.find { it.id == "pikachu_ears" }
        assertNotNull(earTips)
        assertEquals("#161616", earTips!!.targetHex)

        val cheeks = preset.regions.find { it.id == "pikachu_cheeks" }
        assertNotNull(cheeks)
        assertEquals("#E22B22", cheeks!!.targetHex)

        val body = preset.regions.find { it.id == "pikachu_body" }
        assertNotNull(body)
        assertEquals("#FFDE00", body!!.targetHex)
    }

    @Test
    fun testAllBuiltInPresets() {
        val testNames = listOf(
            "Pikachu" to "Pikachu",
            "pumpkin" to "Pumpkin",
            "tree frog" to "Frog",
            "red fox" to "Fox",
            "3D Benchy" to "Benchy",
        )

        for ((input, expectedName) in testNames) {
            val preset = SemanticCharacterPainter.findPreset(input)
            assertNotNull("Preset for '$input' should exist", preset)
            assertEquals(expectedName, preset!!.name)
            assertTrue("Preset '${preset.name}' should have regions", preset.regions.isNotEmpty())
        }
    }

    @Test
    fun testBuildProposalFromPreset() {
        val preset = SemanticCharacterPainter.findPreset("pikachu")!!
        val proposal = SemanticCharacterPainter.buildProposalMap(preset)

        assertEquals(1, proposal["schemaVersion"])
        @Suppress("UNCHECKED_CAST")
        val regions = proposal["regions"] as List<Map<String, Any>>
        assertEquals(3, regions.size)

        val earTip = regions.first { it["id"] == "pikachu_ears" }
        assertEquals("Black Ear Tips", earTip["label"])
        @Suppress("UNCHECKED_CAST")
        val shape = earTip["shape"] as Map<String, Any>
        assertEquals("box", shape["kind"])
        @Suppress("UNCHECKED_CAST")
        val minList = shape["min"] as List<Double>
        assertEquals(0.82, minList[2], 0.001)
    }

    @Test
    fun testParseLlmCharacterProposal() {
        val llmOutput = """
            Here is the requested character layout:
            ```json
            {
              "name": "Mario",
              "regions": [
                {
                  "id": "region_cap",
                  "label": "Cap",
                  "targetHex": "#FF0000",
                  "shape": { "kind": "box", "min": [0.0, 0.0, 0.7], "max": [1.0, 1.0, 1.0] }
                },
                {
                  "id": "region_overalls",
                  "label": "Overalls",
                  "targetHex": "#0000FF",
                  "shape": { "kind": "box", "min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 0.4] }
                }
              ]
            }
            ```
            Enjoy painting!
        """.trimIndent()

        val parsed = SemanticCharacterPainter.parseLlmPlanJson(llmOutput, "Mario")
        assertNotNull(parsed)
        assertEquals("Mario", parsed!!.name)
        val regions = parsed.regions
        assertEquals(2, regions.size)
        assertEquals("region_cap", regions[0].id)
        assertEquals("#FF0000", regions[0].targetHex)
        assertEquals("region_overalls", regions[1].id)
        assertEquals("#0000FF", regions[1].targetHex)

        val proposalMap = SemanticCharacterPainter.buildProposalMap(parsed)
        assertEquals(1, proposalMap["schemaVersion"])
    }

    @Test
    fun testAvailableOnlyPaletteColorMatching() {
        // Loaded filaments: Slot 1: Pure Black (#000000), Slot 2: Bright Yellow (#FFEE00), Slot 3: Cyan (#00FFFF)
        val filaments = listOf(
            FilamentOption("fil_1", false, "Black PLA", "#000000", true, "PLA", null, 0, null, emptyList(), emptyList()),
            FilamentOption("fil_2", false, "Yellow PLA", "#FFEE00", true, "PLA", null, 1, null, emptyList(), emptyList()),
            FilamentOption("fil_3", false, "Cyan PLA", "#00FFFF", true, "PLA", null, 2, null, emptyList(), emptyList()),
        )

        // Pikachu regions:
        // pikachu_ears: targetHex = #161616 (closest to #000000 -> fil_1)
        // pikachu_body: targetHex = #FFDE00 (yellow, closest to #FFEE00 -> fil_2)

        val earTipMatch = filaments.minByOrNull { ColorMath.deltaE2000("#161616", it.color) }
        assertNotNull(earTipMatch)
        assertEquals("fil_1", earTipMatch!!.id)

        val bodyMatch = filaments.minByOrNull { ColorMath.deltaE2000("#FFDE00", it.color) }
        assertNotNull(bodyMatch)
        assertEquals("fil_2", bodyMatch!!.id)
    }
}
