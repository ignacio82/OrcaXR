package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.KeyStore
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The credential vault over the real Android Keystore and preferences. */
@RunWith(AndroidJUnit4::class)
class CredentialVaultTest {
    private val alias = "orcaxr.test.credentials"
    private val file = "orcaxr.test.secrets"
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val keys = AndroidKeyStoreKeys(alias)
    private val vault = CredentialVault(SharedPreferencesBlobStore(context, file, "credentials"), SealingCipher(keys))

    private fun units(text: String) = text.map { it.code }
    private fun record(printer: String, remember: Boolean = true) =
        ProjectIntents.RememberedCredentials(units(printer), listOf(ProjectIntents.RememberedSecret(units("printer-a"), units("a-key-5"))), units("token-6"), remember)
    private fun aliasExists() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias(alias)
    private fun storedText() = context.getSharedPreferences(file, 0).getString("credentials", null)

    @After fun cleanUp() {
        vault.forget()
    }

    @Test fun aKeystoreSealedRecordReadsBackAndHoldsNoSecretInTheClear() {
        CoreCompatibility.verify()
        val saved = record("printer-key-4")
        vault.save(saved)
        assertTrue(aliasExists())
        val stored = storedText()!!
        for (secret in listOf("printer-key-4", "a-key-5", "token-6")) assertFalse(stored.contains(secret))
        assertEquals(saved, vault.load())
    }

    @Test fun theKeystoreKeyCannotBeExportedAndBindsItsPurpose() {
        CoreCompatibility.verify()
        val cipher = SealingCipher(keys)
        val sealed = cipher.seal("secret".toByteArray(), "purpose".toByteArray())
        assertArrayEquals("secret".toByteArray(), cipher.open(sealed, "purpose".toByteArray()))
        assertNull(cipher.open(sealed, "other".toByteArray()))
        // A Keystore key never exposes its material.
        assertNull(keys.existing()!!.encoded)
    }

    @Test fun forgettingRemovesTheBlobAndTheKey() {
        CoreCompatibility.verify()
        vault.save(record("printer-key-4"))
        vault.forget()
        assertNull(storedText())
        assertFalse(aliasExists())
        assertEquals(record("", true).copy(printerApiKeys = emptyList(), slicerToken = emptyList()), vault.load())
    }

    @Test fun aBlobFromALostKeyIsForgotten() {
        CoreCompatibility.verify()
        vault.save(record("printer-key-4"))
        val sealed = storedText()
        keys.delete()
        context.getSharedPreferences(file, 0).edit().putString("credentials", sealed).commit()
        assertEquals(record("", true).copy(printerApiKeys = emptyList(), slicerToken = emptyList()), vault.load())
        assertNull(storedText())
    }
}
