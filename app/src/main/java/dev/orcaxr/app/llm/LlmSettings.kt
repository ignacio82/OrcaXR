package dev.orcaxr.app.llm

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.orcaxr.app.mcp.McpSettings
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * The three providers OrcaXR's in-app assistant can talk to. Selection is
 * persisted so the user can keep keys for several providers but only
 * actively chat with one. The card flips between key-entry rows by
 * provider; the chat panel reads [LlmSettings.selectedProvider] to pick
 * which client to send through.
 */
enum class LlmProvider(val displayName: String, val keyName: String) {
    Claude("Claude", "Anthropic"),
    Gemini("Gemini", "Google AI Studio"),
    OpenAI("OpenAI", "OpenAI"),
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
class LlmSettings(ctx: Context) {

    private val store = ctx.applicationContext.llmDataStore
    private val mcp = McpSettings(ctx.applicationContext)

    val claudeApiKey: Flow<String?> = store.data.map { it[KEY_CLAUDE] }
    val geminiApiKey: Flow<String?> = store.data.map { it[KEY_GEMINI] }
    val openAiApiKey: Flow<String?> = store.data.map { it[KEY_OPENAI] }

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
            if (value.isNullOrBlank()) it.remove(KEY_CLAUDE) else it[KEY_CLAUDE] = value.trim()
        }
        // Mirror to McpSettings so existing tools (find_feature_anchors,
        // generate_mask_from_point) pick it up without a process restart.
        // Clearing on this side does NOT clear the legacy key — the user
        // may have set that separately for the MCP-only flow.
        if (!value.isNullOrBlank()) mcp.setAnthropicApiKey(value.trim())
    }

    suspend fun setGeminiApiKey(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_GEMINI) else it[KEY_GEMINI] = value.trim()
        }
    }

    suspend fun setOpenAiApiKey(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) it.remove(KEY_OPENAI) else it[KEY_OPENAI] = value.trim()
        }
    }

    suspend fun setSelectedProvider(p: LlmProvider) {
        store.edit { it[KEY_SELECTED] = p.name }
    }

    suspend fun setVoiceEnabled(value: Boolean) {
        store.edit { it[KEY_VOICE] = value }
    }

    /** Snapshot for the chat panel — one DataStore read per turn. */
    suspend fun snapshot(): Snapshot {
        val prefs = store.data.first()
        val selected = LlmProvider.fromStorage(prefs[KEY_SELECTED])
        val claude = prefs[KEY_CLAUDE]?.takeIf { it.isNotBlank() }
            ?: mcp.anthropicApiKey.first()?.takeIf { it.isNotBlank() }
        return Snapshot(
            selected = selected,
            claudeKey = claude,
            geminiKey = prefs[KEY_GEMINI]?.takeIf { it.isNotBlank() },
            openAiKey = prefs[KEY_OPENAI]?.takeIf { it.isNotBlank() },
            voiceEnabled = prefs[KEY_VOICE] ?: false,
        )
    }

    data class Snapshot(
        val selected: LlmProvider,
        val claudeKey: String?,
        val geminiKey: String?,
        val openAiKey: String?,
        val voiceEnabled: Boolean,
    ) {
        fun keyFor(p: LlmProvider): String? = when (p) {
            LlmProvider.Claude -> claudeKey
            LlmProvider.Gemini -> geminiKey
            LlmProvider.OpenAI -> openAiKey
        }

        /** True when at least one provider has a key set. The chat
         *  panel and voice button gate on this. */
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
