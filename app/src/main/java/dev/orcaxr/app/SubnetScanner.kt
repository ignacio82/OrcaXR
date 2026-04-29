package dev.orcaxr.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.LinkProperties
import android.net.Network
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import java.net.Inet4Address

/**
 * Belt-and-suspenders LAN scan for the case where mDNS advertising
 * isn't on. We sweep the IPv4 /24 the headset's WiFi sits on, fast-
 * reject dead hosts via a TCP connect with a short timeout, then
 * full-probe Moonraker on the survivors.
 *
 * The Snapmaker U1 the user has does not advertise `_snapmaker._tcp`
 * (its hostname is "lava" — vanilla MainsailOS / FluiddPi rather than
 * Snapmaker firmware). Without this fallback we'd never find it.
 *
 * /24 is hard-coded — almost every consumer LAN is /24, and bigger
 * subnets (/16) would scan 65k addresses which is wasteful. If the
 * headset turns out to be on a /23 or larger we can revisit.
 */
object SubnetScanner {

    private val DEFAULT_PORTS = intArrayOf(80, 8080, 7125)

    /**
     * Returns Moonraker hits as fully-formed [DiscoveredPrinter]
     * records so they can flow into the same UI list as mDNS
     * results.
     *
     * `progress` is invoked with (scanned, total) after each /24
     * completes a port-touch round. The caller can render a progress
     * bar; pass `null` to ignore.
     */
    suspend fun scanLan(
        ctx: Context,
        ports: IntArray = DEFAULT_PORTS,
        // Bumped from 250 to 800 ms after a real-LAN miss: the
        // headset's WiFi radio gets contention spikes that push some
        // round-trips past 250 ms even though the device is up and
        // answering normally a moment later.
        connectTimeoutMs: Int = 800,
        progress: ((Int, Int) -> Unit)? = null,
    ): List<DiscoveredPrinter> = withContext(Dispatchers.IO) {
        val (subnet, selfAddr) = inferSubnet(ctx) ?: return@withContext emptyList()
        android.util.Log.i("OrcaXR/discovery", "subnet-scan: subnet=$subnet self=$selfAddr ports=${ports.toList()} timeout=${connectTimeoutMs}ms")
        val total = 254
        var done = 0
        val candidates: List<Pair<String, Int>> = coroutineScope {
            val chunks = (1..254).chunked(32)
            chunks.flatMap { chunk ->
                chunk.map { lastOctet ->
                    val host = "$subnet.$lastOctet"
                    if (host == selfAddr) return@map async { emptyList() }
                    async {
                        val openPorts = ports.filter {
                            MoonrakerClient.isPortOpen(host, it, connectTimeoutMs)
                        }
                        if (openPorts.isNotEmpty()) {
                            android.util.Log.i(
                                "OrcaXR/discovery",
                                "subnet-scan: $host open on $openPorts",
                            )
                        }
                        openPorts.map { host to it }
                    }
                }.awaitAll().also {
                    done += chunk.size
                    progress?.invoke(done, total)
                }.flatten()
            }
        }
        android.util.Log.i(
            "OrcaXR/discovery",
            "subnet-scan: ${candidates.size} candidate(s) before validation",
        )

        // Validate each open candidate with /printer/info. We do this
        // sequentially: when the parallel version ran 10 HttpURLConnection
        // calls at once, every single one returned IoError on the
        // headset — including a known-good printer that `curl` to the
        // same URL handled fine from the same shell. Suspect: Android's
        // network stack throttles fan-out connect()s and some fail
        // immediately with "Software caused connection abort". Sequential
        // probing dodges that and only costs a few seconds for the small
        // candidate set.
        val validated = mutableListOf<DiscoveredPrinter>()
        for ((host, port) in candidates) {
            val cfg = PrinterConfig(
                id = "scan_$host:$port",
                name = host,
                host = host,
                port = port,
            )
            val info = MoonrakerClient(cfg).ping()
            val detail = when (info) {
                is MoonrakerResult.Ok -> "klippy=${info.value.klippyState}"
                is MoonrakerResult.AuthError -> info.message
                is MoonrakerResult.NotFound -> info.message
                is MoonrakerResult.HttpError -> "code=${info.code}"
                is MoonrakerResult.IoError -> info.message
            }
            android.util.Log.i(
                "OrcaXR/discovery",
                "validate $host:$port -> ${info::class.simpleName} :: $detail",
            )
            if (info is MoonrakerResult.Ok) {
                // Vendor fingerprint from /server/info components list.
                // Best-effort — any failure leaves vendor=null and the
                // label falls back to hostname. Cheap (one extra GET
                // per validated host, no auth required).
                val vendor = (MoonrakerClient(cfg).serverInfo() as? MoonrakerResult.Ok<ServerInfo>)
                    ?.value?.vendor()
                val label = formatDiscoveryName(
                    hostname = info.value.hostname.ifBlank { null },
                    vendor = vendor,
                    host = host,
                )
                android.util.Log.i(
                    "OrcaXR/discovery",
                    "labelled $host:$port as \"$label\" (vendor=${vendor ?: "<unknown>"})",
                )
                validated += DiscoveredPrinter(
                    name = label,
                    host = host,
                    port = port,
                    sn = null,
                    version = info.value.softwareVersion.ifBlank { null },
                    serviceType = "subnet-scan",
                )
            }
        }
        validated
            .groupBy { it.host }
            .map { (_, group) -> group.minBy { it.port } }
            .sortedBy { it.host }
    }

    /**
     * Pulls the first IPv4 LinkAddress off the active default
     * network. Returns ("192.168.1", "192.168.1.112") for a typical
     * /24. Null if no IPv4 link is up.
     */
    private fun inferSubnet(ctx: Context): Pair<String, String>? {
        val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net: Network = cm.activeNetwork ?: return null
        val props: LinkProperties = cm.getLinkProperties(net) ?: return null
        for (la: LinkAddress in props.linkAddresses) {
            val addr = la.address
            if (addr is Inet4Address) {
                val full = addr.hostAddress ?: continue
                val dotted = full.split('.')
                if (dotted.size == 4) {
                    return dotted.subList(0, 3).joinToString(".") to full
                }
            }
        }
        return null
    }
}
