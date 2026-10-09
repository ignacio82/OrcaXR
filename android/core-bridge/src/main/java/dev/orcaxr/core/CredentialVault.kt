package dev.orcaxr.core

import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The remembered credentials record (`orcaxr_printer::credentials`), as the
 * browser's `RememberedCredentials` reads and writes it: the text it is stored
 * as, or that nothing is stored. [CredentialVault] seals that text. */
object RememberedCredentialsPolicy {
    /** [stored] is the saved text, or null when nothing is saved. */
    fun load(stored: String?): ProjectIntents.RememberedCredentials =
        ProjectIntents.decodeRememberedCredentials(NativeProject.credentialsLoad(stored))
    /** The text to store, or null to remove what is stored. */
    fun save(credentials: ProjectIntents.RememberedCredentials): String? =
        NativeProject.credentialsSave(ProjectIntents.encodeRememberedCredentials(credentials))
}

/** Where one sealed blob lives. */
interface SecretBlobStore {
    fun read(): ByteArray?
    fun write(blob: ByteArray)
    fun delete()
}

/** The key a [SealingCipher] seals with, which never leaves its provider. */
interface SecretKeySource {
    fun existing(): SecretKey?
    fun create(): SecretKey
    /** Removes the key: nothing it sealed can be opened again. */
    fun delete()
}

/**
 * AES-256-GCM sealing bound to a purpose: a blob is `1 ‖ iv ‖ ciphertext ‖
 * tag`, the purpose authenticated alongside it, so a blob sealed for one use
 * cannot be opened as another. The IV is the cipher's own random one.
 */
class SealingCipher(private val keys: SecretKeySource) {
    fun seal(plain: ByteArray, purpose: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keys.existing() ?: keys.create())
        cipher.updateAAD(purpose)
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected_iv" }
        return byteArrayOf(VERSION) + iv + cipher.doFinal(plain)
    }

    /** The plain bytes, or null when [sealed] is not something this key sealed for [purpose]. */
    fun open(sealed: ByteArray, purpose: ByteArray): ByteArray? {
        if (sealed.size < 1 + IV_BYTES + TAG_BYTES || sealed[0] != VERSION) return null
        val key = keys.existing() ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, sealed, 1, IV_BYTES))
            cipher.updateAAD(purpose)
            cipher.doFinal(sealed, 1 + IV_BYTES, sealed.size - 1 - IV_BYTES)
        } catch (_: GeneralSecurityException) {
            null
        }
    }

    fun destroy() = keys.delete()

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val VERSION: Byte = 1
        const val IV_BYTES = 12
        const val TAG_BYTES = 16
    }
}

/**
 * The printer keys and slicer token remembered on this device, sealed by a
 * Keystore key.
 *
 * The record is the browser's ([RememberedCredentialsPolicy]): secrets too
 * long to be keys are dropped, remembering off erases what was stored, and a
 * record with nothing in it removes the blob. Forgetting removes the blob and
 * the key, so nothing sealed before can be opened again. A blob that no
 * longer opens — tampered, or its key gone — is forgotten rather than kept.
 */
class CredentialVault(private val store: SecretBlobStore, private val cipher: SealingCipher) {
    fun load(): ProjectIntents.RememberedCredentials {
        val sealed = store.read() ?: return RememberedCredentialsPolicy.load(null)
        val text = cipher.open(sealed, PURPOSE) ?: run {
            forget()
            return RememberedCredentialsPolicy.load(null)
        }
        return RememberedCredentialsPolicy.load(text.toString(Charsets.UTF_8))
    }

    fun save(credentials: ProjectIntents.RememberedCredentials) {
        val text = RememberedCredentialsPolicy.save(credentials)
        if (text == null) store.delete() else store.write(cipher.seal(text.toByteArray(Charsets.UTF_8), PURPOSE))
    }

    fun forget() {
        store.delete()
        cipher.destroy()
    }

    private companion object {
        val PURPOSE = "orcaxr.credentials.v1".toByteArray(Charsets.UTF_8)
    }
}
