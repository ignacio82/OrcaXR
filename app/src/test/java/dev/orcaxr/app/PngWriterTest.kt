package dev.orcaxr.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.image.BufferedImage
import javax.imageio.ImageIO

/**
 * Round-trips [PngWriter] output through the JDK's `javax.imageio`
 * decoder so we know the bytes really are a valid PNG and the
 * pixels survive the encode.
 */
class PngWriterTest {

    @Test fun encodeRgbaProducesValidPng() {
        val w = 4; val h = 3
        val pixels = ByteArray(w * h * 4)
        // Fill with a simple gradient: red increases with x, green with y.
        for (y in 0 until h) {
            for (x in 0 until w) {
                val o = (y * w + x) * 4
                pixels[o] = ((x * 64) and 0xff).toByte()
                pixels[o + 1] = ((y * 64) and 0xff).toByte()
                pixels[o + 2] = 0
                pixels[o + 3] = 255.toByte()
            }
        }
        val png = PngWriter.encodeRgba(pixels, w, h)
        // Validate magic bytes.
        val magic = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        assertArrayEquals(magic, png.copyOfRange(0, 8))
        // Round-trip through ImageIO.
        val img = ImageIO.read(java.io.ByteArrayInputStream(png))
        assertEquals(w, img.width)
        assertEquals(h, img.height)
        // Spot-check a pixel.
        val argb = img.getRGB(1, 1)
        val r = (argb shr 16) and 0xff
        val g = (argb shr 8) and 0xff
        assertEquals(64, r)
        assertEquals(64, g)
    }

    @Test fun encodeRgbProducesValidPng() {
        val w = 2; val h = 2
        val pixels = byteArrayOf(
            255.toByte(), 0, 0,         // red
            0, 255.toByte(), 0,         // green
            0, 0, 255.toByte(),         // blue
            128.toByte(), 128.toByte(), 128.toByte(),  // gray
        )
        val png = PngWriter.encodeRgb(pixels, w, h)
        val img = ImageIO.read(java.io.ByteArrayInputStream(png))
        assertEquals(w, img.width)
        assertEquals(h, img.height)
        // Top-left pixel should be red.
        val tl = img.getRGB(0, 0)
        assertEquals(255, (tl shr 16) and 0xff)
        assertEquals(0, (tl shr 8) and 0xff)
    }

    @Test fun encodeRgbaRejectsWrongBufferSize() {
        runCatching {
            PngWriter.encodeRgba(ByteArray(99), 4, 4)
        }.also { assertTrue("expected throw on size mismatch", it.isFailure) }
    }

    @Test fun differentPixelsProduceDifferentBytes() {
        val a = PngWriter.encodeRgba(ByteArray(64) { 0 }, 4, 4)
        val b = PngWriter.encodeRgba(ByteArray(64) { (it and 0xff).toByte() }, 4, 4)
        assertNotEquals("a vs b PNG bytes", a.toList(), b.toList())
    }
}
