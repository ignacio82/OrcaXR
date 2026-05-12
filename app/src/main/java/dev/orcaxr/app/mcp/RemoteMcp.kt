package dev.orcaxr.app.mcp

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * One stored MCP server reachable over the LAN — typically the user's
 * Galaxy XR headset, beamed onto the phone via Quick Share. Lives next
 * to [McpSettings] (which is the LOCAL server's config) so the phone
 * can drive XR's MCP without losing its own.
 *
 * The token is the bearer the remote server expects; we encrypt it at
 * rest with the same [SecretBox] [LlmSettings] uses for cloud LLM
 * keys, so a stolen DataStore file doesn't hand an attacker the keys
 * to remote-control the headset.
 *
 * [label] is a free-form name the user can rename in Settings (default
 * is the host portion of the URL); [receivedAt] is wall-clock millis
 * for "Received Mar 5" copy in the UI.
 */
data class RemoteMcpEndpoint(
    val url: String,
    val token: String,
    val label: String,
    val receivedAt: Long,
)

/**
 * DataStore-backed persistence for one remote MCP endpoint.
 *
 * One slot — the user has at most one XR headset paired at a time.
 * Replacing the value just overwrites it; clearing wipes everything
 * including the encrypted token.
 */
class RemoteMcpStore(
    ctx: Context,
    private val secretBox: SecretBox = AndroidKeystoreSecretBox(),
) {
    private val store = ctx.applicationContext.remoteMcpDataStore

    val endpoint: Flow<RemoteMcpEndpoint?> = store.data.map { prefs ->
        val url = prefs[KEY_URL]?.takeIf { it.isNotBlank() } ?: return@map null
        val rawToken = prefs[KEY_TOKEN]?.takeIf { it.isNotBlank() } ?: return@map null
        // Audit H3 path — try the encrypted format first; legacy
        // plaintext (or fresh-from-test injection) falls through.
        val token = secretBox.decrypt(rawToken) ?: rawToken
        RemoteMcpEndpoint(
            url = url,
            token = token,
            label = prefs[KEY_LABEL]?.takeIf { it.isNotBlank() } ?: defaultLabelForUrl(url),
            receivedAt = prefs[KEY_RECEIVED_AT]?.toLongOrNull() ?: 0L,
        )
    }

    suspend fun set(endpoint: RemoteMcpEndpoint?) {
        store.edit { prefs ->
            if (endpoint == null) {
                prefs.remove(KEY_URL)
                prefs.remove(KEY_TOKEN)
                prefs.remove(KEY_LABEL)
                prefs.remove(KEY_RECEIVED_AT)
            } else {
                prefs[KEY_URL] = endpoint.url
                prefs[KEY_TOKEN] = secretBox.encrypt(endpoint.token)
                prefs[KEY_LABEL] = endpoint.label
                prefs[KEY_RECEIVED_AT] = endpoint.receivedAt.toString()
            }
        }
    }

    suspend fun rename(label: String) {
        store.edit { prefs ->
            if (label.isBlank()) prefs.remove(KEY_LABEL)
            else prefs[KEY_LABEL] = label.trim()
        }
    }

    companion object {
        private val KEY_URL = stringPreferencesKey("remote_mcp_url")
        private val KEY_TOKEN = stringPreferencesKey("remote_mcp_token")
        private val KEY_LABEL = stringPreferencesKey("remote_mcp_label")
        private val KEY_RECEIVED_AT = stringPreferencesKey("remote_mcp_received_at")

        /** "192.168.1.42:7080" out of "http://192.168.1.42:7080/mcp" — the
         *  most informative bit of the URL when no label exists. */
        fun defaultLabelForUrl(url: String): String {
            val withoutScheme = url.substringAfter("://", url)
            return withoutScheme.substringBefore('/').ifBlank { url }
        }
    }
}

private val Context.remoteMcpDataStore by preferencesDataStore("orcaxr.remote_mcp")
