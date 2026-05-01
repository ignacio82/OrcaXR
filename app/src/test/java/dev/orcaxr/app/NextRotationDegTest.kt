package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class NextRotationDegTest(
    private val current: Int,
    private val signedDirection: Int,
    private val expected: Int
) {

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "current={0}, dir={1} -> expected={2}")
        fun data(): Collection<Array<Any>> {
            return listOf(
                // Forward (dir > 0)
                arrayOf(0, 1, 90),
                arrayOf(90, 1, 180),
                arrayOf(180, 1, 270),
                arrayOf(270, 1, 0),

                // Backward (dir < 0)
                arrayOf(0, -1, 270),
                arrayOf(90, -1, 0),
                arrayOf(180, -1, 90),
                arrayOf(270, -1, 180),

                // Zero direction (dir = 0) normalizes
                arrayOf(450, 0, 90),
                arrayOf(-90, 0, 270),
                arrayOf(360, 0, 0),
                arrayOf(0, 0, 0),
                arrayOf(-360, 0, 0),

                // Negative start angles
                arrayOf(-90, 1, 0),
                arrayOf(-90, -1, 180),
                arrayOf(-180, 1, 270),
                arrayOf(-270, 1, 180),
                arrayOf(-360, 1, 90),
                arrayOf(-450, 1, 0),

                // Large positive start angles
                arrayOf(360, 1, 90),
                arrayOf(450, 1, 180),
                arrayOf(720, -1, 270),
                arrayOf(810, -1, 0),

                // Any positive direction > 1 is treated as positive
                arrayOf(0, 5, 90),
                arrayOf(90, 100, 180),

                // Any negative direction < -1 is treated as negative
                arrayOf(0, -5, 270),
                arrayOf(90, -100, 0)
            )
        }
    }

    @Test
    fun nextRotationDeg_isCorrect() {
        assertEquals(expected, nextRotationDeg(current, signedDirection))
    }
}
