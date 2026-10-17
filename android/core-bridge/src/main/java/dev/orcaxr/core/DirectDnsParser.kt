package dev.orcaxr.core

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

internal data class DnsServiceRecord(val name: String, val port: Int, val serviceType: String)

/**
 * Lightweight DNS parser and builder for DNS-SD service discovery.
 *
 * Designed to be resilient against invalid or oversized DNS records (such as
 * embedded firmware NSEC records with zero-length bitmaps that crash platform
 * parsers) by gracefully skipping unhandled record data without throwing.
 */
internal object DirectDnsParser {
    fun parse(data: ByteArray, length: Int): DnsServiceRecord? {
        if (length < 12) return null
        val flags = ((data[2].toInt() and 0xff) shl 8) or (data[3].toInt() and 0xff)
        // Check if QR bit (0x8000) is set: must be a response
        if ((flags and 0x8000) == 0) return null
        val qdcount = ((data[4].toInt() and 0xff) shl 8) or (data[5].toInt() and 0xff)
        val ancount = ((data[6].toInt() and 0xff) shl 8) or (data[7].toInt() and 0xff)
        val nscount = ((data[8].toInt() and 0xff) shl 8) or (data[9].toInt() and 0xff)
        val arcount = ((data[10].toInt() and 0xff) shl 8) or (data[11].toInt() and 0xff)

        var pos = 12

        fun readName(startOffset: Int): Pair<String, Int> {
            val labels = ArrayList<String>()
            var cur = startOffset
            var jumped = false
            var nextPos = startOffset
            var steps = 0
            while (cur in 0 until length && steps < 64) {
                steps++
                val len = data[cur].toInt() and 0xff
                if (len == 0) {
                    if (!jumped) nextPos = cur + 1
                    break
                }
                if ((len and 0xc0) == 0xc0) {
                    if (cur + 1 >= length) break
                    if (!jumped) {
                        nextPos = cur + 2
                        jumped = true
                    }
                    cur = ((len and 0x3f) shl 8) or (data[cur + 1].toInt() and 0xff)
                } else {
                    cur++
                    if (cur + len > length) break
                    labels.add(String(data, cur, len, Charsets.UTF_8))
                    cur += len
                    if (!jumped) nextPos = cur
                }
            }
            return labels.joinToString(".") to nextPos
        }

        // Skip questions
        for (i in 0 until qdcount) {
            val (_, next) = readName(pos)
            pos = next + 4 // QTYPE (2) + QCLASS (2)
            if (pos > length) return null
        }

        var instanceName: String? = null
        var port: Int? = null
        var matchedType: String? = null

        val totalRecords = ancount + nscount + arcount
        for (i in 0 until totalRecords) {
            if (pos + 10 > length) break
            val (rname, next) = readName(pos)
            pos = next
            if (pos + 10 > length) break
            val rtype = ((data[pos].toInt() and 0xff) shl 8) or (data[pos + 1].toInt() and 0xff)
            val rdlen = ((data[pos + 8].toInt() and 0xff) shl 8) or (data[pos + 9].toInt() and 0xff)
            pos += 10
            val rdataOffset = pos
            pos += rdlen
            if (rdataOffset + rdlen > length) break

            val rnameLower = rname.lowercase()
            when {
                rnameLower.contains("_snapmaker._tcp") -> matchedType = "_snapmaker._tcp"
                rnameLower.contains("_moonraker._tcp") -> matchedType = "_moonraker._tcp"
                rnameLower.contains("_octoprint._tcp") -> matchedType = "_octoprint._tcp"
            }

            when (rtype) {
                12 -> { // PTR
                    val (target, _) = readName(rdataOffset)
                    val targetLower = target.lowercase()
                    when {
                        targetLower.contains("_snapmaker._tcp") -> matchedType = "_snapmaker._tcp"
                        targetLower.contains("_moonraker._tcp") -> matchedType = "_moonraker._tcp"
                        targetLower.contains("_octoprint._tcp") -> matchedType = "_octoprint._tcp"
                    }
                    val firstLabel = target.substringBefore('.')
                    if (firstLabel.isNotEmpty() && !firstLabel.startsWith("_")) {
                        instanceName = firstLabel
                    }
                }
                33 -> { // SRV
                    if (rdlen >= 6) {
                        port = ((data[rdataOffset + 4].toInt() and 0xff) shl 8) or (data[rdataOffset + 5].toInt() and 0xff)
                    }
                }
                16 -> { // TXT
                    var txtPos = rdataOffset
                    val end = rdataOffset + rdlen
                    while (txtPos < end) {
                        val slen = data[txtPos].toInt() and 0xff
                        txtPos++
                        if (txtPos + slen > end) break
                        val text = String(data, txtPos, slen, Charsets.UTF_8)
                        txtPos += slen
                        if (text.startsWith("device_name=", ignoreCase = true)) {
                            val dev = text.substringAfter('=').trim()
                            if (dev.isNotEmpty()) instanceName = dev
                        } else if (text.startsWith("machine_type=", ignoreCase = true) && instanceName == null) {
                            val dev = text.substringAfter('=').trim()
                            if (dev.isNotEmpty()) instanceName = dev
                        }
                    }
                }
            }
        }

        if (matchedType == null) return null
        val finalPort = port ?: if (matchedType == "_snapmaker._tcp") 1884 else 7125
        val finalName = instanceName ?: when (matchedType) {
            "_snapmaker._tcp" -> "Snapmaker"
            "_moonraker._tcp" -> "Moonraker"
            else -> "Printer"
        }
        return DnsServiceRecord(finalName, finalPort, matchedType)
    }

    fun buildQuery(serviceType: String): ByteArray {
        val qname = if (serviceType.endsWith(".local")) serviceType else "$serviceType.local"
        val out = ByteArrayOutputStream()
        val dos = DataOutputStream(out)
        dos.writeShort(0) // Transaction ID
        dos.writeShort(0) // Flags: standard query
        dos.writeShort(1) // QDCOUNT: 1 question
        dos.writeShort(0) // ANCOUNT
        dos.writeShort(0) // NSCOUNT
        dos.writeShort(0) // ARCOUNT
        for (label in qname.split('.')) {
            if (label.isEmpty()) continue
            val bytes = label.toByteArray(Charsets.US_ASCII)
            dos.writeByte(bytes.size)
            dos.write(bytes)
        }
        dos.writeByte(0) // End of domain name
        dos.writeShort(12) // QTYPE = PTR
        dos.writeShort(1) // QCLASS = IN
        return out.toByteArray()
    }
}
