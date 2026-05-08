package dev.orcaxr.app.llm.runner

import android.content.Context
import android.util.Log
import dev.orcaxr.app.llm.LlmClient
import dev.orcaxr.app.llm.LlmProvider
import dev.orcaxr.app.llm.LlmSettings
import dev.orcaxr.app.llm.LlmToolBridge
import dev.orcaxr.app.llm.LlmTurn
import dev.orcaxr.app.llm.local.LocalLlmClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Process-singleton orchestrator for the in-app assistant. Owns:
 *
 *  - The active [SessionStore.Session] (one JSONL file under
 *    `filesDir/llm_sessions/<id>/`).
 *  - The running tool-loop coroutine for the current turn.
 *  - StateFlows the chat panel observes ([turns], [runState]).
 *  - The [AgentForegroundService] binding (started while the loop
 *    is running, stopped on Idle).
 *
 * Why a singleton instead of state owned by the panel: a turn can
 * take tens of seconds (slice → render → vision → paint), and the
 * user routinely takes off the headset mid-turn. State scoped to
 * the panel composable dies with the Activity. State scoped to the
 * Application + a foreground service survives. The panel becomes a
 * pure observer + input forwarder, with no in-flight Job of its
 * own.
 *
 * Crash semantics ride [SessionStore]: every event is persisted to
 * JSONL before its side effect, so a kill-restart replays the
 * transcript including any in-flight tool call. [interruptedOnLoad]
 * goes true when the last session ended without a terminal event,
 * letting the panel surface "interrupted — please retry."
 */
class AgentRunner private constructor(
    private val appContext: Context,
    private val settings: LlmSettings,
    private val store: SessionStore,
) {

    private val tag: String = "OrcaXR/llm/runner"
    private val scope: CoroutineScope =
        CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Tool registry, lazy. Same surface the cloud + local clients
     *  see; mirrors the chat panel's prior wiring. Uses the
     *  in-process bridge — no MCP HTTP loopback. */
    private val bridge: LlmToolBridge by lazy { LlmToolBridge(appContext) }

    private val _turns = MutableStateFlow<List<LlmTurn>>(emptyList())
    val turns: StateFlow<List<LlmTurn>> = _turns.asStateFlow()

    private val _runState = MutableStateFlow<RunState>(RunState.Idle)
    val runState: StateFlow<RunState> = _runState.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /** True when the loaded session ended without a terminal event
     *  — the previous run was killed mid-turn. The panel surfaces
     *  this as a banner so the user knows the assistant doesn't
     *  consider that turn complete; their next message kicks off a
     *  fresh turn. */
    private val _interruptedOnLoad = MutableStateFlow(false)
    val interruptedOnLoad: StateFlow<Boolean> = _interruptedOnLoad.asStateFlow()

    private var activeSession: SessionStore.Session? = null
    private var loopJob: Job? = null

    /** Start (or rejoin) at app startup. Loads the most recent
     *  session if one exists; otherwise creates a fresh one. Safe
     *  to call multiple times — second call is a no-op. */
    fun start() {
        if (activeSession != null) return
        val recent = store.mostRecent()
        if (recent != null) {
            val replay = store.replay(recent)
            activeSession = recent
            _turns.value = replay.turns
            _interruptedOnLoad.value = replay.interrupted
            Log.i(
                tag,
                "loaded session ${recent.id}: ${replay.turns.size} turns, " +
                    "interrupted=${replay.interrupted}",
            )
        } else {
            activeSession = newSession()
        }
    }

    /** Drop the current session and start fresh. The old session
     *  stays on disk for browsing. */
    fun newConversation() {
        cancel(reason = "new_conversation")
        activeSession = newSession()
        _turns.value = emptyList()
        _lastError.value = null
        _interruptedOnLoad.value = false
    }

    /** Append a user message and kick off the tool loop. No-op
     *  while a turn is still in flight — caller should disable
     *  send while [runState] is Replying. */
    fun send(text: String) {
        if (_runState.value is RunState.Replying) {
            Log.w(tag, "send: refused while a turn is in flight")
            return
        }
        val session = activeSession ?: newSession().also { activeSession = it }
        // Append-then-persist. Updates the in-memory flow first so
        // the UI feels instant, then syncs to disk on the IO scope.
        // If the disk write fails the UI still has the turn — the
        // worst case is a missing JSONL line on next replay.
        val userTurn = LlmTurn.User(text)
        _turns.value = _turns.value + userTurn
        _interruptedOnLoad.value = false
        _lastError.value = null
        _runState.value = RunState.Replying
        AgentForegroundService.start(appContext)

        loopJob = scope.launch {
            persistEvent(session, AgentEvent.User(now(), text))
            try {
                runLoop(session)
            } catch (t: Throwable) {
                Log.e(tag, "agent loop crashed: ${t.message}", t)
                val msg = t.message ?: t::class.java.simpleName
                runCatching { persistEvent(session, AgentEvent.Error(now(), msg)) }
                _lastError.value = msg
                _runState.value = RunState.Failed(msg)
            } finally {
                AgentForegroundService.stop(appContext)
            }
        }
    }

    /** Cancel the running turn. Safe to call from any thread. */
    fun cancel(reason: String) {
        val job = loopJob ?: return
        if (!job.isActive) return
        Log.i(tag, "cancel: $reason")
        job.cancel()
        val session = activeSession
        scope.launch {
            if (session != null) {
                runCatching { persistEvent(session, AgentEvent.Cancelled(now())) }
            }
            _runState.value = RunState.Idle
            AgentForegroundService.stop(appContext)
        }
    }

    /**
     * Public hook for the chat panel to acknowledge an interrupted
     * load — clears the banner so the user can move on.
     */
    fun acknowledgeInterruption() {
        _interruptedOnLoad.value = false
    }

    private suspend fun runLoop(session: SessionStore.Session) {
        val snapshot = settings.snapshot()
        val client = buildClient(snapshot)
        val toolDefs = bridge.toolDefs()
        var hopsRemaining = MAX_TOOL_HOPS
        while (hopsRemaining-- > 0) {
            val resp = withContext(Dispatchers.IO) {
                client.respond(_turns.value, toolDefs, SYSTEM_PROMPT)
            }.getOrElse {
                throw it
            }
            val assistantTurn = LlmTurn.Assistant(resp.text, resp.toolCalls)
            _turns.value = _turns.value + assistantTurn
            // Persist the assistant text (if any) and tool-call
            // started markers BEFORE running the tools so a crash
            // mid-tool gives the next replay enough context to
            // reconcile.
            if (!resp.text.isNullOrBlank() && resp.toolCalls.isEmpty()) {
                persistEvent(session, AgentEvent.AssistantText(now(), resp.text))
            }
            for (call in resp.toolCalls) {
                persistEvent(
                    session,
                    AgentEvent.ToolCallStarted(now(), call.id, call.name, call.args),
                )
            }

            if (resp.toolCalls.isEmpty()) {
                val finalText = resp.text?.takeIf { it.isNotBlank() } ?: ""
                persistEvent(session, AgentEvent.Final(now(), finalText))
                _runState.value = RunState.Idle
                return
            }

            for (call in resp.toolCalls) {
                val toolResult = withContext(Dispatchers.IO) {
                    bridge.execute(call.name, call.args)
                }
                val (content, isErr) = if (toolResult == null) {
                    "Unknown tool '${call.name}'." to true
                } else {
                    val payload = JSONObject().apply {
                        put("text", toolResult.text)
                        if (toolResult.structured != null) put("structured", toolResult.structured)
                    }
                    payload.toString() to toolResult.isError
                }
                _turns.value = _turns.value + LlmTurn.ToolResult(
                    callId = call.id,
                    name = call.name,
                    content = content,
                    isError = isErr,
                )
                persistEvent(
                    session,
                    AgentEvent.ToolCallFinished(now(), call.id, call.name, content, isErr),
                )
            }
        }
        // Hop budget exhausted — surface as final.
        val msg = "Assistant hit the tool-call safety cap ($MAX_TOOL_HOPS hops)."
        persistEvent(session, AgentEvent.Final(now(), msg))
        _turns.value = _turns.value + LlmTurn.Assistant(msg, emptyList())
        _runState.value = RunState.Idle
    }

    private fun buildClient(snapshot: LlmSettings.Snapshot): LlmClient {
        return when (snapshot.selected) {
            LlmProvider.Local -> LocalLlmClient(appContext, snapshot.localModelSize)
            else -> {
                val key = snapshot.keyFor(snapshot.selected)
                    ?: error("No API key for ${snapshot.selected.displayName}.")
                LlmClient.forProvider(snapshot.selected, key, snapshot.modelFor(snapshot.selected))
            }
        }
    }

    private fun newSession(): SessionStore.Session {
        val s = store.newSession()
        // Seed the JSONL with a SessionStart marker so the replay
        // path can read the active backend without re-resolving
        // settings.
        scope.launch {
            val snap = runCatching { settings.snapshot() }.getOrNull()
            val backend = snap?.selected?.name ?: "unknown"
            val model = snap?.modelFor(snap.selected)
            runCatching {
                store.appendEvent(s, AgentEvent.SessionStart(now(), backend, model))
            }
        }
        return s
    }

    private suspend fun persistEvent(session: SessionStore.Session, event: AgentEvent) =
        withContext(Dispatchers.IO) {
            runCatching { store.appendEvent(session, event) }
                .onFailure { Log.w(tag, "appendEvent failed: ${it.message}") }
        }

    private fun now(): Long = System.currentTimeMillis()

    sealed interface RunState {
        data object Idle : RunState
        data object Replying : RunState
        data class Failed(val message: String) : RunState
    }

    companion object {
        private const val MAX_TOOL_HOPS = 12

        // Same prompt the panel previously hard-coded; lifted here
        // so the runner is self-contained.
        private val SYSTEM_PROMPT = """
            You are the in-headset assistant for OrcaXR, an Android XR slicer for 3D printers.
            The user is wearing a headset and may be talking to you by voice. Keep replies short
            (1–3 sentences when text-only suffices). When the user asks you to do something,
            prefer using the available tools rather than describing what to do; the tools execute
            real actions on the user's workspace and printers. Confirm destructive actions (delete,
            cancel print, clear paint) before invoking them. If a tool returns an error, summarize
            what went wrong and offer one concrete next step. Do not invent tool names or fields.
        """.trimIndent()

        @Volatile
        private var instance: AgentRunner? = null

        fun get(context: Context): AgentRunner {
            instance?.let { return it }
            return synchronized(this) {
                instance ?: AgentRunner(
                    appContext = context.applicationContext,
                    settings = LlmSettings.get(context),
                    store = SessionStore(SessionStore.rootDir(context)),
                ).also { instance = it }
            }
        }
    }
}
