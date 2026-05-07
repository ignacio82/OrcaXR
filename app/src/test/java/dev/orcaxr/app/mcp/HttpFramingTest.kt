package dev.orcaxr.app.mcp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * Audit H5 / H6 — direct unit coverage for the HTTP framing layer.
 * Previously the only coverage came from [McpServerEndToEndTest], which
 * doesn't exercise malformed clients (response-splitting attempts,
 * negative Content-Length, CR/LF in header values, etc.). These tests
 * pin the guards.
 */
class HttpFramingTest {

    private fun parse(raw: String): HttpFraming.Request? {
        return HttpFraming.readRequest(ByteArrayInputStream(raw.toByteArray(StandardCharsets.US_ASCII)))
    }

    @Test fun `valid POST with body parses correctly`() {
        val raw = "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nABCD"
        val req = parse(raw)
        assertNotNull(req)
        assertEquals("POST", req!!.method)
        assertEquals("/mcp", req.path)
        assertEquals("4", req.headers["content-length"])
        assertEquals("ABCD", req.body)
    }

    @Test fun `empty stream returns null (clean close)`() {
        assertNull(parse(""))
    }

    @Test fun `malformed request line throws`() {
        try {
            parse("GIBBERISH\r\n\r\n")
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("Malformed"))
        }
    }

    /** Audit H5 — Content-Length: -1 must be rejected. */
    @Test fun `negative Content-Length is rejected`() {
        try {
            parse("POST /mcp HTTP/1.1\r\nContent-Length: -1\r\n\r\n")
            fail("expected IOException for negative Content-Length")
        } catch (e: IOException) {
            assertTrue(
                "expected message to mention Content-Length, got '${e.message}'",
                e.message!!.contains("Content-Length"),
            )
        }
    }

    /** Audit H5 — oversized Content-Length must be rejected. */
    @Test fun `oversized Content-Length is rejected`() {
        try {
            parse("POST /mcp HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n")
            fail("expected IOException for oversized Content-Length")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("Content-Length"))
        }
    }

    /** Audit H5 — non-numeric Content-Length is treated as 0 (no body). */
    @Test fun `non-numeric Content-Length is treated as zero`() {
        val req = parse("GET / HTTP/1.1\r\nContent-Length: NaN\r\n\r\n")
        assertNotNull(req)
        assertEquals("", req!!.body)
    }

    @Test fun `writeResponse emits well-formed response with body`() {
        val out = ByteArrayOutputStream()
        HttpFraming.writeResponse(out, 200, "OK", "application/json", "{}")
        val s = out.toString(StandardCharsets.US_ASCII)
        assertTrue(s.startsWith("HTTP/1.1 200 OK\r\n"))
        assertTrue(s.contains("Content-Type: application/json; charset=utf-8\r\n"))
        assertTrue(s.contains("Content-Length: 2\r\n"))
        assertTrue(s.endsWith("\r\n\r\n{}"))
    }

    @Test fun `writeBinaryResponse omits charset suffix`() {
        val out = ByteArrayOutputStream()
        HttpFraming.writeBinaryResponse(out, 200, "OK", "image/png", byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47))
        val s = out.toString(StandardCharsets.ISO_8859_1)
        assertTrue("image content-type without charset", s.contains("Content-Type: image/png\r\n"))
        assertTrue("Content-Length: 4", s.contains("Content-Length: 4\r\n"))
    }

    /** Audit H6 — names with CR or LF must be rejected. */
    @Test fun `extraHeaders rejects CR or LF in name`() {
        val out = ByteArrayOutputStream()
        try {
            HttpFraming.writeResponse(
                out, 200, "OK", "text/plain", "x",
                extraHeaders = mapOf("X-Bad\r\nInjected" to "value"),
            )
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("invalid extraHeader name"))
        }
    }

    /** Audit H6 — names with non-token characters (`:`, ` `, `;`, …) rejected. */
    @Test fun `extraHeaders rejects names with non-token characters`() {
        val out = ByteArrayOutputStream()
        try {
            HttpFraming.writeResponse(
                out, 200, "OK", "text/plain", "x",
                extraHeaders = mapOf("X: Bad" to "value"),
            )
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("invalid extraHeader name"))
        }
    }

    /** Audit H6 — values with CR / LF must be rejected (response-splitting). */
    @Test fun `extraHeaders rejects CR or LF in value`() {
        val out = ByteArrayOutputStream()
        try {
            HttpFraming.writeResponse(
                out, 200, "OK", "text/plain", "x",
                extraHeaders = mapOf("X-OK" to "first\r\nSet-Cookie: pwn=1"),
            )
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("CR/LF"))
        }
    }

    /** Audit H6 — well-formed extraHeaders pass through. */
    @Test fun `extraHeaders allows portable-ASCII tokens with safe values`() {
        val out = ByteArrayOutputStream()
        HttpFraming.writeResponse(
            out, 200, "OK", "text/plain", "x",
            extraHeaders = mapOf("X-Trace-Id" to "abc-123"),
        )
        val s = out.toString(StandardCharsets.US_ASCII)
        assertTrue(s.contains("X-Trace-Id: abc-123\r\n"))
    }
}
