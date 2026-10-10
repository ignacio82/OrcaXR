package dev.orcaxr.core

import java.security.SecureRandom

/**
 * New stable entity IDs as the browser mints them (`UuidIdSource` in
 * web/src/project/domain/ids.ts, fed by `crypto.getRandomValues` words in
 * the workspace's composition root): sixteen bytes, each
 * `floor(word × 256) & 0xff` of one random word in [0, 1), stamped as a
 * version-4 RFC 4122 UUID and written in lower-case hex. The [word] source
 * is injectable so a check can replay the browser's seeded words; production
 * draws 32-bit words from [SecureRandom], as the browser draws a Uint32.
 */
class ProjectIds(private val word: () -> Double = ::secureWord) {
    /** IDs a plan drew but did not take, handed out again first, in order. */
    private val returned = ArrayDeque<String>()

    /** The next ID: a UUID the browser's `isStableEntityId` accepts. */
    fun next(): String = synchronized(returned) { returned.removeFirstOrNull() } ?: fresh()

    /**
     * Hands back IDs drawn for a plan that took fewer (a primitive sharing an
     * asset takes no asset ID), so the next draws take them again: the IDs then
     * follow the browser's sequence, which draws only what it uses.
     */
    fun giveBack(unused: List<String>) = synchronized(returned) { for (id in unused.asReversed()) returned.addFirst(id) }

    private fun fresh(): String {
        val bytes = IntArray(16) { kotlin.math.floor(word() * 256).toInt() and 0xff }
        bytes[6] = (bytes[6] and 0x0f) or 0x40
        bytes[8] = (bytes[8] and 0x3f) or 0x80
        val hex = bytes.joinToString("") { it.toString(16).padStart(2, '0') }
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }

    /** [count] fresh IDs, in the order the browser would draw them. */
    fun next(count: Int): List<String> = List(count) { next() }

    companion object {
        private val random = SecureRandom()

        /** One cryptographically random 32-bit word over 2³², as the browser's `cryptographicRandomWord`. */
        fun secureWord(): Double = (random.nextInt().toLong() and 0xffffffffL) / 4294967296.0
    }
}
