package dev.orcaxr.app

import androidx.test.core.app.ActivityScenario
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class SpatialGltfProbeTest {
    @Test
    fun spatialGltfModelLoadSwapDisposeAndMaterialOverrideProbe() {
        SpatialGltfProbeRegistry.reset()

        val scenario = ActivityScenario.launch(SpatialGltfProbeActivity::class.java)
        val result = try {
            SpatialGltfProbeRegistry.await(timeoutMs = 120_000)
        } finally {
            scenario.close()
        }

        assertNotNull("SpatialGltf probe did not publish a result", result)
        val r = result!!
        assumeTrue(r.message, r.outcome != SpatialGltfProbeOutcome.Skipped)
        assertEquals(r.message, SpatialGltfProbeOutcome.Passed, r.outcome)
        assertEquals("probe should complete all load/swap/dispose cycles", 50, r.cyclesCompleted)
        assertEquals("each cycle loads two generated GLBs", 100, r.loadsCompleted)
        assertEquals("each load should exercise GltfModelNode material override", 100, r.materialOverrides)
        assertTrue("expected at least one glTF node", r.maxNodeCount > 0)
    }
}
