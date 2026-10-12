package dev.orcaxr.core

import java.io.File
import java.io.FileOutputStream
import java.io.FilterOutputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest

/** One staged input of a local slice: its private file and the identity the engine checks before reading it. */
class LocalSliceInput internal constructor(val file: File, val bytes: Long, val sha256: String)

/**
 * One local slice's private job (the plan's engine and job contracts): a
 * directory only this app reads, holding the plate's one-plate archive and
 * its overrides — exactly what the external route uploads — made read-only
 * once written, with the identities the engine checks before it reads them.
 * The engine writes [output]; nothing there is a result until the host has
 * claimed and verified it ([LocalSlicing.claim]).
 */
class LocalSliceJob internal constructor(
    val id: String,
    val directory: File,
    val archive: LocalSliceInput,
    val overrides: LocalSliceInput,
    val output: File,
    /** The projected plate's fingerprint (the archive's `sourceHash`). */
    val sourceHash: String,
    /** The state of the project the archive was written from. */
    val revision: ProjectRevision?,
    /** The archive's Save warnings, as the external route counts them. */
    val warnings: Int,
    /** The plate's pictures for the G-code, drawn from the capture the archive was written from. */
    val thumbnails: PlateThumbnails = PlateThumbnails.NONE,
    /** The archive's Save warnings themselves, as the browser's coordinator collects them. */
    val warningTexts: List<String> = emptyList(),
)

/** What the engine reported of one job ([LocalSlicing.result]): its own result document, read strictly. */
sealed interface LocalEngineResult {
    /** The G-code is written and closed: its length and SHA-256 as the engine read them back. */
    data class Completed(val objects: Long, val gcodeBytes: Long, val gcodeSha256: String, val rejectedOverrides: Long) : LocalEngineResult
    /** The engine refused or failed at [stage], with a stable [code] and its bounded words. */
    data class Failed(val stage: String, val code: String, val message: String, val option: String?) : LocalEngineResult
    /** The engine stopped cooperatively at [stage], as asked. */
    data class Cancelled(val stage: String) : LocalEngineResult
    /** Another job owned the engine. */
    data object Busy : LocalEngineResult
}

/** A job's state as the engine's process reports it ([LocalSlicing.status]). */
sealed interface LocalSliceStatus {
    /** Running: the engine's percent (none before it reported one) and its step's name. */
    data class Running(val percent: Int?, val message: String) : LocalSliceStatus
    data class Done(val result: LocalEngineResult) : LocalSliceStatus
    /** The process holds no such job (it was restarted, or the job was never started there). */
    data object Unknown : LocalSliceStatus
}

/** How a job ended, as its owner observed it. */
sealed interface LocalEngineEnd {
    /** The engine's own result. */
    data class Reported(val result: LocalEngineResult) : LocalEngineEnd
    /** The engine's process died; [afterCancel] when its owner ended it once a cancel went unanswered. */
    data class Died(val afterCancel: Boolean) : LocalEngineEnd
    /** Neither a result nor the process's death was observed in time. */
    data object Lost : LocalEngineEnd
}

/**
 * A local slice's outcome, each kept distinct as the plan requires: output to
 * verify, or failed, cancelled, interrupted (the engine's process died
 * unasked) or unknown, each with the status line the Prepare area shows.
 */
sealed interface LocalSliceOutcome {
    /** The status line for an outcome that ends the slice; none for [Output]. */
    val status: String? get() = null

    /** The engine finished: its output still has to be claimed, verified and published. */
    data class Output(val result: LocalEngineResult.Completed) : LocalSliceOutcome
    data class Failed(override val status: String) : LocalSliceOutcome
    /** [terminated] when the engine did not stop in time and its process was ended. */
    data class Cancelled(val terminated: Boolean) : LocalSliceOutcome {
        override val status: String
            get() = LocalSlicing.failed(if (terminated) LocalSlicing.CANCELLED_TERMINATED else LocalSlicing.CANCELLED)
    }
    data object Interrupted : LocalSliceOutcome {
        override val status: String get() = LocalSlicing.failed(LocalSlicing.INTERRUPTED)
    }
    data object Unknown : LocalSliceOutcome {
        override val status: String get() = LocalSlicing.failed(LocalSlicing.UNKNOWN_OUTCOME)
    }
}

/** The engine's G-code, claimed from the job and checked: where it is now, its length and SHA-256. */
class VerifiedGcode internal constructor(val file: File, val bytes: Long, val sha256: String)

/** A local output that must not be published, in words for the status line. */
class LocalSliceRefusal(message: String) : IOException(message)

/**
 * The local slicing route's platform-free half: staging a job's immutable
 * inputs, reading the engine's documents strictly, mapping how a job ended to
 * its outcome, and claiming, verifying and publishing its output only for
 * the project state it was sliced from — so stale, partial or substituted
 * G-code never becomes previewable or sendable.
 */
object LocalSlicing {
    /** The browser's archive budget ([ProjectWorkspace.ARCHIVE]); the engine refuses more. */
    const val MAX_ARCHIVE_BYTES = 1L shl 30
    const val MAX_OVERRIDES_BYTES = 1L shl 20
    const val MAX_GCODE_BYTES = 2L shl 30
    /** The largest result or status document either process accepts. */
    const val MAX_DOCUMENT_CHARS = 4096
    /** The browser's boundedMessage length. */
    const val MAX_MESSAGE_CHARS = 240

    const val CANCELLED = "Cancelled by user"
    const val CANCELLED_TERMINATED = "Cancelled by user; the slicing engine did not stop in time and was ended."
    const val INTERRUPTED = "the slicing engine stopped unexpectedly; the project is unchanged. Slice again."
    const val UNKNOWN_OUTCOME = "the slicing engine stopped answering; its output was discarded."
    const val BUSY = "the slicing engine is already slicing."

    private val JOB = Regex("[0-9a-f]{32}")
    private val DIGEST = Regex("[0-9a-f]{64}")
    private val OPTION = Regex("[a-z0-9_]{1,96}")
    private val STAGES = setOf("inputs", "project", "configuration", "validation", "processing", "export", "output")
    private val CODES = setOf("invalid-input", "project-load", "configuration", "validation", "engine", "memory", "output", "invalid-result")
    private val LIMITS = ProjectIntentLimits(MAX_DOCUMENT_CHARS, 64, 4)

    /** A failed slice in the browser's status line. */
    fun failed(message: String) = "slice failed: $message"

    // --- Staging --------------------------------------------------------------------------------

    /**
     * Stages job [id] (32 lowercase hex digits) under [root]: a new private
     * directory, the plate archive [write] produces (the host's
     * [ProjectWorkspace.projectPlate]), and its overrides as the canonical
     * JSON the external route submits. Each input is synced, made read-only
     * and hashed from the disk; a failure leaves nothing behind.
     */
    fun stage(root: File, id: String, write: (ProjectDocumentOutput) -> ProjectPlateArchive): LocalSliceJob {
        require(JOB.matches(id)) { "invalid_job" }
        val base = root.toPath()
        Files.createDirectories(base)
        check(Files.isDirectory(base, LinkOption.NOFOLLOW_LINKS)) { "invalid_job_root" }
        val directory = Files.createDirectory(base.resolve(id)).toFile()
        try {
            val archiveFile = File(directory, "input.3mf")
            val archive = write(object : ProjectDocumentOutput {
                override fun openOutput(): OutputStream = SyncedOutput(FileOutputStream(archiveFile))
            })
            val archiveInput = sealed(archiveFile, MAX_ARCHIVE_BYTES)
            val overridesFile = File(directory, "overrides.json")
            val text = CanonicalJson.write(archive.overrides).toByteArray(Charsets.US_ASCII)
            check(text.size <= MAX_OVERRIDES_BYTES) { "overrides_too_large" }
            SyncedOutput(FileOutputStream(overridesFile)).use { it.write(text) }
            val overridesInput = sealed(overridesFile, MAX_OVERRIDES_BYTES)
            return LocalSliceJob(id, directory, archiveInput, overridesInput, File(directory, "output.gcode"),
                archive.sourceHash, archive.revision, archive.warnings.size, archive.thumbnails, archive.warnings.map { String(it) })
        } catch (failure: Throwable) {
            deleteTree(directory.toPath())
            throw failure
        }
    }

    /** A staged file made read-only and hashed as it is on the disk. */
    private fun sealed(file: File, limit: Long): LocalSliceInput {
        check(file.setReadOnly()) { "input_not_sealed" }
        val (bytes, digest) = digest(file.toPath(), limit, null)
        return LocalSliceInput(file, bytes, digest)
    }

    /** Writes through to the file and syncs it to the disk before closing. */
    private class SyncedOutput(private val file: FileOutputStream) : FilterOutputStream(file) {
        override fun write(b: ByteArray, off: Int, len: Int) = out.write(b, off, len)
        override fun close() {
            file.use {
                it.flush()
                it.fd.sync()
            }
        }
    }

    /** Removes every job [root] holds — from an earlier run of the app, none of it running now. */
    fun sweep(root: File) {
        val base = root.toPath()
        if (!Files.isDirectory(base, LinkOption.NOFOLLOW_LINKS)) return
        Files.newDirectoryStream(base).use { entries -> entries.toList() }.forEach(::deleteTree)
    }

    /** Removes [job]'s directory and everything in it. */
    fun discard(job: LocalSliceJob) = discard(job.directory)

    /** Removes a job [directory] and everything in it, never following a link out of it. */
    fun discard(directory: File) = deleteTree(directory.toPath())

    /** Deletes [path] and, for a directory, its contents — never following a link out of it. */
    internal fun deleteTree(path: Path) {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
        Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attributes: BasicFileAttributes): FileVisitResult {
                // A sealed input is deleted as it is: its directory, not its mode, governs removal.
                Files.delete(file)
                return FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(directory: Path, failure: IOException?): FileVisitResult {
                if (failure != null) throw failure
                Files.delete(directory)
                return FileVisitResult.CONTINUE
            }
        })
    }

    // --- Documents --------------------------------------------------------------------------------

    /** The engine's result document, read strictly: exact fields, known stages and codes, bounded words. */
    fun result(text: String): LocalEngineResult = try {
        result(ProjectIntentJson.parse(text, LIMITS))
    } catch (_: InvalidProjectIntent) {
        throw IllegalArgumentException("invalid_engine_result")
    }

    private fun result(value: Any): LocalEngineResult {
        val obj = value as? ProjectJsonObject ?: throw InvalidProjectIntent()
        val keys = obj.keys().asSequence().toSet()
        if (!keys.contains("schemaVersion") || ProjectIntentJson.integer(obj.get("schemaVersion"), 1, 1) != 1L) throw InvalidProjectIntent()
        return when (obj.get("outcome")) {
            "completed" -> {
                exact(keys, "schemaVersion", "outcome", "stage", "objects", "gcodeBytes", "gcodeSha256", "rejectedOverrides")
                if (obj.get("stage") != "output") throw InvalidProjectIntent()
                LocalEngineResult.Completed(
                    ProjectIntentJson.integer(obj.get("objects"), 1, Int.MAX_VALUE.toLong()),
                    ProjectIntentJson.integer(obj.get("gcodeBytes"), 1, MAX_GCODE_BYTES),
                    digest(obj.get("gcodeSha256")),
                    ProjectIntentJson.integer(obj.get("rejectedOverrides"), 0, 4096),
                )
            }
            "failed" -> {
                val option = keys.contains("option")
                exact(keys, *listOfNotNull("schemaVersion", "outcome", "stage", "code", "message", if (option) "option" else null).toTypedArray())
                val code = obj.get("code") as? String ?: throw InvalidProjectIntent()
                if (code !in CODES) throw InvalidProjectIntent()
                LocalEngineResult.Failed(stage(obj.get("stage")), code, words(obj.get("message")),
                    if (option) (obj.get("option") as? String)?.takeIf(OPTION::matches) ?: throw InvalidProjectIntent() else null)
            }
            "cancelled" -> {
                exact(keys, "schemaVersion", "outcome", "stage")
                LocalEngineResult.Cancelled(stage(obj.get("stage")))
            }
            "busy" -> {
                exact(keys, "schemaVersion", "outcome")
                LocalEngineResult.Busy
            }
            else -> throw InvalidProjectIntent()
        }
    }

    /** A job's status document, as the engine's process answers a poll. */
    fun status(text: String): LocalSliceStatus = try {
        val obj = ProjectIntentJson.parse(text, LIMITS) as? ProjectJsonObject ?: throw InvalidProjectIntent()
        val keys = obj.keys().asSequence().toSet()
        if (ProjectIntentJson.integer(obj.get("schemaVersion"), 1, 1) != 1L) throw InvalidProjectIntent()
        when (obj.get("state")) {
            "running" -> {
                exact(keys, "schemaVersion", "state", "percent", "message")
                val percent = ProjectIntentJson.integer(obj.get("percent"), -1, 100).toInt()
                LocalSliceStatus.Running(percent.takeIf { it >= 0 }, words(obj.get("message"), allowEmpty = true))
            }
            "done" -> {
                exact(keys, "schemaVersion", "state", "result")
                LocalSliceStatus.Done(result(obj.get("result")))
            }
            "unknown" -> {
                exact(keys, "schemaVersion", "state")
                LocalSliceStatus.Unknown
            }
            else -> throw InvalidProjectIntent()
        }
    } catch (_: InvalidProjectIntent) {
        throw IllegalArgumentException("invalid_engine_status")
    }

    /** A running job's status document; the engine's step name is bounded to printable ASCII. */
    fun running(percent: Int, message: String): String {
        val shown = if (percent in 0..100) percent else -1
        return "{\"schemaVersion\":1,\"state\":\"running\",\"percent\":$shown,\"message\":${CanonicalJson.quote(printable(message))}}"
    }

    /** A finished job's status document around the engine's own [result] (checked first). */
    fun done(result: String): String {
        result(result)
        return "{\"schemaVersion\":1,\"state\":\"done\",\"result\":$result}"
    }

    const val UNKNOWN = "{\"schemaVersion\":1,\"state\":\"unknown\"}"

    private fun exact(keys: Set<String>, vararg names: String) {
        if (keys != names.toSet()) throw InvalidProjectIntent()
    }

    private fun stage(value: Any): String = (value as? String)?.takeIf { it in STAGES } ?: throw InvalidProjectIntent()

    private fun digest(value: Any): String = (value as? String)?.takeIf(DIGEST::matches) ?: throw InvalidProjectIntent()

    private fun words(value: Any, allowEmpty: Boolean = false): String {
        val text = value as? String ?: throw InvalidProjectIntent()
        if ((text.isEmpty() && !allowEmpty) || text.length > MAX_MESSAGE_CHARS || text.any { it.code !in 0x20..0x7e }) throw InvalidProjectIntent()
        return text
    }

    private fun printable(text: String): String =
        text.map { if (it.code in 0x20..0x7e) it else ' ' }.joinToString("").trim().take(MAX_MESSAGE_CHARS)

    // --- Outcomes ---------------------------------------------------------------------------------

    /** How [end] reads as an outcome, with the browser's words where it has them. */
    fun outcome(end: LocalEngineEnd): LocalSliceOutcome = when (end) {
        is LocalEngineEnd.Reported -> when (val result = end.result) {
            is LocalEngineResult.Completed -> LocalSliceOutcome.Output(result)
            is LocalEngineResult.Cancelled -> LocalSliceOutcome.Cancelled(terminated = false)
            LocalEngineResult.Busy -> LocalSliceOutcome.Failed(failed(BUSY))
            // The browser engine's own wording for a refused print, then the engine's words.
            is LocalEngineResult.Failed -> LocalSliceOutcome.Failed(
                failed(if (result.code == "validation") "validate failed: ${result.message}" else result.message),
            )
        }
        is LocalEngineEnd.Died -> if (end.afterCancel) LocalSliceOutcome.Cancelled(terminated = true) else LocalSliceOutcome.Interrupted
        LocalEngineEnd.Lost -> LocalSliceOutcome.Unknown
    }

    // --- Output -----------------------------------------------------------------------------------

    /**
     * Claims [job]'s G-code the engine reported as [result]: moved out of the
     * job directory to [part] (the engine no longer names it), then checked as
     * a regular file of exactly the reported length and SHA-256, valid UTF-8
     * text as the browser decodes it (fatal), with no NUL. Every byte also
     * passes through [observer] (the host's tally of lines and layers).
     * Anything else is refused and [part] removed.
     */
    fun claim(job: LocalSliceJob, result: LocalEngineResult.Completed, part: File, observer: OutputStream? = null): VerifiedGcode {
        val source = job.output.toPath()
        if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) throw LocalSliceRefusal(NO_OUTPUT)
        val target = part.toPath()
        Files.createDirectories(target.parent)
        Files.move(source, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        try {
            if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS) || Files.size(target) != result.gcodeBytes) {
                throw LocalSliceRefusal(MISMATCH)
            }
            val (bytes, sha) = digest(target, MAX_GCODE_BYTES, Utf8Text(observer))
            if (bytes != result.gcodeBytes || sha != result.gcodeSha256) throw LocalSliceRefusal(MISMATCH)
            return VerifiedGcode(part, bytes, sha)
        } catch (failure: Throwable) {
            Files.deleteIfExists(target)
            throw failure
        }
    }

    /**
     * [verified] with [job]'s pictures where the engine puts them
     * ([GcodeThumbnails.embed]), written to [part] — every byte passing
     * through [observer] — and read back for its length and SHA-256; the
     * engine's own file is removed. The published G-code is this one, as the
     * browser's route puts the pictures into the artifact it hashes.
     */
    fun withThumbnails(verified: VerifiedGcode, job: LocalSliceJob, part: File, observer: OutputStream? = null): VerifiedGcode {
        try {
            val sink = if (observer == null) FileOutputStream(part) else Tee(FileOutputStream(part), observer)
            sink.use { GcodeThumbnails.embed(verified.file, job.thumbnails.blocks, it) }
            val (bytes, sha) = digest(part.toPath(), MAX_GCODE_BYTES, null)
            Files.deleteIfExists(verified.file.toPath())
            return VerifiedGcode(part, bytes, sha)
        } catch (failure: Throwable) {
            Files.deleteIfExists(part.toPath())
            throw failure
        }
    }

    /** Writes to [file] and [observer] alike; closing closes only [file]. */
    private class Tee(private val file: OutputStream, private val observer: OutputStream) : OutputStream() {
        override fun write(b: Int) {
            file.write(b)
            observer.write(b)
        }
        override fun write(b: ByteArray, off: Int, len: Int) {
            file.write(b, off, len)
            observer.write(b, off, len)
        }
        override fun flush() {
            file.flush()
            observer.flush()
        }
        override fun close() {
            file.close()
        }
    }

    /**
     * Publishes [verified] to [destination] only while the project is still
     * [current] — the state [job] was staged from. Stale output is deleted and
     * null returned: it never becomes previewable or sendable.
     */
    fun publish(verified: VerifiedGcode, job: LocalSliceJob, current: ProjectRevision?, destination: File): File? {
        val part = verified.file.toPath()
        if (job.revision == null || current != job.revision) {
            Files.deleteIfExists(part)
            return null
        }
        Files.createDirectories(destination.toPath().parent)
        Files.move(part, destination.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        return destination
    }

    const val NO_OUTPUT = "The slicing engine wrote no G-code."
    const val MISMATCH = "The G-code on the disk is not what the slicing engine reported; it was discarded."
    const val NOT_TEXT = "The slicing engine's G-code is not UTF-8 text; it was discarded."

    /** Length and SHA-256 of a regular file of at most [limit] bytes, each chunk handed to [observer]. */
    private fun digest(path: Path, limit: Long, observer: Utf8Text?): Pair<Long, String> {
        val sha = MessageDigest.getInstance("SHA-256")
        var total = 0L
        Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS).use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                check(total <= limit) { "file_too_large" }
                sha.update(buffer, 0, count)
                observer?.write(buffer, 0, count)
            }
        }
        observer?.finish()
        return total to sha.digest().joinToString("") { "%02x".format(it) }
    }

    /** Strict UTF-8 across chunk boundaries (the browser's fatal TextDecoder), refusing NUL. */
    private class Utf8Text(private val observer: OutputStream?) {
        private val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        private val pending = ByteBuffer.allocate((1 shl 16) + 8)
        private val chars = CharBuffer.allocate((1 shl 16) + 8)

        fun write(bytes: ByteArray, offset: Int, length: Int) {
            observer?.write(bytes, offset, length)
            for (index in offset until offset + length) if (bytes[index] == 0.toByte()) throw LocalSliceRefusal(NOT_TEXT)
            var start = offset
            while (start < offset + length) {
                val count = minOf(pending.remaining(), offset + length - start)
                pending.put(bytes, start, count)
                start += count
                decode(endOfInput = false)
            }
        }

        fun finish() {
            decode(endOfInput = true)
            observer?.flush()
        }

        private fun decode(endOfInput: Boolean) {
            pending.flip()
            while (true) {
                chars.clear()
                val result = decoder.decode(pending, chars, endOfInput)
                if (result.isError) throw LocalSliceRefusal(NOT_TEXT)
                if (result.isUnderflow) break
            }
            if (endOfInput) {
                chars.clear()
                if (decoder.flush(chars).isError || pending.hasRemaining()) throw LocalSliceRefusal(NOT_TEXT)
            }
            pending.compact()
        }
    }
}
