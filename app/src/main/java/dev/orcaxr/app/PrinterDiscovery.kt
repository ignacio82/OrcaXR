package dev.orcaxr.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One advertisement we picked up off the LAN.
 *
 * `host` is the resolved IPv4/IPv6 string, `port` is the SRV port,
 * `sn` is the printer serial number from the TXT record (Snapmaker
 * uses this as the MQTT topic prefix; useful as a stable identifier
 * even if the hostname changes), `version` is the firmware version
 * string Snapmaker advertises.
 */
data class DiscoveredPrinter(
    val name: String,
    val host: String,
    val port: Int,
    val sn: String?,
    val version: String?,
    val serviceType: String,
)

/**
 * mDNS / DNS-SD browser for slicer-relevant LAN services. Currently
 * looks for `_snapmaker._tcp` (advertised by Snapmaker firmwares —
 * source: src/slic3r/GUI/BonjourDialog.cpp in Snapmaker's OrcaSlicer
 * fork, line 126 `Bonjour("snapmaker")`). Adding more service types
 * later (e.g. `_octoprint._tcp`, `_printer._tcp`) is just another
 * call to [discoverServices].
 *
 * We use Android's [NsdManager] rather than a third-party mDNS
 * library — same API used for the OpenXR runtime probe.
 * Wraps the listener+resolve callback dance into a single
 * [StateFlow] of currently-visible services.
 */
class PrinterDiscovery(ctx: Context) {

    private val nsdManager = ctx.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val listeners = mutableListOf<NsdManager.DiscoveryListener>()
    private val validationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _services = MutableStateFlow<List<DiscoveredPrinter>>(emptyList())
    val services: StateFlow<List<DiscoveredPrinter>> = _services

    /** Begin browsing. Idempotent — calling twice is a no-op. */
    fun start() {
        if (listeners.isNotEmpty()) return
        for (type in SERVICE_TYPES) {
            android.util.Log.i("OrcaXR/discovery", "starting NSD discovery for $type")
            val l = makeListener(type)
            try {
                nsdManager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l)
                listeners += l
            } catch (e: Throwable) {
                android.util.Log.e("OrcaXR/discovery", "discoverServices threw for $type", e)
            }
        }
    }

    fun stop() {
        listeners.forEach {
            runCatching { nsdManager.stopServiceDiscovery(it) }
        }
        listeners.clear()
        _services.value = emptyList()
    }

    private fun addEntry(entry: DiscoveredPrinter) {
        _services.update { existing ->
            // Replace any prior entry for the same host so the
            // richest-data record wins (mDNS resolves with TXT data
            // beat bare subnet hits).
            (existing.filterNot { it.host == entry.host } + entry).sortedBy { it.name }
        }
    }

    /**
     * Merge externally-discovered services (e.g. from
     * [SubnetScanner.scanLan]) into the same list that drives the UI.
     * De-duped by host so a printer found via both mDNS and the
     * subnet sweep shows up once.
     */
    fun addResults(extras: List<DiscoveredPrinter>) {
        if (extras.isEmpty()) return
        _services.update { existing ->
            val byHost = (existing + extras).groupBy { it.host }
            byHost.values
                .map { group ->
                    // Prefer entries that carry a real serial number /
                    // version (mDNS-resolved) over bare subnet hits.
                    group.maxBy { (if (it.sn != null) 2 else 0) + (if (it.version != null) 1 else 0) }
                }
                .sortedBy { it.name }
        }
    }

    private fun makeListener(serviceType: String) = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(t: String) {
            android.util.Log.i("OrcaXR/discovery", "discovery started for $t")
        }
        override fun onDiscoveryStopped(t: String) {
            android.util.Log.i("OrcaXR/discovery", "discovery stopped for $t")
        }
        override fun onStartDiscoveryFailed(t: String, errorCode: Int) {
            android.util.Log.e("OrcaXR/discovery", "NSD start failed for $t: $errorCode")
        }
        override fun onStopDiscoveryFailed(t: String, errorCode: Int) {
            android.util.Log.e("OrcaXR/discovery", "NSD stop failed for $t: $errorCode")
        }
        override fun onServiceFound(info: NsdServiceInfo) {
            android.util.Log.i(
                "OrcaXR/discovery",
                "found name='${info.serviceName}' type='${info.serviceType}' on $serviceType",
            )
            @Suppress("DEPRECATION")
            nsdManager.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    android.util.Log.w(
                        "OrcaXR/discovery",
                        "resolve failed for ${serviceInfo.serviceName}: $errorCode",
                    )
                }
                override fun onServiceResolved(resolved: NsdServiceInfo) {
                    val host = resolved.host?.hostAddress
                    val txt = runCatching { resolved.attributes }.getOrNull().orEmpty()
                    android.util.Log.i(
                        "OrcaXR/discovery",
                        "resolved name='${resolved.serviceName}' host=$host:${resolved.port} txt=${txt.keys}",
                    )
                    if (host == null) return
                    val sn = txt["sn"]?.let { String(it, Charsets.UTF_8) }
                    val version = txt["version"]?.let { String(it, Charsets.UTF_8) }
                    val entry = DiscoveredPrinter(
                        name = resolved.serviceName,
                        host = host,
                        port = resolved.port,
                        sn = sn,
                        version = version,
                        serviceType = serviceType,
                    )
                    // Snapmaker / OctoPrint / Moonraker service types
                    // are slicer-specific by definition — the
                    // advertisement implies "this is a printer", so
                    // skip the validation round-trip and trust them.
                    // _workstation and _http are the noisy types
                    // (they pick up Home Assistant, Brother printers,
                    // wled controllers, etc.); validate via Moonraker
                    // probe before showing.
                    val needsValidation = serviceType.startsWith("_workstation") ||
                        serviceType.startsWith("_http")
                    if (!needsValidation) {
                        addEntry(entry)
                        return
                    }
                    validationScope.launch {
                        val cfg = PrinterConfig(
                            id = "validate_${entry.host}",
                            name = entry.name,
                            host = entry.host,
                            port = entry.port,
                        )
                        val (workingCfg, result) = MoonrakerClient.probe(cfg)
                        if (result is MoonrakerResult.Ok) {
                            android.util.Log.i(
                                "OrcaXR/discovery",
                                "validated ${entry.host} as Moonraker on port ${workingCfg.port}",
                            )
                            addEntry(entry.copy(port = workingCfg.port))
                        } else {
                            android.util.Log.i(
                                "OrcaXR/discovery",
                                "rejected ${entry.host} (${entry.serviceType}): not Moonraker",
                            )
                        }
                    }
                }
            })
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            android.util.Log.i("OrcaXR/discovery", "service lost: ${info.serviceName}")
            _services.update { existing ->
                existing.filterNot { it.name == info.serviceName }
            }
        }
    }

    companion object {
        // Browse a few service types in parallel; the host this app
        // runs on is a tabletop XR headset and the LAN is small, so
        // even if a few of these are noisy the user can tell the
        // printer rows apart by name.
        //
        //  - _snapmaker._tcp: Snapmaker stock firmware (per their fork's
        //    BonjourDialog.cpp).
        //  - _octoprint._tcp: OctoPrint instances and many third-party
        //    Klipper distros that mimic OctoPrint's advertising.
        //  - _moonraker._tcp: rare but explicit when present.
        //  - _workstation._tcp: avahi-daemon default on Debian/Ubuntu —
        //    MainsailOS, FluiddPi, and most "lava"-named printer hosts
        //    advertise this. False-positive risk: any Linux box on
        //    the LAN. Validate-by-HTTP-probe handles that.
        //  - _http._tcp: generic; high noise. Validate before showing.
        private val SERVICE_TYPES = listOf(
            "_snapmaker._tcp.",
            "_octoprint._tcp.",
            "_moonraker._tcp.",
            "_workstation._tcp.",
            "_http._tcp.",
        )
    }
}
