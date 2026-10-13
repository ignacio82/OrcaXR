package dev.orcaxr.nativeapp.exports

import android.os.SystemClock
import dev.orcaxr.core.Diagnostics

/**
 * The session's diagnostic events (the browser's `DiagnosticsRecorder`): a
 * bounded record, oldest first out, of failures that reached a boundary —
 * the Project area's work and the exports' — each redacted as it is recorded
 * by the shared core ([Diagnostics.entry]), so a secret never sits in memory
 * inside an event. [secrets] are the credentials this device holds now (the
 * external slicer's token, the printer's API key), struck from every event
 * recorded while they are. Times are milliseconds since the process started
 * recording, not a wall clock.
 */
object DiagnosticsLog {
    private val started = SystemClock.elapsedRealtime()
    private val entries = ArrayDeque<String>()

    /** The values struck from every event as it is recorded. */
    @Volatile var secrets: List<String> = emptyList()

    /** Records one event; nothing is recorded when the core cannot redact it. */
    fun record(level: Diagnostics.Level, scope: String, message: String) {
        val entry = runCatching {
            Diagnostics.entry(SystemClock.elapsedRealtime() - started, level, scope, message, secrets)
        }.getOrNull() ?: return
        synchronized(entries) {
            entries.addLast(entry)
            while (entries.size > Diagnostics.MAX_LOG_ENTRIES) entries.removeFirst()
        }
    }

    /** A failure reaching a boundary, as the browser records an error: its kind and its message. */
    fun recordError(scope: String, error: Throwable) =
        record(Diagnostics.Level.ERROR, scope, "${error.javaClass.simpleName}: ${error.message.orEmpty()}")

    /** The kept events, oldest first. */
    fun snapshot(): List<String> = synchronized(entries) { entries.toList() }
}
