package dev.orcaxr.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-parse tests for `/printer/info` and `/server/info` payloads,
 * plus the discovery-name formatter. The HTTP path inside
 * [MoonrakerClient] hits real OkHttp + DataStore so it doesn't unit-
 * test cleanly without a local server fixture; the parse helpers
 * extracted onto the data-class companions ARE pure JSON consumers.
 */
class MoonrakerClientParseTest {

    @Test fun printerInfoParseMapsStateToKlippyState() {
        // Real /printer/info response shape (verified via curl on the
        // user's Snapmaker U1 — 1.3.0.168 firmware on 2026-04-29).
        // Note: there is NO `klippy_state` key on this endpoint —
        // Klippy's host process state is exposed in `state`. The
        // earlier code read `klippy_state` and resolved to "unknown"
        // on every printer. parse() now maps from `state` instead.
        val json = JSONObject(
            """
            {
              "state": "ready",
              "state_message": "Printer is ready",
              "hostname": "lava",
              "software_version": "1.3.0.168_20260414155825"
            }
            """.trimIndent(),
        )
        val info = PrinterInfo.parse(json)
        assertEquals("ready", info.state)
        assertEquals("ready", info.klippyState)
        assertEquals("lava", info.hostname)
        assertEquals("1.3.0.168_20260414155825", info.softwareVersion)
    }

    @Test fun printerInfoParseFallsBackToUnknownWhenStateMissing() {
        // Defensive: a stripped /printer/info (auth-rejected, partial)
        // shouldn't crash parse — it should report "unknown" state so
        // the caller's discovery validation log stays informative.
        val info = PrinterInfo.parse(JSONObject("""{ "hostname": "" }"""))
        assertEquals("unknown", info.state)
        assertEquals("unknown", info.klippyState)
        assertEquals("", info.hostname)
        assertEquals("", info.softwareVersion)
    }

    @Test fun serverInfoParseExtractsComponentsAndKlippyState() {
        // Real /server/info response shape (curl-verified). The
        // `components` array is what we fingerprint for vendor
        // detection — Snapmaker's fork loads `snapmakercloud`,
        // vanilla MainsailOS does not.
        val json = JSONObject(
            """
            {
              "klippy_connected": true,
              "klippy_state": "ready",
              "components": [
                "secrets", "template", "klippy_connection",
                "websockets", "snapmakercloud", "zeroconf"
              ],
              "moonraker_version": "1.3.0"
            }
            """.trimIndent(),
        )
        val server = ServerInfo.parse(json)
        assertEquals("ready", server.klippyState)
        assertEquals("1.3.0", server.moonrakerVersion)
        assertTrue("snapmakercloud" in server.components)
        assertTrue("websockets" in server.components)
        assertEquals(6, server.components.size)
    }

    @Test fun serverInfoParseEmptyComponentsArrayIsSafe() {
        val server = ServerInfo.parse(JSONObject("{}"))
        assertEquals(emptyList<String>(), server.components)
        assertEquals("unknown", server.klippyState)
        assertEquals("", server.moonrakerVersion)
    }

    @Test fun vendorIsSnapmakerWhenSnapmakercloudComponentPresent() {
        val server = ServerInfo(
            components = listOf("websockets", "snapmakercloud", "zeroconf"),
            klippyState = "ready",
            moonrakerVersion = "1.3.0",
        )
        assertEquals("Snapmaker", server.vendor())
    }

    @Test fun vendorIsNullForVanillaMainsail() {
        // Vanilla MainsailOS / FluiddPi components — the user's
        // Centauri Carbon ships this stack. No Snapmaker plugin, so
        // vendor inference falls back to null and the label uses the
        // hostname.
        val server = ServerInfo(
            components = listOf(
                "websockets", "klippy_apis", "data_store",
                "history", "octoprint_compat",
            ),
            klippyState = "ready",
            moonrakerVersion = "0.9.3",
        )
        assertNull(server.vendor())
    }

    @Test fun formatDiscoveryNamePrefersVendorOverHostname() {
        // Canonical Snapmaker U1 case: hostname "lava" is generic
        // (every MainsailOS install is "lava" by default), so the
        // vendor fingerprint MUST win for the row to be readable.
        val label = formatDiscoveryName(
            hostname = "lava",
            vendor = "Snapmaker",
            host = "192.168.1.228",
        )
        assertEquals("Snapmaker (192.168.1.228)", label)
    }

    @Test fun formatDiscoveryNameFallsBackToHostnameWhenNoVendor() {
        val label = formatDiscoveryName(
            hostname = "myprinter",
            vendor = null,
            host = "192.168.1.50",
        )
        assertEquals("myprinter (192.168.1.50)", label)
    }

    @Test fun formatDiscoveryNameFallsBackToBareHostWhenNothingKnown() {
        val label = formatDiscoveryName(
            hostname = null,
            vendor = null,
            host = "192.168.1.99",
        )
        assertEquals("192.168.1.99", label)
    }

    @Test fun formatDiscoveryNameTreatsBlankInputAsAbsent() {
        // Empty strings come from MoonrakerClient when /printer/info
        // returned a result block without a hostname (auth-stripped
        // or partial response). Treat blank as null so we don't
        // render "  (192.168.1.228)" or similar.
        val label = formatDiscoveryName(
            hostname = "",
            vendor = "",
            host = "192.168.1.228",
        )
        assertEquals("192.168.1.228", label)
    }

    @Test fun formatDiscoveryNameSkipsHostnameThatEqualsHost() {
        // Some Klipper hosts return their IP as the hostname (no
        // /etc/hostname configured). "192.168.1.50 (192.168.1.50)"
        // would be redundant — fall through to the next layer.
        val label = formatDiscoveryName(
            hostname = "192.168.1.50",
            vendor = null,
            host = "192.168.1.50",
        )
        assertEquals("192.168.1.50", label)
    }
}
