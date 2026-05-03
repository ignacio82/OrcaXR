package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * D21b — paint_template auto-resolution. Pure-JVM tests against an
 * in-memory IndexEntry — no Android Context, no MCP layer.
 *
 * Each test gets its own temp directory so we can write files with
 * stable, exact names (vs File.createTempFile which inserts random
 * digits between prefix and extension and would leak into the
 * resolver's filename-alias path).
 */
class PaintTemplateResolverTest {

    private fun freshDir(): File {
        val d = Files.createTempDirectory("paint-template-resolver").toFile()
        d.deleteOnExit()
        return d
    }

    private fun fileNamed(name: String, body: ByteArray = "default-bytes".toByteArray()): File {
        val f = File(freshDir(), name)
        f.writeBytes(body)
        f.deleteOnExit()
        return f
    }

    private fun threeMfWithMetadata(designId: String): File {
        val f = File(freshDir(), "model.3mf")
        ZipOutputStream(f.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("Metadata/model_settings.config"))
            zip.write("design_id=\"$designId\"\nmaterial=PLA\n".toByteArray())
            zip.closeEntry()
        }
        f.deleteOnExit()
        return f
    }

    private val emptyIndex = PaintTemplateResolver.IndexEntry(
        byMakerworldId = emptyMap(),
        bySha256 = emptyMap(),
        byFilenameAlias = emptyMap(),
    )

    @Test fun returnsNullWhenSourceMissing() {
        val ghost = File("/nonexistent/path/missing.stl")
        assertNull(PaintTemplateResolver.resolveAgainst(emptyIndex, ghost))
    }

    @Test fun resolvesByMakerworldIdInFilename() {
        val f = fileNamed("pikachu+US286aabafd2b978.3mf")
        val index = emptyIndex.copy(byMakerworldId = mapOf("US286aabafd2b978" to "funko_pop_pikachu"))
        val res = PaintTemplateResolver.resolveAgainst(index, f)
        assertNotNull(res)
        assertEquals("funko_pop_pikachu", res!!.recipeName)
        assertEquals(PaintTemplateResolver.MatchKey.MakerworldId, res.matchedBy)
        assertEquals("US286aabafd2b978", res.key)
    }

    @Test fun resolvesByMakerworldIdInZipMetadata() {
        val f = threeMfWithMetadata("ABC123XYZ")
        val index = emptyIndex.copy(byMakerworldId = mapOf("ABC123XYZ" to "test_recipe"))
        val res = PaintTemplateResolver.resolveAgainst(index, f)
        assertNotNull(res)
        assertEquals("test_recipe", res!!.recipeName)
        assertEquals(PaintTemplateResolver.MatchKey.MakerworldId, res.matchedBy)
    }

    @Test fun resolvesBySha256() {
        val f = fileNamed("known.stl", "deterministic-bytes".toByteArray())
        val sha = PaintTemplateResolver.sha256(f)!!
        val index = emptyIndex.copy(bySha256 = mapOf(sha to "known_model_recipe"))
        val res = PaintTemplateResolver.resolveAgainst(index, f)
        assertNotNull(res)
        assertEquals("known_model_recipe", res!!.recipeName)
        assertEquals(PaintTemplateResolver.MatchKey.Sha256, res.matchedBy)
        assertEquals(sha, res.key)
    }

    @Test fun resolvesByFilenameAlias() {
        val f = fileNamed("pikachu_funko_pop.stl")
        val index = emptyIndex.copy(byFilenameAlias = mapOf("pikachu_funko_pop" to "funko_pop_pikachu"))
        val res = PaintTemplateResolver.resolveAgainst(index, f)
        assertNotNull(res)
        assertEquals("funko_pop_pikachu", res!!.recipeName)
        assertEquals(PaintTemplateResolver.MatchKey.FilenameAlias, res.matchedBy)
    }

    @Test fun makerworldIdBeatsSha256() {
        val f = fileNamed("model+US12345678.3mf", "hello".toByteArray())
        val sha = PaintTemplateResolver.sha256(f)!!
        val index = PaintTemplateResolver.IndexEntry(
            byMakerworldId = mapOf("US12345678" to "from_id"),
            bySha256 = mapOf(sha to "from_sha"),
            byFilenameAlias = emptyMap(),
        )
        val res = PaintTemplateResolver.resolveAgainst(index, f)
        assertEquals("from_id", res!!.recipeName)
    }

    @Test fun sha256BeatsFilenameAlias() {
        val f = fileNamed("pikachu_funko_pop.stl", "specific-bytes".toByteArray())
        val sha = PaintTemplateResolver.sha256(f)!!
        val index = PaintTemplateResolver.IndexEntry(
            byMakerworldId = emptyMap(),
            bySha256 = mapOf(sha to "exact_sha_recipe"),
            byFilenameAlias = mapOf("pikachu_funko_pop" to "alias_recipe"),
        )
        val res = PaintTemplateResolver.resolveAgainst(index, f)
        assertEquals("exact_sha_recipe", res!!.recipeName)
        assertEquals(PaintTemplateResolver.MatchKey.Sha256, res.matchedBy)
    }

    @Test fun filenameAliasNormalizesDashesAndCase() {
        val f = fileNamed("Pikachu-Funko-Pop.stl")
        val key = PaintTemplateResolver.filenameAlias(f)
        assertEquals("pikachu_funko_pop", key)
    }

    @Test fun filenameAliasStripsMakerworldPlusSuffix() {
        val f = fileNamed("benchy+ABC123.stl")
        val key = PaintTemplateResolver.filenameAlias(f)
        assertEquals("benchy", key)
    }

    @Test fun returnsNullWhenNothingMatches() {
        val f = fileNamed("random_unknown_thing.stl")
        val res = PaintTemplateResolver.resolveAgainst(emptyIndex, f)
        assertNull(res)
    }

    @Test fun sha256IsStableForIdenticalContent() {
        val a = fileNamed("a.stl", "content".toByteArray())
        val b = fileNamed("b_diff_name.stl", "content".toByteArray())
        assertEquals(PaintTemplateResolver.sha256(a), PaintTemplateResolver.sha256(b))
    }

    @Test fun sha256DiffersForDifferentContent() {
        val a = fileNamed("a.stl", "x".toByteArray())
        val b = fileNamed("b.stl", "y".toByteArray())
        assert(PaintTemplateResolver.sha256(a) != PaintTemplateResolver.sha256(b))
    }
}
