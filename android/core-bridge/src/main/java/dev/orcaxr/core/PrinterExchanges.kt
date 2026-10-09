package dev.orcaxr.core

import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** A storage operation's result, with the file's bytes when it was a download. */
class PrinterStorageAnswer(val result: ProjectIntents.PrinterStorageResult, val bytes: ByteArray? = null)

/**
 * The printer's storage, history, console and cameras over a session's
 * [MoonrakerClient]. The shared policy plans each operation, finishes it and
 * reads its reply ([PrinterStorage], [PrintHistory], [PrinterConsole],
 * [PrinterCamera]); this class only performs the exchange the plan names —
 * a request or download through the client, credential attached, or a
 * camera's own URL fetched directly without it.
 *
 * [direct] fetches camera frames from another service on the printer's
 * machine: no credential, no redirect, plain HTTP only to the local network,
 * and judged by the local-network permission like every other exchange.
 */
class PrinterExchanges(
    private val client: MoonrakerClient,
    /** The endpoint the session uses, so a camera's reported URL can be placed. */
    private val endpoint: String?,
    localNetwork: LocalNetworkPermission? = null,
    http: OkHttpClient = OkHttpClient(),
) {
    private val direct: OkHttpClient = http.newBuilder()
        .apply { localNetwork?.let { addInterceptor(LocalNetworkAccess.gate(it, http.dns)) } }
        .addNetworkInterceptor(LanTransportPolicy.cleartextGuard)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private val absent = ProjectIntents.Empty

    private fun unwrap(failure: Throwable): Throwable =
        if ((failure is CompletionException || failure is ExecutionException) && failure.cause != null) unwrap(failure.cause!!) else failure

    /** How an exchange that left no reply to read ended, as the policy reads it. */
    private fun outcome(failure: Throwable?): ProjectIntents.PrinterExchangeOutcome = when (val cause = failure?.let(::unwrap)) {
        null -> ProjectIntents.PrinterExchangeOutcome.Done(absent)
        is CancellationException -> ProjectIntents.PrinterExchangeOutcome.Cancelled(absent)
        is MoonrakerException -> ProjectIntents.PrinterExchangeOutcome.Failed(
            ProjectIntents.TransportFailure(
                ProjectIntents.OptionalMoonrakerErrorCode.Value(cause.fault.code), cause.fault.httpStatus, cause.fault.detail,
            ),
        )
        else -> ProjectIntents.PrinterExchangeOutcome.Failed(
            ProjectIntents.TransportFailure(
                ProjectIntents.OptionalMoonrakerErrorCode.Absent(absent),
                ProjectIntents.OptionalFinite.Absent(absent),
                ProjectIntents.OptionalText.Absent(absent),
            ),
        )
    }

    private fun options(send: ProjectIntents.PrinterSend) = MoonrakerRequestOptions(
        method = text(send.method),
        operation = text(send.operation),
        timeoutMs = (send.timeoutMs as? ProjectIntents.OptionalFinite.Value)?.value,
    )

    /** Sends [send]; [read] reads the reply, [finish] how it ended without one. */
    private fun <R> exchange(send: ProjectIntents.PrinterSend, read: (String) -> R, finish: (ProjectIntents.PrinterExchangeOutcome) -> R): CompletableFuture<R> =
        client.request(text(send.path), options(send)).result.handle { reply, failure ->
            if (failure == null) read(reply) else finish(outcome(failure))
        }

    fun storage(operation: ProjectIntents.PrinterStorageOperation): CompletableFuture<PrinterStorageAnswer> {
        val finish = { outcome: ProjectIntents.PrinterExchangeOutcome ->
            PrinterStorage.finish(ProjectIntents.PrinterStorageFinish(operation, outcome))
        }
        return when (val plan = PrinterStorage.plan(operation)) {
            is ProjectIntents.PrinterStoragePlan.Refused ->
                CompletableFuture.completedFuture(PrinterStorageAnswer(ProjectIntents.PrinterStorageResult.Failed(plan.value)))
            is ProjectIntents.PrinterStoragePlan.Request -> exchange(
                plan.value,
                { reply -> PrinterStorageAnswer(PrinterStorage.read(operation, reply)) },
                { outcome -> PrinterStorageAnswer(finish(outcome)) },
            )
            is ProjectIntents.PrinterStoragePlan.Download ->
                client.download(text(plan.value.path), MoonrakerRequestOptions(operation = text(plan.value.operation))).result
                    .handle { bytes, failure ->
                        PrinterStorageAnswer(finish(outcome(failure)), if (failure == null) bytes else null)
                    }
        }
    }

    fun history(operation: ProjectIntents.PrintHistoryOperation): CompletableFuture<ProjectIntents.PrintHistoryResult> =
        when (val plan = PrintHistory.plan(operation)) {
            is ProjectIntents.PrintHistoryPlan.Refused ->
                CompletableFuture.completedFuture(ProjectIntents.PrintHistoryResult.Failed(plan.value))
            is ProjectIntents.PrintHistoryPlan.Request -> exchange(
                plan.value,
                { reply -> PrintHistory.read(operation, reply) },
                { outcome -> PrintHistory.finish(ProjectIntents.PrintHistoryFinish(operation, outcome)) },
            )
        }

    fun console(operation: ProjectIntents.ConsoleOperation): CompletableFuture<ProjectIntents.ConsoleResult> =
        when (val plan = PrinterConsole.plan(operation)) {
            is ProjectIntents.ConsolePlan.Refused ->
                CompletableFuture.completedFuture(ProjectIntents.ConsoleResult.Failed(plan.value))
            is ProjectIntents.ConsolePlan.Request -> exchange(
                plan.value,
                { reply -> PrinterConsole.read(operation, reply) },
                { outcome -> PrinterConsole.finish(ProjectIntents.ConsoleFinish(operation, outcome)) },
            )
        }

    fun cameras(): CompletableFuture<ProjectIntents.CameraListResult> {
        val request = ProjectIntents.CameraListRequest(
            endpoint?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: ProjectIntents.OptionalText.Absent(absent),
        )
        return exchange(
            PrinterCamera.listPlan(),
            { reply -> PrinterCamera.listRead(request, reply) },
            { outcome -> PrinterCamera.listFinish(ProjectIntents.CameraListFinish(request, outcome)) },
        )
    }

    /**
     * One frame along [mechanism], or the camera's first fetchable route:
     * the bytes, or the failure the policy reads the fetch as.
     */
    fun snapshot(
        camera: ProjectIntents.PrinterCamera,
        mechanism: ProjectIntents.CameraMechanism? = null,
    ): CompletableFuture<Result<ByteArray>> {
        val request = ProjectIntents.CameraSnapshotRequest(
            camera,
            mechanism?.let { ProjectIntents.OptionalCameraMechanism.Value(it) } ?: ProjectIntents.OptionalCameraMechanism.Absent(absent),
        )
        val failed = { outcome: ProjectIntents.CameraSnapshotOutcome ->
            val failure = PrinterCamera.snapshotFailure(ProjectIntents.CameraSnapshotFinish(request, outcome))
            Result.failure<ByteArray>(CameraFrameException(failure))
        }
        return when (val plan = PrinterCamera.snapshotPlan(request)) {
            is ProjectIntents.CameraSnapshotPlan.Refused ->
                CompletableFuture.completedFuture(Result.failure(CameraFrameException(plan.value)))
            is ProjectIntents.CameraSnapshotPlan.Transport ->
                client.download(text(plan.value.path), MoonrakerRequestOptions(operation = text(plan.value.operation))).result
                    .handle { bytes, failure ->
                        when (val cause = failure?.let(::unwrap)) {
                            null -> Result.success(bytes)
                            is CancellationException -> failed(ProjectIntents.CameraSnapshotOutcome.Cancelled(absent))
                            is MoonrakerException ->
                                if (cause.fault.code == ProjectIntents.MoonrakerErrorCode.Cancelled) {
                                    failed(ProjectIntents.CameraSnapshotOutcome.Cancelled(absent))
                                } else {
                                    failed(ProjectIntents.CameraSnapshotOutcome.Transport(ProjectIntents.OptionalMoonrakerErrorCode.Value(cause.fault.code)))
                                }
                            else -> failed(ProjectIntents.CameraSnapshotOutcome.Transport(ProjectIntents.OptionalMoonrakerErrorCode.Absent(absent)))
                        }
                    }
            is ProjectIntents.CameraSnapshotPlan.Direct -> {
                val future = CompletableFuture<Result<ByteArray>>()
                val call = direct.newBuilder()
                    .callTimeout(plan.value.timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .build()
                    .newCall(Request.Builder().url(text(plan.value.url)).build())
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        future.complete(
                            failed(
                                when {
                                    call.isCanceled() -> ProjectIntents.CameraSnapshotOutcome.Cancelled(absent)
                                    e is InterruptedIOException -> ProjectIntents.CameraSnapshotOutcome.Timeout(absent)
                                    else -> ProjectIntents.CameraSnapshotOutcome.Unreachable(units(e.message ?: "request failed"))
                                },
                            ),
                        )
                    }
                    override fun onResponse(call: Call, response: Response) {
                        future.complete(
                            try {
                                response.use {
                                    if (!it.isSuccessful) return@use failed(ProjectIntents.CameraSnapshotOutcome.Status(it.code.toDouble()))
                                    // A frame is read whole up to its bound, never past it.
                                    val source = it.body!!.source()
                                    if (source.request(MAX_FRAME_BYTES + 1)) {
                                        failed(ProjectIntents.CameraSnapshotOutcome.Unreachable(units("the frame is larger than $MAX_FRAME_BYTES bytes")))
                                    } else {
                                        Result.success(source.readByteArray())
                                    }
                                }
                            } catch (e: IOException) {
                                failed(ProjectIntents.CameraSnapshotOutcome.Unreachable(units(e.message ?: "request failed")))
                            },
                        )
                    }
                })
                future.whenComplete { _, _ -> if (future.isCancelled) call.cancel() }
                future
            }
        }
    }
}

/** The largest camera frame read: far past any snapshot a camera serves. */
const val MAX_FRAME_BYTES = 16L * 1024 * 1024

/** A camera frame that could not be fetched, as the policy reads it. */
class CameraFrameException(val failure: ProjectIntents.CameraFailure) :
    Exception(String(CharArray(failure.message.size) { failure.message[it].toChar() }))
