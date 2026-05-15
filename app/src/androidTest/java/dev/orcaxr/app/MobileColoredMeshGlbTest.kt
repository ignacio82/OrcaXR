package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Verifies the new mobile post-slice "colored-mesh sidecar GLB" path:
 * the same `SlicerEngine.writeColoredGlb` the XR shell consumes for
 * its on-plate preview also runs from the mobile slice pipeline, and
 * the resulting GLB carries multiple distinct per-vertex colors so
 * FullSpectrum / paint regions render correctly on phones / tablets.
 *
 * Strategy:
 *   1. Stage the bundled `multicolor_hexagon.3mf` to cacheDir.
 *   2. Build a 16-slot RGB palette with distinct entries.
 *   3. Call `SlicerEngine.writeColoredGlb` (NOT through MainActivity —
 *      this test is the mobile-side analog).
 *   4. Parse the GLB binary header, locate the JSON chunk + BIN chunk,
 *      and walk the COLOR_0 accessor to confirm >=2 distinct vertex
 *      colors are present. (Per-vertex-color encoding is the contract
 *      `writeColoredGlb` upholds; the XR shell renders via SceneCore
 *      and the mobile viewer uses Filament-android's gltfio — both
 *      paths read COLOR_0.)
 */
@RunWith(AndroidJUnit4::class)
class MobileColoredMeshGlbTest {

    @Test
    fun writeColoredGlbProducesMultiColorMesh() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val src = File(appCtx.cacheDir, "mobile_preview_hexagon.3mf").also { dst ->
            testCtx.assets.open("multicolor_hexagon.3mf").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }

        // 16-slot palette: black / red / green / blue / yellow / cyan /
        // magenta / white, then 8 more shades. `writeColoredGlb` maps
        // each painted filament id to palette[id-1]; we just need
        // enough distinct entries that the 3MF's authored colors won't
        // collapse to a single shade in COLOR_0.
        val palette = FloatArray(16 * 3)
        val seedColors = floatArrayOf(
            0f, 0f, 0f,     1f, 0f, 0f,     0f, 1f, 0f,     0f, 0f, 1f,
            1f, 1f, 0f,     0f, 1f, 1f,     1f, 0f, 1f,     1f, 1f, 1f,
            0.5f, 0.2f, 0.8f, 0.2f, 0.7f, 0.4f, 0.9f, 0.5f, 0.1f, 0.3f, 0.3f, 0.7f,
            0.6f, 0.6f, 0.2f, 0.1f, 0.5f, 0.5f, 0.7f, 0.3f, 0.3f, 0.4f, 0.4f, 0.6f,
        )
        System.arraycopy(seedColors, 0, palette, 0, seedColors.size)

        val out = File(appCtx.cacheDir, "mobile_preview_hexagon.colored.glb")
        out.delete()

        val ok = SlicerEngine.writeColoredGlb(
            input = src,
            outGlb = out,
            paletteRgb = palette,
            paintFilamentIndex = null, // let the 3MF's embedded paint drive the colors
        )
        assertTrue("writeColoredGlb returned false", ok)
        assertTrue("colored GLB missing", out.exists())
        assertTrue("colored GLB is empty", out.length() > 0L)

        val distinct = countDistinctVertexColorsInGlb(out)
        assertNotNull("COLOR_0 accessor not found in colored GLB", distinct)
        assertTrue(
            "expected >=2 distinct vertex colors in colored GLB, got $distinct",
            distinct!! >= 2,
        )
    }

    /**
     * Walks the .glb container, reads the JSON chunk, locates the
     * COLOR_0 accessor on the first mesh primitive, then samples the
     * BIN-chunk-backed buffer view to count distinct color triplets.
     * Returns null if the GLB is malformed or has no COLOR_0 accessor.
     *
     * Minimal parser: enough to assert "the bake wrote per-vertex
     * colors" without pulling in a full glTF JSON library. Reads in a
     * way that survives both VEC3 and VEC4 component layouts since
     * `nativeWriteColoredGlb` is free to pick either.
     */
    private fun countDistinctVertexColorsInGlb(file: File): Int? {
        val bytes = file.readBytes()
        if (bytes.size < 28) return null
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = bb.int
        if (magic != 0x46546C67) return null // "glTF"
        bb.int // version
        bb.int // total length

        // First chunk: JSON
        val jsonLen = bb.int
        val jsonType = bb.int
        if (jsonType != 0x4E4F534A) return null // "JSON"
        val json = ByteArray(jsonLen)
        bb.get(json)
        val jsonStr = String(json, Charsets.UTF_8)

        // Second chunk: BIN
        if (bb.remaining() < 8) return null
        val binLen = bb.int
        val binType = bb.int
        if (binType != 0x004E4942) return null // "BIN\0"
        val bin = ByteArray(binLen)
        bb.get(bin)

        // Extract the COLOR_0 accessor index from the first primitive.
        val colorAccessorIdx = extractColor0AccessorIndex(jsonStr) ?: return null

        // Walk accessors[colorAccessorIdx] for bufferView, byteOffset,
        // count, componentType, type.
        val accessor = extractAccessor(jsonStr, colorAccessorIdx) ?: return null
        val bufferView = extractBufferView(jsonStr, accessor.bufferView) ?: return null

        val componentSize = when (accessor.componentType) {
            5126 -> 4 // FLOAT
            5121 -> 1 // UNSIGNED_BYTE
            5123 -> 2 // UNSIGNED_SHORT
            else -> return null
        }
        val numComponents = when (accessor.type) {
            "VEC3" -> 3
            "VEC4" -> 4
            else -> return null
        }
        val stride =
            if (bufferView.byteStride > 0) bufferView.byteStride
            else componentSize * numComponents

        val start = bufferView.byteOffset + accessor.byteOffset
        if (start + accessor.count.toLong() * stride > bin.size) return null

        val seen = HashSet<Long>()
        val sample = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until accessor.count) {
            val pos = start + i * stride
            sample.position(pos)
            val r = readComponent(sample, accessor.componentType)
            val g = readComponent(sample, accessor.componentType)
            val b = readComponent(sample, accessor.componentType)
            // Quantize to 8 bits per channel so floating-point noise
            // doesn't inflate the distinct-color count.
            val q = ((r * 255).toLong() and 0xff shl 16) or
                ((g * 255).toLong() and 0xff shl 8) or
                ((b * 255).toLong() and 0xff)
            seen.add(q)
        }
        return seen.size
    }

    private fun readComponent(bb: ByteBuffer, componentType: Int): Float = when (componentType) {
        5126 -> bb.float
        5121 -> (bb.get().toInt() and 0xff) / 255f
        5123 -> (bb.short.toInt() and 0xffff) / 65535f
        else -> 0f
    }

    private data class AccessorInfo(
        val bufferView: Int,
        val byteOffset: Int,
        val componentType: Int,
        val count: Int,
        val type: String,
    )

    private data class BufferViewInfo(
        val byteOffset: Int,
        val byteLength: Int,
        val byteStride: Int,
    )

    private fun extractColor0AccessorIndex(json: String): Int? {
        // Locate "COLOR_0":<int> anywhere in the first primitive's
        // attributes block. Single occurrence is enough for our use.
        val rx = Regex("\"COLOR_0\"\\s*:\\s*(\\d+)")
        return rx.find(json)?.groupValues?.get(1)?.toIntOrNull()
    }

    private fun extractAccessor(json: String, index: Int): AccessorInfo? {
        // Brittle but adequate: pull the index-th object inside the
        // accessors array. The bake's accessor objects are small and
        // we only care about a handful of keys, so a positional walk
        // (no nested arrays inside an accessor) works.
        val accessorsStart = json.indexOf("\"accessors\"")
        if (accessorsStart < 0) return null
        val arrStart = json.indexOf('[', accessorsStart)
        if (arrStart < 0) return null

        var depth = 0
        var idx = -1
        var objStart = -1
        var i = arrStart
        while (i < json.length) {
            val c = json[i]
            if (c == '{') {
                if (depth == 0) {
                    idx++
                    objStart = i
                }
                depth++
            } else if (c == '}') {
                depth--
                if (depth == 0 && idx == index) {
                    val objStr = json.substring(objStart, i + 1)
                    return parseAccessorObject(objStr)
                }
            } else if (c == ']' && depth == 0) {
                break
            }
            i++
        }
        return null
    }

    private fun parseAccessorObject(obj: String): AccessorInfo {
        val bv = Regex("\"bufferView\"\\s*:\\s*(\\d+)").find(obj)?.groupValues?.get(1)?.toInt() ?: 0
        val bo = Regex("\"byteOffset\"\\s*:\\s*(\\d+)").find(obj)?.groupValues?.get(1)?.toInt() ?: 0
        val ct = Regex("\"componentType\"\\s*:\\s*(\\d+)").find(obj)?.groupValues?.get(1)?.toInt() ?: 5126
        val cnt = Regex("\"count\"\\s*:\\s*(\\d+)").find(obj)?.groupValues?.get(1)?.toInt() ?: 0
        val ty = Regex("\"type\"\\s*:\\s*\"([A-Z0-9]+)\"").find(obj)?.groupValues?.get(1) ?: "VEC3"
        return AccessorInfo(bv, bo, ct, cnt, ty)
    }

    private fun extractBufferView(json: String, index: Int): BufferViewInfo? {
        val bvStart = json.indexOf("\"bufferViews\"")
        if (bvStart < 0) return null
        val arrStart = json.indexOf('[', bvStart)
        if (arrStart < 0) return null

        var depth = 0
        var idx = -1
        var objStart = -1
        var i = arrStart
        while (i < json.length) {
            val c = json[i]
            if (c == '{') {
                if (depth == 0) {
                    idx++
                    objStart = i
                }
                depth++
            } else if (c == '}') {
                depth--
                if (depth == 0 && idx == index) {
                    val objStr = json.substring(objStart, i + 1)
                    val bo = Regex("\"byteOffset\"\\s*:\\s*(\\d+)").find(objStr)?.groupValues?.get(1)?.toInt() ?: 0
                    val bl = Regex("\"byteLength\"\\s*:\\s*(\\d+)").find(objStr)?.groupValues?.get(1)?.toInt() ?: 0
                    val bs = Regex("\"byteStride\"\\s*:\\s*(\\d+)").find(objStr)?.groupValues?.get(1)?.toInt() ?: 0
                    return BufferViewInfo(bo, bl, bs)
                }
            } else if (c == ']' && depth == 0) {
                break
            }
            i++
        }
        return null
    }
}
