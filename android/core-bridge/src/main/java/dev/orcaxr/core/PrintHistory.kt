package dev.orcaxr.core

/** What a printer has already printed (`orcaxr_printer::history`), as the
 * browser's `PrinterHistory` answers it: the request a page or the totals
 * sends, or why it is refused before anything leaves; the result an exchange
 * that ended without a reply reads as; a reply read; and how a panel
 * describes durations, lengths, a job, the totals and a page. The host
 * carries each exchange out. A job carries the printer's own id only where it
 * is not the filename the id falls back to; [id] reads it. */
object PrintHistory {
    fun plan(operation: ProjectIntents.PrintHistoryOperation): ProjectIntents.PrintHistoryPlan =
        ProjectIntents.decodePrintHistoryPlan(NativeProject.printHistoryPlan(ProjectIntents.encodePrintHistoryOperation(operation)))
    fun finish(request: ProjectIntents.PrintHistoryFinish): ProjectIntents.PrintHistoryResult =
        ProjectIntents.decodePrintHistoryResult(NativeProject.printHistoryFinish(ProjectIntents.encodePrintHistoryFinish(request)))
    /** [reply] is Moonraker's `result`, as JSON. */
    fun read(operation: ProjectIntents.PrintHistoryOperation, reply: String): ProjectIntents.PrintHistoryResult =
        ProjectIntents.decodePrintHistoryResult(NativeProject.printHistoryRead(ProjectIntents.encodePrintHistoryOperation(operation), reply))
    fun duration(seconds: Double): ProjectIntents.OptionalText =
        ProjectIntents.decodeOptionalText(NativeProject.printHistoryDuration(seconds))
    fun filament(millimetres: Double): ProjectIntents.OptionalText =
        ProjectIntents.decodeOptionalText(NativeProject.printHistoryFilament(millimetres))
    fun jobView(job: ProjectIntents.PrintHistoryJob): ProjectIntents.PrintHistoryJobView =
        ProjectIntents.decodePrintHistoryJobView(NativeProject.printHistoryJobView(ProjectIntents.encodePrintHistoryJob(job)))
    fun totalsText(totals: ProjectIntents.OptionalPrintHistoryTotals): ProjectIntents.PrinterText =
        ProjectIntents.decodePrinterText(NativeProject.printHistoryTotalsText(ProjectIntents.encodeOptionalPrintHistoryTotals(totals)))
    fun pageView(shape: ProjectIntents.PrintHistoryPageShape): ProjectIntents.PrintHistoryPageView =
        ProjectIntents.decodePrintHistoryPageView(NativeProject.printHistoryPageView(ProjectIntents.encodePrintHistoryPageShape(shape)))

    /** A job's id (UTF-16 units): the printer's own, or its filename. */
    fun id(job: ProjectIntents.PrintHistoryJob): List<Int> = when (val id = job.jobId) {
        is ProjectIntents.OptionalPrinterReplyText.Value -> id.value
        is ProjectIntents.OptionalPrinterReplyText.Absent -> job.filename
    }
}
