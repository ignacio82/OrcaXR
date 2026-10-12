package dev.orcaxr.core

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.source

/** The project archive a slice uploads: its exact length, and a fresh stream
 * of it each time it is asked for (the file a plate archive was written to). */
class ExternalSlicerArchive(val length: Long, val open: () -> InputStream)

/** Where a slice's artifact is written: [open] gives a fresh, empty stream
 * each time a download starts — the result the server retains is fetched
 * again after a transfer that failed, and the earlier one's bytes are void. */
fun interface ExternalSlicerOutput {
    fun open(): OutputStream
}

/** An accepted slice: every byte of the artifact reached the caller's sink,
 * with its transferred length and SHA-256, the engine that attested it, and
 * whether the server confirmed releasing the result. */
data class ExternalSliceResult(
    val length: Long,
    val sha256: String,
    val engine: ProjectIntents.ExternalSlicerAttested,
    val released: Boolean,
)

/** A slice that produced no artifact, as the shared policy reads it: [kind]
 * tells a failure from a cancellation, a job already done, failed or released
 * when cancelled, and a cancellation that could not be confirmed. A cancel the
 * server confirmed completes the call with a [CancellationException] instead. */
class ExternalSlicerException(val kind: ProjectIntents.ExternalSlicerFailureKind, message: String) : Exception(message)

/** A slice in flight: its result, and [cancel], which aborts it as the
 * browser's signal does — confirmed with the server before the call ends. */
class ExternalSliceCall internal constructor(
    val result: CompletableFuture<ExternalSliceResult>,
    private val onCancel: () -> Unit,
) {
    fun cancel() = onCancel()
}

/**
 * The operator's external slicer on Android, as the browser's canonical route
 * drives it: the engine attested against the pinned build, the project
 * archive and its overrides submitted (`POST /slice?async=1`, multipart
 * `file` and `overrides`), the job polled every [pollIntervalMs], the
 * artifact streamed into the caller's output while its length, SHA-256 and
 * UTF-8 text are judged by the shared policy ([ExternalSlicerPolicy]) —
 * fetched again, while the policy allows, after a transfer that dropped, came
 * up short or did not match its checksum, since the server keeps the result
 * (a transfer in progress holds it) until it is released or expires — and an
 * accepted result released. A cancel confirms itself within one
 * [cancellationTimeoutMs] deadline and ends in the policy's outcome.
 *
 * Every request carries the caller's bearer token, follows no redirect
 * (one fails the exchange, so the token never reaches another host), retries
 * nothing, and is judged by the local-network permission and the cleartext
 * rule ([LanTransportPolicy]) before it connects. A reply body is read only
 * as far as [MAX_REPLY_BYTES]; the artifact goes straight to the sink, never
 * into memory. Each call runs on the client's own worker threads.
 */
class ExternalSlicerClient(
    http: OkHttpClient = OkHttpClient(),
    localNetwork: LocalNetworkPermission? = null,
    private val pollIntervalMs: Long = ExternalSlicerPolicy.POLL_INTERVAL_MS,
    private val cancellationTimeoutMs: Long = ExternalSlicerPolicy.CANCELLATION_TIMEOUT_MS,
) : AutoCloseable {
    companion object {
        /** The most of a reply body read; past it the reply cannot be read as JSON. */
        const val MAX_REPLY_BYTES = 1L shl 20
        private const val CHUNK = 64 * 1024
        private val OCTETS: MediaType = "application/octet-stream".toMediaType()
        private const val UNREACHABLE = "The external slicer could not be reached."
        private const val NOT_WRITTEN = "OrcaXR could not keep the external slicer's G-code."
        private const val REDIRECTED = "The external slicer redirected the request; OrcaXR does not follow redirects."
    }

    private val http: OkHttpClient = http.newBuilder()
        .apply { localNetwork?.let { addInterceptor(LocalNetworkAccess.gate(it, http.dns)) } }
        .addNetworkInterceptor(LanTransportPolicy.cleartextGuard)
        .connectionPool(LanTransportPolicy.idleConnections())
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        // A slice may take as long as its engine does; deadlines are the policy's.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val workers: ExecutorService = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "external-slicer").also { it.isDaemon = true }
    }

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private val absent = ProjectIntents.Empty
    private fun optional(value: String?): ProjectIntents.OptionalText =
        if (value == null) ProjectIntents.OptionalText.Absent(absent) else ProjectIntents.OptionalText.Value(units(value))
    private fun failed(failure: ProjectIntents.ExternalSlicerFailure) = ExternalSlicerException(failure.kind, text(failure.message))

    /** One call's exchanges, and the caller's cancel, which stops the one in
     * flight and any pause only while [abortable]: never the submission. */
    private class Flight {
        @Volatile var cancelled = false
        @Volatile var abortable = false
        @Volatile var call: Call? = null
        private val signal = CountDownLatch(1)
        fun cancel() {
            cancelled = true
            if (abortable) call?.cancel()
            signal.countDown()
        }
        /** Waits [ms], or less once cancelled while [abortable]. */
        fun pause(ms: Long) {
            if (ms <= 0) return
            if (abortable) signal.await(ms, TimeUnit.MILLISECONDS) else Thread.sleep(ms)
        }
    }

    /** Thrown inside a call when the caller's cancel stopped an abortable step. */
    private class Aborted : IOException("aborted")

    /** An artifact's reply that never arrived whole, in an operator's words. */
    private class TransferFailed(val detail: String) : IOException(detail)

    /** A downloaded artifact as the policy judged it, and its facts. */
    private class Judged(val verdict: ProjectIntents.ExternalSlicerArtifact, val length: Long, val sha256: String)

    private fun request(send: ProjectIntents.ExternalSlicerSend, token: String?, body: RequestBody? = null): Request {
        val method = text(send.method)
        return Request.Builder().url(text(send.url))
            .method(method, body ?: if (method == "GET" || method == "HEAD") null else ByteArray(0).toRequestBody(null))
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .build()
    }

    /** Runs [request]: the response (not a redirect), or why there is none. */
    private fun execute(flight: Flight, request: Request, deadlineMs: Long? = null): Response {
        val call = http.newCall(request)
        if (deadlineMs != null) call.timeout().timeout(maxOf(1, deadlineMs), TimeUnit.MILLISECONDS)
        flight.call = call
        if (flight.abortable && flight.cancelled) throw Aborted()
        val response = try {
            call.execute()
        } catch (failure: IOException) {
            if (flight.abortable && flight.cancelled) throw Aborted()
            throw failure
        }
        if (response.isRedirect) {
            response.close()
            throw IOException(REDIRECTED)
        }
        return response
    }

    /** An operator's reading of a transport failure: the network rules' own
     * sentences, otherwise nothing private. */
    private fun detail(failure: IOException): String = when (failure) {
        is LocalNetworkDeniedException, is CleartextRefusedException -> failure.message ?: UNREACHABLE
        else -> if (failure.message == REDIRECTED) REDIRECTED else UNREACHABLE
    }

    /** A reply body decoded as UTF-8, as `Response.text()` does, read only as far as [MAX_REPLY_BYTES]. */
    private fun bodyText(response: Response): String {
        val source = response.body!!.source()
        source.request(MAX_REPLY_BYTES + 1)
        val bytes = source.buffer.readByteArray(minOf(source.buffer.size, MAX_REPLY_BYTES + 1))
        return String(bytes, Charsets.UTF_8).removePrefix("\uFEFF")
    }

    /** One plain exchange read as the policy reads it: the reply, or the transport's failure. */
    private fun reply(flight: Flight, request: Request, deadlineMs: Long? = null): ProjectIntents.ExternalSlicerReply =
        try {
            execute(flight, request, deadlineMs).use { response ->
                val body = if (response.isSuccessful) bodyText(response) else ""
                ProjectIntents.ExternalSlicerReply.Response(ProjectIntents.ExternalSlicerResponse(response.code.toLong(), units(body)))
            }
        } catch (aborted: Aborted) {
            throw aborted
        } catch (failure: IOException) {
            ProjectIntents.ExternalSlicerReply.Failed(units(detail(failure)))
        }

    private fun endpointRequest(endpoint: String) = ProjectIntents.ExternalSlicerEndpointRequest(units(endpoint))

    private fun attestation(flight: Flight, endpoint: String, token: String?): ProjectIntents.ExternalSlicerAttestation =
        when (val plan = ExternalSlicerPolicy.attestationPlan(endpointRequest(endpoint))) {
            is ProjectIntents.ExternalSlicerAttestationPlan.Unattested -> ProjectIntents.ExternalSlicerAttestation.Unattested(plan.value)
            // A refusal is read by its status alone, as the browser reads it.
            is ProjectIntents.ExternalSlicerAttestationPlan.Send ->
                ExternalSlicerPolicy.attestation(reply(flight, request(plan.value, token)))
        }

    /** Whether [endpoint] runs the engine build this client accepts (`GET /engine`). */
    fun attest(endpoint: String, token: String? = null): CompletableFuture<ProjectIntents.ExternalSlicerAttestation> =
        CompletableFuture.supplyAsync({ attestation(Flight(), endpoint, token) }, workers)

    /**
     * Slices [archive] on the external slicer at [endpoint] with [overrides]
     * (engine wire strings; [ProjectPlateArchive.overrides] for one plate),
     * streaming the artifact into [output] — a fresh stream for each download
     * of it; only the last one's bytes are the result. [onProgress] hears the
     * job's progress on the client's worker thread. On any failure [output]
     * may hold part of an artifact; discard it.
     */
    fun slice(
        endpoint: String,
        token: String?,
        archive: ExternalSlicerArchive,
        overrides: Map<String, String>,
        output: ExternalSlicerOutput,
        onProgress: (ProjectIntents.ExternalSlicerProgress) -> Unit = {},
    ): ExternalSliceCall {
        val flight = Flight()
        val result = CompletableFuture.supplyAsync({ run(flight, endpoint, token, archive, overrides, output, onProgress) }, workers)
        return ExternalSliceCall(result) { flight.cancel() }
    }

    private fun run(
        flight: Flight,
        endpoint: String,
        token: String?,
        archive: ExternalSlicerArchive,
        overrides: Map<String, String>,
        output: ExternalSlicerOutput,
        onProgress: (ProjectIntents.ExternalSlicerProgress) -> Unit,
    ): ExternalSliceResult {
        val canonical = when (val value = ExternalSlicerPolicy.endpoint(endpointRequest(endpoint))) {
            is ProjectIntents.ExternalSlicerEndpoint.Refused -> throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, text(value.value))
            is ProjectIntents.ExternalSlicerEndpoint.Endpoint -> value.value
        }
        val engine = when (val attested = attestation(flight, endpoint, token)) {
            is ProjectIntents.ExternalSlicerAttestation.Unattested ->
                throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, text(attested.value))
            is ProjectIntents.ExternalSlicerAttestation.Attested -> attested.value
        }
        if (flight.cancelled) throw CancellationException("The external slice was cancelled before it was submitted.")
        val send = when (val plan = ExternalSlicerPolicy.submitPlan(endpointRequest(endpoint))) {
            is ProjectIntents.ExternalSlicerPlan.Refused -> throw failed(plan.value)
            is ProjectIntents.ExternalSlicerPlan.Send -> plan.value
        }
        val file = object : RequestBody() {
            override fun contentType() = OCTETS
            override fun contentLength() = archive.length
            override fun writeTo(sink: BufferedSink) {
                archive.open().source().use { sink.writeAll(it) }
            }
        }
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "project.3mf", file)
            .addFormDataPart("overrides", CanonicalJson.write(overrides))
            .build()
        // Never aborted: once the server accepts the upload, its reply holds
        // the only job ID a cancellation can name. A cancel arriving meanwhile
        // is carried out once the reply is read.
        val response = try {
            execute(flight, request(send, token, form))
        } catch (failure: IOException) {
            val read = ProjectIntents.ExternalSlicerSubmitRead(
                ProjectIntents.ExternalSlicerSubmitReply.Failed(units(detail(failure))), flight.cancelled,
            )
            throw (ExternalSlicerPolicy.submission(read) as? ProjectIntents.ExternalSlicerSubmission.Failed)?.let { failed(it.value) }
                ?: ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, detail(failure))
        }
        // A job reply's cancellation is judged once its body is read; any
        // other reply's before it is, and a cancelled one is left unread.
        var body = ""
        val aborted: Boolean
        try {
            if (response.code == 202) {
                body = bodyText(response)
                aborted = flight.cancelled
            } else {
                aborted = flight.cancelled
                if (!aborted && !response.isSuccessful) body = bodyText(response)
            }
        } catch (failure: IOException) {
            response.close()
            throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, detail(failure))
        }
        val read = ProjectIntents.ExternalSlicerSubmitRead(
            ProjectIntents.ExternalSlicerSubmitReply.Response(
                ProjectIntents.ExternalSlicerSubmitResponse(response.code.toLong(), units(body), optional(response.header("X-OrcaXR-Job-Id"))),
            ),
            aborted,
        )
        return when (val step = ExternalSlicerPolicy.submission(read)) {
            is ProjectIntents.ExternalSlicerSubmission.Failed -> {
                response.close()
                throw failed(step.value)
            }
            is ProjectIntents.ExternalSlicerSubmission.Cancel -> {
                response.close()
                confirmCancellation(flight, canonical, step.value, token)
                throw CancellationException("The external slice was cancelled.")
            }
            is ProjectIntents.ExternalSlicerSubmission.Job -> {
                response.close()
                poll(flight, canonical, step.value, token, engine, output, onProgress)
            }
            // A server without jobs answers the artifact itself; there is no
            // job to cancel or fetch again, so a cancel only stops the transfer.
            is ProjectIntents.ExternalSlicerSubmission.Artifact -> response.use {
                flight.abortable = true
                try {
                    val judged = try {
                        download(flight, it, null, output)
                    } catch (failure: TransferFailed) {
                        throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, failure.detail)
                    }
                    accept(flight, judged, canonical, token, engine)
                } catch (_: Aborted) {
                    throw CancellationException("The external slice was cancelled.")
                }
            }
        }
    }

    private fun jobSend(endpoint: List<Int>, jobId: List<Int>, step: ProjectIntents.ExternalSlicerJobStep): ProjectIntents.ExternalSlicerSend =
        when (val plan = ExternalSlicerPolicy.jobPlan(ProjectIntents.ExternalSlicerJobRequest(endpoint, jobId, step))) {
            is ProjectIntents.ExternalSlicerPlan.Refused -> throw failed(plan.value)
            is ProjectIntents.ExternalSlicerPlan.Send -> plan.value
        }

    private fun poll(
        flight: Flight,
        endpoint: List<Int>,
        jobId: List<Int>,
        token: String?,
        engine: ProjectIntents.ExternalSlicerAttested,
        output: ExternalSlicerOutput,
        onProgress: (ProjectIntents.ExternalSlicerProgress) -> Unit,
    ): ExternalSliceResult {
        flight.abortable = true
        try {
            val status = jobSend(endpoint, jobId, ProjectIntents.ExternalSlicerJobStep.Status)
            var failures = 0L
            while (true) {
                flight.pause(pollIntervalMs)
                if (flight.cancelled) throw Aborted()
                val reply = reply(flight, request(status, token))
                when (val step = ExternalSlicerPolicy.poll(ProjectIntents.ExternalSlicerPollRead(failures, reply))) {
                    is ProjectIntents.ExternalSlicerPollStep.Failed -> throw failed(step.value)
                    is ProjectIntents.ExternalSlicerPollStep.Download -> return fetch(flight, endpoint, jobId, token, engine, output)
                    is ProjectIntents.ExternalSlicerPollStep.Wait -> {
                        failures = step.value.failures
                        (step.value.progress as? ProjectIntents.OptionalExternalSlicerProgress.Value)?.let { onProgress(it.value) }
                    }
                }
            }
        } catch (failure: Throwable) {
            if (!flight.cancelled) throw failure
            // The caller cancelled: confirm it, unless the job already ended
            // in a way a cancellation cannot change.
            val ended = failure is ExternalSlicerException && failure.kind != ProjectIntents.ExternalSlicerFailureKind.Failed &&
                failure.kind != ProjectIntents.ExternalSlicerFailureKind.Unconfirmed &&
                failure.kind != ProjectIntents.ExternalSlicerFailureKind.Retained
            if (ended && failure.kind != ProjectIntents.ExternalSlicerFailureKind.Cancelled) throw failure
            if (!ended) confirmCancellation(flight, endpoint, jobId, token)
            throw CancellationException("The external slice was cancelled.")
        }
    }

    /**
     * A finished job's artifact, fetched as often as the policy allows
     * (`readDownload`): a transfer that failed, or an artifact the server
     * retained, is fetched again after the poll interval, into a fresh
     * output, with the same checks; a cancel stops it where it stands.
     */
    private fun fetch(
        flight: Flight,
        endpoint: List<Int>,
        jobId: List<Int>,
        token: String?,
        engine: ProjectIntents.ExternalSlicerAttested,
        output: ExternalSlicerOutput,
    ): ExternalSliceResult {
        val artifact = jobSend(endpoint, jobId, ProjectIntents.ExternalSlicerJobStep.Artifact)
        var attempt = 1L
        while (true) {
            var judged: Judged? = null
            val outcome = try {
                val read = execute(flight, request(artifact, token)).use { download(flight, it, jobId, output) }
                judged = read
                ProjectIntents.ExternalSlicerDownloadOutcome.Artifact(read.verdict)
            } catch (aborted: Aborted) {
                throw aborted
            } catch (failure: TransferFailed) {
                ProjectIntents.ExternalSlicerDownloadOutcome.TransferFailed(units(failure.detail))
            } catch (failure: IOException) {
                ProjectIntents.ExternalSlicerDownloadOutcome.TransferFailed(units(detail(failure)))
            }
            when (val step = ExternalSlicerPolicy.download(ProjectIntents.ExternalSlicerDownloadRead(attempt, outcome))) {
                is ProjectIntents.ExternalSlicerDownloadStep.Accept -> return accept(flight, judged!!, endpoint, token, engine)
                is ProjectIntents.ExternalSlicerDownloadStep.Failed -> throw failed(step.value)
                is ProjectIntents.ExternalSlicerDownloadStep.Refetch -> {
                    flight.pause(pollIntervalMs)
                    if (flight.cancelled) throw Aborted()
                    attempt++
                }
            }
        }
    }

    /** An accepted artifact: its job released, when the transfer named one and its digest. */
    private fun accept(
        flight: Flight,
        judged: Judged,
        endpoint: List<Int>,
        token: String?,
        engine: ProjectIntents.ExternalSlicerAttested,
    ): ExternalSliceResult = when (val verdict = judged.verdict) {
        is ProjectIntents.ExternalSlicerArtifact.Failed -> throw failed(verdict.value)
        is ProjectIntents.ExternalSlicerArtifact.Accepted -> {
            val named = verdict.value.release as? ProjectIntents.OptionalText.Value
            val released = named != null && release(endpoint, named.value, token)
            if (flight.cancelled) {
                throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.AlreadyDone, "The external slice completed before cancellation.")
            }
            ExternalSliceResult(judged.length, judged.sha256, engine, released)
        }
    }

    /** Streams an artifact reply into a fresh [output] once, for the facts the
     * policy judges it by; a body that never arrives whole is [TransferFailed]. */
    private fun download(
        flight: Flight,
        response: Response,
        jobId: List<Int>?,
        output: ExternalSlicerOutput,
    ): Judged {
        val digest = MessageDigest.getInstance("SHA-256")
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        val chars = CharBuffer.allocate(CHUNK)
        var length = 0L
        var utf8 = true
        var blank = true
        var errorBody = ""
        fun judge(bytes: ByteBuffer, last: Boolean) {
            while (utf8) {
                val result = decoder.decode(bytes, chars, last)
                if (result.isError) { utf8 = false; return }
                chars.flip()
                if (blank) while (chars.hasRemaining()) if (!javascriptSpace(chars.get())) { blank = false; break }
                chars.clear()
                if (result.isUnderflow) {
                    if (last && decoder.flush(chars).isError) utf8 = false
                    return
                }
            }
        }
        try {
            if (response.isSuccessful) {
                val source = response.body!!.byteStream()
                val buffer = ByteArray(CHUNK)
                var carry = ByteBuffer.allocate(0)
                output.open().use { sink ->
                    while (true) {
                        val count = try {
                            source.read(buffer)
                        } catch (failure: IOException) {
                            if (flight.cancelled) throw Aborted()
                            throw TransferFailed(detail(failure))
                        }
                        if (count < 0) break
                        sink.write(buffer, 0, count)
                        digest.update(buffer, 0, count)
                        length += count
                        if (utf8) {
                            val input = ByteBuffer.allocate(carry.remaining() + count).put(carry).put(buffer, 0, count)
                            input.flip()
                            judge(input, false)
                            carry = input.slice()
                        }
                    }
                }
                if (utf8) {
                    judge(carry, true)
                    if (carry.hasRemaining()) utf8 = false
                }
            } else {
                // A refusal is the server's answer, never fetched again, whatever became of its body.
                errorBody = try {
                    bodyText(response)
                } catch (failure: IOException) {
                    if (flight.cancelled) throw Aborted()
                    throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, detail(failure))
                }
            }
        } catch (aborted: Aborted) {
            throw aborted
        } catch (failure: TransferFailed) {
            throw failure
        } catch (failure: IOException) {
            // The caller's own output failing is no transfer to fetch again.
            if (flight.cancelled) throw Aborted()
            throw ExternalSlicerException(ProjectIntents.ExternalSlicerFailureKind.Failed, NOT_WRITTEN)
        }
        if (flight.cancelled) throw Aborted()
        val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
        fun header(name: String) = response.headers.values(name).takeIf { it.isNotEmpty() }?.joinToString(", ")
        val facts = ProjectIntents.ExternalSlicerArtifactFacts(
            response.code.toLong(), units(errorBody), optional(header("X-OrcaXR-Job-Id")), optional(header("X-OrcaXR-Gcode-SHA256")),
            optional(header("X-OrcaXR-Gcode-Bytes")), length, units(sha256), utf8, blank,
        )
        val expected = jobId?.let { ProjectIntents.OptionalText.Value(it) } ?: ProjectIntents.OptionalText.Absent(absent)
        return Judged(ExternalSlicerPolicy.artifact(ProjectIntents.ExternalSlicerArtifactRead(expected, facts)), length, sha256)
    }

    /** Best effort within the plan's own deadline: an older or unavailable
     * server keeps the result until it expires. */
    private fun release(endpoint: List<Int>, jobId: List<Int>, token: String?): Boolean = try {
        val send = jobSend(endpoint, jobId, ProjectIntents.ExternalSlicerJobStep.Release)
        val deadline = (send.timeoutMs as? ProjectIntents.OptionalFinite.Value)?.value?.toLong()
        execute(Flight(), request(send, token), deadline).use { it.isSuccessful }
    } catch (_: Exception) {
        false
    }

    /** `confirmExternalCancellation`: the cancellation's DELETE, then status
     * polls, until the policy reads the outcome or the one deadline passes. */
    private fun confirmCancellation(flight: Flight, endpoint: List<Int>, jobId: List<Int>, token: String?) {
        flight.abortable = false
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(cancellationTimeoutMs)
        fun left() = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
        val timedOut = { ExternalSlicerPolicy.cancel(ProjectIntents.ExternalSlicerCancelRead.TimedOut(absent)) }
        var send = jobSend(endpoint, jobId, ProjectIntents.ExternalSlicerJobStep.Cancel)
        val status = jobSend(endpoint, jobId, ProjectIntents.ExternalSlicerJobStep.Status)
        while (true) {
            // Once the deadline passes, the cancellation timed out, whatever was in flight.
            val step = if (left() <= 0) {
                timedOut()
            } else {
                val reply = reply(Flight(), request(send, token), deadlineMs = left())
                if (left() <= 0) timedOut() else ExternalSlicerPolicy.cancel(ProjectIntents.ExternalSlicerCancelRead.Reply(reply))
            }
            when (step) {
                is ProjectIntents.ExternalSlicerCancelStep.Confirmed -> return
                is ProjectIntents.ExternalSlicerCancelStep.Failed -> throw failed(step.value)
                is ProjectIntents.ExternalSlicerCancelStep.Poll -> {
                    Flight().pause(minOf(pollIntervalMs, maxOf(0, left())))
                    send = status
                }
            }
        }
    }

    /** What JavaScript's `String.prototype.trim` removes. */
    private fun javascriptSpace(c: Char): Boolean = when (c.code) {
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
        else -> c.code in 0x2000..0x200A
    }

    override fun close() {
        workers.shutdownNow()
    }
}
