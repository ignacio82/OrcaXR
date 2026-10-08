package dev.orcaxr.core

/** The print job status model (`orcaxr_printer::status`), as the browser's
 * `PrintJobStatusModel` behaves: feed it the `/printer/objects/query` results
 * and `notify_status_update` params the transport received, as text. A full
 * query replaces earlier readings; patches merge field by field. Text that is
 * not JSON is refused (`invalid_json`) and changes nothing. */
class PrintJobStatus internal constructor(handle: Long) : ProjectHandle(handle) {
    constructor() : this(NativeProject.printJobStatusNew())

    fun applyQuery(text: String, nowMs: Double): ProjectIntents.PrintJobSnapshot = read {
        ProjectIntents.decodePrintJobSnapshot(NativeProject.printJobStatusQuery(it, text, nowMs))
    }
    /** Null when the patch concerns no object the model reads. */
    fun applyNotification(text: String, nowMs: Double): ProjectIntents.PrintJobSnapshot? = read {
        NativeProject.printJobStatusNotify(it, text, nowMs)?.let(ProjectIntents::decodePrintJobSnapshot)
    }
    fun reset(): ProjectIntents.PrintJobSnapshot = read {
        ProjectIntents.decodePrintJobSnapshot(NativeProject.printJobStatusReset(it))
    }
    fun snapshot(): ProjectIntents.PrintJobSnapshot = read {
        ProjectIntents.decodePrintJobSnapshot(NativeProject.printJobStatusSnapshot(it))
    }
}
