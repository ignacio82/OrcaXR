package dev.orcaxr.core

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * The platform's DNS-SD browse for the service Moonraker advertises
 * (`_moonraker._tcp`, published by its zeroconf component), feeding a
 * [PrinterDiscovery] run: each service found is resolved to an address and
 * offered there for verification. Only the platform's service discovery is
 * used — no range of addresses is ever scanned.
 *
 * A browse lasts [WINDOW_MS]; the run stays open after it, so probes in
 * flight still land. [onChange] hears the browse start and end.
 */
class AndroidPrinterDiscovery(
    context: Context,
    private val discovery: PrinterDiscovery,
    private val onChange: () -> Unit = {},
) : AutoCloseable {
    companion object {
        const val SERVICE_TYPE = "_moonraker._tcp"
        const val DEFAULT_PORT = 7125
        val SERVICE_TYPES = listOf(SERVICE_TYPE, "_snapmaker._tcp", "_octoprint._tcp")
        const val WINDOW_MS = 15_000L
        private const val ANDROID_14 = 34

        /** The address a printer is reached at: IPv4 first, else a routable IPv6 one (a link-local one names no interface here). */
        fun address(addresses: List<InetAddress>): String? {
            addresses.firstOrNull { it is Inet4Address }?.let { return it.hostAddress }
            return addresses.firstOrNull { it is Inet6Address && !it.isLinkLocalAddress }?.let { "[${it.hostAddress!!.substringBefore('%')}]" }
        }
    }

    private val nsd: NsdManager = context.getSystemService(NsdManager::class.java)
    private val wifiManager = runCatching { context.applicationContext.getSystemService(WifiManager::class.java) }.getOrNull()
    private val multicastLock = runCatching { wifiManager?.createMulticastLock("OrcaXR:Discovery") }.getOrNull()
    private val thread = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "printer-discovery").also { it.isDaemon = true }
    }

    /**
     * Where the platform's callbacks run: on [thread], or nowhere once this is
     * closed — the platform still delivers a few (an unregistration, a late
     * update) after that, and a rejected one would crash its handler thread.
     */
    private val post = Executor { task ->
        try {
            thread.execute(task)
        } catch (_: RejectedExecutionException) {
            // Closed: nothing is listening.
        }
    }

    // Everything below is touched on [thread] only.
    private val listeners = ArrayList<NsdManager.DiscoveryListener>()
    private var window: ScheduledFuture<*>? = null
    private var run = 0L
    /** Android 14 and later: one callback per service, unregistered once it names an address. */
    private val watching = ArrayList<Any>()
    /** Before Android 14 the platform resolves one service at a time. */
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    @Volatile var browsing: Boolean = false
        private set

    private var directSocket: DatagramSocket? = null
    private var directThread: Thread? = null

    /** Starts a new run and browses for [WINDOW_MS]; a browse already going is ended first. */
    fun start() = post.execute {
        end()
        run = discovery.start()
        val current = run
        android.util.Log.i("OrcaXR:Discovery", "Starting discovery run $current across ${SERVICE_TYPES.joinToString()}")
        for (serviceType in SERVICE_TYPES) {
            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) {
                    android.util.Log.i("OrcaXR:Discovery", "Discovery started for $serviceType")
                }
                override fun onDiscoveryStopped(serviceType: String) {
                    android.util.Log.i("OrcaXR:Discovery", "Discovery stopped for $serviceType")
                }
                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = post.execute {
                    android.util.Log.e("OrcaXR:Discovery", "Start discovery failed for $serviceType, error: $errorCode")
                    listeners.remove(this)
                    if (listeners.isEmpty() && directSocket == null) end()
                }
                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                    android.util.Log.w("OrcaXR:Discovery", "Stop discovery failed for $serviceType, error: $errorCode")
                }
                override fun onServiceFound(serviceInfo: NsdServiceInfo) = post.execute {
                    android.util.Log.i("OrcaXR:Discovery", "Service found: name=${serviceInfo.serviceName}, type=${serviceInfo.serviceType}")
                    if (run == current && this in listeners) resolve(current, serviceInfo)
                }
                override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                    android.util.Log.d("OrcaXR:Discovery", "Service lost: name=${serviceInfo.serviceName}, type=${serviceInfo.serviceType}")
                }
            }
            try {
                nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
                listeners.add(listener)
            } catch (err: RuntimeException) {
                android.util.Log.e("OrcaXR:Discovery", "Failed to invoke discoverServices for $serviceType: ${err.message}", err)
            }
        }
        startDirectProbe(current)
        browsing = true
        window = thread.schedule({
            android.util.Log.i("OrcaXR:Discovery", "Browse window timed out ($WINDOW_MS ms)")
            end()
        }, WINDOW_MS, TimeUnit.MILLISECONDS)
        onChange()
    }

    private fun startDirectProbe(current: Long) {
        val sock = try {
            DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                soTimeout = 1000
                bind(InetSocketAddress(0))
            }
        } catch (err: Exception) {
            android.util.Log.w("OrcaXR:Discovery", "Direct probe socket creation failed: ${err.message}")
            return
        }
        directSocket = sock
        runCatching { multicastLock?.acquire() }

        val queryPackets = SERVICE_TYPES.map { DirectDnsParser.buildQuery(it) }

        directThread = Thread({
            android.util.Log.i("OrcaXR:Discovery", "Direct probe thread started for run $current")
            fun sendQueries() {
                val destinations = LinkedHashSet<InetAddress>()
                runCatching { destinations += InetAddress.getByName("224.0.0.251") }
                runCatching {
                    val interfaces = NetworkInterface.getNetworkInterfaces() ?: return@runCatching
                    for (iface in interfaces) {
                        if (!iface.isUp || iface.isLoopback) continue
                        for (addr in iface.interfaceAddresses) {
                            addr.broadcast?.let { destinations += it }
                        }
                    }
                }
                for (dest in destinations) {
                    for (pkt in queryPackets) {
                        try {
                            sock.send(DatagramPacket(pkt, pkt.size, dest, 5353))
                        } catch (_: Exception) {
                        }
                    }
                }
            }

            sendQueries()
            var lastQuery = System.currentTimeMillis()
            val buf = ByteArray(4096)
            while (run == current && browsing && !sock.isClosed) {
                val recvPacket = DatagramPacket(buf, buf.size)
                try {
                    sock.receive(recvPacket)
                } catch (_: SocketTimeoutException) {
                    val now = System.currentTimeMillis()
                    if (now - lastQuery >= 3000L) {
                        lastQuery = now
                        sendQueries()
                    }
                    continue
                } catch (_: SocketException) {
                    break
                } catch (_: Exception) {
                    break
                }
                val sender = recvPacket.address ?: continue
                if (sender.isLoopbackAddress) continue
                val host = sender.hostAddress ?: continue
                val record = DirectDnsParser.parse(recvPacket.data, recvPacket.length) ?: continue
                android.util.Log.i("OrcaXR:Discovery", "Direct probe received valid record: name=${record.name}, type=${record.serviceType}, host=$host, port=${record.port}")
                post.execute {
                    if (run == current && browsing) {
                        offer(current, record.name, host, record.port, record.serviceType)
                    }
                }
            }
            android.util.Log.i("OrcaXR:Discovery", "Direct probe thread exiting for run $current")
        }, "direct-mdns-probe").also {
            it.isDaemon = true
            it.start()
        }
    }

    /** Ends the browse and the run: answers still on their way are dropped. */
    fun stop() = post.execute {
        end()
        discovery.stop()
    }

    /** Ends the browse (keeping the run): no more services are looked for or resolved. */
    private fun end() {
        window?.cancel(false)
        window = null
        for (listener in listeners) runCatching { nsd.stopServiceDiscovery(listener) }
        listeners.clear()
        if (Build.VERSION.SDK_INT >= ANDROID_14) {
            for (callback in watching) runCatching { nsd.unregisterServiceInfoCallback(callback as NsdManager.ServiceInfoCallback) }
        }
        watching.clear()
        queue.clear()
        runCatching { directSocket?.close() }
        directSocket = null
        directThread = null
        runCatching { if (multicastLock?.isHeld == true) multicastLock.release() }
        val was = browsing
        browsing = false
        if (was) onChange()
    }

    private fun offer(current: Long, serviceName: String, host: String, servicePort: Int, serviceType: String?) {
        val isSnapmaker = serviceType?.contains("snapmaker", ignoreCase = true) == true || servicePort == 1884
        val port = if (isSnapmaker) DEFAULT_PORT else servicePort
        if (port in 1..65535) {
            android.util.Log.i("OrcaXR:Discovery", "Offering candidate: name=$serviceName, host=$host, port=$port (isSnapmaker=$isSnapmaker)")
            discovery.offer(current, DiscoveryCandidate(serviceName, host, port))
        }
        if (servicePort in 1..65535 && servicePort != port) {
            android.util.Log.i("OrcaXR:Discovery", "Offering original candidate: name=$serviceName, host=$host, port=$servicePort")
            discovery.offer(current, DiscoveryCandidate(serviceName, host, servicePort))
        }
        if (!isSnapmaker && servicePort != DEFAULT_PORT && serviceType?.contains("octoprint", ignoreCase = true) == true) {
            discovery.offer(current, DiscoveryCandidate(serviceName, host, DEFAULT_PORT))
        }
    }

    private fun offer(current: Long, service: NsdServiceInfo, addresses: List<InetAddress>, fallbackType: String? = null) {
        val host = address(addresses) ?: return
        val type = service.serviceType ?: fallbackType
        android.util.Log.i("OrcaXR:Discovery", "Resolving service: name=${service.serviceName}, type=$type, host=$host, port=${service.port}")
        offer(current, service.serviceName, host, service.port, type)
    }

    private fun resolve(current: Long, service: NsdServiceInfo) {
        if (Build.VERSION.SDK_INT >= ANDROID_14) watch(current, service) else {
            queue.addLast(service)
            next(current)
        }
    }

    @android.annotation.TargetApi(ANDROID_14)
    private fun watch(current: Long, service: NsdServiceInfo) {
        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                watching.remove(this)
            }
            override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
                if (run != current || this !in watching || serviceInfo.hostAddresses.isEmpty()) return
                offer(current, serviceInfo, serviceInfo.hostAddresses, fallbackType = service.serviceType)
                watching.remove(this)
                runCatching { nsd.unregisterServiceInfoCallback(this) }
            }
            override fun onServiceLost() = Unit
            override fun onServiceInfoCallbackUnregistered() = Unit
        }
        watching += callback
        try {
            nsd.registerServiceInfoCallback(service, post, callback)
        } catch (refused: RuntimeException) {
            watching.remove(callback)
        }
    }

    @Suppress("DEPRECATION")
    private fun next(current: Long) {
        if (resolving || run != current) return
        val service = queue.removeFirstOrNull() ?: return
        resolving = true
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = post.execute {
                resolving = false
                next(current)
            }
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) = post.execute {
                resolving = false
                if (run == current && browsing) serviceInfo.host?.let { offer(current, serviceInfo, listOf(it), fallbackType = service.serviceType) }
                next(current)
            }
        }
        try {
            nsd.resolveService(service, listener)
        } catch (refused: RuntimeException) {
            resolving = false
        }
    }

    override fun close() {
        stop()
        thread.shutdown()
    }
}
