package dev.orcaxr.core

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import okhttp3.Dns
import okhttp3.OkHttpClient

/** The plain-HTTP policy: which addresses are local, and a client that
 * reaches the simulator through a name resolved to a public address (refused
 * before anything is sent) or to a private one (admitted, socket included).
 * The connection is redirected to the simulator either way, so only the
 * address the policy judges differs. */
object ProjectLanPolicyChecks {
    private fun units(text: String) = text.map { it.code }
    private fun absentFinite() = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
    private fun absentText() = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)

    /** Connects every socket to [target], whatever address the route names. */
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

    private fun client(port: Int, resolved: String): MoonrakerClient {
        val http = OkHttpClient.Builder()
            .dns(object : Dns {
                override fun lookup(hostname: String) = listOf(InetAddress.getByName(resolved))
            })
            .socketFactory(Redirecting(InetSocketAddress("127.0.0.1", port)))
            .build()
        return MoonrakerClient(
            ProjectIntents.MoonrakerTransportConfig(
                units("http://printer.example:$port"), absentFinite(), absentText(), absentText(),
                ProjectIntents.MoonrakerVersionPolicyInput(ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite()),
                absentText(), absentText(),
                ProjectIntents.OptionalFinite.Value(5_000.0), ProjectIntents.OptionalFinite.Value(5_000.0), absentFinite(), absentFinite(),
                ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite(), absentFinite(), absentFinite(), absentFinite()),
            ),
            http,
        )
    }

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        val local = listOf(
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "169.254.1.1", "100.64.0.1",
            "100.127.255.254", "::1", "fe80::1", "fd12:3456::1", "::ffff:192.168.1.5",
        )
        val public = listOf("8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "192.169.0.1")
        for (address in local) check(LanTransportPolicy.isLocal(InetAddress.getByName(address))) { "local $address" }
        for (address in public) check(!LanTransportPolicy.isLocal(InetAddress.getByName(address))) { "public $address" }
        checks += local.size + public.size

        val port = URI(endpoint).port
        // A name resolved to a public address: refused before anything is sent.
        client(port, "93.184.215.14").use { refused ->
            val fault = try {
                refused.connect().result.get(15, TimeUnit.SECONDS)
                null
            } catch (thrown: ExecutionException) {
                (thrown.cause as? MoonrakerException)?.fault
            }
            check(fault?.code == ProjectIntents.MoonrakerErrorCode.Network) { "public_refused $fault" }; checks++
        }
        // The same name resolved to a private address: admitted, socket and all.
        client(port, "192.168.77.7").use { admitted ->
            admitted.connect().result.get(15, TimeUnit.SECONDS)
            check(admitted.state is ProjectIntents.MoonrakerConnectionState.Connected) { "private_admitted" }; checks++
        }
        return checks
    }
}
