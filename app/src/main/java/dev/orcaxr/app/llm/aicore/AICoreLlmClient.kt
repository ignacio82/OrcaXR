package dev.orcaxr.app.llm.aicore

import android.content.Context
import android.util.Log
import dev.orcaxr.app.llm.LlmClient
import dev.orcaxr.app.llm.LlmProvider
import dev.orcaxr.app.llm.LlmResponse
import dev.orcaxr.app.llm.LlmToolDef
import dev.orcaxr.app.llm.LlmTurn
import dev.orcaxr.app.llm.local.ParsedEnvelope
import dev.orcaxr.app.llm.local.buildGemma4Prompt
import dev.orcaxr.app.llm.local.envelopeToLlmResponse
import dev.orcaxr.app.llm.local.parseGemma4Envelope

/**
 * On-device LLM client backed by AICore / Gemini Nano via ML Kit
 * GenAI Prompt. Implements the same [LlmClient] contract as the
 * cloud clients and as [dev.orcaxr.app.llm.local.LocalLlmClient] —
 * the chat panel and [dev.orcaxr.app.llm.runner.AgentRunner] don't
 * have to know which on-device runtime is serving the turn.
 *
 * **Tool calling protocol.** ML Kit GenAI Prompt's beta does not
 * expose tool calling, so this client uses OrcaXR's existing
 * text-prose + JSON-envelope pattern, which has been hardened for
 * months across the LiteRT-LM/Gemma 4 path and OrcaAI's AgentLoop.
 * The same prompt builder ([buildGemma4Prompt]) and the same
 * envelope parser ([parseGemma4Envelope]) are reused verbatim — the
 * only thing that differs from [LocalLlmClient] is the inference
 * call itself and the lack of a KV-cache continuation (ML Kit
 * GenAI's request/response API doesn't expose a stateful
 * Conversation handle).
 *
 * **What's intentionally NOT here.**
 *  - No KV-cache delta sending — every turn re-prefills the full
 *    prompt. Nano is small and runs on the TPU, so a fresh prefill
 *    is cheap relative to the LiteRT/GPU equivalent.
 *  - No truncation auto-continue. ML Kit Nano stops cleanly on EOS
 *    in practice; if we observe truncation in the field, we can add
 *    one-shot continuation later by re-sending the original prompt
 *    plus the partial response with an explicit "continue exactly
 *    where you stopped" suffix.
 *  - No streaming surface up the LlmClient interface (yet) — the
 *    chat panel still treats each turn as a single response. The
 *    underlying [AICoreEngineHolder.runInference] does support an
 *    `onToken` callback for the day we add streaming.
 *
 * **Readiness gating.** The chat panel must check
 * [AICoreEngineHolder.checkStatus] before constructing this client
 * — there's no point dispatching a turn through a backend whose
 * feature pack hasn't been downloaded yet. The `respond` call here
 * will surface the underlying ML Kit error verbatim if the model
 * isn't actually available.
 */
class AICoreLlmClient(
    private val appContext: Context,
) : LlmClient {

    private val tag: String = "OrcaXR/llm/aicore"

    override val provider: LlmProvider = LlmProvider.AICore

    override suspend fun respond(
        history: List<LlmTurn>,
        tools: List<LlmToolDef>,
        systemPrompt: String,
    ): Result<LlmResponse> = runCatching {
        val fullPrompt = buildGemma4Prompt(history, tools, systemPrompt)
        Log.d(tag, "respond: ${fullPrompt.length} char prompt to AICore")
        val raw = AICoreEngineHolder.runInference(
            context = appContext,
            prompt = fullPrompt,
            // COMMAND-style determinism — match the LiteRT path's
            // sampler. Small models leak out-of-grammar text at
            // higher temperature; we want a clean
            // {"tool":...} / {"final":...} envelope.
            temperature = 0f,
            topK = 1,
        )
        val parsed = parseGemma4Envelope(raw)
        if (parsed is ParsedEnvelope.Fallback) {
            Log.w(tag, "envelope parse failed; raw=${raw.take(120)}…")
        }
        envelopeToLlmResponse(parsed)
    }
}
