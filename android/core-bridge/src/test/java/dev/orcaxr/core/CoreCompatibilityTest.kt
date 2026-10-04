package dev.orcaxr.core

import org.junit.Assert.assertThrows
import org.junit.Test

class CoreCompatibilityTest {
    private val supported = mapOf<String, Any?>(
        "coreAbiVersion" to CoreProtocol.CORE_ABI_VERSION,
        "protocolVersion" to CoreProtocol.PROTOCOL_VERSION,
        "canonicalEncodingVersion" to CoreProtocol.CANONICAL_ENCODING_VERSION,
        "maxInputBytes" to CoreProtocol.MAX_INPUT_BYTES,
        "maxRequestBytes" to CoreProtocol.MAX_REQUEST_BYTES,
    )

    @Test fun eachVersionAndResourceBoundMustMatchExactly() {
        CoreCompatibility.verifyValues(supported)
        for ((name, value) in supported) {
            for (invalid in listOf(null, value.toString(), (value as Int).toDouble() + 0.5, value + 1, true)) {
                assertThrows(IllegalStateException::class.java) {
                    CoreCompatibility.verifyValues(supported + (name to invalid))
                }
            }
            assertThrows(IllegalStateException::class.java) { CoreCompatibility.verifyValues(supported - name) }
        }
        assertThrows(IllegalStateException::class.java) {
            CoreCompatibility.verifyValues(supported + ("unknown" to 1))
        }
    }
}
