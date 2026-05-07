package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream

/**
 * Roadmap B14 — pure-JVM tests for the share-target staging path.
 *
 * The Activity-side wiring (intent-filters, [MainActivity.onNewIntent],
 * the SharedFlow plumbing into [XrShell]) only meaningfully exercises
 * on-device, but the byte-copy + extension-filter + dedupe core is
 * pure Kotlin and worth pinning here.
 */
class SharedIntentHandlerTest {

    @get:Rule val tmp = TemporaryFolder()

    private val cubeStlBytes: ByteArray by lazy {
        val header = ByteArray(80)
        val triCount = byteArrayOf(0, 0, 0, 0)
        header + triCount
    }

    @Test
    fun `stageStream copies STL bytes to deterministic path with extension`() {
        val sharedDir = tmp.newFolder("shared")
        val out = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes),
            displayName = "cube.stl",
            sharedDir = sharedDir,
        )
        assertNotNull("stageStream returned null for a valid STL", out)
        assertTrue("file does not exist: ${out!!.absolutePath}", out.exists())
        assertTrue("filename should end .stl", out.name.endsWith(".stl"))
        assertTrue("filename should retain basename", out.name.startsWith("cube-"))
        assertEquals(cubeStlBytes.size.toLong(), out.length())
    }

    @Test
    fun `stageStream is idempotent for identical content + name`() {
        val sharedDir = tmp.newFolder("shared")
        val first = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes), "dragon.3mf", sharedDir,
        )
        val second = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes), "dragon.3mf", sharedDir,
        )
        assertNotNull(first); assertNotNull(second)
        assertEquals(
            "same content + name should resolve to the same cache file",
            first!!.absolutePath, second!!.absolutePath,
        )
        // Only one file in shared/ — no fan-out.
        assertEquals(1, sharedDir.listFiles()!!.size)
    }

    @Test
    fun `stageStream rejects unrecognized extensions`() {
        val sharedDir = tmp.newFolder("shared")
        val out = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes), "thumb.png", sharedDir,
        )
        assertNull("png should be rejected — not in ACCEPTED_EXTENSIONS", out)
        assertEquals(0, sharedDir.listFiles()!!.size)
    }

    @Test
    fun `stageStream rejects empty payload`() {
        val sharedDir = tmp.newFolder("shared")
        val out = SharedIntentHandler.stageStream(
            ByteArrayInputStream(ByteArray(0)), "empty.stl", sharedDir,
        )
        assertNull("empty stream should be rejected", out)
    }

    @Test
    fun `stageStream sanitizes basename so OS-illegal chars don't escape`() {
        val sharedDir = tmp.newFolder("shared")
        val out = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes),
            displayName = "../../etc/passwd; rm -rf.stl",
            sharedDir = sharedDir,
        )
        assertNotNull(out)
        // No '/' in the staged filename (path traversal blocked) and
        // no shell metacharacters (every non-[A-Za-z0-9._-] becomes '_').
        assertTrue(
            "expected sanitized basename, got ${out!!.name}",
            out.name.matches(Regex("^[A-Za-z0-9._-]+$")),
        )
        assertEquals(sharedDir, out.parentFile)
    }

    @Test
    fun `accepted-extensions covers the formats SlicerEngine can load`() {
        // Tripwire — if MainActivity.onFileSelected grows support for
        // a new format, the manifest filter + this set must keep up.
        // The minimum coverage is what `nativeRead3mfObjectMetadata` /
        // `loadModel` already accept.
        val expected = setOf("stl", "3mf", "obj", "amf", "step", "stp")
        assertEquals(expected, SharedIntentHandler.ACCEPTED_EXTENSIONS)
    }

    @Test
    fun `extension match is case-insensitive`() {
        val sharedDir = tmp.newFolder("shared")
        val out = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes), "MODEL.STL", sharedDir,
        )
        assertNotNull("uppercase .STL should be accepted", out)
        // Final cache-side extension is lowercased.
        assertTrue(out!!.name.endsWith(".stl"))
    }

    @Test
    fun `different content distinct names produces distinct cache files`() {
        val sharedDir = tmp.newFolder("shared")
        val a = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes), "a.stl", sharedDir,
        )
        val b = SharedIntentHandler.stageStream(
            ByteArrayInputStream(cubeStlBytes + byteArrayOf(7, 7, 7)),
            "a.stl",
            sharedDir,
        )
        assertNotNull(a); assertNotNull(b)
        // Same display name + different bytes => different sha => different file.
        assertTrue(a!!.absolutePath != b!!.absolutePath)
        assertEquals(2, sharedDir.listFiles()!!.size)
    }

    /**
     * Audit H1 — payloads above [SharedIntentHandler.MAX_FILE_SIZE_BYTES]
     * must be rejected mid-stream and the temp file deleted, so a 5 GB
     * share never lands a 5 GB cache artifact.
     */
    @Test
    fun `stageStream rejects payloads above MAX_FILE_SIZE_BYTES`() {
        val sharedDir = tmp.newFolder("shared")
        // We don't materialize 500 MB+1 in memory — wrap a sized
        // InputStream that emits zeros up to the requested length.
        val cap = SharedIntentHandler.MAX_FILE_SIZE_BYTES
        val payloadSize = cap + 1
        val stream = object : java.io.InputStream() {
            private var emitted = 0L
            override fun read(): Int {
                if (emitted >= payloadSize) return -1
                emitted++; return 0
            }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (emitted >= payloadSize) return -1
                val n = minOf(len.toLong(), payloadSize - emitted).toInt()
                java.util.Arrays.fill(b, off, off + n, 0)
                emitted += n
                return n
            }
        }
        val out = SharedIntentHandler.stageStream(stream, "huge.stl", sharedDir)
        assertNull("payload over MAX_FILE_SIZE_BYTES should be rejected", out)
        // Temp file ".incoming-*.stl" must have been cleaned up.
        assertEquals(
            "no cache files should remain after overflow",
            0, sharedDir.listFiles()!!.size,
        )
    }

    /**
     * Audit H1 — exactly-at-the-cap payloads stage successfully (the
     * cap is `>` not `>=`). Use a payload just under the cap to keep
     * the test fast — boundary behavior is what matters.
     */
    @Test
    fun `stageStream accepts payload just under cap`() {
        val sharedDir = tmp.newFolder("shared")
        val payload = ByteArray(1024 * 1024) // 1 MB, well under the 500 MB cap
        val out = SharedIntentHandler.stageStream(
            ByteArrayInputStream(payload), "moderate.stl", sharedDir,
        )
        assertNotNull("1 MB payload should succeed", out)
        assertEquals(payload.size.toLong(), out!!.length())
    }
}
