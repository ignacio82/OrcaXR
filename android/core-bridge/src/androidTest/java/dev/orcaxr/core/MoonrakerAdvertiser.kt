package dev.orcaxr.core

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Not a test: a helper the emulator's Device-area smoke runs alongside the
 * app. It advertises `_moonraker._tcp` on this device the way Moonraker's
 * zeroconf component does, on a port that forwards to the Moonraker
 * simulator on the host, for `advertiseSeconds`. Without its arguments it is
 * skipped.
 */
@RunWith(AndroidJUnit4::class)
class MoonrakerAdvertiser {
    private fun pipe(from: InputStream, to: OutputStream, done: () -> Unit) = Thread {
        try {
            from.copyTo(to)
        } catch (_: java.io.IOException) {
        } finally {
            done()
        }
    }.apply { isDaemon = true }.start()

    @Test fun advertise() {
        val arguments = InstrumentationRegistry.getArguments()
        val target = arguments.getString("advertiseMoonraker")
        assumeTrue(target != null)
        val seconds = arguments.getString("advertiseSeconds")?.toLong() ?: 120
        val (host, port) = target!!.split(":").let { it[0] to it[1].toInt() }
        // On Android 17 the driver grants the local-network permission (`pm grant`): asking
        // UiAutomation here would take the one connection its screen reads need.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val nsd = context.getSystemService(NsdManager::class.java)
        ServerSocket(0).use { server ->
            Thread {
                while (!server.isClosed) {
                    val client = try { server.accept() } catch (_: java.io.IOException) { break }
                    val upstream = try { Socket(host, port) } catch (_: java.io.IOException) { client.close(); continue }
                    val close = { client.close(); upstream.close() }
                    pipe(client.getInputStream(), upstream.getOutputStream(), close)
                    pipe(upstream.getInputStream(), client.getOutputStream(), close)
                }
            }.apply { isDaemon = true }.start()
            val registered = CountDownLatch(1)
            val registration = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(serviceInfo: NsdServiceInfo) = registered.countDown()
                override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
                override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
                override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
            }
            val service = NsdServiceInfo().apply {
                serviceName = "Moonraker on the emulator"
                serviceType = AndroidPrinterDiscovery.SERVICE_TYPE
                setPort(server.localPort)
            }
            nsd.registerService(service, NsdManager.PROTOCOL_DNS_SD, registration)
            try {
                assertTrue("registered", registered.await(15, TimeUnit.SECONDS))
                Thread.sleep(TimeUnit.SECONDS.toMillis(seconds))
            } finally {
                nsd.unregisterService(registration)
            }
        }
    }
}
