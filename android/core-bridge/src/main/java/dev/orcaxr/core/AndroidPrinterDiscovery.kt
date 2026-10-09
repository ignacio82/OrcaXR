package dev.orcaxr.core

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
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
        const val WINDOW_MS = 15_000L
        private const val ANDROID_14 = 34

        /** The address a printer is reached at: IPv4 first, else a routable IPv6 one (a link-local one names no interface here). */
        fun address(addresses: List<InetAddress>): String? {
            addresses.firstOrNull { it is Inet4Address }?.let { return it.hostAddress }
            return addresses.firstOrNull { it is Inet6Address && !it.isLinkLocalAddress }?.let { "[${it.hostAddress!!.substringBefore('%')}]" }
        }
    }

    private val nsd: NsdManager = context.getSystemService(NsdManager::class.java)
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
    private var browse: NsdManager.DiscoveryListener? = null
    private var window: ScheduledFuture<*>? = null
    private var run = 0L
    /** Android 14 and later: one callback per service, unregistered once it names an address. */
    private val watching = ArrayList<Any>()
    /** Before Android 14 the platform resolves one service at a time. */
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    @Volatile var browsing: Boolean = false
        private set

    /** Starts a new run and browses for [WINDOW_MS]; a browse already going is ended first. */
    fun start() = post.execute {
        end()
        run = discovery.start()
        val current = run
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = post.execute {
                if (browse === this) {
                    browse = null
                    end()
                }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) = post.execute { if (run == current && browse === this) resolve(current, serviceInfo) }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
        }
        browse = listener
        browsing = true
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (refused: RuntimeException) {
            // Without the local-network permission the platform may refuse outright.
            browse = null
            end()
            return@execute
        }
        window = thread.schedule({ end() }, WINDOW_MS, TimeUnit.MILLISECONDS)
        onChange()
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
        browse?.let { listener -> runCatching { nsd.stopServiceDiscovery(listener) } }
        browse = null
        if (Build.VERSION.SDK_INT >= ANDROID_14) {
            for (callback in watching) runCatching { nsd.unregisterServiceInfoCallback(callback as NsdManager.ServiceInfoCallback) }
        }
        watching.clear()
        queue.clear()
        val was = browsing
        browsing = false
        if (was) onChange()
    }

    private fun offer(current: Long, service: NsdServiceInfo, addresses: List<InetAddress>) {
        val host = address(addresses) ?: return
        if (service.port !in 1..65535) return
        discovery.offer(current, DiscoveryCandidate(service.serviceName, host, service.port))
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
                offer(current, serviceInfo, serviceInfo.hostAddresses)
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
                if (run == current && browsing) serviceInfo.host?.let { offer(current, serviceInfo, listOf(it)) }
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
