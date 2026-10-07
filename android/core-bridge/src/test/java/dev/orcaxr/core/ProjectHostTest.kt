package dev.orcaxr.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProjectHostTest {
    private val options = ProjectHostOptions(
        documentBytes = 4_294_967_295L,
        documentNodes = 100_000,
        documentTextUnits = 200_000,
        numberBytes = 1024,
        depth = 128,
        assets = 10,
        assetBytes = 8_388_608,
        totalAssetBytes = 16_777_216,
        historyEntries = 100,
        historyBytes = 33_554_432,
    )

    @Test fun preservesUnsignedBudgetsAndWireFieldOrder() {
        assertEquals(1, ProjectHost.VERSION)
        assertArrayEquals(
            doubleArrayOf(4_294_967_295.0, 100_000.0, 200_000.0, 1024.0, 128.0,
                10.0, 8_388_608.0, 16_777_216.0, 100.0, 33_554_432.0),
            options.encode(), 0.0,
        )
        val encoded = options.encode()
        encoded.fill(0.0)
        assertEquals(4_294_967_295.0, options.encode()[0], 0.0)
    }

    @Test fun rejectsEveryOutOfRangeBudgetBeforeTransfer() {
        for (value in listOf(-1L, 4_294_967_296L, Long.MIN_VALUE, Long.MAX_VALUE)) {
            for (invalid in listOf(
                options.copy(documentBytes = value), options.copy(documentNodes = value),
                options.copy(documentTextUnits = value), options.copy(numberBytes = value),
                options.copy(depth = value), options.copy(assets = value),
                options.copy(assetBytes = value), options.copy(totalAssetBytes = value),
                options.copy(historyEntries = value), options.copy(historyBytes = value),
            )) assertThrows(IllegalArgumentException::class.java) { invalid.encode() }
        }
        assertThrows(IllegalArgumentException::class.java) { options.copy(depth = 129).encode() }
        assertThrows(IllegalArgumentException::class.java) { options.copy(numberBytes = 0).encode() }
    }
}
