package dev.orcaxr.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** A non-exportable AES-256 key in the Android Keystore under [alias]. */
class AndroidKeyStoreKeys(private val alias: String) : SecretKeySource {
    private fun store() = KeyStore.getInstance(PROVIDER).apply { load(null) }
    override fun existing(): SecretKey? = (store().getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.secretKey
    override fun create(): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    override fun delete() {
        store().takeIf { it.containsAlias(alias) }?.deleteEntry(alias)
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
    }
}

/** One blob, Base64 in a private preferences file the app's backup rules exclude. */
class SharedPreferencesBlobStore(context: Context, file: String, private val key: String) : SecretBlobStore {
    private val preferences = context.getSharedPreferences(file, Context.MODE_PRIVATE)
    override fun read(): ByteArray? = preferences.getString(key, null)?.let {
        try {
            Base64.decode(it, Base64.NO_WRAP)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
    override fun write(blob: ByteArray) {
        check(preferences.edit().putString(key, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()) { "storage_failed" }
    }
    override fun delete() {
        check(preferences.edit().remove(key).commit()) { "storage_failed" }
    }
}

/** The app's credential vault: a Keystore key and a private preferences file. */
object AppCredentialVault {
    @Volatile private var process: SharedCredentials? = null

    fun open(context: Context): CredentialVault = CredentialVault(
        SharedPreferencesBlobStore(context, "orcaxr.secrets", "credentials"),
        SealingCipher(AndroidKeyStoreKeys("orcaxr.credentials")),
    )

    /** The process's one record over [open]'s vault, which every area reads and changes.
     * The first call reads the vault (the Keystore): make it off the main thread. */
    fun shared(context: Context): SharedCredentials =
        process ?: synchronized(this) { process ?: SharedCredentials(open(context.applicationContext)).also { process = it } }
}
