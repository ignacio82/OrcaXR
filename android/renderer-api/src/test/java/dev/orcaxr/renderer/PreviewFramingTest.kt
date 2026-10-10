package dev.orcaxr.renderer

import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewFramingTest {
    private fun toolpath(center: FloatArray, halfExtent: FloatArray, segments: Int = 1) = ToolpathGeometry(
        ByteBuffer.allocateDirect(0), ByteBuffer.allocateDirect(0), ByteBuffer.allocateDirect(0),
        IntArray(segments), center, halfExtent,
    )

    @Test fun nothingToDrawFramesTheDefaultBed() {
        assertEquals(PreviewFraming(200.0, 200.0, 0.0, 0.0, 200.0, 200.0), PreviewFraming.of(null))
        assertEquals(256.0, PreviewFraming.of(toolpath(floatArrayOf(0f, 0f, 0f), floatArrayOf(1f, 1f, 1f), 0), 256.0).bedWidthMm, 0.0)
    }

    @Test fun theProjectsBedIsDrawnAsItIs() {
        // The U1's printable area reaches 270.5 x 271 mm: nothing drawn frames that bed.
        assertEquals(PreviewFraming(270.5, 271.0, 0.0, 0.0, 270.5, 271.0), PreviewFraming.of(null, 270.5, 271.0))
        // A print beyond one side grows that side alone, in grid steps.
        val framing = PreviewFraming.of(toolpath(floatArrayOf(.2265f, 0f, -.1505f), floatArrayOf(.0265f, 0f, .1505f)), 270.5, 271.0)
        assertEquals(270.5, framing.bedWidthMm, 0.0)
        assertEquals(310.0, framing.bedDepthMm, 0.0)
        assertEquals(1.0, PreviewFraming.drawable(.25), 0.0)
        assertEquals(PreviewFraming.MAX_BED_MM, PreviewFraming.drawable(1e300), 0.0)
        assertEquals(256.0, PreviewFraming.drawable(256.0), 0.0)
    }

    @Test fun aPrintIsFramedInBedMillimetres() {
        // Millimetres x 90..110, y 40..60 at z 0..10: render x .09..11, y 0..01, z -.06..-.04.
        val framing = PreviewFraming.of(toolpath(floatArrayOf(.1f, .005f, -.05f), floatArrayOf(.01f, .005f, .01f)))
        assertEquals(200.0, framing.bedWidthMm, 0.0)
        assertEquals(200.0, framing.bedDepthMm, 0.0)
        assertEquals(85.0, framing.minXMm, 1e-3)
        assertEquals(115.0, framing.maxXMm, 1e-3)
        assertEquals(35.0, framing.minYMm, 1e-3)
        assertEquals(65.0, framing.maxYMm, 1e-3)
    }

    @Test fun theBedGrowsInGridStepsToReachAPrintBeyondIt() {
        // Millimetres x 200..253, y 0..301.
        val framing = PreviewFraming.of(toolpath(floatArrayOf(.2265f, 0f, -.1505f), floatArrayOf(.0265f, 0f, .1505f)))
        assertEquals(260.0, framing.bedWidthMm, 0.0)
        assertEquals(310.0, framing.bedDepthMm, 0.0)
        assertEquals(PreviewFraming.MAX_BED_MM, PreviewFraming.of(toolpath(floatArrayOf(9f, 0f, 0f), floatArrayOf(1f, 0f, 0f))).bedWidthMm, 0.0)
    }
}
