package dev.orcaxr.core

import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** The Android send workflow end to end: the shared core's submission machine
 * over a [PrinterSessionClient] lease against the Moonraker simulator — an
 * upload confirmed as upload-only and verified, a send the operator declines,
 * a stored file reprinted, and a send the busy printer refuses — its
 * confirmation naming why — before any upload. */
object ProjectPrintWorkflowClientChecks {
    private const val WAIT_S = 20L
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun artifact(filename: String, gcode: String): PrintJobArtifact {
        val bytes = gcode.toByteArray()
        val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return PrintJobArtifact(
            filename, bytes, "Plate 1",
            ProjectIntents.GcodeToolUsage(listOf(0L), false, emptyList(), emptyList()),
            "sha256:$hex",
        ) { true }
    }

    private fun failure(future: CompletableFuture<*>): ProjectIntents.PrintSubmissionErrorCode? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        (thrown.cause as? PrintSubmissionException)?.code
    }

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        val confirmations = Collections.synchronizedList(ArrayList<ProjectIntents.PrintWorkflowConfirmation>())
        var decide: (ProjectIntents.PrintWorkflowConfirmation) -> ProjectIntents.PrintWorkflowDecision = {
            ProjectIntents.PrintWorkflowDecision(ProjectIntents.PrintWorkflowDecisionChoice.Upload, false, emptyList())
        }
        PrinterSessionClient(ProjectPrinterSessionClientChecks::clientFor).use { session ->
            session.select(
                ProjectIntents.PrinterSelection(
                    units("simulator"), ProjectIntents.OptionalText.Value(units("Simulator")), units(endpoint), 7125,
                    ProjectIntents.OptionalText.Value(units("android-key")),
                ),
            )
            PrintWorkflowClient(
                captureSession = { _ -> session.connect().thenApply { session.captureLease() } },
                confirm = { input, _ ->
                    confirmations += input
                    CompletableFuture.completedFuture(decide(input))
                },
            ).use { workflow ->
                // An upload, confirmed as upload-only: under a fresh unique name, verified, nothing started.
                val phases = Collections.synchronizedList(ArrayList<ProjectIntents.PrintSubmissionPhase>())
                val part = artifact("part.gcode", "G28\nG1 X10 Y10\n; android send\n")
                val uploaded = workflow.run(part, PrintSendProgress(onPhase = { phases += it })).get(WAIT_S, TimeUnit.SECONDS)!!
                check(!uploaded.startedPrint && uploaded.verifiedBytes == part.gcode.size.toLong()) { "uploaded $uploaded" }; checks++
                check(Regex("part_[0-9a-f]{32}\\.gcode").matches(text(uploaded.path))) { "unique_name ${text(uploaded.path)}" }; checks++
                val asked = confirmations.single()
                check(asked.byteLength == part.gcode.size.toLong() && text(asked.overwrite.filename) == "part.gcode") { "confirmation" }
                check(text(asked.endpointLabel) == "Simulator" && asked.blockers.isEmpty()) { "confirmation_labels" }; checks++
                check(phases.containsAll(listOf(ProjectIntents.PrintSubmissionPhase.Checking, ProjectIntents.PrintSubmissionPhase.Uploading,
                    ProjectIntents.PrintSubmissionPhase.Verifying))) { "phases $phases" }; checks++
                check(!workflow.busy) { "idle" }; checks++

                // Chosen as an overwrite, the upload takes the requested name.
                decide = { ProjectIntents.PrintWorkflowDecision(ProjectIntents.PrintWorkflowDecisionChoice.Upload, true, emptyList()) }
                check(text(workflow.run(part).get(WAIT_S, TimeUnit.SECONDS)!!.path) == "part.gcode") { "overwrite_name" }; checks++

                // Declined: nothing is uploaded. The existing file was offered with its identity.
                decide = { ProjectIntents.PrintWorkflowDecision(ProjectIntents.PrintWorkflowDecisionChoice.Cancel, false, emptyList()) }
                check(workflow.run(part).get(WAIT_S, TimeUnit.SECONDS) == null) { "declined" }; checks++
                check(confirmations.last().overwrite.existing is ProjectIntents.OptionalPrintFileIdentity.Value) { "existing_offered" }
                checks++

                // The stored file, reprinted.
                decide = { ProjectIntents.PrintWorkflowDecision(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint, false, emptyList()) }
                check(workflow.startStored("part.gcode").get(WAIT_S, TimeUnit.SECONDS) == "part.gcode") { "reprint" }; checks++
                check(confirmations.last().stored) { "stored_confirmation" }; checks++

                // A busy printer: the confirmation names why, and the send is refused before any upload.
                check(failure(workflow.run(artifact("second.gcode", "G28\n"))) == ProjectIntents.PrintSubmissionErrorCode.NotReady) {
                    "busy_printer"
                }; checks++
                check(confirmations.last().blockers.isNotEmpty()) { "busy_blockers" }; checks++
            }
        }
        return checks
    }
}
