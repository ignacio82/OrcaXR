package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.SliceBinding
import dev.orcaxr.core.SliceEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** What both routes publish beside a sliced plate's G-code, and the identities its sidecar binds. */
class SliceOutputsTest {
    private val commit = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626"
    private val digest = "ab".repeat(32)

    @Test
    fun aSidecarLiesBesideItsGcodeUnderItsName() {
        val gcode = File("/cache/prepare/gcode/1/Untitled_Plate 1.gcode")
        assertEquals(File("/cache/prepare/gcode/1/Untitled_Plate 1.gcode.json"), SliceOutputs.sidecarFile(gcode))
    }

    @Test
    fun oneJobIdNamesEveryPlateItSlices() {
        val id = SliceOutputs.jobId(UUID.fromString("0123abcd-4567-89ef-0123-456789abcdef"))
        assertEquals("slice-0123abcd456789ef0123456789abcdef", id)
        // A binding's bounded canonical string: 1 to 512 units, as trimmed as it is.
        assertTrue(id.length in 1..512 && id.trim() == id)
    }

    @Test
    fun thePackagedEngineIsItsCommitAndItsPackageDigest() {
        assertEquals(SliceEngine(commit, "sha256:$digest"), SliceOutputs.packagedEngine(commit, digest))
        assertNull(SliceOutputs.packagedEngine(null, digest))
        assertNull(SliceOutputs.packagedEngine(commit, null))
        assertNull(SliceOutputs.packagedEngine(commit.uppercase(), digest))
        assertNull(SliceOutputs.packagedEngine(commit.drop(1), digest))
        assertNull(SliceOutputs.packagedEngine(commit, "sha256:$digest"))
        assertNull(SliceOutputs.packagedEngine(commit, digest.drop(2)))
    }

    @Test
    fun aFileIsHashedAsItIsWrittenAndAsItIsRead() {
        val directory = Files.createTempDirectory("slice-outputs").toFile()
        try {
            val file = File(directory, "plate.gcode")
            val hashed = SliceOutputs.HashedFile(file)
            hashed.output.use { it.write("abc".toByteArray()) }
            // SHA-256("abc"), the FIPS 180-2 example.
            val abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            assertEquals(abc, hashed.hex())
            assertEquals(abc, SliceOutputs.sha256(file))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun aSidecarIsWrittenWholeOrNotAtAll() {
        val directory = Files.createTempDirectory("slice-outputs").toFile()
        try {
            val gcode = File(directory, "plate.gcode").apply { writeText("G28\n") }
            File(directory, "plate.gcode.json").writeText("stale")
            val written = SliceOutputs.writeSidecar(gcode, """{"schema":"orcaxr.slice-output","warnings":["é"]}""")
            assertEquals(File(directory, "plate.gcode.json"), written)
            assertEquals("""{"schema":"orcaxr.slice-output","warnings":["é"]}""", written.readText(Charsets.UTF_8))
            assertFalse(File(directory, "plate.gcode.json.part").exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun aBindingIsWrittenAsCanonicalJson() {
        val binding = SliceBinding(
            "slice-1", "plate \"1\"\u00e9", 7, "fnv1a64:0123456789abcdef", "fnv1a64:fedcba9876543210",
            "sha256:$digest", "sha256:$digest", "sha256:$digest", commit, "sha256:$digest",
        )
        assertEquals(
            "{\"effectiveConfigHash\":\"sha256:$digest\",\"engineArtifactHash\":\"sha256:$digest\",\"engineCommit\":\"$commit\"," +
                "\"gcodeOutputHash\":\"sha256:$digest\",\"jobId\":\"slice-1\",\"plateId\":\"plate \\\"1\\\"\\u00e9\"," +
                "\"projectInputHash\":\"sha256:$digest\",\"sourceAssetHash\":\"fnv1a64:fedcba9876543210\"," +
                "\"sourceHash\":\"fnv1a64:0123456789abcdef\",\"sourceRevision\":7}",
            binding.json(),
        )
        assertEquals("sha256:$digest", SliceBinding.sha256(digest))
    }
}
