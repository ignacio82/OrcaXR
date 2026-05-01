package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SlicerProfileTest {

    @Test
    fun testSlicerProfileInitialization() {
        val profile = SlicerProfile(
            id = "test_id",
            displayName = "Test Name",
            description = "Test Desc",
            config = mapOf("key" to "value")
        )

        assertEquals("test_id", profile.id)
        assertEquals("Test Name", profile.displayName)
        assertEquals("Test Desc", profile.description)
        assertEquals(mapOf("key" to "value"), profile.config)
    }

    @Test
    fun testProfilesDefault() {
        val defaultProfile = Profiles.default

        assertEquals("centauri_carbon_0.4_pla_standard", defaultProfile.id)
        assertEquals("Elegoo Centauri Carbon · 0.4 · PLA", defaultProfile.displayName)

        // Check some of the standard quality base configs
        assertEquals("0.20", defaultProfile.config["layer_height"])
        assertEquals("0.20", defaultProfile.config["initial_layer_print_height"])
        assertEquals("3", defaultProfile.config["wall_loops"])

        // Check some of the filament configs
        assertEquals("215", defaultProfile.config["nozzle_temperature"])
        assertEquals("220", defaultProfile.config["nozzle_temperature_initial_layer"])
        assertEquals("60", defaultProfile.config["hot_plate_temp"])
        assertEquals("60", defaultProfile.config["hot_plate_temp_initial_layer"])

        // Check overriding generic configs
        assertEquals("256", defaultProfile.config["printable_height"])
        assertEquals("klipper", defaultProfile.config["gcode_flavor"])
    }

    @Test
    fun testProfilesAll() {
        // all is supposed to be empty
        assertTrue(Profiles.all.isEmpty())
    }
}
