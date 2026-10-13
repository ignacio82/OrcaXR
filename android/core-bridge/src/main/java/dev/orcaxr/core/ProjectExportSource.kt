package dev.orcaxr.core

import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean

data class ProjectExportLimits(val jsonBytes: Long, val assets: Long, val assetBytes: Long) {
    internal fun validate() { require(listOf(jsonBytes, assets, assetBytes).all { it in 0..ProjectHost.MAX_BUDGET }) { "invalid_options" } }
}

/** One plate's slice archive, once every byte reached its destination: the
 * projected project's fingerprint (the browser's archive `sourceHash`), the
 * print overrides a submission carries with it, the Save warnings, the
 * plate's pictures the slice's G-code is to carry (drawn from the same
 * capture), the profile snapshot the plate is sliced with (of the same
 * capture), and — from [ProjectWorkspace.projectPlate] — the state of the
 * project it was written from. */
class ProjectPlateArchive(
    val sourceHash: String,
    val overrides: Map<String, String>,
    val warnings: List<CharArray>,
    val revision: ProjectRevision? = null,
    val thumbnails: PlateThumbnails = PlateThumbnails.NONE,
    val profiles: SliceProfiles? = null,
)

/** Borrowed on one export worker. Streams canonical JSON and assets in declaration
 * order through bounded owned chunks, or one complete 3MF package. The host owns
 * its destination, flushing, durable-write policy and handoff; return only after success.
 * A complete bundle must be consumed before a save can acknowledge its checkpoint.
 * Retained source calls refuse after the callback returns or the actor closes. */
class ProjectExportSource internal constructor(
    private val scope: ProjectPreparation,
    private val capture: ProjectExportCapture,
    private val project: ProjectSnapshot,
    private val limits: ProjectExportLimits,
) {
    private val workerId = Thread.currentThread().id
    private val active = AtomicBoolean(true)
    val assetCount: Long = capture.assetCount()
    private var nextAsset = 0L
    private var jsonWritten = false
    private var archiveWritten = false
    private var plateWritten = false
    private var answered = false
    init {
        check(assetCount <= limits.assets) { "resource_limit" }
        var total = 0L
        for (index in 0 until assetCount) {
            scope.checkActive()
            capture.asset(index).use { asset ->
                val bytes = asset.length()
                check(bytes <= limits.assetBytes - total) { "resource_limit" }
                total += bytes
            }
        }
    }
    private fun checkActive() {
        check(active.get()) { "closed_export" }
        check(Thread.currentThread().id == workerId) { "wrong_export_thread" }
        scope.checkActive()
    }
    fun assetLength(index: Long): Long { checkActive(); return capture.asset(index).use { it.length() } }
    fun assetIdLength(index: Long): Long { checkActive(); return capture.asset(index).use { it.idLength() } }
    fun assetId(index: Long, start: Long, count: Long): CharArray { checkActive(); return capture.asset(index).use { it.id(start, count) } }
    fun writeJson(destination: OutputStream): Long {
        checkActive(); check(!jsonWritten && !archiveWritten) { "already_written" }
        val bytes = project.writeJson(limits.jsonBytes) { chunk -> checkActive(); destination.write(chunk) }
        checkActive(); jsonWritten = true
        return bytes
    }
    fun writeAsset(index: Long, destination: OutputStream): Long {
        checkActive(); check(!archiveWritten) { "already_written" }; check(index == nextAsset) { "invalid_export_order" }
        return capture.asset(index).use { asset ->
            val length = asset.length()
            var offset = 0L
            while (offset < length) {
                checkActive()
                val bytes = asset.read(offset, minOf(ProjectHost.MAX_CHUNK_BYTES.toLong(), length - offset))
                destination.write(bytes); offset += bytes.size
            }
            checkActive(); nextAsset++
            length
        }
    }
    /** Alternative to the bundle stream: write this capture as one complete 3MF
     * package (canonical envelope plus standard BBS metadata). Returns the
     * browser's Save warnings once every byte reached [destination]. A refused
     * Save (for example unresolvable plate origins) writes nothing. */
    fun writeArchive(options: ProjectArchiveOptions, destination: OutputStream): List<CharArray> {
        checkActive(); check(!jsonWritten && nextAsset == 0L && !archiveWritten && !plateWritten) { "already_written" }
        return capture.writeArchive(options).use { output ->
            val warnings = copy(output, destination)
            checkActive(); archiveWritten = true
            warnings
        }
    }
    /** Alternative for an external slice: write plate [plateId]'s one-plate
     * archive ([ProjectExportCapture.plate], admitted under [resolver] and
     * [profile]) to [destination], and answer what the submission needs with
     * it — and the plate's pictures for its G-code, drawn from that capture. The plate's project is this capture's, so a guard checked against
     * this export is the projection's provenance. A plate archive completes an
     * export but never a save. A refused projection writes nothing. */
    fun writePlateArchive(
        plateId: String,
        options: ProjectArchiveOptions,
        resolver: LocalTimestampResolver,
        profile: ProjectIntegerProfile,
        destination: OutputStream,
    ): ProjectPlateArchive {
        checkActive(); check(!jsonWritten && nextAsset == 0L && !archiveWritten && !plateWritten) { "already_written" }
        return capture.plate(plateId, resolver, profile).use { plate ->
            val sourceHash = plate.project().use { it.hash() }
            val overrides = project.platePrintOverrides(plateId)
            val profiles = project.sliceProfiles(plateId)
            val warnings = plate.writeArchive(options).use { output -> copy(output, destination) }
            checkActive()
            // The plate's pictures, from the capture the archive was written from: as in the
            // browser, a picture is what a display shows, so one that cannot be drawn is none.
            val thumbnails = try {
                plate.thumbnails()
            } catch (_: IllegalStateException) {
                PlateThumbnails.NONE
            }
            checkActive(); plateWritten = true
            ProjectPlateArchive(sourceHash, overrides, warnings, thumbnails = thumbnails, profiles = profiles)
        }
    }
    /** Alternative for Export as 3MF…: this capture as the browser's own
     * package to [destination] (never a save: no checkpoint), or the refusal,
     * which writes nothing. */
    fun writeProjectArchive(options: ProjectArchiveOptions, destination: OutputStream): ProjectArchiveExport {
        checkActive(); check(!jsonWritten && nextAsset == 0L && !archiveWritten && !plateWritten && !answered) { "already_written" }
        val answer = capture.writeProjectArchive(options, object : OutputStream() {
            override fun write(value: Int) { checkActive(); destination.write(value) }
            override fun write(bytes: ByteArray, offset: Int, count: Int) { checkActive(); destination.write(bytes, offset, count) }
        })
        checkActive(); answered = true
        return answer
    }
    /** Alternative for a File menu export: this capture's STL — one merged file,
     * or one per instance in the browser's ZIP ([ModelExports.stlRequest]) — to
     * [destination], or the browser's refusal, which writes nothing. Either
     * completes an export, never a save. */
    fun writeStl(request: String, destination: OutputStream): StlExport {
        checkActive(); check(!jsonWritten && nextAsset == 0L && !archiveWritten && !plateWritten && !answered) { "already_written" }
        val answer = capture.writeStl(request, object : OutputStream() {
            override fun write(value: Int) { checkActive(); destination.write(value) }
            override fun write(bytes: ByteArray, offset: Int, count: Int) { checkActive(); destination.write(bytes, offset, count) }
        })
        checkActive(); answered = true
        return answer
    }
    /** Alternative for Export Diagnostics…: this capture's project shape
     * (counts and object names, never geometry); completes an export, never a save. */
    fun diagnosticsSummary(): Diagnostics.ProjectShape {
        checkActive(); check(!jsonWritten && nextAsset == 0L && !archiveWritten && !plateWritten && !answered) { "already_written" }
        val shape = capture.diagnosticsSummary()
        checkActive(); answered = true
        return shape
    }
    private fun copy(output: ProjectArchiveOutput, destination: OutputStream): List<CharArray> {
        val length = output.length()
        var offset = 0L
        while (offset < length) {
            checkActive()
            val bytes = output.read(offset, minOf(ProjectArchive.MAX_CHUNK_BYTES.toLong(), length - offset))
            destination.write(bytes); offset += bytes.size
        }
        return output.warnings()
    }
    /** Whether the callback consumed the capture: the complete bundle, or for
     * an export (never a [save]) one plate's archive, or its STL's, 3MF's or
     * diagnostics shape's answer. */
    internal fun requireComplete(save: Boolean) {
        checkActive()
        check(archiveWritten || (jsonWritten && nextAsset == assetCount) || (!save && (plateWritten || answered))) { "incomplete_export" }
    }
    internal fun invalidate() { active.set(false) }
}
