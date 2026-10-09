package dev.orcaxr.core

/** The printer session (`orcaxr_printer::session`, the browser's
 * `PrinterSessionController`): one selected printer and every query,
 * subscription and command in it. Stepping calls answer a step naming the
 * effects to carry out (open a transport and answer with its state, connect,
 * a request, a recovery command, a confirmation dialog), effects withdrawn
 * because their epoch ended (stop that work; never answer them), transports
 * to close, epochs ended (cancel any send leased in one), the task a call
 * started and the tasks that finished. Feed the transport's state changes
 * and notifications in as they happen. A refused call throws its code:
 * `not_pending`, `mismatch`, `disposed` or `invalid_request`. */
class PrinterSession internal constructor(handle: Long) : ProjectHandle(handle) {
    constructor() : this(NativeProject.printerSessionNew())

    fun select(selection: ProjectIntents.PrinterSelection): ProjectIntents.PrinterSessionStep = read {
        step(NativeProject.printerSessionSelect(it, ProjectIntents.encodePrinterSelection(selection)))
    }
    fun clear(): ProjectIntents.PrinterSessionStep = read { step(NativeProject.printerSessionClear(it)) }
    fun dispose(): ProjectIntents.PrinterSessionStep = read { step(NativeProject.printerSessionDispose(it)) }
    fun connect(): ProjectIntents.PrinterSessionStep = read { step(NativeProject.printerSessionConnect(it)) }
    fun refresh(): ProjectIntents.PrinterSessionStep = read { step(NativeProject.printerSessionRefresh(it)) }
    fun execute(request: ProjectIntents.PrintJobExecuteRequest): ProjectIntents.PrinterSessionStep = read {
        step(NativeProject.printerSessionExecute(it, ProjectIntents.encodePrintJobExecuteRequest(request)))
    }
    fun transportState(transport: Long, signal: ProjectIntents.ConnectionSignal): ProjectIntents.PrinterSessionStep = read {
        step(NativeProject.printerSessionState(it, transport, ProjectIntents.encodeConnectionSignal(signal)))
    }
    /** A notification's method and params (JSON text) as received at [nowMs]. */
    fun notification(transport: Long, method: String, params: String, nowMs: Double): ProjectIntents.PrinterSessionStep = read {
        step(NativeProject.printerSessionNotification(it, transport, method, params, nowMs))
    }
    fun resolve(id: Long, outcome: ProjectIntents.PrinterSessionOutcome): ProjectIntents.PrinterSessionStep = read {
        step(NativeProject.printerSessionResolve(it, id, ProjectIntents.encodePrinterSessionOutcome(outcome)))
    }
    /** A request's reply: Moonraker's `result`, as JSON text, received at [nowMs]. */
    fun resolveReply(id: Long, text: String, nowMs: Double): ProjectIntents.PrinterSessionStep = read {
        step(NativeProject.printerSessionReply(it, id, text, nowMs))
    }
    val view: ProjectIntents.PrinterSessionView get() = read {
        ProjectIntents.decodePrinterSessionView(NativeProject.printerSessionView(it))
    }
    /** [command] is the wire name: `pause`, `resume`, `cancel`, `emergencyStop`, `firmwareRestart`. */
    fun captureIntent(command: String): ProjectIntents.PrintJobIntentReply = read {
        ProjectIntents.decodePrintJobIntentReply(NativeProject.printerSessionCaptureIntent(it, command))
    }
    fun confirm(intent: Long): ProjectIntents.PrintJobConfirmReply = read {
        ProjectIntents.decodePrintJobConfirmReply(NativeProject.printerSessionConfirm(it, intent))
    }
    fun captureLease(): ProjectIntents.PrinterSessionLeaseReply = read {
        ProjectIntents.decodePrinterSessionLeaseReply(NativeProject.printerSessionCaptureLease(it))
    }
    fun leaseCurrent(lease: ProjectIntents.PrinterSessionLease): Boolean = read {
        NativeProject.printerSessionLeaseCurrent(it, ProjectIntents.encodePrinterSessionLease(lease))
    }

    private fun step(json: String) = ProjectIntents.decodePrinterSessionStep(json)
}
