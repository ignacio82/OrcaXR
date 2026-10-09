package dev.orcaxr.core

/** Print history through the Kotlin wrapper: every request of the browser's
 * corpus round-trips and answers the browser's reply. */
object ProjectPrintHistoryChecks {
    /** [script] lines: `<section>\t<request>\t<reply>`, a read's request being
     * `<operation>\t<Moonraker result>` and its reply followed by the ids the
     * browser gave its jobs (units `,` per id `;`), and a duration's or
     * length's request its number. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "history_${columns[0]}_$checks"
            when (columns[0]) {
                "plans" -> {
                    val operation = ProjectIntents.decodePrintHistoryOperation(columns[1])
                    check(ProjectIntents.decodePrintHistoryOperation(ProjectIntents.encodePrintHistoryOperation(operation)) == operation) { label }
                    check(PrintHistory.plan(operation) == ProjectIntents.decodePrintHistoryPlan(columns[2])) { label }
                }
                "finishes" -> check(PrintHistory.finish(ProjectIntents.decodePrintHistoryFinish(columns[1])) == ProjectIntents.decodePrintHistoryResult(columns[2])) { label }
                "reads" -> {
                    val result = PrintHistory.read(ProjectIntents.decodePrintHistoryOperation(columns[1]), columns[2])
                    check(result == ProjectIntents.decodePrintHistoryResult(columns[3])) { label }
                    check(ProjectIntents.decodePrintHistoryResult(ProjectIntents.encodePrintHistoryResult(result)) == result) { label }
                    val jobs = (result as? ProjectIntents.PrintHistoryResult.Page)?.value?.jobs.orEmpty()
                    check(jobs.joinToString(";") { PrintHistory.id(it).joinToString(",") } == columns[4]) { label }
                }
                "durations" -> check(PrintHistory.duration(columns[1].toDouble()) == ProjectIntents.decodeOptionalText(columns[2])) { label }
                "filaments" -> check(PrintHistory.filament(columns[1].toDouble()) == ProjectIntents.decodeOptionalText(columns[2])) { label }
                "jobViews" -> check(PrintHistory.jobView(ProjectIntents.decodePrintHistoryJob(columns[1])) == ProjectIntents.decodePrintHistoryJobView(columns[2])) { label }
                "totalsTexts" -> check(PrintHistory.totalsText(ProjectIntents.decodeOptionalPrintHistoryTotals(columns[1])) == ProjectIntents.decodePrinterText(columns[2])) { label }
                "pageViews" -> check(PrintHistory.pageView(ProjectIntents.decodePrintHistoryPageShape(columns[1])) == ProjectIntents.decodePrintHistoryPageView(columns[2])) { label }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        return checks
    }
}
