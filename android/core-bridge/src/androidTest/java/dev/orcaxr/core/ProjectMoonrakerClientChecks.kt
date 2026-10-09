package dev.orcaxr.core

import java.util.Collections
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The Android Moonraker host end to end: the shared core's transport over
 * OkHttp against the Moonraker simulator (`web/scripts/moonraker-simulator.mjs`,
 * a real HTTP and WebSocket server) — handshake, credentials, queries,
 * uploads and downloads, refusals before anything is sent, the server's own
 * explanation of a refusal, notifications and heartbeats over the socket, a
 * caller's cancel, and a disconnect. The simulator holds its first upload for
 * a few seconds, so a cancel lands while it is in flight. */
object ProjectMoonrakerClientChecks {
    private fun <T> MoonrakerCall<T>.await(): T = result.get(15, TimeUnit.SECONDS)
    private fun failure(call: MoonrakerCall<*>): ProjectIntents.MoonrakerTransportFault? = try {
        call.await()
        null
    } catch (thrown: ExecutionException) {
        (thrown.cause as? MoonrakerException)?.fault
    }
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun absentFinite() = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
    private fun absentText() = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        val config = ProjectIntents.MoonrakerTransportConfig(
            units(endpoint), absentFinite(), absentText(), absentText(),
            ProjectIntents.MoonrakerVersionPolicyInput(
                ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite(),
            ),
            ProjectIntents.OptionalText.Value(units("OrcaXR Android")), ProjectIntents.OptionalText.Value(units("test")),
            ProjectIntents.OptionalFinite.Value(5_000.0), ProjectIntents.OptionalFinite.Value(5_000.0),
            ProjectIntents.OptionalFinite.Value(150.0), ProjectIntents.OptionalFinite.Value(2_000.0),
            ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite(), absentFinite(), absentFinite(), absentFinite()),
        )
        val logs = Collections.synchronizedList(ArrayList<ProjectIntents.MoonrakerLog>())
        MoonrakerClient(config, logger = { logs += it }).use { client ->
            val notifications = LinkedBlockingQueue<MoonrakerClientNotification>()
            client.subscribeNotifications { notifications += it }
            val first = LinkedBlockingQueue<ProjectIntents.MoonrakerConnectionState>()
            client.subscribeState { first += it }
            check(first.poll() is ProjectIntents.MoonrakerConnectionState.Disconnected) { "initial_state" }; checks++
            check(client.setCredentials(apiKey = "android-key") == null) { "credentials" }; checks++
            check(client.setCredentials(apiKey = "one", bearerToken = "two")?.code == ProjectIntents.MoonrakerErrorCode.InvalidCredentials) {
                "both_credentials"
            }; checks++
            check(client.setSubscription(listOf("print_stats" to listOf("state", "filename"), "webhooks" to null)) == null) { "subscription" }
            checks++
            check(client.setSubscription(listOf("bad name" to null))?.code == ProjectIntents.MoonrakerErrorCode.ProtocolError) {
                "subscription_refused"
            }; checks++

            val handshake = client.connect().await()
            check(handshake.capabilities.fileManagement && handshake.capabilities.klippyConnected) { "handshake" }; checks++
            check(client.state is ProjectIntents.MoonrakerConnectionState.Connected) { "connected" }; checks++

            val status = client.request("/printer/objects/query?print_stats", MoonrakerRequestOptions(operation = "print_status")).await()
            check("\"print_stats\"" in status) { "query" }; checks++

            // The simulator holds this first upload: a cancel lands while it is in flight.
            val held = client.upload(
                "/server/files/upload",
                MoonrakerUpload(listOf("root" to "gcodes", "path" to "", "print" to "false"), "held.gcode", "G28\n".toByteArray()),
                MoonrakerRequestOptions(operation = "upload_gcode", timeoutMs = MoonrakerClient.UNBOUNDED),
            )
            Thread.sleep(300)
            held.cancel()
            check(failure(held)?.code == ProjectIntents.MoonrakerErrorCode.Cancelled) { "cancelled_upload" }; checks++

            val bytes = "G28\nG1 X10 Y10\n; android\n".toByteArray()
            val uploaded = client.upload(
                "/server/files/upload",
                MoonrakerUpload(listOf("root" to "gcodes", "path" to "", "print" to "false"), "android.gcode", bytes),
                MoonrakerRequestOptions(operation = "upload_gcode", timeoutMs = MoonrakerClient.UNBOUNDED),
            ).await()
            check("\"android.gcode\"" in uploaded) { "upload" }; checks++
            val downloaded = client.download("/server/files/gcodes/android.gcode", MoonrakerRequestOptions(operation = "download")).await()
            check(downloaded.contentEquals(bytes)) { "download" }; checks++

            // A mutation sent as a GET is refused before it leaves.
            val asGet = failure(client.request("/printer/print/start?filename=android.gcode", MoonrakerRequestOptions(operation = "start_print")))
            check(asGet?.code == ProjectIntents.MoonrakerErrorCode.InvalidRequest) { "get_mutation" }; checks++
            // A credential header set by hand is refused too.
            val header = failure(client.request("/server/info", MoonrakerRequestOptions(headers = listOf("X-Api-Key" to "leak"))))
            check(header?.code == ProjectIntents.MoonrakerErrorCode.InvalidCredentials) { "credential_header" }; checks++

            // The start, then the printer's own status update over the socket.
            client.request(
                "/printer/print/start?filename=android.gcode",
                MoonrakerRequestOptions(method = "POST", operation = "start_print"),
            ).await()
            checks++
            var printing: MoonrakerClientNotification? = null
            while (printing == null) {
                val next = notifications.poll(10, TimeUnit.SECONDS) ?: error("no status notification")
                if (next.method == "notify_status_update" && "\"printing\"" in next.params) printing = next
            }
            check(printing.generation >= 1 && printing.socketEpoch >= 1) { "notification" }; checks++

            // Heartbeats answered over the socket keep it, and freshen the state.
            Thread.sleep(700)
            val live = client.state as ProjectIntents.MoonrakerConnectionState.Connected
            check(live.value.lastHeartbeatAtMs > live.value.connectedAtMs) { "heartbeat" }; checks++

            // A refusal keeps the server's own explanation.
            val missing = failure(client.request("/server/files/metadata?filename=absent.gcode", MoonrakerRequestOptions(operation = "metadata")))
            check(missing?.code == ProjectIntents.MoonrakerErrorCode.HttpError) { "missing_code" }
            check((missing.httpStatus as ProjectIntents.OptionalFinite.Value).value == 404.0) { "missing_status" }
            check(text((missing.detail as ProjectIntents.OptionalText.Value).value) == "not found") { "missing_detail" }; checks++

            // Recovery reaches HTTP.
            check(client.recovery("firmware-restart").await() == "\"ok\"") { "recovery" }; checks++

            // An idle gap past the server's keep-alive (the simulator's Node
            // server closes idle connections after 5 s): the next request
            // opens a fresh connection rather than failing on the closed one.
            Thread.sleep(6_000)
            check(client.request("/server/info", MoonrakerRequestOptions(operation = "after_idle")).await().contains("klippy")) {
                "after_idle"
            }; checks++

            client.disconnect()
            val after = client.state as ProjectIntents.MoonrakerConnectionState.Disconnected
            check(after.value.reason == ProjectIntents.MoonrakerDisconnectReason.User) { "disconnected" }; checks++
            check(failure(client.request("/server/info"))?.code == ProjectIntents.MoonrakerErrorCode.InvalidState) { "after_disconnect" }
            checks++
        }
        val events = logs.map { it.event }
        check(ProjectIntents.MoonrakerDiagnosticEvent.ConnectionAttempt in events && ProjectIntents.MoonrakerDiagnosticEvent.Connected in events) {
            "diagnostics"
        }; checks++
        return checks
    }
}
