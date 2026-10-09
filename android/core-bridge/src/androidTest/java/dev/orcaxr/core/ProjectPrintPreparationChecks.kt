package dev.orcaxr.core

/** Print preparation and submission checks through the Kotlin wrapper: every
 * case of the browser's script answers the browser's reply. */
object ProjectPrintPreparationChecks {
    /** [script] lines: `<section>\t<input>\t<second input or empty>\t<reply>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val e = line.split("\t")
            val ok = when (e[0]) {
                "objects" -> PrintPreparation.objects(e[1]) == ProjectIntents.decodeOptionalTextList(e[3])
                "components" -> PrintPreparation.components(e[1]) == ProjectIntents.decodeOptionalTextList(e[3])
                "commands" -> PrintPreparation.commands(e[1]) == ProjectIntents.decodeOptionalTextList(e[3])
                "options" -> PrintPreparation.startOptions(ProjectIntents.decodePrinterCapabilityReport(e[1])) == ProjectIntents.decodePrintStartOptions(e[3])
                "plans" -> PrintPreparation.plan(ProjectIntents.decodePrintPreparationPlanRequest(e[1])) == ProjectIntents.decodePrintPreparationPlan(e[3])
                "sends" -> PrintPreparation.send(ProjectIntents.decodePrintPreparationStep(e[1])) == ProjectIntents.decodePrinterSend(e[3])
                "readiness" -> PrintPreparation.readiness(e[1]) == ProjectIntents.decodePrintReadiness(e[3])
                "readinessFailures" -> PrintPreparation.readinessFailure(ProjectIntents.decodePrintReadinessFailure(e[1])) == ProjectIntents.decodePrintReadiness(e[3])
                "filenames" -> PrintPreparation.sanitizeFilename(ProjectIntents.decodePrinterText(e[1])) == ProjectIntents.decodePrinterText(e[3])
                "failures" -> PrintPreparation.describeFailure(ProjectIntents.decodeTransportFailure(e[1])) == ProjectIntents.decodePrinterText(e[3])
                "identities" -> PrintPreparation.fileIdentity(e[1], ProjectIntents.decodePrinterText(e[2])) == ProjectIntents.decodePrintFileIdentityReply(e[3])
                else -> error("unknown script entry ${e[0]}")
            }
            check(ok) { "preparation_${e[0]}_$checks" }
            checks++
        }
        return checks
    }
}
