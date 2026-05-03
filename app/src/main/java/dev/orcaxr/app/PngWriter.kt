package dev.orcaxr.app

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * Minimal pure-Kotlin PNG encoder. Used by AiRenderEngine (C9
 * milestone 2) to write rendered views without depending on Android's
 * Bitmap.compress (which would force every test to be a Robolectric
 * one). Lives in `dev.orcaxr.app` rather than `mcp/` because it has
 * no MCP coupling — it just turns a 4-byte-per-pixel RGBA buffer into
 * a valid PNG file.
 *
 * Format: simple 8-bit RGB or RGBA, no interlacing, single IDAT
 * chunk, default Deflate compression. ~120 lines vs 700+ for
 * stb_image_write.h. Tested by writing known buffers, parsing the
 * output with `javax.imageio` (in JDK), and comparing pixels.
 */
internal object PngWriter {

    /**
     * Encode a width×height RGBA buffer (row-major, top-to-bottom,
     * 4 bytes per pixel) as PNG. [pixels] must be exactly
     * `width * height * 4` long.
     */
    fun encodeRgba(pixels: ByteArray, width: Int, height: Int): ByteArray {
        require(width > 0 && height > 0) { "non-positive dimensions" }
        require(pixels.size == width * height * 4) { "pixels.size != width*height*4" }
        return encode(pixels, width, height, hasAlpha = true)
    }

    /**
     * Encode a width×height RGB buffer (3 bytes per pixel). Smaller
     * output than RGBA when alpha isn't needed (triangle-id maps,
     * solid renders).
     */
    fun encodeRgb(pixels: ByteArray, width: Int, height: Int): ByteArray {
        require(width > 0 && height > 0) { "non-positive dimensions" }
        require(pixels.size == width * height * 3) { "pixels.size != width*height*3" }
        return encode(pixels, width, height, hasAlpha = false)
    }

    private fun encode(pixels: ByteArray, width: Int, height: Int, hasAlpha: Boolean): ByteArray {
        val bpp = if (hasAlpha) 4 else 3
        val out = ByteArrayOutputStream(pixels.size / 2 + 256)
        // Magic.
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        // IHDR (13 bytes payload).
        val ihdr = ByteArrayOutputStream(13).apply {
            writeInt(width); writeInt(height)
            write(8) // bit depth
            write(if (hasAlpha) 6 else 2) // color type: 6=RGBA, 2=RGB
            write(0) // compression
            write(0) // filter
            write(0) // interlace
        }.toByteArray()
        writeChunk(out, "IHDR", ihdr)

        // IDAT — Deflate-compressed scanlines, each prefixed with a
        // single 0x00 filter byte (no per-pixel filtering — the LLM
        // renders are typically large flat regions where the small
        // savings from sub/up filters don't matter).
        val rowStride = width * bpp
        val raw = ByteArray((rowStride + 1) * height)
        var srcOff = 0
        var dstOff = 0
        for (y in 0 until height) {
            raw[dstOff++] = 0  // filter type none
            System.arraycopy(pixels, srcOff, raw, dstOff, rowStride)
            srcOff += rowStride
            dstOff += rowStride
        }
        val def = Deflater(Deflater.DEFAULT_COMPRESSION).apply {
            setInput(raw)
            finish()
        }
        val compressed = ByteArrayOutputStream(raw.size / 4 + 64)
        val buf = ByteArray(8 * 1024)
        while (!def.finished()) {
            val n = def.deflate(buf)
            if (n > 0) compressed.write(buf, 0, n)
        }
        def.end()
        writeChunk(out, "IDAT", compressed.toByteArray())

        // IEND.
        writeChunk(out, "IEND", ByteArray(0))
        return out.toByteArray()
    }

    private fun writeChunk(out: ByteArrayOutputStream, type: String, data: ByteArray) {
        // Length (big-endian).
        out.writeInt(data.size)
        // Type + data, accumulated for the CRC.
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        out.write(typeBytes)
        out.write(data)
        // CRC over type+data.
        val crc = CRC32().apply {
            update(typeBytes)
            update(data)
        }
        out.writeInt(crc.value.toInt())
    }

    private fun ByteArrayOutputStream.writeInt(v: Int) {
        write((v ushr 24) and 0xFF)
        write((v ushr 16) and 0xFF)
        write((v ushr 8) and 0xFF)
        write(v and 0xFF)
    }
}
