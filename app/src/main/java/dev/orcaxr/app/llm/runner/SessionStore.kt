package dev.orcaxr.app.llm.runner

import android.content.Context
import android.util.Log
import dev.orcaxr.app.llm.LlmTurn
import dev.orcaxr.app.llm.ToolCall
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * Append-only JSONL persistence for the in-app assistant's chat
 * sessions.
 *
 * On-disk layout:
 *
 *     filesDir/llm_sessions/
 *         2026-05-08T11-00-00Z/session.jsonl
 *         2026-05-08T11-15-30Z/session.jsonl
 *         ...
 *
 * Each line is one [AgentEvent] JSON object — new events are
 * appended atomically; the file is never rewritten. The Sessions
 * browser (future) reads back any session for an inspectable
 * replay; the [AgentRunner] reloads the most recent session at app
 * start so the user's last conversation survives a process kill or
 * device restart.
 *
 * **Crash semantics.** Two-phase tool commits live here: a
 * [AgentEvent.ToolCallStarted] is appended *before* the MCP tool
 * runs and the matching [AgentEvent.ToolCallFinished] *after*. If a
 * crash happens between them the next replay sees a `Started`
 * without a `Finished` and the runner surfaces it as an "interrupted"
 * tool call rather than re-running silently — the slicer side may
 * have committed real workspace state that re-running would corrupt.
 */
class SessionStore(private val rootDir: File) {

    /** A single chat session — one directory under [rootDir],
     *  containing exactly one `session.jsonl`. */
    data class Session(
        val id: String,
        val dir: File,
    ) {
        val jsonlFile: File get() = File(dir, FILE_NAME)
        val imagesDir: File get() = File(dir, "images")
    }

    /**
     * Create a new session with a UTC-timestamp id. Caller is
     * responsible for appending events through [appendEvent].
     */
    fun newSession(): Session {
        rootDir.mkdirs()
        val id = utcTimestampId()
        val dir = File(rootDir, id).apply { mkdirs() }
        val session = Session(id = id, dir = dir)
        // Touch the file so it exists even if the user closes the
        // app before sending anything.
        runCatching { session.jsonlFile.createNewFile() }
        return session
    }

    /** All known sessions sorted newest-first by id. */
    fun listSessions(): List<Session> {
        val children = rootDir.listFiles() ?: return emptyList()
        return children
            .filter { it.isDirectory && File(it, FILE_NAME).isFile }
            .map { Session(id = it.name, dir = it) }
            .sortedByDescending { it.id }
    }

    /** The most recent session on disk, or null if none. */
    fun mostRecent(): Session? = listSessions().firstOrNull()

    /** Append one event to the session's JSONL. Throws on IO error
     *  so the caller can decide whether to retry or surface; the
     *  runner simply logs and continues — losing one event line is
     *  preferable to crashing mid-turn. */
    @Throws(IOException::class)
    fun appendEvent(session: Session, event: AgentEvent) {
        val line = AgentEvents.encode(event)
        // Append atomically. java.io.FileWriter with append=true
        // takes the FS write lock per call; one event per line so
        // partial writes can't corrupt earlier events.
        session.jsonlFile.appendText(line + "\n")
    }

    /** Read all events from a session and rebuild the conversation
     *  shape needed by the chat panel. Tolerates malformed lines —
     *  one bad event doesn't poison the whole replay. */
    fun replay(session: Session): ReplayResult {
        if (!session.jsonlFile.isFile) {
            return ReplayResult(emptyList(), emptyList(), interrupted = false)
        }
        val events = mutableListOf<AgentEvent>()
        for (line in session.jsonlFile.readLines()) {
            if (line.isBlank()) continue
            val ev = runCatching { AgentEvents.decode(line) }.getOrNull()
            if (ev != null) events.add(ev)
            else Log.w(TAG, "skipping malformed event in ${session.id}")
        }
        return rebuildTurns(events)
    }

    /**
     * Rebuild [LlmTurn] history + figure out whether the session
     * was interrupted (tool call started but never finished, or no
     * terminal event).
     */
    private fun rebuildTurns(events: List<AgentEvent>): ReplayResult {
        val turns = mutableListOf<LlmTurn>()
        // Pending assistant tool call — buffered until we see a
        // matching ToolCallFinished or the replay ends. Multi-tool
        // turns aren't currently produced (the panel runs one tool
        // per assistant turn) but we model the list anyway.
        val pendingCalls = mutableListOf<ToolCall>()
        var pendingAssistantText: String? = null
        var sawTerminal = false
        var interrupted = false

        fun flushAssistantTurn() {
            if (pendingCalls.isNotEmpty() || pendingAssistantText != null) {
                turns.add(
                    LlmTurn.Assistant(
                        text = pendingAssistantText,
                        toolCalls = pendingCalls.toList(),
                    ),
                )
            }
            pendingCalls.clear()
            pendingAssistantText = null
        }

        for (ev in events) when (ev) {
            is AgentEvent.SessionStart -> Unit
            is AgentEvent.User -> {
                flushAssistantTurn()
                turns.add(LlmTurn.User(ev.text))
            }
            is AgentEvent.AssistantText -> {
                pendingAssistantText = ev.text
            }
            is AgentEvent.ToolCallStarted -> {
                pendingCalls.add(ToolCall(ev.callId, ev.name, ev.args))
            }
            is AgentEvent.ToolCallFinished -> {
                flushAssistantTurn()
                turns.add(
                    LlmTurn.ToolResult(
                        callId = ev.callId,
                        name = ev.name,
                        content = ev.content,
                        isError = ev.isError,
                    ),
                )
            }
            is AgentEvent.Final -> {
                flushAssistantTurn()
                if (turns.lastOrNull() !is LlmTurn.Assistant ||
                    (turns.last() as LlmTurn.Assistant).text != ev.text
                ) {
                    turns.add(
                        LlmTurn.Assistant(text = ev.text, toolCalls = emptyList()),
                    )
                }
                sawTerminal = true
            }
            is AgentEvent.Error -> {
                flushAssistantTurn()
                sawTerminal = true
            }
            is AgentEvent.Cancelled -> {
                flushAssistantTurn()
                sawTerminal = true
            }
        }
        // Tail-state cleanup. If we end with un-flushed pending,
        // that's a tool call that never finished or an assistant
        // text with no envelope — treat as interrupted, flush
        // anyway so the user sees what was in flight.
        if (pendingCalls.isNotEmpty() || pendingAssistantText != null) {
            flushAssistantTurn()
            interrupted = true
        }
        // No terminal AND last event isn't a User input either →
        // session was killed mid-turn. Surface as interrupted.
        if (!sawTerminal && events.isNotEmpty()) {
            val lastTurn = turns.lastOrNull()
            if (lastTurn !is LlmTurn.User) interrupted = true
        }
        return ReplayResult(turns = turns, events = events, interrupted = interrupted)
    }

    data class ReplayResult(
        val turns: List<LlmTurn>,
        val events: List<AgentEvent>,
        val interrupted: Boolean,
    )

    companion object {
        private const val TAG = "OrcaXR/llm/sess"
        private const val FILE_NAME = "session.jsonl"

        /** UTC-timestamp session id with hyphens so it's
         *  filesystem-safe on every Android filesystem (FAT, ext4,
         *  emulated FUSE on /sdcard). */
        fun utcTimestampId(): String {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            return fmt.format(Date())
        }

        fun rootDir(context: Context): File =
            File(context.applicationContext.filesDir, "llm_sessions")
    }
}

/**
 * Discrete events appended to a session's JSONL. Keep this enum
 * append-only — old session files have to keep replaying after a
 * schema bump, so deleting or renaming a variant is a one-way
 * compatibility break. Adding a new variant is fine; the decoder
 * tolerates unknown `type` strings by skipping the event.
 */
sealed interface AgentEvent {
    val ts: Long

    data class SessionStart(
        override val ts: Long,
        val backend: String,
        val model: String?,
    ) : AgentEvent

    data class User(override val ts: Long, val text: String) : AgentEvent

    data class AssistantText(override val ts: Long, val text: String) : AgentEvent

    data class ToolCallStarted(
        override val ts: Long,
        val callId: String,
        val name: String,
        val args: JSONObject,
    ) : AgentEvent

    data class ToolCallFinished(
        override val ts: Long,
        val callId: String,
        val name: String,
        val content: String,
        val isError: Boolean,
    ) : AgentEvent

    data class Final(override val ts: Long, val text: String) : AgentEvent

    data class Error(override val ts: Long, val message: String) : AgentEvent

    data class Cancelled(override val ts: Long) : AgentEvent
}

/** Encoder/decoder for [AgentEvent] ⇄ JSON. */
object AgentEvents {
    fun encode(ev: AgentEvent): String {
        val obj = JSONObject().apply {
            put("ts", ev.ts)
            when (ev) {
                is AgentEvent.SessionStart -> {
                    put("type", "session_start")
                    put("backend", ev.backend)
                    if (ev.model != null) put("model", ev.model)
                }
                is AgentEvent.User -> {
                    put("type", "user")
                    put("text", ev.text)
                }
                is AgentEvent.AssistantText -> {
                    put("type", "assistant_text")
                    put("text", ev.text)
                }
                is AgentEvent.ToolCallStarted -> {
                    put("type", "tool_call_start")
                    put("call_id", ev.callId)
                    put("name", ev.name)
                    put("args", ev.args)
                }
                is AgentEvent.ToolCallFinished -> {
                    put("type", "tool_call_finish")
                    put("call_id", ev.callId)
                    put("name", ev.name)
                    put("content", ev.content)
                    put("is_error", ev.isError)
                }
                is AgentEvent.Final -> {
                    put("type", "final")
                    put("text", ev.text)
                }
                is AgentEvent.Error -> {
                    put("type", "error")
                    put("message", ev.message)
                }
                is AgentEvent.Cancelled -> put("type", "cancelled")
            }
        }
        return obj.toString()
    }

    /** Decode one JSONL line. Throws on parse error so the caller
     *  can choose to skip the malformed line. */
    fun decode(line: String): AgentEvent {
        val obj = JSONObject(line)
        val ts = obj.optLong("ts")
        return when (val type = obj.optString("type")) {
            "session_start" -> AgentEvent.SessionStart(
                ts = ts,
                backend = obj.optString("backend"),
                model = obj.optString("model").ifBlank { null },
            )
            "user" -> AgentEvent.User(ts, obj.optString("text"))
            "assistant_text" -> AgentEvent.AssistantText(ts, obj.optString("text"))
            "tool_call_start" -> AgentEvent.ToolCallStarted(
                ts = ts,
                callId = obj.optString("call_id"),
                name = obj.optString("name"),
                args = obj.optJSONObject("args") ?: JSONObject(),
            )
            "tool_call_finish" -> AgentEvent.ToolCallFinished(
                ts = ts,
                callId = obj.optString("call_id"),
                name = obj.optString("name"),
                content = obj.optString("content"),
                isError = obj.optBoolean("is_error", false),
            )
            "final" -> AgentEvent.Final(ts, obj.optString("text"))
            "error" -> AgentEvent.Error(ts, obj.optString("message"))
            "cancelled" -> AgentEvent.Cancelled(ts)
            else -> throw IllegalArgumentException("unknown event type: $type")
        }
    }
}
