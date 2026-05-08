package dev.orcaxr.app.llm.local

import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import dev.orcaxr.app.llm.LlmClient
import dev.orcaxr.app.llm.LlmProvider
import dev.orcaxr.app.llm.LlmResponse
import dev.orcaxr.app.llm.LlmToolDef
import dev.orcaxr.app.llm.LlmTurn
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * On-device LLM client backed by LiteRT-LM running Gemma 4 (E2B or
 * E4B). Implements the same [LlmClient] contract as
 * [dev.orcaxr.app.llm.ClaudeLlmClient] / Gemini / OpenAI — the chat
 * panel doesn't have to know whether it's talking to a cloud model
 * or to a local one.
 *
 * Tool calling protocol:
 *   Gemma 4 is function-calling capable but LiteRT-LM 0.10.x's
 *   typed-tool plumbing doesn't round-trip multi-turn tool histories
 *   cleanly enough for a 100+ tool catalogue. We use the same
 *   text-prose + JSON-envelope pattern OrcaAI's AgentLoop has
 *   hardened for months on the same model. The pure prompt-build /
 *   parse logic lives in [Gemma4Prompt] (split out for unit tests
 *   that can't construct a Context).
 *
 * Phase 3 — KV-cache continuation:
 *   The instance caches one [Conversation] across [respond] calls
 *   within the same session. On each call:
 *     - If the new full prompt strictly extends the previously-sent
 *       text, send only the delta to the cached Conversation. The
 *       LiteRT-LM Engine reuses the prefix's KV cache, skipping
 *       multi-thousand tokens of system-prompt + tool-catalogue
 *       prefill (~1-2 s on Adreno).
 *     - Otherwise close the cached Conversation, create a fresh one,
 *       and send the full prompt.
 *   Cache is invalidated when the loaded Engine changes (size swap,
 *   manual unload), since the Conversation is bound to the Engine.
 *
 * Phase 2 — Auto-continue on truncation:
 *   When the model's response can't be parsed as a `{"tool":...}` /
 *   `{"final":...}` envelope AND the raw text looks cut off (no
 *   balanced object, no terminal punctuation), we issue ONE
 *   continuation message on the same Conversation asking the model
 *   to finish, then re-parse the combined output. Bounded retry
 *   prevents runaway when the model genuinely can't form an envelope
 *   (in that case the caller falls back to the raw text).
 *
 * GPU-then-NPU only — see [LiteRtEngineHolder] header for the
 * rationale and the why-no-CPU policy.
 */
class LocalLlmClient(
    private val appContext: Context,
    private val size: Gemma4Size,
) : LlmClient {

    private val tag: String = "OrcaXR/llm/local"

    override val provider: LlmProvider = LlmProvider.Local

    @OptIn(ExperimentalApi::class)
    @Volatile
    private var cachedConversation: Conversation? = null

    /** Engine identity at the time [cachedConversation] was opened.
     *  When the engine swaps (size change, unload) we drop the
     *  cached conversation since it's bound to the old engine. */
    @OptIn(ExperimentalApi::class)
    @Volatile
    private var cachedEngineRef: Engine? = null

    /** Text prefix already fed into [cachedConversation]. The next
     *  [respond] call sends only `(newPrompt + newRawResponse) -
     *  this.length` worth of tokens. Null when no cached
     *  conversation. */
    @Volatile
    private var lastSentText: String? = null

    @OptIn(ExperimentalApi::class)
    override suspend fun respond(
        history: List<LlmTurn>,
        tools: List<LlmToolDef>,
        systemPrompt: String,
    ): Result<LlmResponse> = runCatching {
        val active = LiteRtEngineHolder.getOrLoad(appContext, size)
        val fullPrompt = buildGemma4Prompt(history, tools, systemPrompt)

        LiteRtEngineHolder.inferenceLock.lock()
        try {
            // Engine swap (size change, manual unload) invalidates
            // the cached Conversation — its KV state is bound to
            // the old engine's GPU resources.
            if (cachedEngineRef !== active.engine) {
                runCatching { cachedConversation?.close() }
                cachedConversation = null
                cachedEngineRef = active.engine
                lastSentText = null
            }

            val (conversation, prefixToSend) = when {
                cachedConversation != null && lastSentText != null &&
                    fullPrompt.startsWith(lastSentText!!) -> {
                    val delta = fullPrompt.substring(lastSentText!!.length)
                    Log.d(
                        tag,
                        "KV-cache hit: sending ${delta.length} chars delta " +
                            "(prefix ${lastSentText!!.length} chars cached)",
                    )
                    cachedConversation!! to delta
                }
                else -> {
                    runCatching { cachedConversation?.close() }
                    val fresh = active.engine.createConversation(
                        ConversationConfig(
                            samplerConfig = SamplerConfig(
                                // COMMAND-style determinism. Small
                                // models leak out-of-grammar text at
                                // high temperature; we want a clean
                                // {"tool":...} or {"final":...}
                                // envelope.
                                topK = 1,
                                topP = 0.1,
                                temperature = 0.0,
                            ),
                        ),
                    )
                    cachedConversation = fresh
                    Log.d(tag, "KV-cache cold: sending ${fullPrompt.length} chars full prompt")
                    fresh to fullPrompt
                }
            }

            val firstRaw = sendAndAwait(conversation, prefixToSend)
            var combinedRaw = firstRaw
            var parsed = parseGemma4Envelope(firstRaw)

            // Auto-continue on truncation. When the model didn't
            // close out a recognizable envelope AND its output
            // doesn't look terminated, send a continuation message
            // on the SAME conversation (KV preserved) and combine.
            if (parsed is ParsedEnvelope.Fallback && looksTruncated(firstRaw)) {
                Log.i(tag, "auto-continue: first response looks truncated; retrying once")
                val continueRaw = sendAndAwait(conversation, CONTINUATION_PROMPT)
                combinedRaw = firstRaw + continueRaw
                parsed = parseGemma4Envelope(combinedRaw)
            }

            // Update cache prefix for next-turn delta.
            lastSentText = fullPrompt + combinedRaw

            envelopeToLlmResponse(parsed)
        } finally {
            LiteRtEngineHolder.inferenceLock.unlock()
        }
    }

    /** Send one user message on the given [Conversation] and await
     *  the full response. The conversation is **not** closed here
     *  — the caller decides whether to keep it for KV-cache reuse
     *  or close it on engine swap. */
    @OptIn(ExperimentalApi::class)
    private suspend fun sendAndAwait(conversation: Conversation, text: String): String {
        if (text.isEmpty()) return ""
        return try {
            suspendCancellableCoroutine<String> { cont ->
                val sb = StringBuilder()
                try {
                    conversation.sendMessageAsync(
                        Contents.of(listOf(Content.Text(text))),
                        object : MessageCallback {
                            override fun onMessage(message: Message) {
                                sb.append(message.toString())
                            }
                            override fun onDone() {
                                cont.resume(sb.toString())
                            }
                            override fun onError(throwable: Throwable) {
                                cont.resumeWithException(throwable)
                            }
                        },
                    )
                } catch (e: Exception) {
                    cont.resumeWithException(e)
                }
            }
        } catch (e: CancellationException) {
            // The Conversation may still be generating; drop the
            // cache so the next respond() rebuilds cleanly. We
            // explicitly DON'T propagate this as a regular error —
            // CancellationException must propagate untouched.
            invalidateCache()
            throw e
        }
    }

    /** Drop cached conversation + prefix. Used when an inference
     *  call fails or is cancelled — the cache state is no longer
     *  trustworthy because we don't know whether the partial output
     *  was committed to the engine's KV or not. */
    @OptIn(ExperimentalApi::class)
    private fun invalidateCache() {
        runCatching { cachedConversation?.close() }
        cachedConversation = null
        lastSentText = null
    }

    companion object {
        // Sent on the same Conversation when the previous turn's
        // output looks truncated. The model sees a fresh user turn
        // wrapping just this hint; KV from the previous turn is
        // preserved so the model "remembers" what it was about to
        // emit.
        private const val CONTINUATION_PROMPT =
            "Your previous reply was cut off mid-output. Please continue exactly where you " +
                "stopped, and end with a clean JSON envelope " +
                "({\"tool\":\"<name>\",\"arguments\":{...}} or {\"final\":\"<message>\"}) " +
                "and nothing else."
    }
}
