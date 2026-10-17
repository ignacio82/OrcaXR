package dev.orcaxr.nativeapp.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterCameraWidgetTest {

    @Test
    fun testResolveCandidateUrls_relativeUrls() {
        val urlsLeadingSlash = PrinterCameraDiscovery.resolveCandidateUrls(
            host = "192.168.1.228",
            port = 7125,
            snapshotUrl = "/webcam/snapshot.jpg",
        )
        assertEquals(2, urlsLeadingSlash.size)
        assertEquals("http://192.168.1.228/webcam/snapshot.jpg", urlsLeadingSlash[0])
        assertEquals("http://192.168.1.228:7125/webcam/snapshot.jpg", urlsLeadingSlash[1])

        val urlsBare = PrinterCameraDiscovery.resolveCandidateUrls(
            host = "192.168.1.228",
            port = 7125,
            snapshotUrl = "screen/snapshot",
        )
        assertEquals(2, urlsBare.size)
        assertEquals("http://192.168.1.228/screen/snapshot", urlsBare[0])
        assertEquals("http://192.168.1.228:7125/screen/snapshot", urlsBare[1])
    }

    @Test
    fun testResolveCandidateUrls_absoluteUrls() {
        val httpUrl = PrinterCameraDiscovery.resolveCandidateUrls(
            host = "192.168.1.228",
            port = 7125,
            snapshotUrl = "http://192.168.1.50:8080/?action=snapshot",
        )
        assertEquals(listOf("http://192.168.1.50:8080/?action=snapshot"), httpUrl)

        val httpsUrl = PrinterCameraDiscovery.resolveCandidateUrls(
            host = "192.168.1.228",
            port = 7125,
            snapshotUrl = "https://printer.local/camera/snapshot",
        )
        assertEquals(listOf("https://printer.local/camera/snapshot"), httpsUrl)
    }

    @Test
    fun testParseWebcamsJson() {
        val json = """
            {
              "result": {
                "webcams": [
                  {
                    "name": "case",
                    "enabled": true,
                    "icon": "mdiWebcam",
                    "aspect_ratio": "16:9",
                    "target_fps": 15,
                    "target_fps_idle": 5,
                    "location": "printer",
                    "service": "webrtc-camerastreamer",
                    "stream_url": "/webcam/webrtc",
                    "snapshot_url": "/webcam/snapshot.jpg",
                    "flip_horizontal": false,
                    "flip_vertical": true,
                    "rotation": 180,
                    "source": "config",
                    "extra_data": {},
                    "uid": "b46ed60e-478f-52e1-aa7f-ef77195d7e5f"
                  },
                  {
                    "name": "gui",
                    "enabled": false,
                    "icon": "mdiWebcam",
                    "aspect_ratio": "480:320",
                    "target_fps": 30,
                    "service": "iframe",
                    "stream_url": "/screen/",
                    "snapshot_url": "/screen/snapshot",
                    "flip_horizontal": true,
                    "flip_vertical": false,
                    "rotation": 0,
                    "uid": "bc963a69-748e-547d-abc8-d535e6b9ff58"
                  }
                ]
              }
            }
        """.trimIndent()

        val webcams = PrinterCameraDiscovery.parseWebcamsJson(json)
        assertEquals(2, webcams.size)

        val caseCam = webcams[0]
        assertEquals("case", caseCam.name)
        assertEquals("b46ed60e-478f-52e1-aa7f-ef77195d7e5f", caseCam.uid)
        assertEquals("webrtc-camerastreamer", caseCam.service)
        assertEquals("/webcam/snapshot.jpg", caseCam.snapshotUrl)
        assertTrue(caseCam.enabled)
        assertEquals(15.0, caseCam.targetFps, 0.001)
        assertEquals("16:9", caseCam.aspectRatio)
        assertFalse(caseCam.flipHorizontal)
        assertTrue(caseCam.flipVertical)
        assertEquals(180, caseCam.rotation)

        val guiCam = webcams[1]
        assertEquals("gui", guiCam.name)
        assertEquals("bc963a69-748e-547d-abc8-d535e6b9ff58", guiCam.uid)
        assertEquals("iframe", guiCam.service)
        assertEquals("/screen/snapshot", guiCam.snapshotUrl)
        assertFalse(guiCam.enabled)
        assertEquals(30.0, guiCam.targetFps, 0.001)
        assertEquals("480:320", guiCam.aspectRatio)
        assertTrue(guiCam.flipHorizontal)
        assertFalse(guiCam.flipVertical)
        assertEquals(0, guiCam.rotation)
    }

    @Test
    fun testParseWebcamsJson_emptyOrMalformed() {
        assertTrue(PrinterCameraDiscovery.parseWebcamsJson("{}").isEmpty())
        assertTrue(PrinterCameraDiscovery.parseWebcamsJson("{\"result\": {}}").isEmpty())
        assertTrue(PrinterCameraDiscovery.parseWebcamsJson("{\"result\": {\"webcams\": []}}").isEmpty())
    }
}
