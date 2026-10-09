package dev.orcaxr.core

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.Inet4Address
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The platform's service discovery feeding a discovery run: a Moonraker
 * service advertised on this device is found, resolved and offered at the
 * port it answers on, and the platform's callbacks after the finder closed
 * are dropped rather than crashing the process. */
@RunWith(AndroidJUnit4::class)
class AndroidPrinterDiscoveryTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun anIpv4AddressIsPreferredAndALinkLocalOneIsNeverUsed() {
        val ipv4 = InetAddress.getByName("192.168.1.20")
        val linkLocal = InetAddress.getByName("fe80::1")
        val uniqueLocal = InetAddress.getByName("fd00::5")
        assertEquals("192.168.1.20", AndroidPrinterDiscovery.address(listOf(uniqueLocal, ipv4)))
        assertEquals("[fd00::5]", AndroidPrinterDiscovery.address(listOf(linkLocal, uniqueLocal)))
        assertNull(AndroidPrinterDiscovery.address(listOf(linkLocal)))
    }

    @Test fun aMoonrakerServiceOnTheNetworkIsOfferedWhereItAnswers() {
        val nsd = context.getSystemService(NsdManager::class.java)
        ServerSocket(0).use { server ->
            val registered = CountDownLatch(1)
            var name = ""
            val registration = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                    name = serviceInfo.serviceName
                    registered.countDown()
                }
                override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
                override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
                override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
            }
            val service = NsdServiceInfo().apply {
                serviceName = "OrcaXR test printer"
                serviceType = AndroidPrinterDiscovery.SERVICE_TYPE
                port = server.localPort
            }
            nsd.registerService(service, NsdManager.PROTOCOL_DNS_SD, registration)
            try {
                assertTrue("registered", registered.await(15, TimeUnit.SECONDS))
                val offered = LinkedBlockingQueue<DiscoveryCandidate>()
                val discovery = PrinterDiscovery { candidate ->
                    offered.add(candidate)
                    CompletableFuture.completedFuture(DiscoveryProbe.Moonraker("test-printer"))
                }
                AndroidPrinterDiscovery(context, discovery).use { finder ->
                    finder.start()
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    var ours: DiscoveryCandidate? = null
                    while (ours == null) {
                        val next = offered.poll(deadline - System.nanoTime(), TimeUnit.NANOSECONDS) ?: break
                        if (next.name == name) ours = next
                    }
                    assertNotNull("offered", ours)
                    assertEquals(server.localPort, ours!!.port)
                    assertTrue(ours.host, InetAddress.getByName(ours.host) is Inet4Address)
                    // The probe saw it; its answer is recorded on the finder's thread just after.
                    while (discovery.proposals.none { it.candidate == ours } && System.nanoTime() < deadline) Thread.sleep(20)
                    assertTrue(discovery.proposals.any { it.candidate == ours })
                }
                // The platform still delivers callbacks after the finder closed
                // (an unregistration, a late update); they must land harmlessly,
                // not crash its handler thread.
                Thread.sleep(2_000)
            } finally {
                nsd.unregisterService(registration)
            }
        }
    }
}
