package dev.orcaxr.core

/** The printer console through the Kotlin wrapper: every request of the
 * browser's corpus round-trips and answers the browser's reply. */
object ProjectPrinterConsoleChecks {
    /** [script] lines: `<section>\t<request>\t<reply>`, a read's request being
     * `<operation>\t<Moonraker result>` and a notification's
     * `<request>\t<params>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "console_${columns[0]}_$checks"
            when (columns[0]) {
                "assessments" -> {
                    val request = ProjectIntents.decodeGcodeAssessRequest(columns[1])
                    check(ProjectIntents.decodeGcodeAssessRequest(ProjectIntents.encodeGcodeAssessRequest(request)) == request) { label }
                    check(PrinterConsole.assess(request) == ProjectIntents.decodeGcodeAssessment(columns[2])) { label }
                }
                "plans" -> check(PrinterConsole.plan(ProjectIntents.decodeConsoleOperation(columns[1])) == ProjectIntents.decodeConsolePlan(columns[2])) { label }
                "finishes" -> check(PrinterConsole.finish(ProjectIntents.decodeConsoleFinish(columns[1])) == ProjectIntents.decodeConsoleResult(columns[2])) { label }
                "reads" -> {
                    val result = PrinterConsole.read(ProjectIntents.decodeConsoleOperation(columns[1]), columns[2])
                    check(result == ProjectIntents.decodeConsoleResult(columns[3])) { label }
                    check(ProjectIntents.decodeConsoleResult(ProjectIntents.encodeConsoleResult(result)) == result) { label }
                }
                "invocations" -> check(PrinterConsole.invocation(ProjectIntents.decodeMacroInvocationRequest(columns[1])) == ProjectIntents.decodeMacroInvocation(columns[2])) { label }
                "lines" -> check(PrinterConsole.line(ProjectIntents.decodeConsoleLineRequest(columns[1])) == ProjectIntents.decodeConsoleLine(columns[2])) { label }
                "notifications" -> check(PrinterConsole.notification(ProjectIntents.decodeConsoleNotificationRequest(columns[1]), columns[2]) == ProjectIntents.decodeOptionalConsoleLine(columns[3])) { label }
                "recents" -> check(PrinterConsole.recent(ProjectIntents.decodeConsoleRecentRequest(columns[1])) == ProjectIntents.decodeTextList(columns[2])) { label }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        return checks
    }
}
