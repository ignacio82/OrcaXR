package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D13 — contract tests for the bundled handy-model catalog. Asset
 * staging itself runs against a real Android Context (instrumented),
 * but the catalog metadata + lookup live in pure Kotlin and warrant a
 * fast unit gate so a typo or duplicate id surfaces locally.
 */
class HandyModelCatalogTest {

    @Test fun catalogHasEightEntries() {
        // Mirrors upstream OrcaSlicer's resources/handy_models/
        // directory — adding a new asset here requires bumping the
        // assert and adding a new HandyModel entry.
        assertEquals(8, HandyModelCatalog.ENTRIES.size)
    }

    @Test fun idsAreUnique() {
        val ids = HandyModelCatalog.ENTRIES.map { it.id }
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test fun byIdIsCaseInsensitive() {
        assertNotNull(HandyModelCatalog.byId("benchy"))
        assertNotNull(HandyModelCatalog.byId("BENCHY"))
        assertNotNull(HandyModelCatalog.byId("Benchy"))
    }

    @Test fun byIdReturnsNullForUnknown() {
        assertNull(HandyModelCatalog.byId("not-a-real-id"))
    }

    @Test fun assetPathsLiveUnderHandyModelsFolder() {
        // The MCP tool stages from assets/handy_models/<name>; if a
        // future entry hardcodes a different prefix the staging
        // would silently miss it on-device.
        for (m in HandyModelCatalog.ENTRIES) {
            assertTrue(
                "asset path '${m.assetPath}' must start with handy_models/",
                m.assetPath.startsWith("handy_models/"),
            )
        }
    }

    @Test fun fileNameStripsPrefix() {
        val benchy = HandyModelCatalog.byId("benchy")!!
        assertEquals("3DBenchy.drc", benchy.fileName)
    }

    @Test fun extensionsAreSupportedByLoader() {
        // libslic3r's read_from_file dispatch table accepts .drc
        // (Draco-compressed) and .3mf among the formats we use here.
        val supported = setOf("drc", "3mf")
        for (m in HandyModelCatalog.ENTRIES) {
            val ext = m.assetPath.substringAfterLast('.').lowercase()
            assertTrue(
                "extension .$ext on ${m.id} not in supported set $supported",
                ext in supported,
            )
        }
    }

    @Test fun displayNamesAndHintsAreNonEmpty() {
        for (m in HandyModelCatalog.ENTRIES) {
            assertTrue("displayName empty on ${m.id}", m.displayName.isNotBlank())
            assertTrue("hint empty on ${m.id}", m.hint.isNotBlank())
        }
    }
}
