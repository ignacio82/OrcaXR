package dev.orcaxr.core

/** The Moonraker transport through the Kotlin wrapper: every input of every
 * browser scenario, fed in order to one [MoonrakerTransport], answers the
 * browser's step and state, or its reply, and a closed transport answers
 * nothing. */
object ProjectMoonrakerTransportChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun text(base64: String) = String(java.util.Base64.getDecoder().decode(base64), Charsets.UTF_8)

    /** [script] lines: `<kind>\t<number>\t<argument>\t<base64 text>\t<now>\t<expected>\t<state>`.
     * A `create` opens a fresh transport; `<expected>` is a reply, a step, a
     * subscription reply, an optional fault, or `!code`; `<state>` is the
     * connection state, or `<hasApiKey>,<hasBearerToken>` after credentials.
     * Two more columns list the texts the step leaves beside it: results as
     * `<task>:<base64>` and params as `<base64>`, comma-separated. Body and
     * frame text travels as base64 UTF-8. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        var transport: MoonrakerTransport? = null
        try {
            for (line in script.split("\n")) {
                val e = line.split("\t")
                val number = e[1].toLongOrNull() ?: 0L
                val now = e[4].toDouble()
                val expected = e[5]
                val label = "transport_${e[0]}_$checks"
                if (e[0] == "create") {
                    transport?.close()
                    transport = null
                    val config = ProjectIntents.decodeMoonrakerTransportConfig(e[2])
                    check(ProjectIntents.decodeMoonrakerTransportConfig(ProjectIntents.encodeMoonrakerTransportConfig(config)) == config) { label }
                    val reply = MoonrakerTransport.configure(config)
                    check(reply == ProjectIntents.decodeMoonrakerTransportReply(expected)) { label }
                    if (reply is ProjectIntents.MoonrakerTransportReply.State) {
                        transport = MoonrakerTransport(config)
                        check(transport.state == reply.value) { label }
                    } else {
                        check(failure { MoonrakerTransport(config).close() } == "invalid_request") { label }
                    }
                    checks++
                    continue
                }
                val current = checkNotNull(transport) { "no open transport" }
                when (e[0]) {
                    "credentials", "clearCredentials" -> {
                        if (e[0] == "credentials") {
                            val refused = current.setCredentials(ProjectIntents.decodeMoonrakerCredentials(e[2]), now)
                            check(refused == expected.takeIf { it.isNotEmpty() }?.let(ProjectIntents::decodeMoonrakerTransportFault)) { label }
                        } else {
                            current.clearCredentials(now)
                        }
                        check("${current.hasApiKey},${current.hasBearerToken}" == e[6]) { label }
                        checks++
                        continue
                    }
                    "subscription" -> if (e[2] != "null") {
                        val entries = ProjectIntents.decodeMoonrakerObjectSubscription(e[2])
                        check(current.setSubscription(entries, now) == ProjectIntents.decodeMoonrakerTransportStepReply(expected)) { label }
                        if (e[6].isNotEmpty()) check(current.state == ProjectIntents.decodeMoonrakerConnectionState(e[6])) { label }
                        checks++
                        continue
                    }
                }
                val stepping: () -> ProjectIntents.MoonrakerTransportStep = when (e[0]) {
                    "subscription" -> { { current.clearSubscription(now) } }
                    "connect" -> {
                        val signal = ProjectIntents.MoonrakerSignal.values().single { it.name.lowercase() == e[2] }
                        val connect = { current.connect(signal, now) }
                        connect
                    }
                    "disconnect" -> {
                        val reason = ProjectIntents.MoonrakerDisconnectReason.values().single { it.name.lowercase() == e[2] }
                        val disconnect = { current.disconnect(reason, now) }
                        disconnect
                    }
                    "dispose" -> { { current.dispose(now) } }
                    "request", "upload", "download" -> {
                        val request = ProjectIntents.decodeMoonrakerRequest(e[2])
                        check(ProjectIntents.decodeMoonrakerRequest(ProjectIntents.encodeMoonrakerRequest(request)) == request) { label }
                        val send = when (e[0]) {
                            "request" -> { { current.request(request, now) } }
                            "upload" -> { { current.upload(request, now) } }
                            else -> { { current.download(request, now) } }
                        }
                        send
                    }
                    "recovery" -> {
                        val request = ProjectIntents.decodeMoonrakerRecoveryRequest(e[2])
                        val recovery = { current.recovery(request, now) }
                        recovery
                    }
                    "abort" -> { { current.abort(number, now) } }
                    "resolve" -> {
                        val outcome = ProjectIntents.decodeMoonrakerTransportOutcome(e[2])
                        check(ProjectIntents.decodeMoonrakerTransportOutcome(ProjectIntents.encodeMoonrakerTransportOutcome(outcome)) == outcome) { label }
                        val resolve = { current.resolve(number, outcome, now) }
                        resolve
                    }
                    "text" -> {
                        val body = text(e[3])
                        val answer = { current.resolveText(number, body, now) }
                        answer
                    }
                    "socketOpen" -> { { current.socketOpen(number, now) } }
                    "socketError" -> { { current.socketError(number, now) } }
                    "socketClose" -> { { current.socketClose(number, now) } }
                    "socketMessage" -> {
                        val frame = text(e[3])
                        val message = { current.socketMessage(number, frame, now) }
                        message
                    }
                    "timer" -> { { current.timer(number, now) } }
                    else -> error("unknown script entry ${e[0]}")
                }
                if (expected.startsWith("!")) {
                    check(failure { stepping() } == expected.substring(1)) { label }
                } else {
                    // Steps carry doubles, whose Kotlin spelling differs; compare values.
                    val step = stepping()
                    check(step == ProjectIntents.decodeMoonrakerTransportStep(expected)) { label }
                    check(current.state == ProjectIntents.decodeMoonrakerConnectionState(e[6])) { label }
                    // Result and params texts travel beside the step, each taken once.
                    val results = step.finished.mapNotNull { finished ->
                        (finished.result as? ProjectIntents.MoonrakerTaskResult.Result)?.let {
                            val text = current.takeResult(finished.task)
                            check(text.length.toLong() == it.value.units) { label }
                            check(failure { current.takeResult(finished.task) } == "not_pending") { label }
                            finished.task to text
                        }
                    }
                    val params = step.outputs.mapNotNull { output ->
                        (output as? ProjectIntents.MoonrakerTransportOutput.Notification)?.let { current.takeParams(it.value.id) }
                    }
                    val listed = { column: Int -> e.getOrElse(column) { "" }.split(",").filter { it.isNotEmpty() } }
                    check(results == listed(7).map { val (task, body) = it.split(":"); task.toLong() to text(body) }) { label }
                    check(params == listed(8).map(::text)) { label }
                }
                checks++
            }
            val closed = checkNotNull(transport)
            closed.close()
            check(failure { closed.dispose(0.0) } == "closed") { "transport_closed" }; checks++
        } finally {
            transport?.close()
        }
        return checks
    }
}
