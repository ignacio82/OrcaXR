package dev.orcaxr.core

/** New projects through real JNI against the browser's
 * (`project-fresh-vectors.json`): the empty project a session starts with, and
 * "New project" from every state of the model corpus — each opened as a
 * session first — byte for byte; the result opens as a session; malformed
 * words and timestamps are refused; timestamps are written as JavaScript's
 * `toISOString` writes them. */
object ProjectNewChecks {
    private fun failure(work: () -> Unit) = runCatching(work).exceptionOrNull()?.message

    private fun session(scope: ProjectPreparation, bytes: ByteArray): ProjectSession {
        val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 4_000_000, 1024, 128, 10, 16_777_216, 33_554_432, 100, 33_554_432)
        val upload = scope.own(ProjectUpload(bytes.size.toLong(), options, LocalTimestampResolver { it }, ProjectIntegerProfile.CHROMIUM))
        upload.appendDocument(0, bytes)
        upload.sealDocument()
        return scope.own(upload.open())
    }

    /** One browser case: the empty project ([source] null) or "New project"
     * from [source], drawn from [words] at [now]; [expected] is the browser's. */
    @JvmStatic fun replay(now: String, words: DoubleArray, source: String?, expected: String): Long {
        if (source == null) {
            val document = NewProjects.empty(words, now)
            check(String(document, Charsets.UTF_8) == expected) { "empty $now" }
            return 1
        }
        ProjectPreparation().use { scope ->
            val current = session(scope, source.toByteArray(Charsets.UTF_8))
            val document = current.snapshot().use { it.fresh(words, now) }
            check(String(document, Charsets.UTF_8) == expected) { "fresh $now" }
            // What "New project" made opens as a session of its own.
            check(session(scope, document).snapshot().use { it.revision() } >= 0) { "fresh_opens" }
        }
        return 2
    }

    @JvmStatic fun run(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val words = NewProjects.words()
        check(words.size == NewProjects.WORDS && words.all { it >= 0.0 && it < 1.0 }, "words")
        check(failure { NewProjects.empty(DoubleArray(31), "2026-10-09T00:00:00.000Z") } == "invalid_words", "short_words_refused")
        check(failure { NewProjects.empty(words, "") } == "invalid_timestamp", "empty_timestamp_refused")
        check(failure { NewProjects.empty(words, "9".repeat(65)) } == "invalid_timestamp", "long_timestamp_refused")
        check(NewProjects.timestamp(0) == "1970-01-01T00:00:00.000Z", "epoch")
        check(NewProjects.timestamp(1_791_550_609_936) == "2026-10-09T12:56:49.936Z", "millis")
        check(NewProjects.timestamp(253_402_300_799_999) == "9999-12-31T23:59:59.999Z", "last_four_digit_year")
        check(NewProjects.timestamp(-1) == "1969-12-31T23:59:59.999Z", "before_epoch")
        return checks
    }
}
