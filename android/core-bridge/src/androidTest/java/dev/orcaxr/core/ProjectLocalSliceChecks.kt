package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * The local slicing route's platform-free half on a real session: a plate
 * staged as a private job (the same archive and overrides the external route
 * uploads, read-only, hashed from the disk), the engine's documents read
 * strictly, every way a job can end mapped to its own outcome, and the
 * engine's output claimed, verified (length, digest, UTF-8 text) and
 * published only while the project is still the state it was staged from.
 */
object ProjectLocalSliceChecks {
    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @JvmStatic fun run(cube: ByteArray, gcode: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun refused(label: String, block: () -> Unit) {
            val failure = try {
                block()
                null
            } catch (expected: Exception) {
                expected
            }
            check(failure != null, label)
        }
        fun <T> done(future: java.util.concurrent.CompletableFuture<T>): T = future.get(60, TimeUnit.SECONDS)
        fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (!condition(workspace.view)) {
                kotlin.check(System.nanoTime() < deadline) { "view_timeout ${workspace.view}" }
                Thread.sleep(20)
            }
            return workspace.view
        }
        val scratch = Files.createTempDirectory("orcaxr-local-slice-").toFile()
        try {
            val root = File(scratch, "engine-jobs")
            ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
                done(workspace.ready())
                done(workspace.commitImport(done(workspace.prepareImport(Memory(cube), "cube.stl")), emptyList()))
                val view = until(workspace) { it.activePlate?.objects == 1 && it.revision != null }
                val plate = checkNotNull(view.activePlate).id

                // Staging: the external route's own archive and overrides, private, sealed and hashed from the disk.
                val id = "0123456789abcdef0123456789abcdef"
                val job = LocalSlicing.stage(root, id) { output -> done(workspace.projectPlate(plate, output)) }
                val uploaded = ByteArrayOutputStream()
                val reference = done(workspace.projectPlate(plate, object : ProjectDocumentOutput {
                    override fun openOutput(): OutputStream = uploaded
                }))
                val archiveBytes = job.archive.file.readBytes()
                check(job.directory == File(root, id) && job.directory.isDirectory, "job_directory")
                check(archiveBytes.contentEquals(uploaded.toByteArray()), "archive_is_the_external_upload")
                check(job.archive.bytes == archiveBytes.size.toLong() && job.archive.sha256 == sha(archiveBytes), "archive_identity")
                val overridesBytes = job.overrides.file.readBytes()
                check(String(overridesBytes, Charsets.US_ASCII) == CanonicalJson.write(reference.overrides), "overrides_are_the_external_form")
                check(job.overrides.bytes == overridesBytes.size.toLong() && job.overrides.sha256 == sha(overridesBytes), "overrides_identity")
                check(!job.archive.file.canWrite() && !job.overrides.file.canWrite(), "inputs_sealed")
                check(job.sourceHash == reference.sourceHash && job.revision == workspace.view.revision, "job_state")
                check(!job.output.exists() && job.output.parentFile == job.directory, "output_not_yet_written")
                refused("same_job_refused") { LocalSlicing.stage(root, id) { output -> done(workspace.projectPlate(plate, output)) } }
                check(job.archive.file.readBytes().contentEquals(archiveBytes), "first_job_untouched")
                refused("invalid_job_id") { LocalSlicing.stage(root, "../escape") { output -> done(workspace.projectPlate(plate, output)) } }
                val failing = "fedcba9876543210fedcba9876543210"
                refused("failed_write") { LocalSlicing.stage(root, failing) { throw IllegalStateException("projection") } }
                check(!File(root, failing).exists(), "failed_stage_leaves_nothing")
                refused("unknown_plate") { LocalSlicing.stage(root, failing) { output -> done(workspace.projectPlate("plate-missing", output)) } }
                check(!File(root, failing).exists(), "refused_projection_leaves_nothing")

                // The engine's documents: strict shapes, known stages and codes, bounded ASCII words.
                val digest = sha(gcode)
                val completed = "{\"schemaVersion\":1,\"outcome\":\"completed\",\"stage\":\"output\",\"objects\":1," +
                    "\"gcodeBytes\":${gcode.size},\"gcodeSha256\":\"$digest\",\"rejectedOverrides\":0}"
                val result = LocalSlicing.result(completed)
                check(result == LocalEngineResult.Completed(1, gcode.size.toLong(), digest, 0), "completed_read")
                check(LocalSlicing.result("{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"validation\",\"code\":\"validation\"," +
                    "\"message\":\"Too tall\",\"option\":\"printable_height\"}") ==
                    LocalEngineResult.Failed("validation", "validation", "Too tall", "printable_height"), "failed_read")
                check(LocalSlicing.result("{\"schemaVersion\":1,\"outcome\":\"cancelled\",\"stage\":\"processing\"}") ==
                    LocalEngineResult.Cancelled("processing"), "cancelled_read")
                check(LocalSlicing.result("{\"schemaVersion\":1,\"outcome\":\"busy\"}") == LocalEngineResult.Busy, "busy_read")
                val malformed = listOf(
                    completed.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
                    completed.replace(",\"rejectedOverrides\":0", ""),
                    completed.replace("}", ",\"extra\":1}"),
                    completed.replace(digest, digest.uppercase()),
                    completed.replace("\"objects\":1", "\"objects\":0"),
                    completed.replace("\"gcodeBytes\":${gcode.size}", "\"gcodeBytes\":${LocalSlicing.MAX_GCODE_BYTES + 1}"),
                    completed.replace("\"stage\":\"output\"", "\"stage\":\"export\""),
                    "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"slicing\",\"code\":\"engine\",\"message\":\"x\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"processing\",\"code\":\"crash\",\"message\":\"x\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"processing\",\"code\":\"engine\",\"message\":\"\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"processing\",\"code\":\"engine\",\"message\":\"\\u00e9\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"processing\",\"code\":\"engine\",\"message\":\"${"x".repeat(241)}\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"validation\",\"code\":\"validation\",\"message\":\"x\",\"option\":\"Bad Key\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"done\"}",
                    "[1]",
                    "{\"schemaVersion\":1,\"outcome\":\"busy\",\"outcome\":\"busy\"}",
                    "{\"schemaVersion\":1,\"outcome\":\"cancelled\",\"stage\":\"processing\"} ",
                )
                for ((index, text) in malformed.withIndex()) {
                    if (index == malformed.lastIndex) {
                        // Trailing whitespace is JSON; only shapes are refused.
                        check(LocalSlicing.result(text) == LocalEngineResult.Cancelled("processing"), "whitespace_tolerated")
                    } else {
                        refused("malformed_result_$index") { LocalSlicing.result(text) }
                    }
                }
                check(LocalSlicing.status(LocalSlicing.running(42, "Generating\tperimeters\u0001")) ==
                    LocalSliceStatus.Running(42, "Generating perimeters"), "running_status")
                check(LocalSlicing.status(LocalSlicing.running(-5, "")) == LocalSliceStatus.Running(null, ""), "running_without_percent")
                check(LocalSlicing.status(LocalSlicing.done(completed)) == LocalSliceStatus.Done(result), "done_status")
                check(LocalSlicing.status(LocalSlicing.UNKNOWN) == LocalSliceStatus.Unknown, "unknown_status")
                refused("done_checks_result") { LocalSlicing.done("{\"schemaVersion\":1,\"outcome\":\"won\"}") }
                refused("status_extra_key") { LocalSlicing.status("{\"schemaVersion\":1,\"state\":\"unknown\",\"job\":\"x\"}") }
                refused("status_percent_range") { LocalSlicing.status("{\"schemaVersion\":1,\"state\":\"running\",\"percent\":101,\"message\":\"\"}") }

                // Every way a job ends is its own outcome.
                check(LocalSlicing.outcome(LocalEngineEnd.Reported(result)) == LocalSliceOutcome.Output(result as LocalEngineResult.Completed), "outcome_output")
                check(LocalSlicing.outcome(LocalEngineEnd.Reported(LocalEngineResult.Cancelled("processing"))).status ==
                    "slice failed: Cancelled by user", "outcome_cancelled")
                check(LocalSlicing.outcome(LocalEngineEnd.Died(afterCancel = true)) == LocalSliceOutcome.Cancelled(terminated = true), "outcome_terminated")
                check(LocalSlicing.outcome(LocalEngineEnd.Died(afterCancel = false)) == LocalSliceOutcome.Interrupted, "outcome_interrupted")
                check(LocalSlicing.outcome(LocalEngineEnd.Lost) == LocalSliceOutcome.Unknown, "outcome_unknown")
                check(LocalSlicing.outcome(LocalEngineEnd.Reported(LocalEngineResult.Failed("validation", "validation", "Too tall", null))).status ==
                    "slice failed: validate failed: Too tall", "outcome_validation_words")
                check(LocalSlicing.outcome(LocalEngineEnd.Reported(LocalEngineResult.Failed("project", "project-load", "No plate", null))).status ==
                    "slice failed: No plate", "outcome_failed_words")
                check(LocalSlicing.outcome(LocalEngineEnd.Reported(LocalEngineResult.Busy)) is LocalSliceOutcome.Failed, "outcome_busy")
                check(setOf(LocalSliceOutcome.Interrupted.status, LocalSliceOutcome.Unknown.status,
                    LocalSliceOutcome.Cancelled(true).status, LocalSliceOutcome.Cancelled(false).status).size == 4, "outcomes_distinct")

                // Output: claimed out of the job, checked, then published only for the state it was staged from.
                val prepare = File(scratch, "prepare")
                val part = File(prepare, "slice.gcode.part")
                fun engineWrites(bytes: ByteArray) {
                    job.output.delete()
                    job.output.writeBytes(bytes)
                }
                fun completedFor(bytes: ByteArray) = LocalEngineResult.Completed(1, bytes.size.toLong(), sha(bytes), 0)
                refused("no_output") { LocalSlicing.claim(job, completedFor(gcode), part) }
                engineWrites(gcode)
                val tally = ByteArrayOutputStream()
                val verified = LocalSlicing.claim(job, completedFor(gcode), part, tally)
                check(!job.output.exists() && part.isFile, "claimed_out_of_the_job")
                check(verified.bytes == gcode.size.toLong() && verified.sha256 == digest, "verified_identity")
                check(tally.toByteArray().contentEquals(gcode), "observer_saw_every_byte")
                val published = File(prepare, "gcode/cube_Plate_1.gcode")
                check(LocalSlicing.publish(verified, job, workspace.view.revision, published) == published, "published_while_current")
                check(published.readBytes().contentEquals(gcode) && !part.exists(), "published_bytes")

                fun refusedOutput(label: String, bytes: ByteArray, reported: LocalEngineResult.Completed = completedFor(bytes)) {
                    engineWrites(bytes)
                    refused(label) { LocalSlicing.claim(job, reported, part) }
                    check(!part.exists(), "${label}_removed")
                }
                refusedOutput("length_mismatch", gcode, completedFor(gcode).copy(gcodeBytes = gcode.size + 1L))
                refusedOutput("digest_mismatch", gcode, completedFor(gcode).copy(gcodeSha256 = "0".repeat(64)))
                refusedOutput("invalid_utf8", byteArrayOf(0x47, 0x31, 0xc3.toByte(), 0x28, 0x0a))
                refusedOutput("truncated_utf8", byteArrayOf(0x47, 0x31, 0x0a, 0xe2.toByte(), 0x82.toByte()))
                refusedOutput("nul_byte", byteArrayOf(0x47, 0x31, 0x00, 0x0a))
                // A character split across the reader's 64 KiB chunks is still one character.
                val split = ByteArray(65535) { 'a'.code.toByte() } + "é\n".toByteArray(Charsets.UTF_8)
                engineWrites(split)
                check(LocalSlicing.claim(job, completedFor(split), part).bytes == split.size.toLong(), "split_character_accepted")
                Files.deleteIfExists(part.toPath())
                // A link where the G-code should be is never followed.
                job.output.delete()
                Files.createSymbolicLink(job.output.toPath(), published.toPath())
                refused("symlink_output") { LocalSlicing.claim(job, completedFor(gcode), part) }
                check(published.readBytes().contentEquals(gcode), "symlink_target_untouched")
                job.output.delete()

                // Stale: the project changed after the plate was staged; the output is discarded, never published.
                engineWrites(gcode)
                val again = LocalSlicing.claim(job, completedFor(gcode), part)
                done(workspace.commitImport(done(workspace.prepareImport(Memory(cube), "cube.stl")), emptyList()))
                val changed = until(workspace) { it.activePlate?.objects == 2 }.revision
                check(changed != job.revision, "project_changed")
                val stale = File(prepare, "gcode/stale.gcode")
                check(LocalSlicing.publish(again, job, changed, stale) == null && !stale.exists() && !part.exists(), "stale_output_discarded")

                // Discarding a job never follows a link out of it; a sweep removes what an earlier run left.
                val outside = File(scratch, "outside.txt").apply { writeText("keep") }
                Files.createSymbolicLink(File(job.directory, "link").toPath(), outside.toPath())
                LocalSlicing.discard(job)
                check(!job.directory.exists() && outside.readText() == "keep", "discard_keeps_link_target")
                val leftover = LocalSlicing.stage(root, "00112233445566778899aabbccddeeff") { output -> done(workspace.projectPlate(plate, output)) }
                LocalSlicing.sweep(root)
                check(!leftover.directory.exists() && root.isDirectory, "sweep_removes_jobs")
                refused("job_exists_check") {
                    Files.createDirectory(File(root, id).toPath())
                    LocalSlicing.stage(root, id) { output -> done(workspace.projectPlate(plate, output)) }
                }
                check(Files.exists(File(root, id).toPath()), "existing_directory_kept")
            }
        } finally {
            LocalSlicing.discard(scratch)
        }
        return checks
    }
}
