package dev.orcaxr.nativeapp.engine

import dev.orcaxr.nativeapp.prepare.AttestedEngine
import dev.orcaxr.nativeapp.prepare.PrepareWords
import dev.orcaxr.nativeapp.prepare.SliceRouteKind
import dev.orcaxr.nativeapp.prepare.SlicerConnection
import dev.orcaxr.nativeapp.prepare.sliceRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalEngineRouteTest {
    private val commit = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626"
    private val gib = 1L shl 30
    private val ready = LocalEngineState(commit, "x86_64", totalMemory = 4 * gib, availableMemory = 2 * gib)
    private val endpoint = "http://10.0.2.2:3000"
    private val external = SlicerConnection().probing(endpoint).let {
        it.probed(it.generation, AttestedEngine(cli = true, commit = commit), "")
    }

    @Test
    fun aDeviceSlicesLocallyOnlyWithThePackagedEngineAndEnoughMemory() {
        assertTrue(ready.available)
        assertNull(ready.reason)
        assertEquals(LocalEngineWords.NOT_PACKAGED, LocalEngineState.NONE.reason)
        assertFalse(LocalEngineState.NONE.available)
        assertEquals(LocalEngineWords.NO_ABI, ready.copy(abi = null).reason)
        assertEquals(LocalEngineWords.SMALL_DEVICE, ready.copy(totalMemory = 1 * gib).reason)
        assertEquals(LocalEngineWords.LOW_MEMORY, ready.copy(lowMemory = true).reason)
        // Too little available even for the engine's own baseline.
        assertEquals(LocalEngineWords.LOW_MEMORY, ready.copy(availableMemory = LocalSliceBudget.BASELINE_BYTES).reason)
        assertFalse(ready.copy(lowMemory = true).available)
    }

    @Test
    fun aPlateIsAdmittedAgainstTheMemoryMeasuredNow() {
        val archive = 10L shl 20
        assertEquals(LocalSliceBudget.BASELINE_BYTES + archive * LocalSliceBudget.ARCHIVE_EXPANSION, LocalSliceBudget.required(archive))
        val largest = LocalSliceBudget.largestArchive(ready.availableMemory)
        assertTrue(LocalSliceBudget.fits(largest, ready))
        assertFalse(LocalSliceBudget.fits(largest + 1, ready))
        assertFalse("an unavailable engine admits nothing", LocalSliceBudget.fits(1, ready.copy(abi = null)))
        assertEquals(0, LocalSliceBudget.largestArchive(0))
        assertEquals(
            "The plate needs about 416 MB to slice on this device, which has 2048 MB available now.",
            LocalEngineWords.tooLarge(archive, ready),
        )
    }

    @Test
    fun theRouteIsTheExternalSlicerTheOperatorTurnedOnOtherwiseThisDevice() {
        assertEquals(SliceRouteKind.External, sliceRoute(external, ready))
        assertEquals(SliceRouteKind.External, sliceRoute(external, LocalEngineState.NONE))
        assertEquals(SliceRouteKind.Local, sliceRoute(external.disable(), ready))
        assertEquals(SliceRouteKind.Local, sliceRoute(SlicerConnection(), ready))
        // A slicer being checked or refused is off: never chosen in the device's place.
        assertEquals(SliceRouteKind.Local, sliceRoute(SlicerConnection().probing(endpoint), ready))
        assertEquals(SliceRouteKind.None, sliceRoute(SlicerConnection().probing(endpoint), LocalEngineState.NONE))
        assertEquals(SliceRouteKind.None, sliceRoute(SlicerConnection(), ready.copy(lowMemory = true)))
    }

    @Test
    fun prepareSaysWhichRouteAndWhy() {
        assertEquals(
            "Slicing route: this device's own engine (Snapmaker Orca at 9fd12ffb2b1b), as external slicing is off. " +
                "Plates of up to 112 MB fit the memory this device has now.",
            PrepareWords.route(SlicerConnection(), ready),
        )
        assertTrue(PrepareWords.route(external, ready).startsWith("Slicing route: the external slicer at $endpoint, whose engine attested as"))
        assertEquals(
            "Slicing route: none. ${LocalEngineWords.LOW_MEMORY} Connect an external slicer whose engine attests.",
            PrepareWords.route(SlicerConnection(), ready.copy(lowMemory = true)),
        )
        assertEquals(PrepareWords.OFF_LOCAL, PrepareWords.hint(SlicerConnection(), ready))
        assertEquals(PrepareWords.OFF, PrepareWords.hint(SlicerConnection(), LocalEngineState.NONE))
        assertEquals("On — models will be sliced on the external server.", PrepareWords.hint(external, ready))
        // The browser's words when the device slices instead; the device's own when it cannot.
        assertEquals("External slicer connection failed — slicing locally.", PrepareWords.connectionFailed(ready))
        assertEquals("External slicer removed — slicing locally.", PrepareWords.removed(ready))
        assertEquals(PrepareWords.CONNECTION_FAILED, PrepareWords.connectionFailed(LocalEngineState.NONE))
        assertEquals(PrepareWords.REMOVED, PrepareWords.removed(LocalEngineState.NONE))
    }

    @Test
    fun jobsAreNamedByThirtyTwoHexDigits() {
        assertTrue(LocalEngineFiles.validJob("0123456789abcdef0123456789abcdef"))
        assertFalse(LocalEngineFiles.validJob("0123456789ABCDEF0123456789abcdef"))
        assertFalse(LocalEngineFiles.validJob("../0123456789abcdef0123456789ab"))
        assertFalse(LocalEngineFiles.validJob(""))
    }
}
