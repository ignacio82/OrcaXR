package dev.orcaxr.core

/** The printer session through the Kotlin wrapper: every input of every
 * browser scenario, fed in order to one [PrinterSession], answers the
 * browser's step and view, or its reply, and a closed session answers
 * nothing. */
object ProjectPrinterSessionChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun text(base64: String) = String(java.util.Base64.getDecoder().decode(base64), Charsets.UTF_8)

    /** [script] lines: `N` opens a fresh session, then
     * `<kind>\t<number>\t<argument>\t<base64 text>\t<now>\t<expected>\t<view>`,
     * where `<expected>` is a step, a reply, `true`/`false`, or `!code`.
     * Notification methods and params and reply text travel as base64 UTF-8. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        var session: PrinterSession? = null
        try {
            for (line in script.split("\n")) {
                if (line == "N") {
                    session?.close()
                    session = PrinterSession()
                    continue
                }
                val current = checkNotNull(session) { "no open session" }
                val e = line.split("\t")
                val number = e[1].toLongOrNull() ?: 0L
                val now = e[4].toDoubleOrNull() ?: 0.0
                val expected = e[5]
                val stepping: (() -> ProjectIntents.PrinterSessionStep)? = when (e[0]) {
                    "select" -> {
                        val selection = ProjectIntents.decodePrinterSelection(e[2])
                        check(ProjectIntents.decodePrinterSelection(ProjectIntents.encodePrinterSelection(selection)) == selection) { "session_selection_$checks" }
                        val select = { current.select(selection) }
                        select
                    }
                    "clear" -> { { current.clear() } }
                    "dispose" -> { { current.dispose() } }
                    "connect" -> { { current.connect() } }
                    "refresh" -> { { current.refresh() } }
                    "execute" -> {
                        val request = ProjectIntents.decodePrintJobExecuteRequest(e[2])
                        val execute = { current.execute(request) }
                        execute
                    }
                    "state" -> {
                        val signal = ProjectIntents.decodeConnectionSignal(e[2])
                        val state = { current.transportState(number, signal) }
                        state
                    }
                    "notification" -> {
                        val method = text(e[2])
                        val params = text(e[3])
                        val notify = { current.notification(number, method, params, now) }
                        notify
                    }
                    "resolve" -> {
                        val outcome = ProjectIntents.decodePrinterSessionOutcome(e[2])
                        check(ProjectIntents.decodePrinterSessionOutcome(ProjectIntents.encodePrinterSessionOutcome(outcome)) == outcome) { "session_outcome_$checks" }
                        val resolve = { current.resolve(number, outcome) }
                        resolve
                    }
                    "reply" -> {
                        val body = text(e[3])
                        val reply = { current.resolveReply(number, body, now) }
                        reply
                    }
                    else -> null
                }
                if (stepping != null) {
                    if (expected.startsWith("!")) {
                        check(failure { stepping() } == expected.substring(1)) { "session_refused_$checks" }
                    } else {
                        // Steps and views carry doubles, whose Kotlin spelling differs; compare values.
                        check(stepping() == ProjectIntents.decodePrinterSessionStep(expected)) { "session_step_$checks" }
                        check(current.view == ProjectIntents.decodePrinterSessionView(e[6])) { "session_view_$checks" }
                    }
                } else when (e[0]) {
                    "captureIntent" -> check(current.captureIntent(e[2]) == ProjectIntents.decodePrintJobIntentReply(expected)) { "session_intent_$checks" }
                    "confirm" -> check(current.confirm(number) == ProjectIntents.decodePrintJobConfirmReply(expected)) { "session_confirm_$checks" }
                    "captureLease" -> check(current.captureLease() == ProjectIntents.decodePrinterSessionLeaseReply(expected)) { "session_lease_$checks" }
                    "leaseCurrent" -> check(current.leaseCurrent(ProjectIntents.decodePrinterSessionLease(e[2])) == expected.toBoolean()) { "session_lease_current_$checks" }
                    else -> error("unknown script entry ${e[0]}")
                }
                checks++
            }
            val closed = checkNotNull(session)
            closed.close()
            check(failure { closed.refresh() } == "closed") { "session_closed" }; checks++
        } finally {
            session?.close()
        }
        return checks
    }
}
