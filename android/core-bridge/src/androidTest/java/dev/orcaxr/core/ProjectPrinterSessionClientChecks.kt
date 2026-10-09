package dev.orcaxr.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** The Android printer session end to end: the shared core's session over
 * [MoonrakerClient]s against the Moonraker simulator — select, connect and
 * the first refresh, a job the session identifies from the printer's own
 * history, pause and resume bound to that job, a cancel that needs and then
 * spends a confirmation, an emergency stop confirmed by a dialog, a lease that
 * the clear ends, and the session's own disposal. */
object ProjectPrinterSessionClientChecks {
    private const val WAIT_S = 15L
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun absentFinite() = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
    private fun absentText() = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)

    /** The client a selection opens: its endpoint, port and session key. */
    fun clientFor(selection: ProjectIntents.PrinterSelection): MoonrakerClient {
        val client = MoonrakerClient(
            ProjectIntents.MoonrakerTransportConfig(
                selection.endpoint, ProjectIntents.OptionalFinite.Value(selection.port.toDouble()), absentText(), absentText(),
                ProjectIntents.MoonrakerVersionPolicyInput(
                    ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite(),
                ),
                ProjectIntents.OptionalText.Value(units("OrcaXR Android")), ProjectIntents.OptionalText.Value(units("test")),
                ProjectIntents.OptionalFinite.Value(5_000.0), ProjectIntents.OptionalFinite.Value(5_000.0),
                absentFinite(), absentFinite(),
                ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite(), absentFinite(), absentFinite(), absentFinite()),
            ),
        )
        (selection.apiKey as? ProjectIntents.OptionalText.Value)?.let { client.setCredentials(apiKey = text(it.value)) }
        return client
    }

    private fun awaitView(session: PrinterSessionClient, what: String, test: (ProjectIntents.PrinterSessionView) -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!test(session.view)) {
            check(System.nanoTime() < deadline) { "timed out waiting: $what (${session.view})" }
            Thread.sleep(25)
        }
    }
    private fun snapshotState(view: ProjectIntents.PrinterSessionView) =
        (view.snapshot as? ProjectIntents.OptionalPrintJobSnapshot.Value)?.value?.state
    private fun allowed(view: ProjectIntents.PrinterSessionView, command: ProjectIntents.PrintJobCommand) =
        view.availability.any { it.command == command && it.allowed }
    private fun refusal(future: CompletableFuture<*>): ProjectIntents.PrintJobCommandErrorCode? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        (thrown.cause as? PrintJobCommandException)?.code
    }

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        val opened = AtomicInteger()
        PrinterSessionClient({ selection -> opened.incrementAndGet(); clientFor(selection) }).use { session ->
            val changes = AtomicInteger()
            session.subscribe { changes.incrementAndGet() }
            val selection = ProjectIntents.PrinterSelection(
                units("simulator"), ProjectIntents.OptionalText.Value(units("Simulator")), units(endpoint), 7125,
                ProjectIntents.OptionalText.Value(units("android-key")),
            )
            val client = session.select(selection)
            check(session.select(selection) === client && opened.get() == 1) { "same_selection" }; checks++
            check(session.captureIntent(ProjectIntents.PrintJobCommand.EmergencyStop).command ==
                ProjectIntents.PrintJobCommand.EmergencyStop) { "recovery_without_connection" }; checks++

            session.connect().get(WAIT_S, TimeUnit.SECONDS)
            check(session.state is ProjectIntents.MoonrakerConnectionState.Connected) { "connected" }; checks++
            awaitView(session, "standby") { snapshotState(it) == ProjectIntents.PrintJobState.Standby }; checks++
            check(changes.get() > 0) { "listeners" }; checks++
            check(!allowed(session.view, ProjectIntents.PrintJobCommand.Pause)) { "nothing_to_pause" }; checks++

            // A job arrives the way a send makes one: uploaded, then started.
            client.upload(
                "/server/files/upload",
                MoonrakerUpload(listOf("root" to "gcodes", "path" to "", "print" to "false"), "session.gcode", "G28\n".toByteArray()),
                MoonrakerRequestOptions(operation = "upload_gcode"),
            ).result.get(WAIT_S, TimeUnit.SECONDS)
            client.request(
                "/printer/print/start?filename=session.gcode",
                MoonrakerRequestOptions(method = "POST", operation = "start_print"),
            ).result.get(WAIT_S, TimeUnit.SECONDS)
            // The session hears it over the socket and identifies the job before allowing a pause.
            awaitView(session, "printing, identified") {
                snapshotState(it) == ProjectIntents.PrintJobState.Printing && allowed(it, ProjectIntents.PrintJobCommand.Pause)
            }; checks++

            val pause = session.captureIntent(ProjectIntents.PrintJobCommand.Pause)
            val job = (pause.job as ProjectIntents.OptionalPrintJobIdentity.Value).value
            check(text(job.filename) == "session.gcode") { "intent_job" }; checks++
            session.execute(pause).get(WAIT_S, TimeUnit.SECONDS)
            awaitView(session, "paused") { snapshotState(it) == ProjectIntents.PrintJobState.Paused }; checks++
            check(refusal(session.execute(pause)) == ProjectIntents.PrintJobCommandErrorCode.NotAllowed) { "intent_spent" }; checks++

            awaitView(session, "resumable") { allowed(it, ProjectIntents.PrintJobCommand.Resume) }
            session.execute(session.captureIntent(ProjectIntents.PrintJobCommand.Resume)).get(WAIT_S, TimeUnit.SECONDS)
            awaitView(session, "printing again") {
                snapshotState(it) == ProjectIntents.PrintJobState.Printing && allowed(it, ProjectIntents.PrintJobCommand.Cancel)
            }; checks++

            // A cancel needs a confirmation; without one nothing is sent and the intent is spent.
            val unconfirmed = session.captureIntent(ProjectIntents.PrintJobCommand.Cancel)
            check(refusal(session.execute(unconfirmed)) == ProjectIntents.PrintJobCommandErrorCode.ConfirmationRequired) {
                "cancel_unconfirmed"
            }; checks++
            awaitView(session, "cancellable") { allowed(it, ProjectIntents.PrintJobCommand.Cancel) }
            val cancel = session.captureIntent(ProjectIntents.PrintJobCommand.Cancel)
            val token = session.confirm(cancel)
            session.execute(cancel, token = token).get(WAIT_S, TimeUnit.SECONDS)
            awaitView(session, "cancelled") { snapshotState(it) == ProjectIntents.PrintJobState.Cancelled }; checks++

            // A lease holds while the session does.
            val lease = session.captureLease()
            check(lease.isCurrent() && lease.client === client && !lease.ended.isDone) { "lease" }; checks++

            // An emergency stop is confirmed by a dialog, which hears the session end.
            val asked = AtomicInteger()
            session.execute(session.captureIntent(ProjectIntents.PrintJobCommand.EmergencyStop)) { intent, _ ->
                asked.incrementAndGet()
                CompletableFuture.completedFuture(intent.command == ProjectIntents.PrintJobCommand.EmergencyStop)
            }.get(WAIT_S, TimeUnit.SECONDS)
            check(asked.get() == 1) { "dialog" }; checks++

            session.clear()
            check(session.client == null && !lease.isCurrent()) { "cleared" }; checks++
            check(lease.ended.isDone) { "lease_ended" }; checks++
        }
        return checks
    }
}
