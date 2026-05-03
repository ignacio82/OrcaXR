package dev.orcaxr.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * F1 — Snapmaker U1 0.2 / 0.8 nozzle profile catalog. Vendored from
 * the AGPL Snapmaker fork v2.3.1, byte-identical to upstream so a
 * future re-vendor is a trivial `cp -r`. This test loads the actual
 * JSONs and asserts:
 *  - every expected leaf (machine + process) is present + instantiable
 *  - every leaf's `inherits` chain resolves to a vendored parent
 *  - the inheritance walk produces the right `nozzle_diameter` per
 *    machine + the right `layer_height` per process leaf
 *
 * Pairs with [SnapmakerPlaCatalogTest] which tests the filament
 * catalog. Same harness pattern: load directory, run leavesOf +
 * flatten, assert known values.
 */
class SnapmakerNozzleCatalogTest {

    private fun resolveProfileDir(sub: String): File? {
        val candidates = listOf(
            File("src/main/assets/profiles/Snapmaker/$sub"),
            File("app/src/main/assets/profiles/Snapmaker/$sub"),
        )
        return candidates.firstOrNull { it.isDirectory }
    }

    private fun loadProfileDir(sub: String): Pair<List<JSONObject>, Map<String, JSONObject>> {
        val dir = resolveProfileDir(sub)
        assumeTrue("$sub asset dir not found from CWD ${File(".").absolutePath}", dir != null)
        val files = dir!!.listFiles { _, name -> name.endsWith(".json") }!!.toList()
        val jsons = files.map { JSONObject(it.readText()) }
        val byName = jsons.filter { it.has("name") }.associateBy { it.getString("name") }
        return jsons to byName
    }

    @Test fun u1ZeroTwoNozzleMachineIsPresentAndInstantiable() {
        val (jsons, _) = loadProfileDir("machine")
        val match = jsons.firstOrNull { it.optString("name") == "Snapmaker U1 (0.2 nozzle)" }
        assertNotNull("Snapmaker U1 (0.2 nozzle) machine profile must be vendored", match)
        assertTrue("must be instantiable", match!!.optString("instantiation", "true") != "false")
    }

    @Test fun u1ZeroEightNozzleMachineIsPresentAndInstantiable() {
        val (jsons, _) = loadProfileDir("machine")
        val match = jsons.firstOrNull { it.optString("name") == "Snapmaker U1 (0.8 nozzle)" }
        assertNotNull("Snapmaker U1 (0.8 nozzle) machine profile must be vendored", match)
        assertTrue("must be instantiable", match!!.optString("instantiation", "true") != "false")
    }

    @Test fun u1ZeroTwoNozzleResolvesNozzleDiameter() {
        val (_, byName) = loadProfileDir("machine")
        val leaf = byName["Snapmaker U1 (0.2 nozzle)"]!!
        val flat = OrcaProfileLoader.flatten(leaf, byName)
        // nozzle_diameter is a flat string-encoded array per
        // PrintConfig serialization conventions; the 0.2 nozzle
        // machine must carry a 0.2 entry.
        val nd = flat["nozzle_diameter"] ?: ""
        assertTrue("nozzle_diameter must include 0.2 (got '$nd')", nd.contains("0.2"))
    }

    @Test fun u1ZeroEightNozzleResolvesNozzleDiameter() {
        val (_, byName) = loadProfileDir("machine")
        val leaf = byName["Snapmaker U1 (0.8 nozzle)"]!!
        val flat = OrcaProfileLoader.flatten(leaf, byName)
        val nd = flat["nozzle_diameter"] ?: ""
        assertTrue("nozzle_diameter must include 0.8 (got '$nd')", nd.contains("0.8"))
    }

    @Test fun zeroTwoNozzleProcessLeavesArePresent() {
        val (jsons, _) = loadProfileDir("process")
        val expected = setOf(
            "0.06 High Quality @Snapmaker U1 (0.2 nozzle)",
            "0.06 Standard @Snapmaker U1 (0.2 nozzle)",
            "0.08 High Quality @Snapmaker U1 (0.2 nozzle)",
            "0.08 Standard @Snapmaker U1 (0.2 nozzle)",
            "0.10 High Quality @Snapmaker U1 (0.2 nozzle)",
            "0.10 Standard @Snapmaker U1 (0.2 nozzle)",
            "0.12 Standard @Snapmaker U1 (0.2 nozzle)",
            "0.14 Standard @Snapmaker U1 (0.2 nozzle)",
        )
        val found = jsons.mapNotNull { it.optString("name").takeIf(String::isNotBlank) }
            .filter { it in expected }
            .toSet()
        assertEquals("every 0.2 nozzle process leaf must be vendored", expected, found)
    }

    @Test fun zeroEightNozzleProcessLeavesArePresent() {
        val (jsons, _) = loadProfileDir("process")
        val expected = setOf(
            "0.24 Standard @Snapmaker U1 (0.8 nozzle)",
            "0.32 Standard @Snapmaker U1 (0.8 nozzle)",
            "0.40 Standard @Snapmaker U1 (0.8 nozzle)",
            "0.48 Standard @Snapmaker U1 (0.8 nozzle)",
            "0.56 Standard @Snapmaker U1 (0.8 nozzle)",
        )
        val found = jsons.mapNotNull { it.optString("name").takeIf(String::isNotBlank) }
            .filter { it in expected }
            .toSet()
        assertEquals("every 0.8 nozzle process leaf must be vendored", expected, found)
    }

    @Test fun zeroTwoLeafResolvesLayerHeight() {
        val (_, byName) = loadProfileDir("process")
        val leaf = byName["0.06 Standard @Snapmaker U1 (0.2 nozzle)"]
            ?: error("leaf missing")
        val flat = OrcaProfileLoader.flatten(leaf, byName)
        assertEquals("layer_height should resolve to 0.06", "0.06", flat["layer_height"])
    }

    @Test fun zeroEightLeafResolvesLayerHeight() {
        val (_, byName) = loadProfileDir("process")
        val leaf = byName["0.40 Standard @Snapmaker U1 (0.8 nozzle)"]
            ?: error("leaf missing")
        val flat = OrcaProfileLoader.flatten(leaf, byName)
        assertEquals("layer_height should resolve to 0.4", "0.4", flat["layer_height"])
    }

    @Test fun everyVendoredLeafsInheritsChainResolves() {
        // Tripwire — fails if any vendored leaf's `inherits` points
        // at a parent that wasn't also vendored.
        val (machineJsons, machineByName) = loadProfileDir("machine")
        val (processJsons, processByName) = loadProfileDir("process")
        val (filamentJsons, filamentByName) = loadProfileDir("filament")
        val allByName = machineByName + processByName + filamentByName
        val allJsons = machineJsons + processJsons + filamentJsons

        for (leaf in allJsons) {
            val name = leaf.optString("name").takeIf(String::isNotBlank) ?: continue
            // Walk the chain manually.
            var cur: JSONObject? = leaf
            var depth = 0
            while (cur != null && depth < 16) {
                val parentName = cur.optString("inherits", "").takeIf(String::isNotBlank)
                    ?: break
                val parent = allByName[parentName]
                assertNotNull(
                    "leaf '$name' inherits from missing parent '$parentName'",
                    parent,
                )
                cur = parent
                depth += 1
            }
        }
    }
}
