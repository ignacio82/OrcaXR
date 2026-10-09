package dev.orcaxr.core

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.SocketFactory
import okhttp3.Dns
import okhttp3.OkHttpClient

/** The local-network permission: which addresses and names need it, and a
 * client that is refused before anything is sent while it is denied — when
 * the platform would leave the connection to time out — then reaches the
 * simulator once it is granted, loses it on revocation and regains it on a
 * new grant. Connections are redirected to the simulator, so only the
 * address the permission is judged by differs. */
object ProjectLocalNetworkChecks {
    private fun units(text: String) = text.map { it.code }
    private fun absentFinite() = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
    private fun absentText() = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)

    private class Redirecting(private val target: InetSocketAddress) : SocketFactory() {
        override fun createSocket(): Socket = object : Socket() {
            override fun connect(endpoint: SocketAddress, timeout: Int) = super.connect(target, timeout)
        }
        override fun createSocket(host: String, port: Int): Socket = throw UnsupportedOperationException()
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = throw UnsupportedOperationException()
        override fun createSocket(host: InetAddress, port: Int): Socket = throw UnsupportedOperationException()
        override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket =
            throw UnsupportedOperationException()
    }

    private class Resolver(private val resolved: String) : Dns {
        val lookups = mutableListOf<String>()
        override fun lookup(hostname: String): List<InetAddress> {
            synchronized(lookups) { lookups += hostname }
            return listOf(InetAddress.getByName(resolved))
        }
    }

    private fun client(host: String, port: Int, resolver: Resolver, permission: LocalNetworkPermission): MoonrakerClient {
        val http = OkHttpClient.Builder()
            .dns(resolver)
            .socketFactory(Redirecting(InetSocketAddress("127.0.0.1", port)))
            .build()
        return MoonrakerClient(
            ProjectIntents.MoonrakerTransportConfig(
                units("http://$host:$port"), absentFinite(), absentText(), absentText(),
                ProjectIntents.MoonrakerVersionPolicyInput(ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite()),
                absentText(), absentText(),
                ProjectIntents.OptionalFinite.Value(30_000.0), ProjectIntents.OptionalFinite.Value(30_000.0), absentFinite(), absentFinite(),
                ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite(), absentFinite(), absentFinite(), absentFinite()),
            ),
            http,
            localNetwork = permission,
        )
    }

    private fun <T> refused(call: MoonrakerCall<T>): ProjectIntents.MoonrakerTransportFault? = try {
        call.result.get(15, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        (thrown.cause as? MoonrakerException)?.fault
    }

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val needs = listOf(
            "10.1.2.3", "172.16.0.1", "192.168.1.5", "169.254.1.1", "224.0.0.251", "fe80::1", "fd12:3456::1",
            "ff02::fb", "::ffff:192.168.1.5",
        )
        val free = listOf("127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8")
        for (address in needs) check(LocalNetworkAccess.requiresPermission(InetAddress.getByName(address)), "needs $address")
        for (address in free) check(!LocalNetworkAccess.requiresPermission(InetAddress.getByName(address)), "free $address")
        for (name in listOf("printer.local", "Printer.LOCAL.", "local")) check(LocalNetworkAccess.multicastName(name), "mdns $name")
        for (name in listOf("printer.example", "localhost", "mylocal")) check(!LocalNetworkAccess.multicastName(name), "dns $name")

        val port = URI(endpoint).port
        val allowed = AtomicBoolean(false)
        val permission = LocalNetworkPermission { allowed.get() }

        // Denied: a LAN printer is refused at once, not left to time out.
        client("printer.example", port, Resolver("192.168.77.7"), permission).use { denied ->
            val started = System.nanoTime()
            check(refused(denied.connect())?.code == ProjectIntents.MoonrakerErrorCode.Network, "denied_refused")
            check(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(5), "denied_promptly")
        }
        // A multicast name is refused before it is even resolved.
        val mdns = Resolver("192.168.77.7")
        client("printer.local", port, mdns, permission).use { denied ->
            check(refused(denied.connect())?.code == ProjectIntents.MoonrakerErrorCode.Network, "mdns_refused")
            check(mdns.lookups.isEmpty(), "mdns_unresolved")
        }
        // Granted: connected; revoked: the next request is refused before it
        // leaves; granted again: the same client reaches the printer.
        allowed.set(true)
        client("printer.example", port, Resolver("192.168.77.7"), permission).use { client ->
            client.connect().result.get(15, TimeUnit.SECONDS)
            check(client.state is ProjectIntents.MoonrakerConnectionState.Connected, "granted_connected")
            allowed.set(false)
            check(refused(client.request("/server/info", MoonrakerRequestOptions(operation = "revoked"))) != null, "revoked_refused")
            allowed.set(true)
            check(refused(client.request("/printer/info", MoonrakerRequestOptions(operation = "regranted"))) == null, "regranted_reaches")
        }
        return checks
    }
}
