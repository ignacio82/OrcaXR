package dev.orcaxr.app.llm

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.orcaxr.app.llm.local.Gemma4Size
import dev.orcaxr.app.mcp.AndroidKeystoreSecretBox
import dev.orcaxr.app.mcp.McpSettings
import dev.orcaxr.app.mcp.SecretBox
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * The five providers OrcaXR's in-app assistant can talk to.
 *
 * - Cloud (Claude / Gemini / OpenAI) — billed to the user's own
 *   account; needs an API key.
 * - Local (on-device Gemma 4 via LiteRT-LM) — no key, free, but
 *   requires downloading a 2-3 GiB .litertlm bundle the first time.
 *   See `dev.orcaxr.app.llm.local.LocalLlmClient`. Runs on Adreno
 *   GPU on phones / on the headset's GPU on Galaxy XR.
 * - AICore (on-device Gemini Nano via ML Kit GenAI Prompt) — no key,
 *   free, runs on the Pixel Tensor TPU at the OS level. The model is
 *   provisioned by AICore (typically a few-hundred-MB feature pack)
 *   and is unavailable on devices without a Tensor SoC. See
 *   `dev.orcaxr.app.llm.aicore.AICoreLlmClient`.
 *
 * Selection is persisted so the user can keep keys for several
 * providers but only actively chat with one. The card flips between
 * key-entry rows (cloud) and a model-download row (local / aicore)
 * by provider; the chat panel reads [LlmSettings.selectedProvider]
 * to pick which client to send through.
 */
enum class LlmProvider(val displayName: String, val keyName: String) {
    Claude("Claude", "Anthropic"),
    Gemini("Gemini", "Google AI Studio"),
    OpenAI("OpenAI", "OpenAI"),
    /** On-device Gemma 4. `keyName` is unused for this entry but kept
     *  non-empty for the existing card label code path. */
    Local("Gemma 4", "On-device"),
    /** On-device Gemini Nano via AICore. Pixel-class devices only. */
    AICore("Gemini Nano", "On-device (Tensor)"),
    ;
    companion object {
        fun fromStorage(s: String?): LlmProvider = entries.firstOrNull { it.name == s } ?: Claude
    }
}

/**
 * Per-user persisted config for the optional in-app LLM assistant.
 *
 * Distinct from [McpSettings]: that store is for the *outgoing* MCP
 * server (LLMs calling INTO OrcaXR). This one is for the *incoming*
 * direction — OrcaXR calling out to a hosted LLM so the user can
 * drive the app by voice or text. Keys are billed to the user's
 * provider account; OrcaXR doesn't proxy.
 *
 * The Anthropic key on `McpSettings.anthropicApiKey` (used by
 * `find_feature_anchors`) is folded in by [unifiedClaudeKey] so a key
 * entered here also unlocks the vision feature anchors tool — there
 * is no reason to ask the user for the same key twice.
 */
class LlmSettings(
    ctx: Context,
    /**
     * Audit H3 (2026-05-07) — same Keystore-backed AEAD that
     * [McpSettings] uses, so the Claude / Gemini / OpenAI keys
     * stored here ride encrypted at rest. Migration is silent: a
     * legacy plaintext value falls through to the original string and
     * gets rewritten encrypted on the next setter call.
     */
    private val secretBox: SecretBox = AndroidKeystoreSecretBox(),
) {

    private val store = ctx.applicationContext.llmDataStore
    private val mcp = McpSettings(ctx.applicationContext, secretBox)

    val claudeApiKey: Flow<String?> = store.data.map { decode(it[KEY_CLAUDE]) }
    val geminiApiKey: Flow<String?> = store.data.map { decode(it[KEY_GEMINI]) }
    val openAiApiKey: Flow<String?> = store.data.map { decode(it[KEY_OPENAI]) }

    /**
     * Per-provider model override. When null/blank, the client falls
     * back to its `DEFAULT_MODEL` constant. Audit H_PIXEL10 (2026-05-08):
     * we made these user-overridable because the published model IDs
     * on each provider's API change frequently (Gemini 3 preview lines
     * appear / disappear, Claude 4.x family rotates, OpenAI rev IDs
     * roll forward) and shipping a new APK to track every flip is
     * unsustainable. Letting the user paste in whatever model id their
     * key has access to is cheaper for everyone.
     */
    val claudeModel: Flow<String?> = store.data.map { it[KEY_MODEL_CLAUDE] }
    val geminiModel: Flow<String?> = store.data.map { it[KEY_MODEL_GEMINI] }
    val openAiModel: Flow<String?> = store.data.map { it[KEY_MODEL_OPENAI] }

    /** Audit H3 — try encrypted-format first, fall back to legacy
     *  plaintext when the value doesn't decode. Returns null for null
     *  inputs so empty Flows behave identically to the previous code. */
    private fun decode(raw: String?): String? = if (raw == null) null
        else (secretBox.decrypt(raw) ?: raw)

    val selectedProvider: Flow<LlmProvider> = store.data.map {
        LlmProvider.fromStorage(it[KEY_SELECTED])
    }

    /**
     * Voice-input toggle. Even when keys are configured, the user can
     * keep the mic disabled (e.g. shared environment, microphone in
     * use by another app). Off by default — enabling prompts for
     * RECORD_AUDIO at the panel.
     */
    val voiceEnabled: Flow<Boolean> = store.data.map { it[KEY_VOICE] ?: false }

    /**
     * User's preferred Gemma 4 size for the on-device backend. E2B
     * (~2.4 GiB, ~2.3B effective params) is the default — fits the
     * Galaxy XR's thermal and RAM envelope better than E4B and the
     * MMLU-Pro / tool-routing accuracy is enough for the slicer's
     * tool surface. Users on a phone form factor with plenty of RAM
     * can flip to E4B for the harder reasoning tasks.
     */
    val localModelSize: Flow<Gemma4Size> = store.data.map {
        Gemma4Size.fromStorage(it[KEY_LOCAL_SIZE])
    }

    /**
     * Combined Claude key flow that prefers a value entered through this
     * settings store, with the legacy [McpSettings.anthropicApiKey] as
     * a fallback. The MCP-side vision tools subscribe to this so the
     * user only ever has to enter the Anthropic key once, in either UI.
     */
    val unifiedClaudeKey: Flow<String?> =
        claudeApiKey.combine(mcp.anthropicApiKey) { newer, legacy ->
            newer?.takeIf { it.isNotBlank() } ?: legacy?.takeIf { it.isNotBlank() }
        }

    suspend fun setClaudeApiKey(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_CLAUDE)
            else it[KEY_CLAUDE] = secretBox.encrypt(value.trim())
        }
        // Mirror to McpSettings so existing tools (find_feature_anchors,
        // generate_mask_from_point) pick it up without a process restart.
        // Clearing on this side does NOT clear the legacy key — the user
        // may have set that separately for the MCP-only flow.
        if (!value.isNullOrBlank()) mcp.setAnthropicApiKey(value.trim())
    }

    suspend fun setGeminiApiKey(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_GEMINI)
            else it[KEY_GEMINI] = secretBox.encrypt(value.trim())
        }
    }

    suspend fun setOpenAiApiKey(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_OPENAI)
            else it[KEY_OPENAI] = secretBox.encrypt(value.trim())
        }
    }

    suspend fun setClaudeModel(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_MODEL_CLAUDE)
            else it[KEY_MODEL_CLAUDE] = value.trim()
        }
    }

    suspend fun setGeminiModel(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_MODEL_GEMINI)
            else it[KEY_MODEL_GEMINI] = value.trim()
        }
    }

    suspend fun setOpenAiModel(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_MODEL_OPENAI)
            else it[KEY_MODEL_OPENAI] = value.trim()
        }
    }

    suspend fun setSelectedProvider(p: LlmProvider) {
        store.edit { it[KEY_SELECTED] = p.name }
    }

    suspend fun setVoiceEnabled(value: Boolean) {
        store.edit { it[KEY_VOICE] = value }
    }

    suspend fun setLocalModelSize(size: Gemma4Size) {
        store.edit { it[KEY_LOCAL_SIZE] = size.storageName }
    }

    /** Snapshot for the chat panel — one DataStore read per turn. */
    suspend fun snapshot(): Snapshot {
        val prefs = store.data.first()
        val selected = LlmProvider.fromStorage(prefs[KEY_SELECTED])
        // Audit H3 — decrypt all three keys via the SecretBox so the
        // snapshot returns plaintext for the chat panel. Migration-
        // friendly: legacy plaintext values fall through to the original
        // string courtesy of [decode].
        val claude = decode(prefs[KEY_CLAUDE])?.takeIf { it.isNotBlank() }
            ?: mcp.anthropicApiKey.first()?.takeIf { it.isNotBlank() }
        return Snapshot(
            selected = selected,
            claudeKey = claude,
            geminiKey = decode(prefs[KEY_GEMINI])?.takeIf { it.isNotBlank() },
            openAiKey = decode(prefs[KEY_OPENAI])?.takeIf { it.isNotBlank() },
            claudeModel = prefs[KEY_MODEL_CLAUDE]?.takeIf { it.isNotBlank() },
            geminiModel = prefs[KEY_MODEL_GEMINI]?.takeIf { it.isNotBlank() },
            openAiModel = prefs[KEY_MODEL_OPENAI]?.takeIf { it.isNotBlank() },
            voiceEnabled = prefs[KEY_VOICE] ?: false,
            localModelSize = Gemma4Size.fromStorage(prefs[KEY_LOCAL_SIZE]),
        )
    }

    data class Snapshot(
        val selected: LlmProvider,
        val claudeKey: String?,
        val geminiKey: String?,
        val openAiKey: String?,
        val claudeModel: String?,
        val geminiModel: String?,
        val openAiModel: String?,
        val voiceEnabled: Boolean,
        val localModelSize: Gemma4Size,
    ) {
        fun keyFor(p: LlmProvider): String? = when (p) {
            LlmProvider.Claude -> claudeKey
            LlmProvider.Gemini -> geminiKey
            LlmProvider.OpenAI -> openAiKey
            // On-device backends have no key — readiness is computed
            // from Gemma4DownloadRepository.isDownloaded() (Local) or
            // AICoreEngineHolder.checkStatus() (AICore) at the call
            // site instead.
            LlmProvider.Local -> null
            LlmProvider.AICore -> null
        }

        fun modelFor(p: LlmProvider): String? = when (p) {
            LlmProvider.Claude -> claudeModel
            LlmProvider.Gemini -> geminiModel
            LlmProvider.OpenAI -> openAiModel
            LlmProvider.Local -> localModelSize.storageName
            // AICore picks whichever Gemini Nano feature pack the
            // device has provisioned; the user doesn't override.
            LlmProvider.AICore -> null
        }

        /** True when at least one cloud provider has a key set. The
         *  chat panel and voice button gate on this OR
         *  Local-model-downloaded. */
        val anyKeyConfigured: Boolean
            get() = !claudeKey.isNullOrBlank() ||
                !geminiKey.isNullOrBlank() ||
                !openAiKey.isNullOrBlank()
    }

    companion object {
        private val KEY_CLAUDE = stringPreferencesKey("llm_claude_api_key")
        private val KEY_GEMINI = stringPreferencesKey("llm_gemini_api_key")
        private val KEY_OPENAI = stringPreferencesKey("llm_openai_api_key")
        private val KEY_SELECTED = stringPreferencesKey("llm_selected_provider")
        private val KEY_VOICE = booleanPreferencesKey("llm_voice_enabled")
        private val KEY_MODEL_CLAUDE = stringPreferencesKey("llm_claude_model")
        private val KEY_MODEL_GEMINI = stringPreferencesKey("llm_gemini_model")
        private val KEY_MODEL_OPENAI = stringPreferencesKey("llm_openai_model")
        private val KEY_LOCAL_SIZE = stringPreferencesKey("llm_local_size")

        @Volatile private var instance: LlmSettings? = null

        /** Lazy-singleton getter. Pass any Context. */
        fun get(ctx: Context): LlmSettings {
            instance?.let { return it }
            return synchronized(this) {
                instance ?: LlmSettings(ctx.applicationContext).also { instance = it }
            }
        }
    }
}

private val Context.llmDataStore by preferencesDataStore("orcaxr.llm")
