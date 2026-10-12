package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.SliceEngine
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.security.DigestOutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * What both routes publish beside each sliced plate's G-code: its sidecar
 * (`orcaxr.slice-output`, assembled by the shared core), which binds the file
 * to the job, the plate, the project's revision and fingerprints, the
 * archive the engine read, the G-code's own SHA-256, the effective
 * configuration and the engine — the identities the browser's coordinator
 * binds every plate's result to — and carries the engine's own totals.
 */
object SliceOutputs {
    /** A plate's sidecar: beside its G-code, under the G-code's own name with this added. */
    const val SIDECAR_SUFFIX = ".json"

    /** Why this device's engine cannot bind its output. */
    const val UNIDENTIFIED_ENGINE = "This build's slicing engine does not state its commit and package digest."

    private val COMMIT = Regex("[0-9a-f]{40}")
    private val DIGEST = Regex("[0-9a-f]{64}")

    fun sidecarFile(gcode: File): File = File(gcode.parentFile, gcode.name + SIDECAR_SUFFIX)

    /** One job's ID, shared by every plate it slices: `slice-` and the UUID's 32 hex digits. */
    fun jobId(uuid: UUID): String = "slice-" + uuid.toString().replace("-", "")

    /**
     * This device's engine as the build packaged it: the engine manifest's
     * commit, and as its artifact the SHA-256 of the ABI's verified adapter
     * export manifest — which names every library and resource the engine
     * loads. Null unless both are complete.
     */
    fun packagedEngine(commit: String?, packageSha256: String?): SliceEngine? =
        if (commit != null && packageSha256 != null && COMMIT.matches(commit) && DIGEST.matches(packageSha256)) {
            SliceEngine(commit, "sha256:$packageSha256")
        } else {
            null
        }

    /** Lowercase hex of a finished digest. */
    fun hex(digest: MessageDigest): String = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** The SHA-256 of a file's bytes as lowercase hex, read a chunk at a time. */
    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return hex(digest)
    }

    /** A file written through a SHA-256 of what was written; [hex] reads it once the file is closed. */
    class HashedFile(file: File) {
        private val digest = MessageDigest.getInstance("SHA-256")
        val output: OutputStream = DigestOutputStream(FileOutputStream(file), digest)
        fun hex(): String = hex(digest)
    }

    /**
     * Writes [document] as [gcode]'s sidecar: a part file synced, then moved
     * into place, so a sidecar is either whole or absent.
     */
    fun writeSidecar(gcode: File, document: String): File {
        val target = sidecarFile(gcode)
        val part = File(target.parentFile, target.name + ".part")
        try {
            FileOutputStream(part).use { stream ->
                stream.write(document.toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
            check(part.renameTo(target)) { "OrcaXR could not keep the sliced G-code's sidecar." }
            return target
        } finally {
            part.delete()
        }
    }
}
