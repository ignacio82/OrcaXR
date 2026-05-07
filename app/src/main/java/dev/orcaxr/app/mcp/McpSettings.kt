package dev.orcaxr.app.mcp

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.security.SecureRandom

/**
 * Persisted MCP server config. Three knobs:
 * - `enabled` — gates whether [McpServer] starts at all. OFF by
 *   default; the user has to opt in from the Devices panel.
 * - `port` — TCP port to bind. 7080 by default (same band as
 *   Mainsail/Klipper run on, won't collide with common dev tools).
 * - `apiKey` — bearer token clients must present in
 *   `Authorization: Bearer <key>`. Generated on first enable so the
 *   user never has to invent their own; shown in the UI for
 *   copy-paste into the LLM client config.
 *
 * The DataStore file lives at `orcaxr.mcp` (separate from
 * `orcaxr.printers` etc.) so toggling this won't ever rewrite the
 * other stores.
 */
class McpSettings(
    ctx: Context,
    /**
     * Audit H3 — symmetric AEAD wrapper used to encrypt the Anthropic
     * API key at rest. Defaults to a Keystore-backed AES-256-GCM box;
     * unit tests can pass a [PlaintextSecretBox] when they don't have
     * a Keystore. The MCP bearer token is unencrypted today (it's
     * generated on-device and is functionally a capability — losing
     * it isn't an account-takeover the way the Anthropic key is); a
     * future commit can extend the scheme to it.
     */
    private val secretBox: SecretBox = AndroidKeystoreSecretBox(),
) {

    private val store = ctx.applicationContext.mcpDataStore

    val enabled: Flow<Boolean> = store.data.map { it[KEY_ENABLED] ?: false }

    val port: Flow<Int> = store.data.map { it[KEY_PORT] ?: DEFAULT_PORT }

    /**
     * The persisted bearer token, or null if one has never been
     * generated. UI calls [ensureApiKey] when the user flips the
     * server on; this Flow is the read side for displaying it.
     */
    val apiKey: Flow<String?> = store.data.map { it[KEY_API_KEY] }

    /**
     * D18c — Anthropic API key for `find_feature_anchors` (vision-LLM
     * subroutine). Stored in DataStore; read by the tool when invoked.
     * Null/empty means the feature isn't configured; the tool returns
     * a clear error in that case so the LLM doesn't burn tokens
     * retrying. The key is for the user's own account — OrcaXR
     * doesn't own the billing relationship, costs accrue to whoever
     * provisioned the key.
     *
     * Audit H3 (2026-05-07) — encrypted at rest via [SecretBox] (AES-
     * 256-GCM with the Keystore-held key). Migration: a value that
     * doesn't decrypt as our format is treated as legacy plaintext and
     * returned as-is; the next [setAnthropicApiKey] call rewrites the
     * value encrypted. Don't add log statements that surface this Flow
     * — the decrypted key must never reach logcat.
     */
    val anthropicApiKey: Flow<String?> = store.data.map { prefs ->
        val raw = prefs[KEY_ANTHROPIC_API_KEY] ?: return@map null
        // Try the encrypted path first; fall back to treating raw as
        // legacy plaintext if decrypt fails. The migration is silent.
        secretBox.decrypt(raw) ?: raw
    }

    suspend fun setAnthropicApiKey(value: String?) {
        store.edit {
            if (value.isNullOrBlank()) {
                it.remove(KEY_ANTHROPIC_API_KEY)
            } else {
                it[KEY_ANTHROPIC_API_KEY] = secretBox.encrypt(value)
            }
        }
    }

    suspend fun setEnabled(value: Boolean) {
        store.edit { it[KEY_ENABLED] = value }
    }

    suspend fun setPort(value: Int) {
        store.edit { it[KEY_PORT] = value.coerceIn(1024, 65535) }
    }

    /** Generate-and-persist a fresh token. Returns the new value. */
    suspend fun rotateApiKey(): String {
        val fresh = generateApiKey()
        store.edit { it[KEY_API_KEY] = fresh }
        return fresh
    }

    /**
     * Get-or-create. Used when toggling `enabled` on for the first
     * time so the UI can show the user a key without a separate
     * "generate" step.
     */
    suspend fun ensureApiKey(): String {
        val existing = store.data.first()[KEY_API_KEY]
        if (!existing.isNullOrBlank()) return existing
        return rotateApiKey()
    }

    /**
     * Snapshot suitable for one server start. Resolves all three
     * knobs in one DataStore read so the server doesn't see torn
     * state across `enabled` / `port` / `apiKey`.
     */
    suspend fun snapshot(): Snapshot {
        val prefs = store.data.first()
        return Snapshot(
            enabled = prefs[KEY_ENABLED] ?: false,
            port = prefs[KEY_PORT] ?: DEFAULT_PORT,
            apiKey = prefs[KEY_API_KEY],
        )
    }

    data class Snapshot(val enabled: Boolean, val port: Int, val apiKey: String?)

    companion object {
        const val DEFAULT_PORT: Int = 7080
        private val KEY_ENABLED = booleanPreferencesKey("mcp_enabled")
        private val KEY_PORT = intPreferencesKey("mcp_port")
        private val KEY_API_KEY = stringPreferencesKey("mcp_api_key")
        private val KEY_ANTHROPIC_API_KEY = stringPreferencesKey("anthropic_api_key")

        /**
         * 32 alphanumeric chars from a CSPRNG. ~190 bits of entropy —
         * far more than we need for a LAN-only auth gate, but the
         * cost of generating once per first-enable is nothing and a
         * future tightening of the security posture (running on a
         * shared Wi-Fi) is suddenly free.
         */
        fun generateApiKey(): String {
            val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
            val rng = SecureRandom()
            val sb = StringBuilder(32)
            repeat(32) { sb.append(alphabet[rng.nextInt(alphabet.length)]) }
            return sb.toString()
        }
    }
}

private val Context.mcpDataStore by preferencesDataStore("orcaxr.mcp")
