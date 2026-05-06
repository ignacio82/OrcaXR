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
}
