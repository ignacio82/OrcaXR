package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

class PrinterDiscoveryTest {

    @Test
    fun formatDiscoveryName_vendorProvided_usesVendor() {
        val result = formatDiscoveryName(hostname = "lava", vendor = "Snapmaker", host = "192.168.1.228")
        assertEquals("Snapmaker (192.168.1.228)", result)
    }

    @Test
    fun formatDiscoveryName_vendorBlank_usesHostname() {
        val result = formatDiscoveryName(hostname = "lava", vendor = "   ", host = "192.168.1.228")
        assertEquals("lava (192.168.1.228)", result)
    }

    @Test
    fun formatDiscoveryName_vendorNull_usesHostname() {
        val result = formatDiscoveryName(hostname = "lava", vendor = null, host = "192.168.1.228")
        assertEquals("lava (192.168.1.228)", result)
    }

    @Test
    fun formatDiscoveryName_hostnameAndVendorNull_usesHostOnly() {
        val result = formatDiscoveryName(hostname = null, vendor = null, host = "192.168.1.228")
        assertEquals("192.168.1.228", result)
    }

    @Test
    fun formatDiscoveryName_hostnameAndVendorBlank_usesHostOnly() {
        val result = formatDiscoveryName(hostname = "  ", vendor = "  ", host = "192.168.1.228")
        assertEquals("192.168.1.228", result)
    }

    @Test
    fun formatDiscoveryName_hostnameMatchesHost_usesHostOnly() {
        val result = formatDiscoveryName(hostname = "192.168.1.228", vendor = null, host = "192.168.1.228")
        assertEquals("192.168.1.228", result)
    }
}
