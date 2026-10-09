package dev.orcaxr.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** Why a printer command was refused or failed: the session's code and sentence. */
class PrintJobCommandException(val code: ProjectIntents.PrintJobCommandErrorCode, message: String) : Exception(message)

/** A send's hold on the session: which printer, which generation, over which client. */
class PrinterSessionClientLease internal constructor(
    val printerId: String,
    val label: String,
    val generation: Long,
    val client: MoonrakerClient,
    /** Completes when the session this lease was taken in ends. */
    val ended: CompletableFuture<Unit>,
    private val current: () -> Boolean,
) {
    /** Whether the printer, client and generation are still the session's. */
    fun isCurrent(): Boolean = current()
}

/**
 * A printer session on Android: the shared core's session machine
 * (`orcaxr_printer::session`, the policy the browser runs) over
 * [MoonrakerClient]s. The core owns the selection, generations, status model,
 * identity checks, command guards and confirmations; this class opens a
 * client when the core asks (subscribing it to the job objects, as the
 * browser does), feeds its state and notifications in, carries out connects,
 * requests and recovery commands on each epoch — cancelling what an ended
 * epoch carried — and asks the operator through the dialog a command brings.
 *
 * Every call into the core runs on the session's one thread, and steps apply
 * in the order the core produced them; listeners run there too.
 */
class PrinterSessionClient(
    private val openClient: (ProjectIntents.PrinterSelection) -> MoonrakerClient,
    private val clock: () -> Double = { System.currentTimeMillis().toDouble() },
) : AutoCloseable {
    companion object {
        /** The Klipper objects the status model reads (`orcaxr_printer::status::OBJECTS`). */
        val PRINT_JOB_OBJECTS =
            listOf("webhooks", "print_stats", "virtual_sdcard", "display_status", "extruder", "heater_bed")
    }

    @Volatile private var thread: Thread? = null
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "printer-session").also {
            it.isDaemon = true
            thread = it
        }
    }
    private val session = PrinterSession()

    // Everything below is touched on the session's thread only.
    private val listeners = LinkedHashSet<() -> Unit>()
    private val clients = HashMap<Long, Pair<MoonrakerClient, List<AutoCloseable>>>()
    private val states = HashMap<Long, ProjectIntents.MoonrakerConnectionState>()
    private var currentTransport: Long? = null
    private val epochs = HashMap<Long, CompletableFuture<Unit>>()
    private val epochCalls = HashMap<Long, MutableList<MoonrakerCall<*>>>()
    private val tasks = HashMap<Long, (ProjectIntents.PrinterTaskResult) -> Unit>()
    private val hints = HashMap<Long, Hint>()
    private val handshakes = HashMap<Long, ProjectIntents.MoonrakerHandshake>()
    private val failures = HashMap<Long, Throwable>()
    private val queue = ArrayDeque<ProjectIntents.PrinterSessionStep>()
    private var draining = false
    private var viewValue: ProjectIntents.PrinterSessionView = session.view
    private var closed = false

    private class Hint(
        val task: Long,
        val dialog: ((ProjectIntents.PrintJobCommandIntent, CompletableFuture<Unit>) -> CompletableFuture<Boolean>)? = null,
    )

    private fun <T> onThread(work: () -> T): T =
        if (Thread.currentThread() === thread) work() else executor.submit<T> { work() }.get().also { }

    private fun post(work: () -> Unit) {
        try {
            executor.execute { if (!closed) work() }
        } catch (rejected: RejectedExecutionException) {
            // Closed: late events are dropped.
        }
    }

    /** The printer's client while one is selected. */
    val client: MoonrakerClient? get() = onThread { currentTransport?.let { clients[it]?.first } }
    /** The generation, the latest status snapshot and each command's availability. */
    val view: ProjectIntents.PrinterSessionView get() = onThread { viewValue }
    /** The selected client's latest connection state. */
    val state: ProjectIntents.MoonrakerConnectionState? get() = onThread { currentTransport?.let { states[it] } }

    fun subscribe(listener: () -> Unit): AutoCloseable = onThread {
        listeners += listener
        AutoCloseable { onThread { listeners -= listener } }
    }

    fun select(selection: ProjectIntents.PrinterSelection): MoonrakerClient = onThread {
        apply(session.select(selection))
        clients[currentTransport]!!.first
    }

    fun connect(): CompletableFuture<ProjectIntents.MoonrakerHandshake> {
        var task = -1L
        return start({ session.connect().also { task = (it.task as? ProjectIntents.OptionalCounter.Value)?.value ?: -1 } }) {
            handshakes.remove(task) ?: error("connected without a handshake")
        }
    }

    fun refresh(): CompletableFuture<Unit> = start({ session.refresh() }) {}

    fun clear() = onThread { apply(session.clear()) }

    /** Captured at press time: bound to this printer, generation and the running job. */
    fun captureIntent(command: ProjectIntents.PrintJobCommand): ProjectIntents.PrintJobCommandIntent = onThread {
        when (val reply = session.captureIntent(commandName(command))) {
            is ProjectIntents.PrintJobIntentReply.Intent -> reply.value
            is ProjectIntents.PrintJobIntentReply.Refused -> throw refusal(reply.value)
        }
    }

    /** A single-use confirmation token for exactly [intent]. */
    fun confirm(intent: ProjectIntents.PrintJobCommandIntent): Long = onThread {
        when (val reply = session.confirm(intent.id)) {
            is ProjectIntents.PrintJobConfirmReply.Token -> reply.value
            is ProjectIntents.PrintJobConfirmReply.Refused -> throw refusal(reply.value)
        }
    }

    /** Sends [intent]'s command, confirmed by [token] or by asking [dialog] (which hears the session end). */
    fun execute(
        intent: ProjectIntents.PrintJobCommandIntent,
        token: Long? = null,
        dialog: ((ProjectIntents.PrintJobCommandIntent, CompletableFuture<Unit>) -> CompletableFuture<Boolean>)? = null,
    ): CompletableFuture<Unit> {
        val confirmation = when {
            dialog != null -> ProjectIntents.PrintJobExecuteConfirmation.Dialog(ProjectIntents.Empty)
            token != null -> ProjectIntents.PrintJobExecuteConfirmation.Token(token)
            else -> ProjectIntents.PrintJobExecuteConfirmation.None(ProjectIntents.Empty)
        }
        return start({ session.execute(ProjectIntents.PrintJobExecuteRequest(intent.id, confirmation)) }, dialog) {}
    }

    /** A send's hold on the connected session; throws its sentence when there is none. */
    fun captureLease(): PrinterSessionClientLease = onThread {
        when (val reply = session.captureLease()) {
            is ProjectIntents.PrinterSessionLeaseReply.Refused -> throw IllegalStateException(text(reply.value.text))
            is ProjectIntents.PrinterSessionLeaseReply.Lease -> {
                val lease = reply.value
                PrinterSessionClientLease(
                    text(lease.printerId), text(lease.label), lease.generation, clients[lease.transport]!!.first,
                    epoch(lease.generation),
                ) { onThread { !closed && session.leaseCurrent(lease) } }
            }
        }
    }

    override fun close() {
        onThread {
            if (!closed) {
                apply(session.dispose())
                closed = true
                listeners.clear()
            }
        }
        executor.shutdown()
        session.close()
    }

    // --- Tasks and steps ----------------------------------------------------------------------

    private fun <T> start(
        call: () -> ProjectIntents.PrinterSessionStep,
        dialog: ((ProjectIntents.PrintJobCommandIntent, CompletableFuture<Unit>) -> CompletableFuture<Boolean>)? = null,
        done: () -> T,
    ): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        post {
            val step = try {
                call()
            } catch (failure: Throwable) {
                future.completeExceptionally(failure)
                return@post
            }
            val task = (step.task as? ProjectIntents.OptionalCounter.Value)?.value
            if (task == null) {
                apply(step)
                future.completeExceptionally(IllegalStateException("The printer session started no task."))
                return@post
            }
            tasks[task] = { result ->
                when (result) {
                    is ProjectIntents.PrinterTaskResult.Done -> runCatching(done).fold(future::complete, future::completeExceptionally)
                    is ProjectIntents.PrinterTaskResult.Refused -> future.completeExceptionally(refusal(result.value))
                    // The browser hands a failed exchange's own error on: the client's fault.
                    is ProjectIntents.PrinterTaskResult.Failed ->
                        future.completeExceptionally(failures.remove(task) ?: IllegalStateException(text(result.value.text)))
                }
                failures.remove(task)
            }
            // The connect or dialog a call issues is in the step that started it.
            for (effect in step.effects) {
                if (effect.effect is ProjectIntents.PrinterSessionEffect.Connect ||
                    effect.effect is ProjectIntents.PrinterSessionEffect.ConfirmCommand
                ) {
                    hints[effect.id] = Hint(task, dialog)
                }
            }
            apply(step)
        }
        return future
    }

    private fun input(call: () -> ProjectIntents.PrinterSessionStep) {
        val step = try {
            call()
        } catch (failure: IllegalStateException) {
            if (failure.message == "not_pending" || failure.message == "mismatch") return
            throw failure
        }
        apply(step)
    }

    private fun answer(id: Long, outcome: ProjectIntents.PrinterSessionOutcome) = input { session.resolve(id, outcome) }

    private fun apply(step: ProjectIntents.PrinterSessionStep) {
        queue.addLast(step)
        if (draining) return
        draining = true
        try {
            while (true) run(queue.removeFirstOrNull() ?: break)
        } finally {
            draining = false
        }
    }

    private fun run(step: ProjectIntents.PrinterSessionStep) {
        for (pending in step.effects) carryOut(pending.id, pending.effect)
        for (transport in step.closed) {
            clients.remove(transport)?.let { (client, stops) ->
                stops.forEach { runCatching { it.close() } }
                client.close()
            }
            states.remove(transport)
            if (currentTransport == transport) currentTransport = null
        }
        for (epoch in step.aborted) {
            epochCalls.remove(epoch)?.forEach { it.cancel() }
            epoch(epoch).complete(Unit)
        }
        for (id in step.withdrawn) hints.remove(id)
        if (step.changed > 0) {
            viewValue = session.view
            repeat(step.changed.toInt()) { for (listener in listeners.toList()) runCatching { listener() } }
        }
        for (finished in step.finished) tasks.remove(finished.task)?.invoke(finished.result)
    }

    private fun carryOut(id: Long, effect: ProjectIntents.PrinterSessionEffect) {
        val hint = hints.remove(id)
        when (effect) {
            is ProjectIntents.PrinterSessionEffect.OpenTransport -> open(id, effect.value.transport, effect.value.selection)
            is ProjectIntents.PrinterSessionEffect.Connect -> {
                val client = clients[effect.value.transport]?.first
                if (client == null) {
                    queue.addLast(session.resolve(id, failed(null)))
                    return
                }
                client.connect().result.whenComplete { handshake, thrown ->
                    post {
                        if (thrown == null) {
                            if (hint != null) handshakes[hint.task] = handshake
                            answer(id, ProjectIntents.PrinterSessionOutcome.Connected(ProjectIntents.Empty))
                        } else {
                            val cause = unwrap(thrown)
                            if (hint != null) failures[hint.task] = cause
                            answer(id, failed(cause))
                        }
                    }
                }
            }
            is ProjectIntents.PrinterSessionEffect.Request -> {
                val (transport, epoch, send) = effect.value
                val method = text(send.method)
                val operation = text(send.operation)
                val options = MoonrakerRequestOptions(
                    method = method.takeIf { it != "GET" },
                    operation = operation.ifEmpty { null },
                    timeoutMs = (send.timeoutMs as? ProjectIntents.OptionalFinite.Value)?.value,
                )
                exchange(id, epoch) { clients[transport]!!.first.request(text(send.path), options) }
            }
            is ProjectIntents.PrinterSessionEffect.Recovery -> {
                val (transport, epoch, command) = effect.value
                val name = if (command == ProjectIntents.PrintJobCommand.EmergencyStop) "emergency-stop" else "firmware-restart"
                exchange(id, epoch) { clients[transport]!!.first.recovery(name) }
            }
            is ProjectIntents.PrinterSessionEffect.ConfirmCommand -> {
                val asked = hint?.dialog
                if (asked == null) {
                    queue.addLast(session.resolve(id, ProjectIntents.PrinterSessionOutcome.Confirmed(false)))
                    return
                }
                val answered = runCatching { asked(effect.value, epoch(effect.value.generation)) }
                    .getOrElse { CompletableFuture.failedFuture(it) }
                // A dialog that fails sent nothing: it reads as dismissed.
                answered.whenComplete { confirmed, _ -> post { answer(id, ProjectIntents.PrinterSessionOutcome.Confirmed(confirmed == true)) } }
            }
        }
    }

    /** A request or recovery command on [epoch]: its reply (`result`, as JSON) or its failure. */
    private fun exchange(id: Long, epoch: Long, send: () -> MoonrakerCall<String>) {
        val call = try {
            send()
        } catch (failure: RuntimeException) {
            queue.addLast(session.resolve(id, failed(failure)))
            return
        }
        epochCalls.getOrPut(epoch) { ArrayList() } += call
        call.result.whenComplete { reply, thrown ->
            post {
                epochCalls[epoch]?.remove(call)
                if (thrown == null) input { session.resolveReply(id, reply, clock()) } else answer(id, failed(unwrap(thrown)))
            }
        }
    }

    /** Opens the client the core asked for; its first state answers the opening itself. */
    private fun open(id: Long, transport: Long, selection: ProjectIntents.PrinterSelection) {
        val client = openClient(selection)
        currentTransport = transport
        client.setSubscription(PRINT_JOB_OBJECTS.map { it to null })
        val opening = AtomicBoolean(true)
        val stops = listOf(
            client.subscribeNotifications { notification ->
                post {
                    if (clients[transport]?.first === client) {
                        input { session.notification(transport, notification.method, notification.params, notification.receivedAtMs) }
                    }
                }
            },
            client.subscribeState { state ->
                if (opening.get()) return@subscribeState
                post {
                    if (clients[transport]?.first !== client) return@post
                    states[transport] = state
                    input { session.transportState(transport, signal(state)) }
                }
            },
        )
        opening.set(false)
        clients[transport] = client to stops
        val state = client.state
        states[transport] = state
        queue.addLast(session.resolve(id, ProjectIntents.PrinterSessionOutcome.State(signal(state))))
    }

    private fun epoch(epoch: Long): CompletableFuture<Unit> = epochs.getOrPut(epoch) { CompletableFuture() }

    private fun signal(state: ProjectIntents.MoonrakerConnectionState): ProjectIntents.ConnectionSignal = when (state) {
        is ProjectIntents.MoonrakerConnectionState.Disconnected -> signalOf(ProjectIntents.ConnectionStatus.Disconnected, state.value.generation)
        is ProjectIntents.MoonrakerConnectionState.Connecting -> signalOf(ProjectIntents.ConnectionStatus.Connecting, state.value.generation)
        is ProjectIntents.MoonrakerConnectionState.Connected -> ProjectIntents.ConnectionSignal(
            ProjectIntents.ConnectionStatus.Connected, state.value.generation, ProjectIntents.OptionalCounter.Value(state.value.socketEpoch),
        )
        is ProjectIntents.MoonrakerConnectionState.Reconnecting -> signalOf(ProjectIntents.ConnectionStatus.Reconnecting, state.value.generation)
        is ProjectIntents.MoonrakerConnectionState.Error -> signalOf(ProjectIntents.ConnectionStatus.Error, state.value.generation)
    }
    private fun signalOf(status: ProjectIntents.ConnectionStatus, generation: Long) =
        ProjectIntents.ConnectionSignal(status, generation, ProjectIntents.OptionalCounter.Absent(ProjectIntents.Empty))

    /** What the core reads of a failed exchange: the client's fault, or nothing it can name. */
    private fun failed(cause: Throwable?): ProjectIntents.PrinterSessionOutcome {
        val fault = (cause as? MoonrakerException)?.fault
        return ProjectIntents.PrinterSessionOutcome.Failed(
            if (fault == null) {
                ProjectIntents.TransportFailure(
                    ProjectIntents.OptionalMoonrakerErrorCode.Absent(ProjectIntents.Empty),
                    ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty),
                    ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                )
            } else {
                ProjectIntents.TransportFailure(ProjectIntents.OptionalMoonrakerErrorCode.Value(fault.code), fault.httpStatus, fault.detail)
            },
        )
    }

    private fun refusal(refused: ProjectIntents.PrintJobCommandRefusal) =
        PrintJobCommandException(refused.code, text(refused.message))

    private fun unwrap(thrown: Throwable): Throwable =
        if ((thrown is CompletionException || thrown is ExecutionException) && thrown.cause != null) thrown.cause!! else thrown

    private fun commandName(command: ProjectIntents.PrintJobCommand) = when (command) {
        ProjectIntents.PrintJobCommand.Pause -> "pause"
        ProjectIntents.PrintJobCommand.Resume -> "resume"
        ProjectIntents.PrintJobCommand.Cancel -> "cancel"
        ProjectIntents.PrintJobCommand.EmergencyStop -> "emergencyStop"
        ProjectIntents.PrintJobCommand.FirmwareRestart -> "firmwareRestart"
    }

    private fun text(units: List<Int>): String = String(CharArray(units.size) { units[it].toChar() })
}
