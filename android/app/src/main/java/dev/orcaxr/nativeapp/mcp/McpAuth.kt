package dev.orcaxr.nativeapp.mcp

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Authentication and configuration manager for the embedded MCP server.
 * Manages loopback vs. LAN binding, port, and a cryptographically secure
 * Bearer capability token.
 */
class McpAuth(
    private val prefs: SharedPreferences,
) {
    constructor(context: Context) : this(
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    )

    private val random = SecureRandom()

    val token: String
        get() = synchronized(this) {
            val existing = prefs.getString(KEY_TOKEN, null)
            if (!existing.isNullOrBlank()) {
                existing
            } else {
                val newToken = generateToken()
                prefs.edit().putString(KEY_TOKEN, newToken).apply()
                newToken
            }
        }

    fun regenerateToken(): String = synchronized(this) {
        val newToken = generateToken()
        prefs.edit().putString(KEY_TOKEN, newToken).apply()
        newToken
    }

    fun validateToken(candidate: String?): Boolean {
        if (candidate.isNullOrBlank()) return false
        val cleanCandidate = candidate.removePrefix("Bearer ").trim()
        val currentToken = token
        return MessageDigest.isEqual(
            cleanCandidate.toByteArray(Charsets.UTF_8),
            currentToken.toByteArray(Charsets.UTF_8),
        )
    }

    var serverEnabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_ENABLED, value).apply()
        }

    var allowLan: Boolean
        get() = prefs.getBoolean(KEY_ALLOW_LAN, false)
        set(value) {
            prefs.edit().putBoolean(KEY_ALLOW_LAN, value).apply()
        }

    var serverPort: Int
        get() = prefs.getInt(KEY_PORT, DEFAULT_PORT)
        set(value) {
            prefs.edit().putInt(KEY_PORT, value).apply()
        }

    fun adbForwardCommand(): String = "adb forward tcp:$serverPort tcp:$serverPort"

    private fun generateToken(): String {
        val bytes = ByteArray(32) // 256 bits of entropy
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val DEFAULT_PORT = 8765
        private const val PREFS_NAME = "orcaxr_mcp_prefs"
        private const val KEY_TOKEN = "bearer_token"
        private const val KEY_ENABLED = "server_enabled"
        private const val KEY_ALLOW_LAN = "allow_lan"
        private const val KEY_PORT = "server_port"
    }
}
