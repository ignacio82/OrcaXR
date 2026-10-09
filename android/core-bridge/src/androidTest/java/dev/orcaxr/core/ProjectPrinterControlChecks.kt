package dev.orcaxr.core

/** Printer control through the Kotlin wrappers: every request of the
 * browser's script round-trips and answers the browser's reply, every
 * hold-to-confirm step the browser's state, and a closed hold answers nothing. */
object ProjectPrinterControlChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** Requests carry doubles, so round trips compare values. [script] lines: `A|C|F|S|G\t<request>\t<reply>` for availability, plans,
     * failures, summaries and guarded actions; `T` opens a fresh hold, then
     * `<press|poll|cancel|release>\t<nowMs>\t<action or empty>\t<reply>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        var hold: HoldToConfirm? = null
        try {
            for (line in script.split("\n")) {
                if (line == "T") {
                    hold?.close()
                    hold = HoldToConfirm()
                    continue
                }
                val e = line.split("\t")
                when (e[0]) {
                    "A" -> {
                        val request = ProjectIntents.decodePrintJobAvailabilityRequest(e[1])
                        check(ProjectIntents.decodePrintJobAvailabilityRequest(ProjectIntents.encodePrintJobAvailabilityRequest(request)) == request) { "control_request_$checks" }
                        check(PrinterControl.availability(request) == ProjectIntents.decodePrintJobCommandDescriptors(e[2])) { "control_availability_$checks" }
                    }
                    "C" -> {
                        val request = ProjectIntents.decodePrintJobCommandCheckRequest(e[1])
                        check(ProjectIntents.decodePrintJobCommandCheckRequest(ProjectIntents.encodePrintJobCommandCheckRequest(request)) == request) { "control_request_$checks" }
                        check(PrinterControl.plan(request) == ProjectIntents.decodePrintJobCommandPlan(e[2])) { "control_plan_$checks" }
                    }
                    "F" -> check(PrinterControl.failure(ProjectIntents.decodePrintJobCommandFailureRequest(e[1])) == ProjectIntents.decodePrintJobCommandRefusal(e[2])) { "control_failure_$checks" }
                    "S" -> {
                        val request = ProjectIntents.decodePrinterStatusRequest(e[1])
                        check(ProjectIntents.decodePrinterStatusRequest(ProjectIntents.encodePrinterStatusRequest(request)) == request) { "control_request_$checks" }
                        check(PrinterControl.summary(request) == ProjectIntents.decodePrinterStatusSummary(e[2])) { "control_summary_$checks" }
                    }
                    "G" -> check(PrinterControl.guarded(ProjectIntents.decodeGuardedPrinterActionsRequest(e[1])) == ProjectIntents.decodeGuardedPrinterActions(e[2])) { "control_guarded_$checks" }
                    else -> {
                        val current = checkNotNull(hold) { "no open hold" }
                        val now = e[1].toDouble()
                        when (e[0]) {
                            "press" -> check(current.press(ProjectIntents.decodeGuardedPrinterAction(e[2]), now) == ProjectIntents.decodeHoldToConfirmState(e[3])) { "hold_press_$checks" }
                            "poll" -> check(current.poll(now) == ProjectIntents.decodeHoldToConfirmState(e[3])) { "hold_poll_$checks" }
                            "cancel" -> check(current.cancel() == ProjectIntents.decodeHoldToConfirmState(e[3])) { "hold_cancel_$checks" }
                            "release" -> check(current.release(now) == ProjectIntents.decodeHoldToConfirmRelease(e[3])) { "hold_release_$checks" }
                            else -> error("unknown script entry ${e[0]}")
                        }
                    }
                }
                checks++
            }
            val closed = checkNotNull(hold)
            closed.close()
            check(failure { closed.poll(0.0) } == "closed") { "hold_closed" }; checks++
        } finally {
            hold?.close()
        }
        return checks
    }
}
