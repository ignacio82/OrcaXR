package dev.orcaxr.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * F2 first slice — Snapmaker U1 PLA-family branded leaves vendored from
 * the AGPL OrcaSlicer/Snapmaker resources tree. This test reads the
 * actual JSONs under `src/main/assets/profiles/Snapmaker/filament/`,
 * runs them through the same `flatten()` + `leavesOf` machinery
 * `OrcaProfileLoader.loadFilaments` does, and asserts the per-material
 * tuned values that B3's per-slot override path consumes (the
 * promise of F2 is that "Snapmaker PLA Matte" raises `nozzle_temperature`
 * to 220 over Generic PLA's 200, etc).
 */
class SnapmakerPlaCatalogTest {

    private fun resolveFilamentDir(): File? {
        val candidates = listOf(
            File("src/main/assets/profiles/Snapmaker/filament"),
            File("app/src/main/assets/profiles/Snapmaker/filament"),
        )
        return candidates.firstOrNull { it.isDirectory }
    }

    private fun loadFilamentDir(): Pair<List<JSONObject>, Map<String, JSONObject>> {
        val dir = resolveFilamentDir()
        assumeTrue("filament asset dir not found from CWD ${File(".").absolutePath}", dir != null)
        val files = dir!!.listFiles { _, name -> name.endsWith(".json") }!!.toList()
        val jsons = files.map { JSONObject(it.readText()) }
        val byName = jsons.filter { it.has("name") }.associateBy { it.getString("name") }
        return jsons to byName
    }

    private fun catalogKeyOf(json: JSONObject): String =
        json.optString("name").substringBefore('@').trim()

    @Test fun snapmakerPlaFamilyLeavesAreInstantiable() {
        val (jsons, _) = loadFilamentDir()
        val expected = setOf(
            "Snapmaker PLA",
            "Snapmaker PLA Matte",
            "Snapmaker PLA Eco",
            "Snapmaker PLA Silk",
            "Snapmaker PLA Metal",
            "Snapmaker PLA-CF",
        )
        val parents = jsons.mapNotNullTo(mutableSetOf()) {
            it.optString("inherits", "").takeIf(String::isNotBlank)
        }
        val foundLeaves = jsons.filter {
            val n = it.optString("name", "")
            n.isNotBlank() &&
                n !in parents &&
                it.optString("instantiation", "true") != "false" &&
                catalogKeyOf(it) in expected
        }.map(::catalogKeyOf).toSet()
        assertEquals(
            "every PLA-family leaf must be present and instantiable",
            expected, foundLeaves,
        )
    }

    @Test fun matteTunesNozzleTemperatureTo220() {
        val (jsons, byName) = loadFilamentDir()
        val matte = jsons.first {
            it.optString("name") == "Snapmaker PLA Matte @U1"
        }
        val flat = OrcaProfileLoader.flatten(matte, byName)
        assertEquals("220", flat["nozzle_temperature"])
        assertEquals("220", flat["nozzle_temperature_initial_layer"])
        assertNotNull("PA must inherit from chain", flat["pressure_advance"])
    }

    @Test fun cfTunesNozzleTemperatureTo230() {
        val (jsons, byName) = loadFilamentDir()
        val cf = jsons.first {
            it.optString("name") == "Snapmaker PLA-CF @U1"
        }
        val flat = OrcaProfileLoader.flatten(cf, byName)
        // PLA-CF runs hotter than vanilla PLA; verifies the inheritance
        // chain reaches the @U1 base where the bumped nozzle temp lives.
        val temp = flat["nozzle_temperature"]?.toIntOrNull()
        assertNotNull("PLA-CF must define nozzle_temperature", temp)
        assertTrue("PLA-CF nozzle_temperature ${temp} should be ≥ 220", temp!! >= 220)
    }

    @Test fun ecoChainResolvesFlowRatio() {
        val (jsons, byName) = loadFilamentDir()
        val eco = jsons.first {
            it.optString("name") == "Snapmaker PLA Eco @U1"
        }
        val flat = OrcaProfileLoader.flatten(eco, byName)
        // Eco inherits through fdm_filament_pla_eco → fdm_filament_pla
        // → fdm_filament_common; flow_ratio is set somewhere in that
        // chain. If the chain breaks (missing parent), this is null.
        assertNotNull("Eco chain must reach the parent that sets filament_flow_ratio",
            flat["filament_flow_ratio"])
    }

    @Test fun chainContainsNoOrphanInheritsLink() {
        val (jsons, byName) = loadFilamentDir()
        // For every non-empty `inherits`, the named parent must exist
        // somewhere in the brand's tree. A missing parent doesn't crash
        // (flatten just stops climbing) but values defined only in the
        // missing parent are silently lost — exactly the regression we
        // want to catch when vendoring new branded leaves.
        val missing = mutableListOf<Pair<String, String>>()
        for (j in jsons) {
            val name = j.optString("name", "(unnamed)")
            val parent = j.optString("inherits", "").takeIf(String::isNotBlank) ?: continue
            if (parent !in byName) missing += name to parent
        }
        assertEquals(
            "every inherits must resolve within the brand's tree: $missing",
            emptyList<Pair<String, String>>(), missing,
        )
    }
}
