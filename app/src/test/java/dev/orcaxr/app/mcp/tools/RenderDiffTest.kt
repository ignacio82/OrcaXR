package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.PngWriter
import dev.orcaxr.app.mcp.AiSessionState
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RenderDiffTest {

    private fun fakeArtifact(session: AiSessionState, w: Int, h: Int, fillColor: IntArray): String {
        val rgba = ByteArray(w * h * 4)
        for (i in 0 until w * h) {
            val o = i * 4
            rgba[o] = fillColor[0].toByte()
            rgba[o + 1] = fillColor[1].toByte()
            rgba[o + 2] = fillColor[2].toByte()
            rgba[o + 3] = 255.toByte()
        }
        val png = PngWriter.encodeRgba(rgba, w, h)
        val cam = AiRenderEngine.CameraSpec(FloatArray(16), FloatArray(16), w, h)
        val token = "fake_${fillColor.joinToString("_")}_${System.nanoTime()}"
        session.saveArtifact(AiSessionState.RenderArtifact(
            token = token, pngBytes = png, widthPx = w, heightPx = h,
            camera = cam, triangleIdMap = null,
            createdAtMs = System.currentTimeMillis(),
        ))
        return token
    }

    @Test fun identicalRendersHaveZeroChangedPixels() = runTest {
        val session = AiSessionState()
        val tA = fakeArtifact(session, 32, 32, intArrayOf(100, 100, 100))
        val tB = fakeArtifact(session, 32, 32, intArrayOf(100, 100, 100))
        val tool = AiVisionTools.RenderDiff(session)
        val res = tool.call(JSONObject().apply { put("token_a", tA); put("token_b", tB) })
        val s = res.structured!!
        assertEquals(0, s.getInt("changed_pixels"))
        assertEquals(32 * 32, s.getInt("total_pixels"))
    }

    @Test fun completelyDifferentRendersFlagAllPixels() = runTest {
        val session = AiSessionState()
        val tA = fakeArtifact(session, 16, 16, intArrayOf(0, 0, 0))
        val tB = fakeArtifact(session, 16, 16, intArrayOf(255, 255, 255))
        val res = AiVisionTools.RenderDiff(session)
            .call(JSONObject().apply { put("token_a", tA); put("token_b", tB) })
        val s = res.structured!!
        assertEquals(16 * 16, s.getInt("changed_pixels"))
    }

    @Test fun thresholdHidesSmallDifferences() = runTest {
        val session = AiSessionState()
        val tA = fakeArtifact(session, 16, 16, intArrayOf(100, 100, 100))
        val tB = fakeArtifact(session, 16, 16, intArrayOf(105, 105, 105))
        // threshold=10 should hide the 5-unit diff.
        val res = AiVisionTools.RenderDiff(session)
            .call(JSONObject().apply {
                put("token_a", tA); put("token_b", tB)
                put("threshold", 10)
            })
        val s = res.structured!!
        assertEquals(0, s.getInt("changed_pixels"))
    }

    @Test fun dimensionMismatchReturnsError() = runTest {
        val session = AiSessionState()
        val tA = fakeArtifact(session, 16, 16, intArrayOf(0, 0, 0))
        val tB = fakeArtifact(session, 32, 32, intArrayOf(0, 0, 0))
        val res = AiVisionTools.RenderDiff(session)
            .call(JSONObject().apply { put("token_a", tA); put("token_b", tB) })
        assertTrue("expected isError on dim mismatch", res.isError)
    }

    @Test fun unknownTokenReturnsError() = runTest {
        val session = AiSessionState()
        val tA = fakeArtifact(session, 16, 16, intArrayOf(0, 0, 0))
        val res = AiVisionTools.RenderDiff(session)
            .call(JSONObject().apply { put("token_a", tA); put("token_b", "nope") })
        assertTrue(res.isError)
    }

    @Test fun diffArtifactIsRetrievableViaToken() = runTest {
        val session = AiSessionState()
        val tA = fakeArtifact(session, 8, 8, intArrayOf(0, 0, 0))
        val tB = fakeArtifact(session, 8, 8, intArrayOf(255, 0, 0))
        val res = AiVisionTools.RenderDiff(session)
            .call(JSONObject().apply { put("token_a", tA); put("token_b", tB) })
        val newToken = res.structured!!.getString("render_token")
        // The diff artifact is now in the session.
        val art = session.getArtifact(newToken)
        assertNotNull(art)
        assertEquals(8, art!!.widthPx)
    }
}
