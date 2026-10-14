package dev.orcaxr.core

import java.io.InputStream
import java.security.SecureRandom

/**
 * Bed placement for a model import: centred on [bedArea] (printer mm, the
 * workspace bed's [WorkspaceBed.areaMm]: the midpoint of its corners, which a
 * printer may offset from the bed corner), or kept where the source put it.
 */
data class ProjectModelPlacement(val bedArea: PrintableArea? = null, val dropToBed: Boolean = false) {
    internal fun encode(): DoubleArray {
        val area = bedArea ?: return DoubleArray(0)
        val corners = doubleArrayOf(area.xMin, area.yMin, area.xMax, area.yMax)
        require(corners.all(Double::isFinite)) { "invalid_options" }
        return corners
    }
}

/** Model source bytes (STL/OBJ/AMF/ZIP), staged in bounded chunks. Null length
 * stages open-ended input under [ProjectModelImportOptions.maxBytes]. */
class ProjectModelUpload(
    modelBytes: Long?,
    options: ProjectModelImportOptions,
    resolver: LocalTimestampResolver,
    profile: ProjectIntegerProfile,
) : ProjectHandle(NativeProject.modelUploadNew(ProjectModelImport.VERSION, modelBytes.also { require(it == null || it >= 0) { "input_limit" } } ?: -1, options.encode(), resolver, profile.bits)) {
    fun append(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectModelImport.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.modelUploadAppend(it, offset, bytes)
    }
    internal companion object {
        fun stream(scope: ProjectPreparation, input: InputStream, length: Long?, options: ProjectModelImportOptions,
            resolver: LocalTimestampResolver, profile: ProjectIntegerProfile): ProjectModelUpload {
            val upload = scope.own(ProjectModelUpload(length, options, resolver, profile))
            val buffer = ByteArray(ProjectModelImport.MAX_CHUNK_BYTES)
            var offset = 0L
            while (length == null || offset < length) {
                scope.checkActive()
                val wanted = if (length == null) buffer.size else minOf(buffer.size.toLong(), length - offset).toInt()
                val count = input.read(buffer, 0, wanted)
                if (count < 0 && length == null) break
                check(count > 0) { "incomplete_archive" }
                upload.append(offset, if (count == buffer.size) buffer else buffer.copyOf(count))
                offset += count
            }
            if (length != null) check(input.read() < 0) { "archive_length_mismatch" }
            return upload
        }
    }
}

/** Stable-ID source for staged entities. */
sealed interface ProjectImportIds {
    /** Production: UUIDv4 from a fresh secure seed. */
    data object Random : ProjectImportIds
    /** Deterministic replay: `import:<namespace>:<kind>-<n>`. */
    data class Counter(val namespace: String) : ProjectImportIds
}

/** The base an import is prepared against, captured on the actor's authority. */
class ProjectImportBase internal constructor(handle: Long) : ProjectHandle(handle) {
    /** Consumes [upload] on every outcome. Decoding, staging and preview are
     * synchronous and belong to the preparation worker; closing cancels them. */
    fun prepareModel(
        upload: ProjectModelUpload,
        filename: String,
        importedAt: String,
        placement: ProjectModelPlacement = ProjectModelPlacement(),
        ids: ProjectImportIds = ProjectImportIds.Random,
    ): ProjectImportPreview {
        val bed = placement.encode()
        val (seed, namespace) = when (ids) {
            ProjectImportIds.Random -> SecureRandom().let { random -> LongArray(4) { random.nextLong() } } to null
            is ProjectImportIds.Counter -> LongArray(0) to ids.namespace
        }
        return read { base ->
            upload.move { input ->
                NativeProject.importPrepareModel(input, base, filename.toCharArray(), importedAt.toCharArray(), bed, placement.dropToBed, seed, namespace)
                own(input, ::ProjectImportPreview)
            }
        }
    }

    /** Prepares a 3MF geometry-only import, merging objects/meshes into the active plate. */
    fun prepareGeometry(
        upload: ProjectModelUpload,
        filename: String,
        importedAt: String,
        placement: ProjectModelPlacement = ProjectModelPlacement(),
        ids: ProjectImportIds = ProjectImportIds.Random,
    ): ProjectImportPreview {
        val bed = placement.encode()
        val (seed, namespace) = when (ids) {
            ProjectImportIds.Random -> SecureRandom().let { random -> LongArray(4) { random.nextLong() } } to null
            is ProjectImportIds.Counter -> LongArray(0) to ids.namespace
        }
        return read { base ->
            upload.move { input ->
                NativeProject.importPrepareGeometry(input, base, filename.toCharArray(), importedAt.toCharArray(), bed, placement.dropToBed, seed, namespace)
                own(input, ::ProjectImportPreview)
            }
        }
    }
}

/** The browser's import preview (canonical JSON) and its private candidate. */
class ProjectImportPreview internal constructor(handle: Long) : ProjectHandle(handle) {
    fun blocked(): Boolean = read { NativeProject.importPreviewBlocked(it) }
    fun json(): String = read { handle ->
        val length = NativeProject.importPreviewLength(handle)
        val out = java.io.ByteArrayOutputStream(length.toInt())
        var start = 0L
        while (start < length) {
            val chunk = NativeProject.importPreviewRead(handle, start, minOf(ProjectModelImport.MAX_CHUNK_BYTES.toLong(), length - start))
            out.write(chunk); start += chunk.size
        }
        out.toString(Charsets.UTF_8.name())
    }
}

internal fun jsonStrings(values: List<String>): String = buildString {
    append('[')
    values.forEachIndexed { index, value ->
        if (index > 0) append(',')
        append('"')
        for (c in value) when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c < ' ' || c.isSurrogate() -> append("\\u").append(c.code.toString(16).padStart(4, '0'))
            else -> append(c)
        }
        append('"')
    }
    append(']')
}
