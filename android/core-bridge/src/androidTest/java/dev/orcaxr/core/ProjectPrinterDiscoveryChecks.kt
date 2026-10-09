package dev.orcaxr.core

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.net.SocketFactory
import okhttp3.OkHttpClient

/** Discovery against two Moonraker simulators — one open, one asking for a
 * key — a web server that is not Moonraker and a port nothing answers on:
 * each verified by the handshake with no key sent, only the two printers
 * proposed, a candidate probed once per run and at most 32 of them, a probe
 * for an earlier or stopped run dropped when it answers, and nothing saved
 * until the operator adds a proposal — not even by a probe that completes
 * after the operator chose another printer. A printer that needs a key is
 * added without one and connects once its key is entered. */
object ProjectPrinterDiscoveryChecks {
    private const val WAIT_S = 15L

    private class MemoryText : DeviceTextStore {
        var text: String? = null
        override fun read() = text
        override fun write(text: String) { this.text = text }
    }
    private class MemoryBlob : SecretBlobStore {
        var blob: ByteArray? = null
        override fun read() = blob?.copyOf()
        override fun write(blob: ByteArray) { this.blob = blob.copyOf() }
        override fun delete() { blob = null }
    }
    private class SoftwareKeys : SecretKeySource {
        var key: SecretKey? = null
        override fun existing() = key
        override fun create(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
        override fun delete() { key = null }
    }
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

    /** A web server that answers every request with a page: something, but not Moonraker. */
    private fun webPage(): ServerSocket {
        val server = ServerSocket(0, 8, InetAddress.getLoopbackAddress())
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: IOException) { break }
                socket.use {
                    val reader = it.getInputStream().bufferedReader()
                    while (reader.readLine()?.isNotEmpty() == true) Unit
                    val page = "<html>router</html>"
                    it.getOutputStream().write(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${page.length}\r\nConnection: close\r\n\r\n$page".toByteArray(),
                    )
                }
            }
        }.apply { isDaemon = true }.start()
        return server
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** Waits until [discovery] has no probe in flight. */
    private fun settled(discovery: PrinterDiscovery) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (discovery.probing > 0) {
            kotlin.check(System.nanoTime() < deadline) { "probes never settled" }
            Thread.sleep(25)
        }
    }

    @JvmStatic fun run(endpoint: String, lockedEndpoint: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val open = URI(endpoint).port
        val locked = URI(lockedEndpoint).port
        val page = webPage()
        val closed = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).let { val port = it.localPort; it.close(); port }
        val loopback = "127.0.0.1"

        // The probe alone: the handshake a connection makes, without a key.
        val probe = MoonrakerProbe()
        val answer = { port: Int -> probe(DiscoveryCandidate("Candidate", loopback, port)).get(WAIT_S, TimeUnit.SECONDS) }
        check(answer(open) == DiscoveryProbe.Moonraker("orcaxr-simulator"), "open_printer_verified")
        check(answer(locked) == DiscoveryProbe.NeedsKey, "locked_printer_needs_key")
        check(answer(page.localPort) is DiscoveryProbe.Unverified, "web_page_not_moonraker")
        check(answer(closed) is DiscoveryProbe.Unverified, "nothing_answers")

        // A printer on the local network is not probed while the permission is denied.
        val granted = AtomicBoolean(false)
        val redirected = OkHttpClient.Builder().socketFactory(Redirecting(InetSocketAddress(loopback, open))).build()
        val nearby = MoonrakerProbe(redirected, LocalNetworkPermission { granted.get() })
        val lan = DiscoveryCandidate("Workshop", "192.168.77.7", open)
        val started = System.nanoTime()
        check(nearby(lan).get(WAIT_S, TimeUnit.SECONDS) is DiscoveryProbe.Unverified, "denied_not_probed")
        check(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(4), "denied_promptly")
        granted.set(true)
        check(nearby(lan).get(WAIT_S, TimeUnit.SECONDS) is DiscoveryProbe.Moonraker, "granted_probed")

        // A run over the real probe: only the two printers are proposed, each candidate probed once.
        val probes = AtomicInteger()
        val discovery = PrinterDiscovery { candidate -> probes.incrementAndGet(); probe(candidate) }
        val heard = AtomicInteger()
        discovery.subscribe { heard.incrementAndGet() }
        val run = discovery.start()
        for (port in listOf(open, locked, page.localPort, closed, open)) {
            discovery.offer(run, DiscoveryCandidate("Service $port", loopback, port))
        }
        check(probes.get() == 4, "probed_once_each ${probes.get()}")
        settled(discovery)
        val proposed = discovery.proposals.associate { it.candidate.port to it.probe }
        check(proposed == mapOf(open to DiscoveryProbe.Moonraker("orcaxr-simulator"), locked to DiscoveryProbe.NeedsKey), "only_printers_proposed $proposed")
        check(discovery.proposals.first { it.candidate.port == open }.name == "orcaxr-simulator", "named_as_it_names_itself")
        check(discovery.proposals.first { it.candidate.port == locked }.name == "Service $locked", "named_as_advertised")
        check(heard.get() >= 6, "listeners_heard ${heard.get()}")
        discovery.offer(run, DiscoveryCandidate("Again", "127.0.0.1", open))
        check(probes.get() == 4, "same_run_not_probed_again")

        // Probes under the test's control: answers arrive when it says.
        val held = ArrayList<CompletableFuture<DiscoveryProbe>>()
        val controlled = PrinterDiscovery { CompletableFuture<DiscoveryProbe>().also(held::add) }
        val first = controlled.start()
        controlled.offer(first, DiscoveryCandidate("Late", "192.168.1.20", 7125))
        val second = controlled.start()
        held[0].complete(DiscoveryProbe.Moonraker("late"))
        check(controlled.proposals.isEmpty() && controlled.probing == 0, "earlier_run_dropped")
        controlled.offer(first, DiscoveryCandidate("Stale", "192.168.1.21", 7125))
        check(held.size == 1, "stale_run_not_probed")
        controlled.offer(second, DiscoveryCandidate("Kept", "192.168.1.22", 7125))
        held[1].complete(DiscoveryProbe.NeedsKey)
        check(controlled.proposals.map { it.candidate.name } == listOf("Kept"), "current_run_proposed")
        controlled.offer(second, DiscoveryCandidate("Stopped", "192.168.1.23", 7125))
        controlled.stop()
        held[2].complete(DiscoveryProbe.Moonraker("stopped"))
        check(!controlled.active && controlled.proposals.map { it.candidate.name } == listOf("Kept"), "stopped_run_dropped_kept_proposals")
        controlled.offer(second, DiscoveryCandidate("After", "192.168.1.24", 7125))
        check(held.size == 3, "stopped_run_not_probed")
        val bounded = controlled.start()
        for (n in 1..PrinterDiscovery.MAX_CANDIDATES + 8) controlled.offer(bounded, DiscoveryCandidate("Flood $n", "10.0.0.$n", 7125))
        check(held.size == 3 + PrinterDiscovery.MAX_CANDIDATES, "candidates_bounded ${held.size}")
        controlled.stop()

        // The Device area: proposals are offered, never saved, until the operator adds one.
        val directoryText = MemoryText()
        val ids = AtomicInteger()
        DeviceWorkspace(
            directoryText, CredentialVault(MemoryBlob(), SealingCipher(SoftwareKeys())), LocalNetworkPermission { true },
            newId = { "printer-${ids.incrementAndGet()}" },
        ).use { device ->
            val found = device.discovery
            val search = found.start()
            found.offer(search, DiscoveryCandidate("Open printer", loopback, open))
            found.offer(search, DiscoveryCandidate("Locked printer", loopback, locked))
            settled(found)
            check(found.proposals.size == 2 && directoryText.text == null && device.directory.printers.isEmpty(), "proposals_not_saved")
            val lockedProposal = found.proposals.first { it.probe == DiscoveryProbe.NeedsKey }
            check(device.savedAs(lockedProposal.candidate) == null, "not_yet_saved")
            val added = device.addDiscovered(lockedProposal)
            check(device.active?.let { text(it.id) } == added && text(device.active!!.name) == "Locked printer", "added_when_chosen")
            check(device.savedAs(DiscoveryCandidate("Same machine", "127.0.0.1", locked))?.let { text(it.id) } == added, "saved_machine_recognised")
            check(device.apiKey(added).isEmpty(), "added_without_a_key")
            val refused = try {
                device.connect().get(WAIT_S, TimeUnit.SECONDS)
                null
            } catch (failure: java.util.concurrent.ExecutionException) {
                generateSequence<Throwable>(failure) { it.cause }.filterIsInstance<MoonrakerException>().firstOrNull()?.fault?.code
            }
            check(refused == ProjectIntents.MoonrakerErrorCode.AuthRequired, "needs_its_key $refused")
            device.setApiKey(added, "locked-key")
            device.connect().get(WAIT_S, TimeUnit.SECONDS)
            check(device.session.state is ProjectIntents.MoonrakerConnectionState.Connected, "connects_with_its_key")
            device.disconnect()

            // A probe that completes after the operator chose another printer changes nothing saved.
            val rerun = found.start()
            found.offer(rerun, DiscoveryCandidate("Open printer", loopback, open))
            val manual = device.addPrinter("Typed in", "printer.example", 7125)
            val stored = directoryText.text
            settled(found)
            check(found.proposals.size == 1 && directoryText.text == stored && device.active?.let { text(it.id) } == manual,
                "late_probe_left_choice_alone")
        }
        page.close()
        return checks
    }
}
