package dev.orcaxr.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * F2 second slice — Snapmaker U1 ABS / ASA / PETG / PETG-CF branded
 * filament leaves vendored from the AGPL Snapmaker fork v2.3.1. Same
 * harness pattern as [SnapmakerPlaCatalogTest]: load directory, run
 * `flatten()`, assert known per-material values.
 *
 * The PLA-family equivalent ([SnapmakerPlaCatalogTest]) has a
 * known-failing test (`matteTunesNozzleTemperatureTo220`) on main —
 * see project memory. Don't model these tests on the failing one;
 * use values that match what the vendored JSON actually carries.
 */
class SnapmakerAbsPetgCatalogTest {

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

    @Test fun absAsaPetgFamilyLeavesAreInstantiable() {
        val (jsons, _) = loadFilamentDir()
        val expected = setOf(
            "Snapmaker ABS",
            "Snapmaker ASA",
            "Snapmaker PETG",
            "Snapmaker PETG-CF",
        )
        val parents = jsons.mapNotNullTo(mutableSetOf()) {
            it.optString("inherits", "").takeIf(String::isNotBlank)
        }
        val foundLeaves = jsons.filter {
            val n = it.optString("name", "")
            n.isNotBlank() &&
                n !in parents &&
                it.optString("instantiation", "true") != "false" &&
                catalogKeyOf(it) in expected &&
                n.contains("@U1")
        }.map(::catalogKeyOf).toSet()
        assertEquals(
            "every ABS/ASA/PETG U1 leaf must be present and instantiable",
            expected, foundLeaves,
        )
    }

    @Test fun absLeafResolvesAbsFilamentType() {
        val (_, byName) = loadFilamentDir()
        val abs = byName["Snapmaker ABS @U1"]
            ?: error("Snapmaker ABS @U1 missing")
        val flat = OrcaProfileLoader.flatten(abs, byName)
        assertEquals("ABS", flat["filament_type"])
    }

    @Test fun asaLeafResolvesAsaFilamentType() {
        val (_, byName) = loadFilamentDir()
        val asa = byName["Snapmaker ASA @U1"]
            ?: error("Snapmaker ASA @U1 missing")
        val flat = OrcaProfileLoader.flatten(asa, byName)
        assertEquals("ASA", flat["filament_type"])
    }

    @Test fun petgLeafResolvesPetgFilamentType() {
        val (_, byName) = loadFilamentDir()
        val petg = byName["Snapmaker PETG @U1"]
            ?: error("Snapmaker PETG @U1 missing")
        val flat = OrcaProfileLoader.flatten(petg, byName)
        // Filament type may be PETG or PET depending on fork version;
        // accept either.
        val ft = flat["filament_type"]
        assertTrue("filament_type should be PETG or PET, got '$ft'", ft == "PETG" || ft == "PET")
    }

    @Test fun petgCfLeafResolvesNozzleTemperature() {
        val (_, byName) = loadFilamentDir()
        val cf = byName["Snapmaker PETG-CF @U1"]
            ?: error("Snapmaker PETG-CF @U1 missing")
        val flat = OrcaProfileLoader.flatten(cf, byName)
        val temp = flat["nozzle_temperature"]?.toIntOrNull()
        // PETG-CF runs hot; sanity check that the chain delivers a
        // numeric temperature in the expected band.
        assertNotNull("nozzle_temperature must resolve", temp)
        assertTrue("PETG-CF nozzle_temperature ($temp) should be ≥ 220", temp!! >= 220)
    }
}
