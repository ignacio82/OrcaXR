package dev.orcaxr.core

import java.io.InputStream

enum class ProjectArchiveFormat { CANONICAL, FOREIGN }

/** Archive Open input. Every detailed ZIP/XML/model/metadata/settings/OPC limit
 * derives from the generated options, identically to the browser WASM binding.
 * Run staging and preparation inside an actor openDocument/resetDocument producer:
 * the actor's original Open ticket or reset guard still decides adoption. */
class ProjectArchiveUpload(
    archiveBytes: Long,
    options: ProjectArchiveOptions,
    resolver: LocalTimestampResolver,
    profile: ProjectIntegerProfile,
) : ProjectHandle(NativeProject.archiveUploadNew(ProjectArchive.VERSION, archiveBytes, options.encode(), resolver, profile.bits)) {
    fun append(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectArchive.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.archiveUploadAppend(it, offset, bytes)
    }
    /** Consumes this upload on every outcome. Completes canonical or foreign import
     * synchronously; closing the handle (or its preparation scope) cancels it. */
    fun prepare(): ProjectArchiveImport = move {
        NativeProject.archiveUploadPrepare(it)
        own(it, ::ProjectArchiveImport)
    }
    companion object {
        /** Stages exactly [archiveBytes] from [input] in bounded chunks, refuses
         * trailing bytes, then prepares. Every handle is owned by [scope]. */
        fun prepare(
            scope: ProjectPreparation,
            input: InputStream,
            archiveBytes: Long,
            options: ProjectArchiveOptions,
            resolver: LocalTimestampResolver,
            profile: ProjectIntegerProfile,
        ): ProjectArchiveImport {
            val upload = scope.own(ProjectArchiveUpload(archiveBytes, options, resolver, profile))
            val buffer = ByteArray(ProjectArchive.MAX_CHUNK_BYTES)
            var offset = 0L
            while (offset < archiveBytes) {
                scope.checkActive()
                val count = input.read(buffer, 0, minOf(buffer.size.toLong(), archiveBytes - offset).toInt())
                check(count > 0) { "incomplete_archive" }
                upload.append(offset, if (count == buffer.size) buffer else buffer.copyOf(count))
                offset += count
            }
            check(input.read() < 0) { "archive_length_mismatch" }
            scope.checkActive()
            return scope.own(upload.prepare())
        }
    }
}

/** Shared bounded warning reads for archive results. Texts are the browser's
 * sorted, de-duplicated messages; some quote project text, lone surrogates kept. */
abstract class ProjectArchiveResult internal constructor(handle: Long) : ProjectHandle(handle) {
    fun warningCount(): Long = read { NativeProject.archiveWarningCount(it) }
    fun warningLength(position: Long): Long = read { NativeProject.archiveWarningLength(it, position) }
    fun warning(position: Long, start: Long, count: Long): CharArray = read { NativeProject.archiveWarning(it, position, start, count) }
    fun warnings(): List<CharArray> = read { handle ->
        List(NativeProject.archiveWarningCount(handle).toInt()) { position ->
            val length = NativeProject.archiveWarningLength(handle, position.toLong())
            val text = CharArray(length.toInt())
            var start = 0L
            while (start < length) {
                val chunk = NativeProject.archiveWarning(handle, position.toLong(), start, minOf(ProjectHost.MAX_TEXT_CHUNK_UNITS.toLong(), length - start))
                chunk.copyInto(text, start.toInt())
                start += chunk.size
            }
            text
        }
    }
}

/** Completed private import. Read the format and warnings, then take the
 * document once for the actor's guarded adoption. */
class ProjectArchiveImport internal constructor(handle: Long) : ProjectArchiveResult(handle) {
    fun format(): ProjectArchiveFormat = read {
        when (NativeProject.archiveFormat(it)) {
            ProjectArchive.FORMAT_CANONICAL -> ProjectArchiveFormat.CANONICAL
            ProjectArchive.FORMAT_FOREIGN -> ProjectArchiveFormat.FOREIGN
            else -> error("invalid_archive_format")
        }
    }
    /** Consumes this import; its native slot then holds the prepared document. */
    fun document(): ProjectDocument = move {
        NativeProject.archiveDocument(it)
        own(it, ::ProjectDocument)
    }
}

/** Complete 3MF package written from an immutable export capture. */
class ProjectArchiveOutput internal constructor(handle: Long) : ProjectArchiveResult(handle) {
    fun length(): Long = read { NativeProject.archiveLength(it) }
    fun read(start: Long, count: Long): ByteArray = read { NativeProject.archiveRead(it, start, count) }
}
