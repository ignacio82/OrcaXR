package dev.orcaxr.app

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.ByteString.Companion.decodeHex
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Coverage for the Snapmaker U1 webcam discovery + JPEG extraction
 * path. We don't unit-test the WebSocket wake pulse — that needs a
 * mock WebSocket and Moonraker doesn't ack the JSON-RPC call; the
 * HTTP polling half is where every interesting corner case lives.
 */
class WebcamSessionTest {

    private lateinit var server: MockWebServer
    private val httpClient = OkHttpClient()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun makeSession(): WebcamSession {
        val baseUrl = server.url("/").toString().trimEnd('/')
        return WebcamSession(
            printer = PrinterConfig(id = "p1", name = "U1", host = "localhost", port = server.port),
            baseUrl = baseUrl,
            httpClient = httpClient,
            applyApiKey = { it },
        )
    }

    @Test fun fetchFrameDiscoversSnapshotUrlFromWebcamsList() {
        // /server/webcams/list publishes a snapshot_url; the session
        // should resolve and use it. Subsequent /server/files/camera/
        // monitor.jpg returns a tiny JPEG.
        val jpeg = "FFD8FFE000".decodeHex().toByteArray() + ByteArray(8) +
            "FFD9".decodeHex().toByteArray()
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"result":{"webcams":[{"name":"u1","snapshot_url":"/server/files/camera/monitor.jpg"}]}}""",
                ),
        )
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "image/jpeg")
                .setBody(Buffer().apply { write(jpeg) }),
        )

        val session = makeSession()
        val result = kotlinx.coroutines.runBlocking { session.fetchFrame() }
        assertTrue("expected Ok, got $result", result is MoonrakerResult.Ok)
        // First request was /server/webcams/list, second was the
        // resolved snapshot_url + cache buster.
        val first = server.takeRequest()
        assertEquals("/server/webcams/list", first.path)
        val second = server.takeRequest()
        assertTrue("snapshot path: ${second.path}", second.path?.startsWith("/server/files/camera/monitor.jpg") == true)
        assertTrue("cache buster present: ${second.path}", second.path?.contains("_cb=") == true)
    }

    @Test fun fetchFrameFallsBackToLegacyPathWhenListEmpty() {
        // Empty webcams list (or an HTTP 404) — the fallback list
        // must contain monitor.jpg AND /webcam/?action=snapshot. We
        // test that the session walks past 404s to find a working
        // candidate.
        server.enqueue(MockResponse().setResponseCode(404)) // /server/webcams/list
        server.enqueue(MockResponse().setResponseCode(404)) // monitor.jpg
        val jpeg = "FFD8FFE000".decodeHex().toByteArray() + ByteArray(4) +
            "FFD9".decodeHex().toByteArray()
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "image/jpeg")
                .setBody(Buffer().apply { write(jpeg) }),
        )

        val session = makeSession()
        val result = kotlinx.coroutines.runBlocking { session.fetchFrame() }
        assertTrue("expected Ok, got $result", result is MoonrakerResult.Ok)
        // /webcam/?action=snapshot should have been the third request.
        server.takeRequest() // /server/webcams/list
        server.takeRequest() // monitor.jpg (404)
        val mjpg = server.takeRequest()
        assertTrue("legacy path: ${mjpg.path}", mjpg.path?.startsWith("/webcam/") == true)
    }

    @Test fun fetchFrameExtractsJpegFromMultipartBody() {
        // mjpg-streamer's `?action=stream` URL replies with
        // multipart/x-mixed-replace. Even when called as a single GET,
        // it sends one frame followed by another --boundary segment.
        // We must extract the first JPEG and ignore the rest.
        server.enqueue(MockResponse().setResponseCode(404)) // /server/webcams/list
        server.enqueue(MockResponse().setResponseCode(404)) // monitor.jpg
        val frameOne = "FFD8FFE000".decodeHex().toByteArray() + ByteArray(4) +
            "FFD9".decodeHex().toByteArray()
        // Multipart preamble + boundary + headers + JPEG + trailing
        // boundary. The exact bytes don't matter — extractFirstJpeg
        // walks for SOI (FF D8) and EOI (FF D9) markers.
        val multipart = "--boundary\r\nContent-Type: image/jpeg\r\n\r\n".toByteArray() +
            frameOne +
            "\r\n--boundary--\r\n".toByteArray()
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "multipart/x-mixed-replace; boundary=boundary")
                .setBody(Buffer().apply { write(multipart) }),
        )

        val session = makeSession()
        val result = kotlinx.coroutines.runBlocking { session.fetchFrame() }
        assertTrue("expected Ok, got $result", result is MoonrakerResult.Ok)
        val bytes = (result as MoonrakerResult.Ok).value
        // Extracted JPEG should be exactly frameOne (SOI..EOI).
        assertEquals(frameOne.size, bytes.size)
        assertEquals(0xFF.toByte(), bytes[0])
        assertEquals(0xD8.toByte(), bytes[1])
        assertEquals(0xFF.toByte(), bytes[bytes.size - 2])
        assertEquals(0xD9.toByte(), bytes[bytes.size - 1])
    }

    @Test fun fetchFrameReturnsNotFoundOnlyAfterEveryCandidateFails() {
        // Make every candidate 404 forever; the session must walk
        // through the full candidate list AT LEAST once before
        // surfacing NotFound (so a single 404 doesn't kill the
        // panel). After enough consecutive failures, NotFound.
        repeat(20) { server.enqueue(MockResponse().setResponseCode(404)) }
        val session = makeSession()
        var lastResult: MoonrakerResult<ByteArray>? = null
        kotlinx.coroutines.runBlocking {
            // Walk a few rounds — should eventually surface NotFound.
            repeat(5) {
                lastResult = session.fetchFrame()
            }
        }
        assertNotNull(lastResult)
        assertTrue(
            "expected NotFound or IoError, got $lastResult",
            lastResult is MoonrakerResult.NotFound || lastResult is MoonrakerResult.IoError,
        )
    }
}
