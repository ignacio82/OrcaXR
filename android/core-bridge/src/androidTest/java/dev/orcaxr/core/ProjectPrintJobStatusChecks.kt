package dev.orcaxr.core

/** The print job status model through the Kotlin wrapper: every step of the
 * browser's traces answers the browser's reply (a snapshot, an ignored patch
 * or a refusal) and leaves the browser's snapshot, and a closed model answers
 * nothing. */
object ProjectPrintJobStatusChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] lines: `T` opens a fresh model; otherwise
     * `<op>\t<nowMs>\t<text>\t<S|I|R>\t<snapshot or refusal>\t<snapshot after>`
     * with op `Q` (query), `N` (notification) or `X` (reset). */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        var model: PrintJobStatus? = null
        try {
            for (line in script.split("\n")) {
                if (line == "T") {
                    model?.close()
                    model = PrintJobStatus()
                    continue
                }
                val e = line.split("\t")
                val current = checkNotNull(model) { "no open model" }
                val now = e[1].toDouble()
                if (e[0] == "X") {
                    check(current.reset() == ProjectIntents.decodePrintJobSnapshot(e[4])) { "status_reset_$checks" }
                } else {
                    val reply = runCatching {
                        if (e[0] == "Q") current.applyQuery(e[2], now) else current.applyNotification(e[2], now)
                    }
                    when (e[3]) {
                        "S" -> check(reply.getOrThrow() == ProjectIntents.decodePrintJobSnapshot(e[4])) { "status_reply_$checks" }
                        "I" -> check(reply.getOrThrow() == null) { "status_ignored_$checks" }
                        "R" -> check(reply.exceptionOrNull()?.message == e[4]) { "status_refusal_$checks" }
                        else -> error("unknown expectation ${e[3]}")
                    }
                }
                checks++
                check(current.snapshot() == ProjectIntents.decodePrintJobSnapshot(e[5])) { "status_after_$checks" }; checks++
            }
            val closed = checkNotNull(model)
            closed.close()
            check(failure { closed.snapshot() } == "closed") { "status_closed" }; checks++
        } finally {
            model?.close()
        }
        return checks
    }
}
