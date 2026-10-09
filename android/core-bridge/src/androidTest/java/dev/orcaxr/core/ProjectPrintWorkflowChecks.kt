package dev.orcaxr.core

/** The print submission workflow through the Kotlin wrapper: every input of
 * every browser scenario, fed in order to one [PrintWorkflow], answers the
 * browser's step or refuses with its code, and a closed workflow answers
 * nothing. */
object ProjectPrintWorkflowChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] lines: `N` opens a fresh workflow, then
     * `<run|stored|resolve|reply|cancel|dispose>\t<id>\t<argument>\t<step or !code>`.
     * Reply text travels as base64 UTF-8, so a tab or newline in it survives the line. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        var workflow: PrintWorkflow? = null
        try {
            for (line in script.split("\n")) {
                if (line == "N") {
                    workflow?.let { check(!it.busy) { "workflow_busy_$checks" }; it.close() }
                    workflow = PrintWorkflow()
                    continue
                }
                val current = checkNotNull(workflow) { "no open workflow" }
                val e = line.split("\t")
                val id = e[1].toLongOrNull() ?: 0L
                val call: () -> ProjectIntents.PrintWorkflowStep = when (e[0]) {
                    "run" -> {
                        val intent = ProjectIntents.decodePrintWorkflowIntent(e[2])
                        check(ProjectIntents.decodePrintWorkflowIntent(ProjectIntents.encodePrintWorkflowIntent(intent)) == intent) { "workflow_intent_$checks" }
                        val run = { current.run(intent) }
                        run
                    }
                    "stored" -> {
                        val path = ProjectIntents.decodePrinterText(e[2]);
                        { current.startStored(path) }
                    }
                    "resolve" -> {
                        val outcome = ProjectIntents.decodePrintWorkflowOutcome(e[2])
                        check(ProjectIntents.decodePrintWorkflowOutcome(ProjectIntents.encodePrintWorkflowOutcome(outcome)) == outcome) { "workflow_outcome_$checks" }
                        val resolve = { current.resolve(id, outcome) }
                        resolve
                    }
                    "reply" -> {
                        val text = String(java.util.Base64.getDecoder().decode(e[2]), Charsets.UTF_8);
                        { current.resolveReply(id, text) }
                    }
                    "cancel" -> { { current.cancel() } }
                    "dispose" -> { { current.dispose() } }
                    else -> error("unknown script entry ${e[0]}")
                }
                val expected = e[3]
                if (expected.startsWith("!")) {
                    check(failure { call() } == expected.substring(1)) { "workflow_refused_$checks" }
                } else {
                    // Steps carry doubles, whose Kotlin spelling differs; compare values.
                    check(call() == ProjectIntents.decodePrintWorkflowStep(expected)) { "workflow_step_$checks" }
                }
                checks++
            }
            val closed = checkNotNull(workflow)
            check(!closed.busy) { "workflow_busy_$checks" }
            closed.close()
            check(failure { closed.cancel() } == "closed") { "workflow_closed" }; checks++
        } finally {
            workflow?.close()
        }
        return checks
    }
}
