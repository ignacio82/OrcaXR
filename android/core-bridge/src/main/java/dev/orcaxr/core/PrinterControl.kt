package dev.orcaxr.core

/** Printer control policy (`orcaxr_printer::control`, `orcaxr_printer::summary`),
 * as the browser's `PrintJobControl` and `PrinterStatusSummary` answer it:
 * which lifecycle commands the reported state allows, what sending one does
 * or why it is refused, the sentence a failed send reports, the compact
 * status a surface shows, and the guarded actions it offers. */
object PrinterControl {
    fun availability(request: ProjectIntents.PrintJobAvailabilityRequest): List<ProjectIntents.PrintJobCommandDescriptor> =
        ProjectIntents.decodePrintJobCommandDescriptors(NativeProject.printJobAvailability(ProjectIntents.encodePrintJobAvailabilityRequest(request)))
    fun plan(request: ProjectIntents.PrintJobCommandCheckRequest): ProjectIntents.PrintJobCommandPlan =
        ProjectIntents.decodePrintJobCommandPlan(NativeProject.printJobCommandPlan(ProjectIntents.encodePrintJobCommandCheckRequest(request)))
    fun failure(request: ProjectIntents.PrintJobCommandFailureRequest): ProjectIntents.PrintJobCommandRefusal =
        ProjectIntents.decodePrintJobCommandRefusal(NativeProject.printJobCommandFailure(ProjectIntents.encodePrintJobCommandFailureRequest(request)))
    fun summary(request: ProjectIntents.PrinterStatusRequest): ProjectIntents.PrinterStatusSummary =
        ProjectIntents.decodePrinterStatusSummary(NativeProject.printerStatusSummary(ProjectIntents.encodePrinterStatusRequest(request)))
    fun guarded(request: ProjectIntents.GuardedPrinterActionsRequest): List<ProjectIntents.GuardedPrinterAction> =
        ProjectIntents.decodeGuardedPrinterActions(NativeProject.guardedPrinterActions(ProjectIntents.encodeGuardedPrinterActionsRequest(request)))
}

/** The hold-to-confirm gesture every surface performs the same way: a press,
 * then a release at least the action's hold later, fires it; an early release
 * fires nothing. Each call takes the host's clock. */
class HoldToConfirm internal constructor(handle: Long) : ProjectHandle(handle) {
    constructor() : this(NativeProject.holdNew())

    fun press(action: ProjectIntents.GuardedPrinterAction, nowMs: Double): ProjectIntents.HoldToConfirmState = read {
        ProjectIntents.decodeHoldToConfirmState(NativeProject.holdPress(it, ProjectIntents.encodeGuardedPrinterAction(action), nowMs))
    }
    fun poll(nowMs: Double): ProjectIntents.HoldToConfirmState = read {
        ProjectIntents.decodeHoldToConfirmState(NativeProject.holdPoll(it, nowMs))
    }
    fun release(nowMs: Double): ProjectIntents.HoldToConfirmRelease = read {
        ProjectIntents.decodeHoldToConfirmRelease(NativeProject.holdRelease(it, nowMs))
    }
    fun cancel(): ProjectIntents.HoldToConfirmState = read {
        ProjectIntents.decodeHoldToConfirmState(NativeProject.holdCancel(it))
    }
}
