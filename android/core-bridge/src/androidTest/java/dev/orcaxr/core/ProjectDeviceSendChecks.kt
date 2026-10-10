package dev.orcaxr.core

import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** The Android send end to end, as the app runs it: a sliced G-code file
 * opened as an artifact (its digest and the tools it uses read by the shared
 * scanner across chunks, the file held so a slice that replaces it changes
 * nothing sent), sent through the Device area's workspace to the active
 * printer — connected and leased as the browser's shell does — against the
 * simulator holding one loaded filament: a send cancelled mid-upload, one
 * refused while another waits for its confirmation, one declined, the
 * confirmation the browser's dialog shows (printer, state, tools, the mapping
 * blocker and colour warning, the start options, the exact-name choice), a
 * start refused while that blocker stands, an upload-only send stored and
 * verified byte for byte, stale artifacts refused before and after the
 * operator confirms, and a one-tool print started with the timelapse and
 * levelling the operator chose, after which the status shows the job. */
object ProjectDeviceSendChecks {
    private const val WAIT_S = 20L
    private val absent = ProjectIntents.Empty

    private class MemoryText : DeviceTextStore {
        var text: String? = null
        override fun read() = text
        override fun write(text: String) { this.text = text }
    }
    private class MemoryBlob : SecretBlobStore {
        var blob: ByteArray? = null
        override fun read() = blob?.copyOf()
        override fun write(blob: ByteArray) { this.blob = blob.copyOf() }
        override fun delete() { blob = null }
    }
    private class SoftwareKeys : SecretKeySource {
        var key: SecretKey? = null
        override fun existing() = key
        override fun create(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
        override fun delete() { key = null }
    }

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun sha256(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun decision(choice: ProjectIntents.PrintWorkflowDecisionChoice, overwrite: Boolean = false,
                         options: List<ProjectIntents.PrintStartOptionId> = emptyList()) =
        ProjectIntents.PrintWorkflowDecision(choice, overwrite, options)

    private fun failure(future: CompletableFuture<*>): PrintSubmissionException? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        thrown.cause as? PrintSubmissionException ?: throw thrown
    }

    /** Polls [condition] until it holds or the wait runs out. */
    private fun await(label: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition()) {
            kotlin.check(System.nanoTime() < deadline) { "never: $label" }
            Thread.sleep(25)
        }
    }

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val folder = Files.createTempDirectory("orcaxr-send-checks").toFile()
        // Two tools, the second selected past the scanner's first 64 KiB chunk, with Orca's declarations.
        val twoTools = buildString {
            append("; OrcaXR Android send check. DO NOT PRINT.\nT0\nG1 X1 Y1 E1\n")
            while (length < 70_000) append("; padding to carry the next tool change past the first chunk\n")
            append("T1\nG1 X2 Y2 E1\n; filament_colour = #00FF00;#0000FF\n; filament_type = PLA;PETG\n")
        }.toByteArray()
        val sliced = File(folder, "Bracket_Plate_1.gcode").apply { writeBytes(twoTools) }
        val current = AtomicBoolean(true)
        val artifact = PrintJobArtifacts.open(sliced, "Bracket_Plate_1.gcode", "Plate 1") { current.get() }
        check(artifact.byteLength == twoTools.size.toLong() && artifact.outputHash == sha256(twoTools), "artifact_identity")
        check(artifact.usage.tools == listOf(0L, 1L) && artifact.usage.multiMaterial, "artifact_tools ${artifact.usage}")
        check(artifact.usage.declaredColors.map(::text) == listOf("#00FF00", "#0000FF") &&
            artifact.usage.declaredMaterials.map(::text) == listOf("PLA", "PETG"), "artifact_declarations")
        // A new slice replaces the file: the artifact still sends what it read.
        val replacement = File(folder, "next.gcode").apply { writeText("; another slice\nT0\n") }
        Files.move(replacement.toPath(), sliced.toPath(), StandardCopyOption.REPLACE_EXISTING)

        val confirmations = Collections.synchronizedList(ArrayList<ProjectIntents.PrintWorkflowConfirmation>())
        val withdrawn = Collections.synchronizedList(ArrayList<CompletableFuture<Unit>>())
        val answer = AtomicReference<(ProjectIntents.PrintWorkflowConfirmation) -> CompletableFuture<ProjectIntents.PrintWorkflowDecision>> {
            CompletableFuture.completedFuture(decision(ProjectIntents.PrintWorkflowDecisionChoice.Upload))
        }
        val ids = AtomicInteger()
        DeviceWorkspace(
            MemoryText(), CredentialVault(MemoryBlob(), SealingCipher(SoftwareKeys())), LocalNetworkPermission { true },
            newId = { "printer-${ids.incrementAndGet()}" },
            confirmSend = { input, gone ->
                confirmations += input
                withdrawn += gone
                answer.get()(input)
            },
        ).use { device ->
            val printer = device.addPrinter("Toolchanger", "127.0.0.1", URI(endpoint).port)
            device.setApiKey(printer, "send-key")

            // Not yet connected: the send connects the active printer, as the browser's capture does.
            // The simulator holds this first upload; the operator cancels it in flight.
            val uploading = CountDownLatch(1)
            val held = device.send(artifact, PrintSendProgress(onPhase = { if (it == ProjectIntents.PrintSubmissionPhase.Uploading) uploading.countDown() }))
            check(uploading.await(WAIT_S, TimeUnit.SECONDS), "upload_started")
            check(device.session.state is ProjectIntents.MoonrakerConnectionState.Connected, "send_connected_the_printer")
            Thread.sleep(300)
            device.cancelSend()
            val cancelled = failure(held)
            check(cancelled?.code == ProjectIntents.PrintSubmissionErrorCode.Cancelled && cancelled.message == "Upload cancelled.",
                "cancelled_mid_upload ${cancelled?.message}")
            check(!device.sending, "idle_after_cancel")

            // While one send waits for its confirmation, another is refused; the first is then declined.
            val gate = CompletableFuture<ProjectIntents.PrintWorkflowDecision>()
            answer.set { gate }
            val waiting = device.send(artifact)
            await("asked") { confirmations.size == 2 }
            check(device.sending, "sending_while_asked")
            check(failure(device.send(artifact))?.code == ProjectIntents.PrintSubmissionErrorCode.StaleContext, "second_send_refused")
            gate.complete(decision(ProjectIntents.PrintWorkflowDecisionChoice.Cancel))
            check(waiting.get(WAIT_S, TimeUnit.SECONDS) == null, "declined")

            // What the browser's dialog shows.
            val asked = confirmations.last()
            check(!asked.stored && text(asked.endpointLabel) == "Toolchanger" && text(asked.printerStateLabel) == "ready (standby)",
                "confirmation_printer ${text(asked.endpointLabel)} ${text(asked.printerStateLabel)}")
            check(text(asked.plateName) == "Plate 1" && asked.byteLength == twoTools.size.toLong(), "confirmation_plate")
            check(Regex("Bracket_Plate_1_[0-9a-f]{32}\\.gcode").matches(text(asked.filename)) &&
                text(asked.overwrite.filename) == "Bracket_Plate_1.gcode" && asked.overwrite.allowed &&
                asked.overwrite.existing is ProjectIntents.OptionalPrintFileIdentity.Absent, "confirmation_names ${text(asked.filename)}")
            check(text(asked.toolSummary) == "2 tools (T0, T1) · H1: PLA #FF0000", "confirmation_tools ${text(asked.toolSummary)}")
            check(asked.blockers.map(::text) == listOf("The artifact prints with tool T1, but the printer reports no filament loaded in slot 2.") &&
                asked.warnings.map(::text) == listOf("T0 was sliced as #00FF00, but slot 1 holds #FF0000."),
                "confirmation_mapping ${asked.blockers.map(::text)} ${asked.warnings.map(::text)}")
            check(asked.startOptions.map { it.id to it.available } == listOf(
                ProjectIntents.PrintStartOptionId.BedLeveling to true, ProjectIntents.PrintStartOptionId.Timelapse to true,
            ) && asked.startOptions.none { it.defaultEnabled }, "confirmation_options")
            // Cancelling while the operator is asked withdraws the dialog.
            answer.set { CompletableFuture() }
            val asking = device.send(artifact)
            await("asked again") { confirmations.size == 3 }
            device.cancelSend()
            val withdrawnSend = failure(asking)
            check(withdrawnSend?.code == ProjectIntents.PrintSubmissionErrorCode.Cancelled && withdrawn.last().isDone,
                "dialog_withdrawn ${withdrawnSend?.message}")

            // Starting is refused while a tool has no filament; uploading only is not.
            answer.set { CompletableFuture.completedFuture(decision(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint)) }
            val blocked = failure(device.send(artifact))
            check(blocked?.code == ProjectIntents.PrintSubmissionErrorCode.NotReady &&
                blocked.message == "The artifact prints with tool T1, but the printer reports no filament loaded in slot 2.", "start_blocked ${blocked?.message}")
            answer.set { CompletableFuture.completedFuture(decision(ProjectIntents.PrintWorkflowDecisionChoice.Upload)) }
            val stored = device.send(artifact).get(WAIT_S, TimeUnit.SECONDS)!!
            check(!stored.startedPrint && stored.verifiedBytes == twoTools.size.toLong() &&
                Regex("Bracket_Plate_1_[0-9a-f]{32}\\.gcode").matches(text(stored.path)), "uploaded ${text(stored.path)}")
            val download = device.exchanges()!!.storage(ProjectIntents.PrinterStorageOperation.Download(ProjectIntents.PrinterText(stored.path)))
                .get(WAIT_S, TimeUnit.SECONDS)
            check(download.bytes.contentEquals(twoTools), "stored_byte_for_byte")
            artifact.close()

            // A stale artifact is refused before the operator is asked, and after they confirm.
            val one = File(folder, "Bracket_Plate_2.gcode").apply { writeText("; one tool\nT0\nG1 X1 E1\n; filament_colour = #FF0000\n") }
            current.set(false)
            PrintJobArtifacts.open(one, "Bracket_Plate_2.gcode", "Plate 2") { current.get() }.use { stale ->
                val before = confirmations.size
                val refused = failure(device.send(stale))
                check(refused?.code == ProjectIntents.PrintSubmissionErrorCode.StaleContext &&
                    refused.message == "The sliced artifact is no longer current. Slice and confirm a new send." &&
                    confirmations.size == before, "stale_refused ${refused?.message}")
                current.set(true)
                answer.set {
                    current.set(false)
                    CompletableFuture.completedFuture(decision(ProjectIntents.PrintWorkflowDecisionChoice.Upload))
                }
                check(failure(device.send(stale))?.code == ProjectIntents.PrintSubmissionErrorCode.StaleContext, "stale_after_confirmation")
            }

            // One tool, loaded: started under the exact name with the options chosen, and the status shows the job.
            current.set(true)
            answer.set {
                CompletableFuture.completedFuture(decision(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint, overwrite = true,
                    options = listOf(ProjectIntents.PrintStartOptionId.BedLeveling, ProjectIntents.PrintStartOptionId.Timelapse)))
            }
            val phases = Collections.synchronizedList(ArrayList<ProjectIntents.PrintSubmissionPhase>())
            PrintJobArtifacts.open(one, "Bracket_Plate_2.gcode", "Plate 2") { current.get() }.use { ready ->
                val started = device.send(ready, PrintSendProgress(onPhase = { phases += it })).get(WAIT_S, TimeUnit.SECONDS)!!
                check(started.startedPrint && text(started.path) == "Bracket_Plate_2.gcode" && started.verifiedBytes == one.length(),
                    "started ${text(started.path)}")
                check(confirmations.last().blockers.isEmpty() && confirmations.last().warnings.isEmpty(), "one_tool_clear")
                check(phases.containsAll(listOf(ProjectIntents.PrintSubmissionPhase.Preparing, ProjectIntents.PrintSubmissionPhase.Starting,
                    ProjectIntents.PrintSubmissionPhase.Completed)), "phases $phases")
                // The send refreshed the session: the status already shows the print.
                check(device.summary().tone == ProjectIntents.PrinterStatusTone.Active, "status_shows_the_job ${device.summary().tone}")
            }
        }
        folder.deleteRecursively()
        return checks
    }
}
