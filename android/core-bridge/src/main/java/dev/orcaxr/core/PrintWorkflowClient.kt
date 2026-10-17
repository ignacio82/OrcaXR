package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Why a send failed or was refused: the workflow's code and sentence. */
class PrintSubmissionException(val code: ProjectIntents.PrintSubmissionErrorCode, message: String) : Exception(message)

/**
 * A sliced artifact to send: its G-code — [byteLength] bytes that [open] reads
 * from the start each time — its identity and the tools it uses. Closing it
 * releases what holds the bytes (see [PrintJobArtifacts]).
 */
class PrintJobArtifact(
    val filename: String,
    val byteLength: Long,
    val open: () -> InputStream,
    val plateName: String,
    val usage: ProjectIntents.GcodeToolUsage,
    /** `sha256:` and the hex digest of the G-code. */
    val outputHash: String,
    /** Whether the artifact still matches what the operator sliced. */
    val isCurrent: () -> Boolean,
    private val release: () -> Unit = {},
) : AutoCloseable {
    /** An artifact whose G-code is held in memory. */
    constructor(
        filename: String,
        gcode: ByteArray,
        plateName: String,
        usage: ProjectIntents.GcodeToolUsage,
        outputHash: String,
        isCurrent: () -> Boolean,
    ) : this(filename, gcode.size.toLong(), { ByteArrayInputStream(gcode) }, plateName, usage, outputHash, isCurrent)

    override fun close() = release()
}

/** Progress the operator sees while a send runs. */
class PrintSendProgress(
    val onPhase: (ProjectIntents.PrintSubmissionPhase) -> Unit = {},
    /** Elapsed milliseconds and total bytes, every second while the upload runs. */
    val onUploadElapsed: ((Long, Long) -> Unit)? = null,
)

/**
 * The send workflow on Android: the shared core's submission machine
 * (`orcaxr_printer::workflow`, the policy the browser runs). The core owns
 * readiness, file management, the confirmation it asks for, the unique upload
 * name, verification, preparation, the start and every uncertain outcome; this
 * class captures the printer session, asks the operator, sends requests and
 * the upload over the session's client, draws random bytes, and answers whether
 * the artifact and session are still current.
 *
 * A cancel stops what the operation started (its requests, upload, dialog and
 * session capture); the one reconciling query the core sends after an
 * uncertain step is not the operation's and runs on. A session that ends
 * reaches the core as a cancel. Every core call runs on the workflow's one
 * thread, in the core's step order.
 */
class PrintWorkflowClient(
    private val captureSession: (cancelled: CompletableFuture<Unit>) -> CompletableFuture<PrinterSessionClientLease>,
    private val confirm: (
        ProjectIntents.PrintWorkflowConfirmation,
        cancelled: CompletableFuture<Unit>,
    ) -> CompletableFuture<ProjectIntents.PrintWorkflowDecision>,
    private val randomBytes: () -> ByteArray = { ByteArray(16).also(secure::nextBytes) },
) : AutoCloseable {
    private companion object {
        val secure = SecureRandom()
    }

    @Volatile private var thread: Thread? = null
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "print-workflow").also {
            it.isDaemon = true
            thread = it
        }
    }
    private val workflow = PrintWorkflow()

    private class Operation(
        val future: CompletableFuture<Any?>,
        val progress: PrintSendProgress,
        val artifact: PrintJobArtifact?,
    ) {
        val cancelled = CompletableFuture<Unit>()
        val calls = ArrayList<MoonrakerCall<*>>()
        var lease: PrinterSessionClientLease? = null
        var ticker: ScheduledFuture<*>? = null
    }

    // Touched on the workflow's thread only.
    private var operation: Operation? = null
    private var phaseValue = ProjectIntents.PrintWorkflowPhase.Idle
    private val queue = ArrayDeque<ProjectIntents.PrintWorkflowStep>()
    private var draining = false
    private var closed = false

    private fun <T> onThread(work: () -> T): T =
        if (Thread.currentThread() === thread) work() else executor.submit<T> { work() }.get()

    private fun post(work: () -> Unit) {
        try {
            executor.execute { if (!closed) work() }
        } catch (rejected: RejectedExecutionException) {
            // Closed: late answers are dropped.
        }
    }

    val busy: Boolean get() = onThread { operation != null }
    val phase: ProjectIntents.PrintWorkflowPhase get() = onThread { phaseValue }

    /** Sends [artifact]: the submitted result, `null` when the operator declined. */
    fun run(artifact: PrintJobArtifact, progress: PrintSendProgress = PrintSendProgress()): CompletableFuture<ProjectIntents.PrintSubmissionResult?> {
        val intent = ProjectIntents.PrintWorkflowIntent(
            units(artifact.filename), artifact.byteLength, units(artifact.plateName), artifact.usage,
            units(artifact.outputHash),
        )
        @Suppress("UNCHECKED_CAST")
        return start({ workflow.run(intent) }, progress, artifact) as CompletableFuture<ProjectIntents.PrintSubmissionResult?>
    }

    /** Reprints a stored file: its path once started, `null` when the operator declined. */
    fun startStored(path: String): CompletableFuture<String?> {
        @Suppress("UNCHECKED_CAST")
        return start({ workflow.startStored(ProjectIntents.PrinterText(units(path))) }, PrintSendProgress(), null) as CompletableFuture<String?>
    }

    fun cancel() = onThread {
        val current = operation ?: return@onThread
        stop(current)
        input { workflow.cancel() }
    }

    override fun close() {
        onThread {
            if (!closed) {
                operation?.let(::stop)
                apply(workflow.dispose())
                closed = true
            }
        }
        executor.shutdown()
        workflow.close()
    }

    // --- Operations and steps -----------------------------------------------------------------

    private fun start(call: () -> ProjectIntents.PrintWorkflowStep, progress: PrintSendProgress, artifact: PrintJobArtifact?): CompletableFuture<Any?> {
        val future = CompletableFuture<Any?>()
        post {
            if (operation != null) {
                future.completeExceptionally(unavailable())
                return@post
            }
            val step = try {
                call()
            } catch (failure: IllegalStateException) {
                future.completeExceptionally(if (failure.message == "unavailable") unavailable() else failure)
                return@post
            }
            operation = Operation(future, progress, artifact)
            apply(step)
        }
        return future
    }

    private fun unavailable() = PrintSubmissionException(
        ProjectIntents.PrintSubmissionErrorCode.StaleContext, "A send is unavailable or already pending.",
    )

    /** Stops what [operation] started: its calls, its dialog's wait and its upload ticks. */
    private fun stop(operation: Operation) {
        operation.cancelled.complete(Unit)
        operation.calls.forEach { it.cancel() }
        operation.calls.clear()
        operation.ticker?.cancel(false)
    }

    private fun input(call: () -> ProjectIntents.PrintWorkflowStep) {
        val step = try {
            call()
        } catch (failure: IllegalStateException) {
            if (failure.message == "not_pending" || failure.message == "mismatch") return
            throw failure
        }
        apply(step)
    }

    private fun answer(id: Long, outcome: ProjectIntents.PrintWorkflowOutcome) = input { workflow.resolve(id, outcome) }

    private fun apply(step: ProjectIntents.PrintWorkflowStep) {
        queue.addLast(step)
        if (draining) return
        draining = true
        try {
            while (true) run(queue.removeFirstOrNull() ?: break)
        } finally {
            draining = false
        }
    }

    private fun run(step: ProjectIntents.PrintWorkflowStep) {
        val current = operation
        phaseValue = step.phase
        for (phase in step.phases) current?.progress?.onPhase?.let { runCatching { it(phase) } }
        if (current != null) for (pending in step.effects) carryOut(pending.id, pending.effect, current)
        settle(step.state, current)
    }

    private fun carryOut(id: Long, effect: ProjectIntents.PrintWorkflowEffect, operation: Operation) {
        when (effect) {
            // Asked synchronously: answered at once, in the core's order.
            is ProjectIntents.PrintWorkflowEffect.Random -> queue.addLast(
                workflow.resolve(id, ProjectIntents.PrintWorkflowOutcome.Random(randomBytes().map { it.toInt() and 0xff })),
            )
            is ProjectIntents.PrintWorkflowEffect.ArtifactCurrent -> queue.addLast(
                workflow.resolve(id, ProjectIntents.PrintWorkflowOutcome.Current(runCatching { operation.artifact?.isCurrent?.invoke() == true }.getOrDefault(false))),
            )
            is ProjectIntents.PrintWorkflowEffect.SessionCurrent -> queue.addLast(
                workflow.resolve(id, ProjectIntents.PrintWorkflowOutcome.Current(runCatching { operation.lease?.isCurrent() == true }.getOrDefault(false))),
            )
            is ProjectIntents.PrintWorkflowEffect.CaptureSession -> {
                val captured = runCatching { captureSession(operation.cancelled) }.getOrElse { CompletableFuture.failedFuture(it) }
                captured.whenComplete { lease, thrown ->
                    post {
                        if (this.operation !== operation) return@post
                        if (thrown != null) {
                            val unwrapped = unwrap(thrown)
                            val message = unwrapped.message?.trim()?.ifEmpty { null }
                                ?: (unwrapped.javaClass.simpleName + (unwrapped.cause?.let { " (${it.message?.trim()?.ifEmpty { null } ?: it.javaClass.simpleName})" } ?: ""))
                            android.util.Log.e("OrcaXRSend", "CaptureSession failed: $message", unwrapped)
                            answer(id, ProjectIntents.PrintWorkflowOutcome.SessionFailed(ProjectIntents.PrinterText(units(message))))
                            return@post
                        }
                        operation.lease = lease
                        // A session that ends reaches the core as a cancel, before its answer.
                        lease.ended.thenRun { post { if (this.operation === operation) cancel() } }
                        if (lease.ended.isDone) cancel()
                        answer(id, ProjectIntents.PrintWorkflowOutcome.Session(ProjectIntents.PrinterText(units(lease.label))))
                    }
                }
            }
            is ProjectIntents.PrintWorkflowEffect.Confirm -> {
                val asked = runCatching { confirm(effect.value, operation.cancelled) }.getOrElse { CompletableFuture.failedFuture(it) }
                asked.whenComplete { decision, thrown ->
                    // A dialog that fails sent nothing: it reads as a cancelled send.
                    val chosen = if (thrown == null && decision != null) decision else ProjectIntents.PrintWorkflowDecision(
                        ProjectIntents.PrintWorkflowDecisionChoice.Cancel, false, emptyList(),
                    )
                    post { answer(id, ProjectIntents.PrintWorkflowOutcome.Decision(chosen)) }
                }
            }
            is ProjectIntents.PrintWorkflowEffect.Request -> exchange(id, operation, track = true) {
                it.request(text(effect.value.path), options(effect.value))
            }
            // Not the operation's: it carries its own deadline and runs on after a cancel.
            is ProjectIntents.PrintWorkflowEffect.Reconcile -> exchange(id, operation, track = false) {
                it.request(text(effect.value.path), options(effect.value))
            }
            is ProjectIntents.PrintWorkflowEffect.Upload -> {
                val upload = effect.value
                val artifact = operation.artifact
                val fields = buildList {
                    add("root" to text(upload.root))
                    add("path" to text(upload.directory))
                    add("print" to if (upload.print) "true" else "false")
                    (upload.checksum as? ProjectIntents.OptionalText.Value)?.let { add("checksum" to text(it.value)) }
                }
                operation.progress.onUploadElapsed?.let { report ->
                    val startedAt = System.currentTimeMillis()
                    operation.ticker = executor.scheduleAtFixedRate(
                        { runCatching { report(System.currentTimeMillis() - startedAt, upload.size) } }, 1, 1, TimeUnit.SECONDS,
                    )
                }
                val operationName = text(upload.operation)
                exchange(id, operation, track = true, done = { operation.ticker?.cancel(false) }) {
                    it.upload(
                        text(upload.path),
                        if (artifact == null) MoonrakerUpload(fields, text(upload.filename), ByteArray(0))
                        else MoonrakerUpload(fields, text(upload.filename), artifact.byteLength, artifact.open),
                        MoonrakerRequestOptions(operation = operationName.ifEmpty { null }, timeoutMs = MoonrakerClient.UNBOUNDED),
                    )
                }
            }
        }
    }

    private fun options(send: ProjectIntents.PrinterSend): MoonrakerRequestOptions {
        val method = text(send.method)
        val operation = text(send.operation)
        return MoonrakerRequestOptions(
            method = method.takeIf { it != "GET" },
            operation = operation.ifEmpty { null },
            timeoutMs = (send.timeoutMs as? ProjectIntents.OptionalFinite.Value)?.value,
        )
    }

    /** A request or upload over the session's client: its reply (`result`, as JSON) or failure. */
    private fun exchange(
        id: Long,
        operation: Operation,
        track: Boolean,
        done: () -> Unit = {},
        send: (MoonrakerClient) -> MoonrakerCall<String>,
    ) {
        val client = operation.lease?.client
        val call = try {
            if (client == null) error("no session") else send(client)
        } catch (failure: RuntimeException) {
            done()
            queue.addLast(workflow.resolve(id, failed(failure)))
            return
        }
        if (track) operation.calls += call
        call.result.whenComplete { reply, thrown ->
            post {
                done()
                operation.calls -= call
                if (thrown == null) input { workflow.resolveReply(id, reply) } else answer(id, failed(unwrap(thrown)))
            }
        }
    }

    private fun settle(state: ProjectIntents.PrintWorkflowState, current: Operation?) {
        if (state is ProjectIntents.PrintWorkflowState.Pending || current == null || operation !== current) return
        operation = null
        stop(current)
        when (state) {
            is ProjectIntents.PrintWorkflowState.Submitted -> current.future.complete(state.value)
            is ProjectIntents.PrintWorkflowState.Started -> current.future.complete(text(state.value.text))
            is ProjectIntents.PrintWorkflowState.Failed -> {
                val rawMsg = text(state.value.message).trim()
                val errorMsg = rawMsg.ifEmpty { "Workflow failed (${state.value.code.name})" }
                android.util.Log.e("OrcaXRSend", "PrintWorkflowState.Failed code=${state.value.code}: $errorMsg")
                current.future.completeExceptionally(PrintSubmissionException(state.value.code, errorMsg))
            }
            else -> current.future.complete(null)
        }
    }

    private fun failed(cause: Throwable): ProjectIntents.PrintWorkflowOutcome {
        val fault = (cause as? MoonrakerException)?.fault
        return ProjectIntents.PrintWorkflowOutcome.Failed(
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

    private fun unwrap(thrown: Throwable): Throwable =
        if ((thrown is CompletionException || thrown is ExecutionException) && thrown.cause != null) thrown.cause!! else thrown

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>): String = String(CharArray(units.size) { units[it].toChar() })
}
