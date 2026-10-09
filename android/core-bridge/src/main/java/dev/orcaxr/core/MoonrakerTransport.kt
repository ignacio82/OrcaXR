package dev.orcaxr.core

/** The Moonraker transport (`orcaxr_printer::transport`, the browser's
 * `MoonrakerTransport`): one printer's connection — the REST handshake, the
 * JSON-RPC socket, its heartbeat and reconnects — and every HTTP request,
 * upload, download and recovery command on it. Stepping calls answer a step
 * naming what to do (fetch, read a body as text or as bytes, open, write or
 * close a socket, arm or clear a timer, draw a random number), the tasks
 * that finished, effects to fail as aborted, and diagnostics. Answer effects
 * with [resolve] or [resolveText]; feed socket events and fired timers in as
 * they happen. A task's result text and a notification's params travel
 * beside the step: take them with [takeResult] and [takeParams]. A socket
 * blink keeps HTTP work in flight; only a session that cannot come back
 * cancels it. A refused answer throws its code:
 * `not_pending` or `mismatch`, and nothing changes. */
class MoonrakerTransport internal constructor(handle: Long) : ProjectHandle(handle) {
    /** A [config] that [configure] accepts; any other throws `invalid_request`. */
    constructor(config: ProjectIntents.MoonrakerTransportConfig) :
        this(NativeProject.moonrakerTransportNew(ProjectIntents.encodeMoonrakerTransportConfig(config)))

    companion object {
        /** What creating a transport from [config] answers: its first state,
         * or why the configuration is refused. */
        fun configure(config: ProjectIntents.MoonrakerTransportConfig): ProjectIntents.MoonrakerTransportReply =
            ProjectIntents.decodeMoonrakerTransportReply(
                NativeProject.moonrakerTransportConfigure(ProjectIntents.encodeMoonrakerTransportConfig(config)),
            )

        /** Past this many UTF-16 units, text decides every outcome by its
         * length alone, so [resolveText] and [socketMessage] pass at most one
         * unit more. */
        val maxTextUnits: Int by lazy { NativeProject.moonrakerTransportTextUnits().toInt() }

        private fun received(text: String) =
            if (text.length > maxTextUnits) text.substring(0, maxTextUnits + 1) else text
    }

    /** The JSON text of finished task [task]'s result, which travels beside
     * the step that finished it; taken once (`not_pending` after). */
    fun takeResult(task: Long): String = read { NativeProject.moonrakerTransportTakeResult(it, task) }
    /** The JSON text of notification [id]'s params, taken once. */
    fun takeParams(id: Long): String = read { NativeProject.moonrakerTransportTakeParams(it, id) }

    val state: ProjectIntents.MoonrakerConnectionState get() = read {
        ProjectIntents.decodeMoonrakerConnectionState(NativeProject.moonrakerTransportState(it))
    }
    val hasApiKey: Boolean get() = read { NativeProject.moonrakerTransportHasApiKey(it) }
    val hasBearerToken: Boolean get() = read { NativeProject.moonrakerTransportHasBearerToken(it) }

    /** Session-only credentials; the fault when they are refused (and nothing changed). */
    fun setCredentials(credentials: ProjectIntents.MoonrakerCredentials, nowMs: Double): ProjectIntents.MoonrakerTransportFault? = read {
        val refused = ProjectIntents.decodeOptionalMoonrakerTransportFault(
            NativeProject.moonrakerTransportCredentials(it, ProjectIntents.encodeMoonrakerCredentials(credentials), nowMs),
        )
        (refused as? ProjectIntents.OptionalMoonrakerTransportFault.Value)?.value
    }
    fun clearCredentials(nowMs: Double) = read { NativeProject.moonrakerTransportClearCredentials(it, nowMs) }

    /** The objects (and fields) to subscribe to now and on every socket;
     * a refused subscription keeps the one before it. */
    fun setSubscription(entries: List<ProjectIntents.MoonrakerSubscriptionEntry>, nowMs: Double): ProjectIntents.MoonrakerTransportStepReply = read {
        ProjectIntents.decodeMoonrakerTransportStepReply(
            NativeProject.moonrakerTransportSubscription(it, ProjectIntents.encodeMoonrakerObjectSubscription(entries), nowMs),
        )
    }
    fun clearSubscription(nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportClearSubscription(it, nowMs))
    }

    /** [signal] `Live` lets the caller [abort] the connect later. */
    fun connect(signal: ProjectIntents.MoonrakerSignal, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportConnect(it, signal.name.lowercase(), nowMs))
    }
    /** [reason] is `User`, `Cancelled` or `Disposed`. */
    fun disconnect(reason: ProjectIntents.MoonrakerDisconnectReason, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportDisconnect(it, reason.name.lowercase(), nowMs))
    }
    fun dispose(nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportDispose(it, nowMs))
    }
    fun request(request: ProjectIntents.MoonrakerRequest, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportRequest(it, ProjectIntents.encodeMoonrakerRequest(request), nowMs))
    }
    /** A POST whose body is the host's file; the reply may be bare. */
    fun upload(request: ProjectIntents.MoonrakerRequest, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportUpload(it, ProjectIntents.encodeMoonrakerRequest(request), nowMs))
    }
    /** A file read as bytes; the task finishes with its length. */
    fun download(request: ProjectIntents.MoonrakerRequest, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportDownload(it, ProjectIntents.encodeMoonrakerRequest(request), nowMs))
    }
    /** An emergency stop or firmware restart: it reaches HTTP even when the handshake or socket failed. */
    fun recovery(request: ProjectIntents.MoonrakerRecoveryRequest, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportRecovery(it, ProjectIntents.encodeMoonrakerRecoveryRequest(request), nowMs))
    }
    /** The caller's live signal for task [task] aborts. */
    fun abort(task: Long, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportAbort(it, task, nowMs))
    }
    fun resolve(id: Long, outcome: ProjectIntents.MoonrakerTransportOutcome, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportResolve(it, id, ProjectIntents.encodeMoonrakerTransportOutcome(outcome), nowMs))
    }
    /** A body read as text, answering effect [id]. */
    fun resolveText(id: Long, text: String, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportText(it, id, received(text), nowMs))
    }
    fun socketOpen(socket: Long, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportSocketOpen(it, socket, nowMs))
    }
    fun socketError(socket: Long, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportSocketError(it, socket, nowMs))
    }
    fun socketClose(socket: Long, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportSocketClose(it, socket, nowMs))
    }
    /** A text frame socket [socket] received. */
    fun socketMessage(socket: Long, text: String, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportSocketMessage(it, socket, received(text), nowMs))
    }
    /** Timer [timer] fired. */
    fun timer(timer: Long, nowMs: Double): ProjectIntents.MoonrakerTransportStep = read {
        step(NativeProject.moonrakerTransportTimer(it, timer, nowMs))
    }

    private fun step(json: String) = ProjectIntents.decodeMoonrakerTransportStep(json)
}
