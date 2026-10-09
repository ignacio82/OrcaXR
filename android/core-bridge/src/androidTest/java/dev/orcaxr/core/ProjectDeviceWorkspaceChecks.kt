package dev.orcaxr.core

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.net.SocketFactory
import okhttp3.Dns
import okhttp3.OkHttpClient

/** The Device area's workspace against the Moonraker simulator: printers
 * added, refused, switched and removed through the shared directory; each
 * printer's key its own, remembered in the vault only while remembering is
 * on and gone with its printer; a connection to the active printer with its
 * key and the status the browser would show; and a printer behind the
 * local-network permission refused promptly until it is granted. A reload is
 * a new workspace over the same stores. */
object ProjectDeviceWorkspaceChecks {
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

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun ByteArray.holds(text: String): Boolean {
        val needle = text.toByteArray(Charsets.UTF_8)
        return (0..size - needle.size).any { start -> needle.indices.all { this[start + it] == needle[it] } }
    }
    private fun refusal(work: () -> Unit): String? = try {
        work()
        null
    } catch (refused: DeviceRefusal) {
        refused.message
    }
    private fun failed(future: java.util.concurrent.CompletableFuture<*>): Throwable? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        thrown.cause
    }

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val port = URI(endpoint).port
        val directoryText = MemoryText()
        val blob = MemoryBlob()
        val keys = SoftwareKeys()
        val granted = AtomicBoolean(true)
        val ids = AtomicInteger()
        fun workspace(http: OkHttpClient = OkHttpClient()) = DeviceWorkspace(
            directoryText, CredentialVault(blob, SealingCipher(keys)), LocalNetworkPermission { granted.get() },
            newId = { "printer-${ids.incrementAndGet()}" }, http = http,
        )

        var simulator = ""
        workspace().use { device ->
            check(device.directory.printers.isEmpty() && device.active == null, "starts_empty")
            check(failed(device.connect()) is DeviceRefusal, "connect_needs_a_printer")
            simulator = device.addPrinter("Simulator", "127.0.0.1", port)
            check(device.active?.let { text(it.id) } == simulator, "added_is_active")
            check(directoryText.text?.contains("Simulator") == true, "directory_stored")
            check(refusal { device.addPrinter("Again", "http://127.0.0.1:$port") } == "That address is already saved under another name", "same_machine_refused")
            check(refusal { device.addPrinter("Bad", "printer local") } != null, "unusable_address_refused")
            check(device.directory.printers.size == 1, "refusals_store_nothing")

            // Recovery is reachable before any status has been read, and reaches
            // the printer without a connection.
            val recovery = device.session.view.availability.filter { it.allowed }.map { it.command }
            check(ProjectIntents.PrintJobCommand.EmergencyStop in recovery && ProjectIntents.PrintJobCommand.FirmwareRestart in recovery,
                "recovery_without_status $recovery")
            val restart = device.session.captureIntent(ProjectIntents.PrintJobCommand.FirmwareRestart)
            device.session.execute(restart) { _, _ -> java.util.concurrent.CompletableFuture.completedFuture(true) }.get(WAIT_S, TimeUnit.SECONDS)
            check(device.session.state !is ProjectIntents.MoonrakerConnectionState.Connected, "restart_without_connection")
            device.setApiKey(simulator, "sim-key-1234")
            check(blob.blob != null && !blob.blob!!.holds("sim-key-1234"), "key_sealed")
            device.connect().get(WAIT_S, TimeUnit.SECONDS)
            check(device.session.state is ProjectIntents.MoonrakerConnectionState.Connected, "connected")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
            while (device.session.view.snapshot !is ProjectIntents.OptionalPrintJobSnapshot.Value) {
                kotlin.check(System.nanoTime() < deadline) { "no status" }
                Thread.sleep(25)
            }
            val summary = device.summary()
            check(summary.tone == ProjectIntents.PrinterStatusTone.Idle && !summary.present && summary.headline.isNotEmpty(), "status_summary ${summary.tone}")

            // A job another client starts: identified, then pausable here.
            val elsewhere = OkHttpClient()
            val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
                .addFormDataPart("file", "elsewhere.gcode", okhttp3.RequestBody.create(null, "G28\n".toByteArray()))
                .build()
            elsewhere.newCall(okhttp3.Request.Builder().url("$endpoint/server/files/upload").post(body).build()).execute().close()
            elsewhere.newCall(
                okhttp3.Request.Builder().url("$endpoint/printer/print/start?filename=elsewhere.gcode")
                    .post(okhttp3.RequestBody.create(null, ByteArray(0))).build(),
            ).execute().close()
            val pausable = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
            while (device.session.view.availability.none { it.command == ProjectIntents.PrintJobCommand.Pause && it.allowed }) {
                kotlin.check(System.nanoTime() < pausable) { "never pausable: ${device.session.view}" }
                Thread.sleep(25)
            }
            check(device.summary().tone == ProjectIntents.PrinterStatusTone.Active, "printing_summary")
            device.session.execute(device.session.captureIntent(ProjectIntents.PrintJobCommand.Cancel)) { _, _ ->
                java.util.concurrent.CompletableFuture.completedFuture(true)
            }.get(WAIT_S, TimeUnit.SECONDS)
            check(true, "cancelled_with_dialog")

            // Another printer: switching clears the session, and no key follows.
            val other = device.addPrinter("Other", "localhost", port)
            check(device.active?.let { text(it.id) } == other, "switched")
            check(device.session.state !is ProjectIntents.MoonrakerConnectionState.Connected, "switch_clears_session")
            check(device.apiKey(other) == "" && device.apiKey(simulator) == "sim-key-1234", "keys_stay_with_printers")
        }

        // A reload: the same printers, the active one, and the remembered key.
        workspace().use { device ->
            check(device.directory.printers.map { text(it.name) } == listOf("Simulator", "Other"), "reload_keeps_printers")
            check(device.active?.let { text(it.name) } == "Other", "reload_keeps_active")
            check(device.apiKey(simulator) == "sim-key-1234", "reload_keeps_key")
            // Remembering off erases the stored key but keeps this run's.
            device.setRemember(false)
            check(blob.blob != null && device.apiKey(simulator) == "sim-key-1234", "off_keeps_this_run")
        }
        workspace().use { device ->
            check(device.apiKey(simulator) == "" && !device.credentials.remember, "off_forgets_on_reload")
            device.setRemember(true)
            device.setApiKey(simulator, "second-key-5678")
            // Removing a printer removes its key.
            device.removePrinter(simulator)
            check(device.directory.printers.size == 1 && device.apiKey(simulator) == "", "removed_with_key")
            check(blob.blob == null, "nothing_left_to_remember")
            device.setApiKey(device.active!!.id.let(::text), "other-key")
            device.forgetCredentials()
            check(blob.blob == null && keys.key == null && device.credentials.printerApiKeys.isEmpty(), "forgotten")
        }

        // A printer on the local network: blocked while the permission is denied.
        val redirected = OkHttpClient.Builder()
            .dns(object : Dns {
                override fun lookup(hostname: String) = listOf(InetAddress.getByName("192.168.77.7"))
            })
            .socketFactory(Redirecting(InetSocketAddress("127.0.0.1", port)))
            .build()
        granted.set(false)
        workspace(redirected).use { device ->
            device.addPrinter("Workshop", "workshop.example", port)
            check(device.localNetworkBlocked(), "lan_printer_blocked")
            val started = System.nanoTime()
            val denied = failed(device.connect())
            check(denied is DeviceRefusal && denied.message.orEmpty().contains("may not use the local network"), "denied_connect_explained $denied")
            check(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(5), "denied_promptly")
            granted.set(true)
            check(!device.localNetworkBlocked(), "granted_unblocked")
            device.connect().get(WAIT_S, TimeUnit.SECONDS)
            check(device.session.state is ProjectIntents.MoonrakerConnectionState.Connected, "granted_connects")
        }
        return checks
    }
}
