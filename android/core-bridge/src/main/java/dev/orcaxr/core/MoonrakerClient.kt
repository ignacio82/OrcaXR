package dev.orcaxr.core

import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers.Companion.headersOf
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/** Why a Moonraker call failed: the transport's fault — code, operation, status and the server's detail. */
class MoonrakerException(val fault: ProjectIntents.MoonrakerTransportFault) :
    Exception("${fault.code.name}: ${text(fault.operation)}")

/** A call in flight: its result, and [cancel], which aborts it as the caller's signal would. */
class MoonrakerCall<T> internal constructor(
    val result: CompletableFuture<T>,
    private val onCancel: () -> Unit,
) {
    fun cancel() = onCancel()
}

/** A multipart upload: its form fields, in order, then the file. */
class MoonrakerUpload(
    val fields: List<Pair<String, String>>,
    val filename: String,
    val bytes: ByteArray,
    val contentType: String = "text/plain",
)

/** How a request is sent; the core decides what each choice means. */
data class MoonrakerRequestOptions(
    val method: String? = null,
    val operation: String? = null,
    /** `null` is the transport's own deadline; [MoonrakerClient.UNBOUNDED] none at all. */
    val timeoutMs: Double? = null,
    val headers: List<Pair<String, String>> = emptyList(),
    val acceptBareEnvelope: Boolean = false,
)

/** A JSON-RPC notification the socket received: its method and params, as JSON text. */
data class MoonrakerClientNotification(
    val method: String,
    val params: String,
    val receivedAtMs: Double,
    val generation: Long,
    val socketEpoch: Long,
)

private fun text(units: List<Int>): String = String(CharArray(units.size) { units[it].toChar() })
private fun units(text: String): List<Int> = text.map { it.code }
private val EMPTY = ProjectIntents.Empty
private fun optionalText(value: String?): ProjectIntents.OptionalText =
    if (value == null) ProjectIntents.OptionalText.Absent(EMPTY) else ProjectIntents.OptionalText.Value(units(value))

/**
 * A Moonraker connection on Android: the shared core's transport machine
 * (`orcaxr_printer::transport`, the policy the browser runs) driven over
 * OkHttp. The core decides everything — handshake, socket, heartbeat,
 * reconnects, deadlines, bounds, refusals — and this class carries out what it
 * asks: HTTP exchanges, body reads, a WebSocket, timers and random draws.
 *
 * Every call into the core runs on one thread, and steps apply in the order
 * the core produced them; an effect the core asks for synchronously (a
 * socket's construction, a random draw) is answered at once. Listeners run on
 * that thread too. OkHttp follows no redirect (a redirect fails the exchange,
 * as `fetch` with `redirect: "error"` does), retries nothing and keeps no
 * deadline of its own: the core keeps every one. Plain HTTP reaches only a
 * local address ([LanTransportPolicy]).
 */
class MoonrakerClient(
    config: ProjectIntents.MoonrakerTransportConfig,
    http: OkHttpClient = OkHttpClient(),
    private val clock: () -> Double = { System.currentTimeMillis().toDouble() },
    private val random: () -> Double = { secure.nextDouble() },
    private val logger: ((ProjectIntents.MoonrakerLog) -> Unit)? = null,
) : AutoCloseable {
    companion object {
        /** A request deadline of none at all, for a transfer the operator can stop. */
        const val UNBOUNDED = Double.POSITIVE_INFINITY

        /** The core refuses a download past this many bytes; reading stops one byte later. */
        const val MAX_DOWNLOAD_BYTES = 256L * 1024 * 1024

        private val secure = SecureRandom()
    }

    private val http: OkHttpClient = http.newBuilder()
        // Plain HTTP only to a local address, judged where the connection landed.
        .addNetworkInterceptor(LanTransportPolicy.cleartextGuard)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(0, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val textBound = MoonrakerTransport.maxTextUnits
    private val transport = MoonrakerTransport(config)
    @Volatile private var thread: Thread? = null
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "moonraker-client").also {
            it.isDaemon = true
            thread = it
        }
    }
    private val reading: ExecutorService = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "moonraker-body").also { it.isDaemon = true }
    }

    // Everything below is touched on the client's thread only.
    private var current: ProjectIntents.MoonrakerConnectionState = transport.state
    private val stateListeners = LinkedHashSet<(ProjectIntents.MoonrakerConnectionState) -> Unit>()
    private val notificationListeners = LinkedHashSet<(MoonrakerClientNotification) -> Unit>()
    private val tasks = HashMap<Long, (ProjectIntents.MoonrakerTaskResult) -> Unit>()
    private val hints = HashMap<Long, Pair<Long, MoonrakerUpload?>>()
    private val calls = HashMap<Long, Exchange>()
    private val reads = HashMap<Long, Long>()
    private val downloads = HashMap<Long, ByteArray>()
    private val sockets = HashMap<Long, WebSocket>()
    private val timers = HashMap<Long, ScheduledFuture<*>>()
    private val queue = ArrayDeque<ProjectIntents.MoonrakerTransportStep>()
    private var draining = false
    private var closed = false

    private class Exchange(val task: Long?, val call: Call) {
        var response: Response? = null
        var abandoned = false
    }

    /** Runs [work] on the client's thread: at once when already there. */
    private fun <T> onThread(work: () -> T): T =
        if (Thread.currentThread() === thread) work() else executor.submit<T> { work() }.get()

    /** Runs [work] later on the client's thread; nothing runs once the client is closed. */
    private fun post(work: () -> Unit) {
        try {
            executor.execute { if (!closed) work() }
        } catch (rejected: java.util.concurrent.RejectedExecutionException) {
            // Closed: late network and timer events are dropped.
        }
    }

    val state: ProjectIntents.MoonrakerConnectionState get() = onThread { current }

    /** The listener hears the current state now and every later one, on the client's thread. */
    fun subscribeState(listener: (ProjectIntents.MoonrakerConnectionState) -> Unit): AutoCloseable = onThread {
        stateListeners.add(listener)
        listener(current)
        AutoCloseable { onThread { stateListeners.remove(listener) } }
    }

    fun subscribeNotifications(listener: (MoonrakerClientNotification) -> Unit): AutoCloseable = onThread {
        notificationListeners.add(listener)
        AutoCloseable { onThread { notificationListeners.remove(listener) } }
    }

    /** Session-only credentials; the fault when they are refused (nothing changed). */
    fun setCredentials(apiKey: String? = null, bearerToken: String? = null): ProjectIntents.MoonrakerTransportFault? =
        onThread {
            transport.setCredentials(ProjectIntents.MoonrakerCredentials(optionalText(apiKey), optionalText(bearerToken)), clock())
        }

    fun clearCredentials() = onThread { transport.clearCredentials(clock()) }

    /** The objects (and fields, or all with `null`) to subscribe to; the fault when refused. */
    fun setSubscription(objects: List<Pair<String, List<String>?>>?): ProjectIntents.MoonrakerTransportFault? = onThread {
        if (objects == null) {
            apply(transport.clearSubscription(clock()))
            null
        } else {
            val entries = objects.map { (name, fields) ->
                ProjectIntents.MoonrakerSubscriptionEntry(
                    units(name),
                    if (fields == null) ProjectIntents.OptionalTextList.Absent(EMPTY)
                    else ProjectIntents.OptionalTextList.Value(fields.map(::units)),
                )
            }
            when (val reply = transport.setSubscription(entries, clock())) {
                is ProjectIntents.MoonrakerTransportStepReply.Step -> {
                    apply(reply.value)
                    null
                }
                is ProjectIntents.MoonrakerTransportStepReply.Refused -> reply.value
            }
        }
    }

    fun connect(): MoonrakerCall<ProjectIntents.MoonrakerHandshake> =
        start({ transport.connect(ProjectIntents.MoonrakerSignal.Live, clock()) }) { _, result ->
            (result as ProjectIntents.MoonrakerTaskResult.Handshake).value
        }

    fun disconnect(reason: ProjectIntents.MoonrakerDisconnectReason = ProjectIntents.MoonrakerDisconnectReason.User) =
        onThread { apply(transport.disconnect(reason, clock())) }

    /** Moonraker's `result`, as JSON text. */
    fun request(path: String, options: MoonrakerRequestOptions = MoonrakerRequestOptions()): MoonrakerCall<String> =
        start({ transport.request(requestOf(path, options), clock()) }) { task, _ -> transport.takeResult(task) }

    /** A multipart POST whose reply may be bare; Moonraker's answer as JSON text. */
    fun upload(path: String, upload: MoonrakerUpload, options: MoonrakerRequestOptions = MoonrakerRequestOptions()): MoonrakerCall<String> =
        start({ transport.upload(requestOf(path, options), clock()) }, upload) { task, _ -> transport.takeResult(task) }

    /** The file's bytes, at most [MAX_DOWNLOAD_BYTES]. */
    fun download(path: String, options: MoonrakerRequestOptions = MoonrakerRequestOptions()): MoonrakerCall<ByteArray> =
        start({ transport.download(requestOf(path, options), clock()) }) { task, _ -> downloads.remove(task) ?: ByteArray(0) }

    /** `emergency-stop` or `firmware-restart`: reaches HTTP even when the handshake or socket failed. */
    fun recovery(command: String): MoonrakerCall<String> = start({
        transport.recovery(ProjectIntents.MoonrakerRecoveryRequest(units(command), ProjectIntents.MoonrakerSignal.Live), clock())
    }) { task, _ -> transport.takeResult(task) }

    /** Disposes the transport, abandoning everything in flight, and stops the client's threads. */
    override fun close() {
        onThread {
            if (!closed) {
                apply(transport.dispose(clock()))
                closed = true
                for (socket in sockets.values) socket.cancel()
                sockets.clear()
                for (timer in timers.values) timer.cancel(false)
                timers.clear()
            }
        }
        executor.shutdown()
        reading.shutdown()
        transport.close()
    }

    // --- Tasks --------------------------------------------------------------------------------

    private fun requestOf(path: String, options: MoonrakerRequestOptions) = ProjectIntents.MoonrakerRequest(
        units(path),
        ProjectIntents.MoonrakerRequestOptions(
            optionalText(options.method),
            optionalText(options.operation),
            when (val ms = options.timeoutMs) {
                null -> ProjectIntents.MoonrakerDeadline.Default(EMPTY)
                UNBOUNDED -> ProjectIntents.MoonrakerDeadline.Unbounded(EMPTY)
                // A deadline that is not a finite number is refused as one out of range.
                else -> ProjectIntents.MoonrakerDeadline.Ms(if (ms.isFinite()) ms else -1.0)
            },
            options.headers.map { (name, value) -> ProjectIntents.MoonrakerHeader(units(name), units(value)) },
            options.acceptBareEnvelope,
            ProjectIntents.MoonrakerSignal.Live,
        ),
    )

    /** A call that starts a task: its future completes when the task finishes. */
    private fun <T> start(
        call: () -> ProjectIntents.MoonrakerTransportStep,
        upload: MoonrakerUpload? = null,
        read: (task: Long, result: ProjectIntents.MoonrakerTaskResult) -> T,
    ): MoonrakerCall<T> {
        val future = CompletableFuture<T>()
        var started: Long? = null
        if (executor.isShutdown) future.completeExceptionally(IllegalStateException("closed"))
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
                future.completeExceptionally(IllegalStateException("The transport started no task."))
                return@post
            }
            started = task
            tasks[task] = { result ->
                if (result is ProjectIntents.MoonrakerTaskResult.Refused) future.completeExceptionally(MoonrakerException(result.value))
                else runCatching { read(task, result) }.fold(future::complete, future::completeExceptionally)
            }
            // The fetch a request, upload or download issues is in the step that started it.
            for (output in step.outputs) {
                if (output is ProjectIntents.MoonrakerTransportOutput.Fetch) {
                    val withBody = output.value.body == ProjectIntents.MoonrakerRequestBody.Upload
                    hints[output.value.id] = task to (if (withBody) upload else null)
                }
            }
            apply(step)
        }
        return MoonrakerCall(future) { post { started?.let { input { transport.abort(it, clock()) } } } }
    }

    // --- Steps --------------------------------------------------------------------------------

    /** An event from outside; an answer the core no longer awaits changes nothing. */
    private fun input(call: () -> ProjectIntents.MoonrakerTransportStep) {
        val step = try {
            call()
        } catch (failure: RuntimeException) {
            if (failure.message == "not_pending" || failure.message == "mismatch") return
            throw failure
        }
        apply(step)
    }

    private fun apply(step: ProjectIntents.MoonrakerTransportStep) {
        queue.addLast(step)
        if (draining) return
        draining = true
        try {
            while (true) run(queue.removeFirstOrNull() ?: break)
        } finally {
            draining = false
        }
    }

    private fun run(step: ProjectIntents.MoonrakerTransportStep) {
        val notify = ArrayList<() -> Unit>()
        for (output in step.outputs) {
            when (output) {
                is ProjectIntents.MoonrakerTransportOutput.Fetch -> issue(output.value)
                is ProjectIntents.MoonrakerTransportOutput.ReadBody -> read(output.value)
                is ProjectIntents.MoonrakerTransportOutput.OpenSocket -> queue.addLast(openSocket(output.value))
                is ProjectIntents.MoonrakerTransportOutput.Random ->
                    queue.addLast(transport.resolve(output.value.id, ProjectIntents.MoonrakerTransportOutcome.Random(random()), clock()))
                is ProjectIntents.MoonrakerTransportOutput.SocketSend -> send(output.value.socket, text(output.value.text))
                is ProjectIntents.MoonrakerTransportOutput.SocketClose -> {
                    val socket = sockets.remove(output.value.socket)
                    runCatching { socket?.close(output.value.code.toInt(), text(output.value.reason)) }
                }
                is ProjectIntents.MoonrakerTransportOutput.SetTimer -> setTimer(output.value.timer, output.value.delayMs)
                is ProjectIntents.MoonrakerTransportOutput.State -> {
                    val state = output.value
                    notify += {
                        current = state
                        for (listener in stateListeners.toList()) runCatching { listener(state) }
                    }
                }
                is ProjectIntents.MoonrakerTransportOutput.Notification -> {
                    val wire = output.value
                    val notification = MoonrakerClientNotification(
                        text(wire.method), transport.takeParams(wire.id), wire.receivedAtMs, wire.generation, wire.socketEpoch,
                    )
                    notify += { for (listener in notificationListeners.toList()) runCatching { listener(notification) } }
                }
            }
        }
        for (timer in step.cleared) timers.remove(timer)?.cancel(false)
        for (id in step.aborted) abandon(id)
        for (run in notify) run()
        for (log in step.logs) logger?.let { runCatching { it(log) } }
        for (finished in step.finished) {
            calls.values.removeAll { it.task == finished.task }
            tasks.remove(finished.task)?.invoke(finished.result)
        }
    }

    private fun issue(fetch: ProjectIntents.MoonrakerFetch) {
        val (task, upload) = hints.remove(fetch.id) ?: (null to null)
        val method = text(fetch.method)
        val body: RequestBody? = when {
            upload != null -> MultipartBody.Builder().setType(MultipartBody.FORM).apply {
                for ((name, value) in upload.fields) addFormDataPart(name, value)
                addFormDataPart("file", upload.filename, upload.bytes.toRequestBody(upload.contentType.toMediaType()))
            }.build()
            method == "GET" || method == "HEAD" -> null
            else -> ByteArray(0).toRequestBody(null)
        }
        val headers = headersOf(*fetch.headers.flatMap { listOf(text(it.name), text(it.value)) }.toTypedArray())
        val call = try {
            http.newCall(Request.Builder().url(text(fetch.url)).method(method, body).headers(headers).build())
        } catch (failure: IllegalArgumentException) {
            queue.addLast(transport.resolve(fetch.id, ProjectIntents.MoonrakerTransportOutcome.Failed(EMPTY), clock()))
            return
        }
        val exchange = Exchange(task, call)
        calls[fetch.id] = exchange
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = post {
                if (!exchange.abandoned) input { transport.resolve(fetch.id, ProjectIntents.MoonrakerTransportOutcome.Failed(EMPTY), clock()) }
            }
            override fun onResponse(call: Call, response: Response) = post {
                if (exchange.abandoned) {
                    response.close()
                    return@post
                }
                // `fetch` with `redirect: "error"` fails on a redirect rather than returning it.
                if (response.isRedirect) {
                    response.close()
                    input { transport.resolve(fetch.id, ProjectIntents.MoonrakerTransportOutcome.Failed(EMPTY), clock()) }
                    return@post
                }
                exchange.response = response
                val outcome = ProjectIntents.MoonrakerTransportOutcome.Headers(
                    ProjectIntents.MoonrakerResponseHeaders(response.code.toDouble(), optionalText(response.header("Content-Length"))),
                )
                input { transport.resolve(fetch.id, outcome, clock()) }
            }
        })
    }

    private fun read(body: ProjectIntents.MoonrakerReadBody) {
        val exchange = calls[body.fetch]
        val response = exchange?.response
        if (response == null) {
            queue.addLast(transport.resolve(body.id, ProjectIntents.MoonrakerTransportOutcome.Failed(EMPTY), clock()))
            return
        }
        reads[body.id] = body.fetch
        val done = { answer: () -> ProjectIntents.MoonrakerTransportStep ->
            post { if (reads.remove(body.id) != null) input(answer) }
        }
        reading.execute {
            try {
                response.use {
                    val source = it.body!!.source()
                    if (body.kind == ProjectIntents.MoonrakerBodyKind.Text) {
                        // Decoded as UTF-8, as `Response.text()` does, and only as far as decides any outcome.
                        source.request(3L * (textBound + 2))
                        val bytes = source.buffer.readByteArray(minOf(source.buffer.size, 3L * (textBound + 2)))
                        var text = String(bytes, Charsets.UTF_8).removePrefix("﻿")
                        if (text.length > textBound) text = text.substring(0, textBound + 1)
                        done { transport.resolveText(body.id, text, clock()) }
                    } else {
                        source.request(MAX_DOWNLOAD_BYTES + 1)
                        val length = minOf(source.buffer.size, MAX_DOWNLOAD_BYTES + 1)
                        val bytes = source.buffer.readByteArray(length)
                        done {
                            if (exchange.task != null) downloads[exchange.task] = bytes
                            transport.resolve(body.id, ProjectIntents.MoonrakerTransportOutcome.Bytes(bytes.size.toLong()), clock())
                        }
                    }
                }
            } catch (failure: IOException) {
                done { transport.resolve(body.id, ProjectIntents.MoonrakerTransportOutcome.Failed(EMPTY), clock()) }
            }
        }
    }

    /** The core gave up on effect [id]: stop it and never answer it. */
    private fun abandon(id: Long) {
        calls.remove(id)?.let {
            it.abandoned = true
            it.call.cancel()
            return
        }
        reads.remove(id)?.let { fetch -> calls[fetch]?.call?.cancel() }
    }

    private fun openSocket(open: ProjectIntents.MoonrakerSocketOpen): ProjectIntents.MoonrakerTransportStep {
        val id = open.id
        val socket = try {
            http.newWebSocket(Request.Builder().url(text(open.url)).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = post { input { transport.socketOpen(id, clock()) } }
                override fun onMessage(webSocket: WebSocket, text: String) = post { message(id, text) }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = post { message(id, bytes.utf8()) }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // Answer the peer's close; a code it may not send back is answered as normal.
                    runCatching { webSocket.close(code, null) }.onFailure { webSocket.close(1000, null) }
                    post { closed(id) }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = post { closed(id) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = post {
                    if (sockets.remove(id) != null) input { transport.socketError(id, clock()) }
                }
            })
        } catch (failure: IllegalArgumentException) {
            return transport.resolve(id, ProjectIntents.MoonrakerTransportOutcome.Broken(EMPTY), clock())
        }
        sockets[id] = socket
        return transport.resolve(id, ProjectIntents.MoonrakerTransportOutcome.Created(EMPTY), clock())
    }

    private fun message(id: Long, frame: String) {
        if (!sockets.containsKey(id)) return
        val bounded = if (frame.length > textBound) frame.substring(0, textBound + 1) else frame
        input { transport.socketMessage(id, bounded, clock()) }
    }

    private fun closed(id: Long) {
        if (sockets.remove(id) != null) input { transport.socketClose(id, clock()) }
    }

    private fun send(id: Long, frame: String) {
        val socket = sockets[id]
        // A socket that cannot send is lost; the core hears it after this step.
        if (socket == null || !socket.send(frame)) post { if (sockets.remove(id) != null) input { transport.socketError(id, clock()) } }
    }

    private fun setTimer(id: Long, delayMs: Double) {
        timers[id] = executor.schedule({
            if (timers.remove(id) != null) input { transport.timer(id, clock()) }
        }, (delayMs * 1000).toLong(), TimeUnit.MICROSECONDS)
    }
}
