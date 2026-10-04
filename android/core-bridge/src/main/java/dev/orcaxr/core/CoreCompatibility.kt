package dev.orcaxr.core

import org.json.JSONObject
import org.json.JSONException

/** Refuse mismatched packaged bindings before accepting project operations. */
object CoreCompatibility {
    fun verify(encoded: String = NativeCore.coreInfo()) {
        try {
            val info = JSONObject(encoded)
            verifyValues(info.keys().asSequence().associateWith { info.get(it) })
        } catch (_: JSONException) {
            throw IllegalStateException("Invalid core handshake")
        }
    }

    internal fun verifyValues(info: Map<String, Any?>) {
        val expectedFields = mapOf(
            "coreAbiVersion" to CoreProtocol.CORE_ABI_VERSION,
            "protocolVersion" to CoreProtocol.PROTOCOL_VERSION,
            "canonicalEncodingVersion" to CoreProtocol.CANONICAL_ENCODING_VERSION,
            "maxInputBytes" to CoreProtocol.MAX_INPUT_BYTES,
            "maxRequestBytes" to CoreProtocol.MAX_REQUEST_BYTES,
        )
        check(info.keys == expectedFields.keys) { "Invalid core handshake fields" }
        for ((name, expected) in expectedFields) {
            val actual = info[name]
            check(actual is Number && actual.toDouble() == expected.toDouble()) {
                "Incompatible core bindings"
            }
        }
    }
}
