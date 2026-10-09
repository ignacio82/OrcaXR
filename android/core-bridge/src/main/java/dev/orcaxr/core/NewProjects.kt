package dev.orcaxr.core

import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * New projects as the browser makes them: the empty project a session starts
 * with (`createEmptyProject` with its defaults) and, through
 * [ProjectSnapshot.fresh], the one "New project" replaces a project with.
 * Both are canonical documents for a [ProjectUpload]; their identifiers come
 * from the browser's UUID source over [words], their times from [timestamp].
 */
object NewProjects {
    /** Words the UUID source draws for a new project's two identifiers. */
    const val WORDS = 32
    private val secure = SecureRandom()
    private val iso = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** Random words in [0, 1), as the browser's composition root injects them. */
    fun words(random: SecureRandom = secure): DoubleArray = DoubleArray(WORDS) { random.nextDouble() }

    /** The instant as JavaScript's `Date.prototype.toISOString` writes it (years 0–9999). */
    fun timestamp(epochMs: Long): String = iso.format(Instant.ofEpochMilli(epochMs))

    /** The canonical document of the browser's default empty project. */
    fun empty(words: DoubleArray, now: String): ByteArray = NativeProject.projectEmpty(words, now)
}
