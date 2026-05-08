package dev.orcaxr.app.llm.runner

import dev.orcaxr.app.llm.LlmTurn
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [SessionStore]'s JSONL roundtrip + replay
 * reconstruction. The two pieces matter most:
 *
 *  1. **Encode/decode symmetry** — a session written then re-read
 *     produces the same logical event sequence. Skew here would
 *     break replay-after-crash: the on-disk format has to evolve
 *     additively, never breakingly, because old session files have
 *     to keep working after an APK upgrade.
 *
 *  2. **Interrupted-session detection** — a JSONL ending mid-tool
 *     (Started without Finished) or with no terminal event must be
 *     reported as `interrupted=true` so the chat panel can surface
 *     the "last turn was killed" banner.
 */
class SessionStoreTest {

    private lateinit var rootDir: File

    @Before
    fun setUp() {
        rootDir = createTempDir(prefix = "orcaxr-sessionstore-test")
    }

    @After
    fun tearDown() {
        rootDir.deleteRecursively()
    }

    // -------------- encode/decode roundtrip --------------

    @Test
    fun `encode and decode preserve all event shapes`() {
        val events: List<AgentEvent> = listOf(
            AgentEvent.SessionStart(ts = 1000L, backend = "Local", model = "e2b"),
            AgentEvent.User(ts = 1100L, text = "List my printers."),
            AgentEvent.AssistantText(ts = 1200L, text = "Sure."),
            AgentEvent.ToolCallStarted(
                ts = 1300L,
                callId = "call_1",
                name = "list_printers",
                args = JSONObject("""{"a":1,"b":"x"}"""),
            ),
            AgentEvent.ToolCallFinished(
                ts = 1400L,
                callId = "call_1",
                name = "list_printers",
                content = "U1, ECC",
                isError = false,
            ),
            AgentEvent.Final(ts = 1500L, text = "Two printers configured."),
            AgentEvent.Error(ts = 1600L, message = "boom"),
            AgentEvent.Cancelled(ts = 1700L),
        )

        val roundtripped = events.map { AgentEvents.encode(it) }
            .map { AgentEvents.decode(it) }

        assertEquals(events.size, roundtripped.size)
        // Equality on JSONObject inside ToolCallStarted goes through
        // toString() comparison since JSONObject doesn't override
        // equals(). Compare the encoded forms instead — that's
        // what'll round-trip on disk anyway.
        val original = events.map { AgentEvents.encode(it) }
        val rebuilt = roundtripped.map { AgentEvents.encode(it) }
        assertEquals(original, rebuilt)
    }

    @Test
    fun `decode tolerates unknown event type`() {
        val bad = """{"type":"some_future_event","ts":42}"""
        val ex = runCatching { AgentEvents.decode(bad) }.exceptionOrNull()
        assertNotNull("decode should fail on unknown type", ex)
        assertTrue(ex is IllegalArgumentException)
    }

    // -------------- session lifecycle --------------

    @Test
    fun `newSession creates a directory and an empty jsonl`() {
        val store = SessionStore(rootDir)
        val s = store.newSession()
        assertTrue("dir created", s.dir.isDirectory)
        assertTrue("jsonl created", s.jsonlFile.isFile)
        assertEquals("empty body", 0L, s.jsonlFile.length())
    }

    @Test
    fun `appendEvent writes one line per event`() {
        val store = SessionStore(rootDir)
        val s = store.newSession()
        store.appendEvent(s, AgentEvent.User(ts = 1L, text = "hi"))
        store.appendEvent(s, AgentEvent.AssistantText(ts = 2L, text = "hello"))
        val lines = s.jsonlFile.readLines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].contains("\"user\""))
        assertTrue(lines[1].contains("\"assistant_text\""))
    }

    @Test
    fun `mostRecent picks the highest-id session`() {
        val store = SessionStore(rootDir)
        val older = File(rootDir, "2025-01-01T00-00-00Z").apply {
            mkdirs(); File(this, "session.jsonl").createNewFile()
        }
        val newer = File(rootDir, "2026-05-08T11-00-00Z").apply {
            mkdirs(); File(this, "session.jsonl").createNewFile()
        }
        val recent = store.mostRecent()
        assertNotNull(recent)
        assertEquals(newer.name, recent!!.id)
    }

    // -------------- replay reconstruction --------------

    @Test
    fun `replay reconstructs a clean session as turns`() {
        val store = SessionStore(rootDir)
        val s = store.newSession()
        store.appendEvent(s, AgentEvent.SessionStart(1L, "Local", "e2b"))
        store.appendEvent(s, AgentEvent.User(2L, "List my printers."))
        store.appendEvent(s, AgentEvent.ToolCallStarted(3L, "c1", "list_printers", JSONObject()))
        store.appendEvent(s, AgentEvent.ToolCallFinished(4L, "c1", "list_printers", "U1", false))
        store.appendEvent(s, AgentEvent.Final(5L, "You have one printer: U1."))

        val result = store.replay(s)
        assertFalse("clean session should not be flagged interrupted", result.interrupted)
        // Expected turns: User, Assistant(toolCalls=[list_printers]),
        // ToolResult, Assistant(text=final).
        assertEquals(4, result.turns.size)
        assertTrue(result.turns[0] is LlmTurn.User)
        assertTrue(result.turns[1] is LlmTurn.Assistant)
        assertTrue(result.turns[2] is LlmTurn.ToolResult)
        assertTrue(result.turns[3] is LlmTurn.Assistant)

        val toolCallTurn = result.turns[1] as LlmTurn.Assistant
        assertEquals(1, toolCallTurn.toolCalls.size)
        assertEquals("list_printers", toolCallTurn.toolCalls[0].name)
        assertEquals("c1", toolCallTurn.toolCalls[0].id)

        val finalTurn = result.turns[3] as LlmTurn.Assistant
        assertEquals("You have one printer: U1.", finalTurn.text)
    }

    @Test
    fun `replay flags interrupted when no terminal event`() {
        val store = SessionStore(rootDir)
        val s = store.newSession()
        store.appendEvent(s, AgentEvent.SessionStart(1L, "Local", "e2b"))
        store.appendEvent(s, AgentEvent.User(2L, "Slice the cube."))
        store.appendEvent(s, AgentEvent.ToolCallStarted(3L, "c1", "slice_active_plate", JSONObject()))
        // Process killed before tool finishes.

        val result = store.replay(s)
        assertTrue("dangling tool call should mark session interrupted", result.interrupted)
    }

    @Test
    fun `replay survives malformed lines`() {
        val store = SessionStore(rootDir)
        val s = store.newSession()
        store.appendEvent(s, AgentEvent.User(1L, "hi"))
        // Inject a corrupt line — earlier write got truncated by an
        // SD card unmount, future schema's not-yet-known type, etc.
        s.jsonlFile.appendText("not-valid-json-here\n")
        store.appendEvent(s, AgentEvent.Final(2L, "ok"))

        val result = store.replay(s)
        // Two good events → User turn + Final-as-Assistant turn.
        assertEquals(2, result.turns.size)
        assertTrue(result.turns[0] is LlmTurn.User)
        assertTrue(result.turns[1] is LlmTurn.Assistant)
        assertEquals("ok", (result.turns[1] as LlmTurn.Assistant).text)
    }
}
