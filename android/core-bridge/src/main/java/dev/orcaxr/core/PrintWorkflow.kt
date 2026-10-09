package dev.orcaxr.core

/** The print submission workflow (`orcaxr_printer::workflow`, the browser's
 * `PrintWorkflowController`): one send or stored reprint at a time, shared by
 * every surface. Each call answers a step naming the effects to carry out —
 * capture the session, ask whether it or the artifact is still current, send
 * a request or the upload, draw random bytes, ask the operator — which the
 * host answers by id with [resolve] or [resolveReply]. On [cancel], fail the
 * operation's requests and upload in flight as `cancelled`; a `reconcile`
 * query is not the operation's and keeps its own deadline. A refused call
 * throws its code: `unavailable`, `not_pending` or `mismatch`. */
class PrintWorkflow internal constructor(handle: Long) : ProjectHandle(handle) {
    constructor() : this(NativeProject.printWorkflowNew())

    val busy: Boolean get() = read { NativeProject.printWorkflowBusy(it) }

    /** Send a sliced artifact. */
    fun run(intent: ProjectIntents.PrintWorkflowIntent): ProjectIntents.PrintWorkflowStep = read {
        step(NativeProject.printWorkflowRun(it, ProjectIntents.encodePrintWorkflowIntent(intent)))
    }
    /** Start a file already stored on the printer, after its own confirmation. */
    fun startStored(path: ProjectIntents.PrinterText): ProjectIntents.PrintWorkflowStep = read {
        step(NativeProject.printWorkflowStartStored(it, ProjectIntents.encodePrinterText(path)))
    }
    fun resolve(id: Long, outcome: ProjectIntents.PrintWorkflowOutcome): ProjectIntents.PrintWorkflowStep = read {
        step(NativeProject.printWorkflowResolve(it, id, ProjectIntents.encodePrintWorkflowOutcome(outcome)))
    }
    /** A request's or the upload's reply: Moonraker's `result`, as JSON text. */
    fun resolveReply(id: Long, text: String): ProjectIntents.PrintWorkflowStep = read {
        step(NativeProject.printWorkflowReply(it, id, text))
    }
    fun cancel(): ProjectIntents.PrintWorkflowStep = read { step(NativeProject.printWorkflowCancel(it)) }
    /** Cancel, and refuse every later operation. */
    fun dispose(): ProjectIntents.PrintWorkflowStep = read { step(NativeProject.printWorkflowDispose(it)) }

    private fun step(json: String) = ProjectIntents.decodePrintWorkflowStep(json)
}
