package dev.orcaxr.core

/** Print preparation and submission checks (`orcaxr_printer::preparation`), as
 * the browser's `PrintStartOptions` and `PrintJobSubmission` answer them:
 * capability lists from the printer's replies, the start options they
 * support, the preparation plan and what each step posts, readiness, upload
 * names, stored-file identity and how a transport failure reads. Reply text
 * is passed as received. */
object PrintPreparation {
    fun objects(text: String): ProjectIntents.OptionalTextList = ProjectIntents.decodeOptionalTextList(NativeProject.printerObjects(text))
    fun components(text: String): ProjectIntents.OptionalTextList = ProjectIntents.decodeOptionalTextList(NativeProject.serverComponents(text))
    fun commands(text: String): ProjectIntents.OptionalTextList = ProjectIntents.decodeOptionalTextList(NativeProject.gcodeCommands(text))
    fun startOptions(report: ProjectIntents.PrinterCapabilityReport): List<ProjectIntents.PrintStartOption> =
        ProjectIntents.decodePrintStartOptions(NativeProject.printStartOptions(ProjectIntents.encodePrinterCapabilityReport(report)))
    fun plan(request: ProjectIntents.PrintPreparationPlanRequest): ProjectIntents.PrintPreparationPlan =
        ProjectIntents.decodePrintPreparationPlan(NativeProject.printPreparationPlan(ProjectIntents.encodePrintPreparationPlanRequest(request)))
    fun send(step: ProjectIntents.PrintPreparationStep): ProjectIntents.PrinterSend =
        ProjectIntents.decodePrinterSend(NativeProject.printPreparationSend(ProjectIntents.encodePrintPreparationStep(step)))
    fun readiness(text: String): ProjectIntents.PrintReadiness = ProjectIntents.decodePrintReadiness(NativeProject.printReadiness(text))
    fun readinessFailure(request: ProjectIntents.PrintReadinessFailure): ProjectIntents.PrintReadiness =
        ProjectIntents.decodePrintReadiness(NativeProject.printReadinessFailure(ProjectIntents.encodePrintReadinessFailure(request)))
    fun sanitizeFilename(name: ProjectIntents.PrinterText): ProjectIntents.PrinterText =
        ProjectIntents.decodePrinterText(NativeProject.sanitizeGcodeFilename(ProjectIntents.encodePrinterText(name)))
    fun describeFailure(request: ProjectIntents.TransportFailure): ProjectIntents.PrinterText =
        ProjectIntents.decodePrinterText(NativeProject.describeTransportFailure(ProjectIntents.encodeTransportFailure(request)))
    fun fileIdentity(text: String, filename: ProjectIntents.PrinterText): ProjectIntents.PrintFileIdentityReply =
        ProjectIntents.decodePrintFileIdentityReply(NativeProject.printFileIdentity(text, ProjectIntents.encodePrinterText(filename)))
}
