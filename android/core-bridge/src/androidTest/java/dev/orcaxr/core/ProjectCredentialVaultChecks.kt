package dev.orcaxr.core

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** The credential vault over a software key and an in-memory blob, as the
 * host JVM can run it; the Keystore key itself is exercised on a device
 * (`CredentialVaultTest`). */
object ProjectCredentialVaultChecks {
    private class SoftwareKeys : SecretKeySource {
        var key: SecretKey? = null
        override fun existing() = key
        override fun create(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
        override fun delete() { key = null }
    }
    private class MemoryStore : SecretBlobStore {
        var blob: ByteArray? = null
        override fun read() = blob?.copyOf()
        override fun write(blob: ByteArray) { this.blob = blob.copyOf() }
        override fun delete() { blob = null }
    }
    private fun units(text: String) = text.map { it.code }
    private fun record(printer: String, slicer: String, remember: Boolean = true, keys: Map<String, String> = emptyMap()) =
        ProjectIntents.RememberedCredentials(
            units(printer),
            keys.map { (key, secret) -> ProjectIntents.RememberedSecret(units(key), units(secret)) },
            units(slicer),
            remember,
        )
    private fun ByteArray.holds(text: String): Boolean {
        val needle = text.toByteArray(Charsets.UTF_8)
        return (0..size - needle.size).any { start -> needle.indices.all { this[start + it] == needle[it] } }
    }

    @JvmStatic fun run(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val keys = SoftwareKeys()
        val store = MemoryStore()
        val vault = CredentialVault(store, SealingCipher(keys))
        val saved = record("printer-key-0001", "slicer-token-0002", keys = mapOf("printer-a" to "key-for-a-0003"))
        vault.save(saved)
        val blob = store.blob
        check(blob != null, "a record is stored")
        for (secret in listOf("printer-key-0001", "slicer-token-0002", "key-for-a-0003")) {
            check(!blob!!.holds(secret), "the stored blob does not hold $secret")
        }
        check(vault.load() == saved, "the record reads back as itself")
        vault.save(saved)
        check(!store.blob.contentEquals(blob), "each seal draws its own IV")
        check(vault.load() == saved, "a second seal reads back too")

        // Remembering off erases every secret but keeps the switch.
        vault.save(record("printer-key-0001", "slicer-token-0002", remember = false))
        check(store.blob != null && !store.blob!!.holds("printer-key-0001"), "remembering off stores no secret")
        check(vault.load() == record("", "", remember = false), "remembering off reads back as off")

        // Nothing to remember removes the blob.
        vault.save(record("", ""))
        check(store.blob == null, "an empty record leaves nothing behind")

        // A tampered blob is forgotten rather than kept.
        vault.save(saved)
        val tampered = store.blob!!.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        store.blob = tampered
        check(vault.load() == record("", ""), "a tampered blob opens to nothing")
        check(store.blob == null && keys.key == null, "a tampered blob is forgotten with its key")

        // A blob sealed for another purpose, or under another key, does not open.
        val cipher = SealingCipher(keys)
        val other = cipher.seal("{}".toByteArray(), "another.purpose".toByteArray())
        check(cipher.open(other, "orcaxr.credentials.v1".toByteArray()) == null, "a purpose binds its blob")
        vault.save(saved)
        val sealedEarlier = store.blob!!
        keys.delete()
        keys.create()
        store.blob = sealedEarlier
        check(vault.load() == record("", ""), "a blob from a lost key opens to nothing")
        check(cipher.open(byteArrayOf(1, 2, 3), "x".toByteArray()) == null, "a short blob opens to nothing")

        // Forgetting removes the blob and the key.
        vault.save(saved)
        vault.forget()
        check(store.blob == null && keys.key == null, "forgetting removes the blob and the key")
        check(vault.load() == record("", ""), "a forgotten vault remembers nothing")

        // One record for every area (the Device area's keys, Prepare's token): no change loses another's.
        val sharedKeys = SoftwareKeys()
        val sharedStore = MemoryStore()
        val shared = SharedCredentials(CredentialVault(sharedStore, SealingCipher(sharedKeys)))
        var heard = 0
        shared.subscribe { heard++ }.use {
            shared.update { it.copy(slicerToken = units("slicer-token-0002")) }
            shared.update { it.copy(printerApiKeys = listOf(ProjectIntents.RememberedSecret(units("printer-a"), units("key-for-a-0003")))) }
            check(shared.current == record("", "slicer-token-0002", keys = mapOf("printer-a" to "key-for-a-0003")), "neither change lost the other")
            check(CredentialVault(sharedStore, SealingCipher(sharedKeys)).load() == shared.current, "the stored record is the shared one")
            shared.update { it.copy(remember = false) }
            check(
                shared.current.slicerToken == units("slicer-token-0002") && sharedStore.blob != null && !sharedStore.blob!!.holds("slicer-token-0002"),
                "remembering off keeps the run's token and stores none",
            )
            shared.forget()
            check(shared.current == record("", "") && sharedStore.blob == null && sharedKeys.key == null, "forgetting clears the run's copy too")
        }
        shared.update { it }
        check(heard == 4, "listeners hear every change until they stop")
        return checks
    }
}
