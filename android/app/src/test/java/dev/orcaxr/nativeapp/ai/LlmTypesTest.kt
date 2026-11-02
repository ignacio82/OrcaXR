package dev.orcaxr.nativeapp.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class LlmTypesTest {
    @Test
    fun testInferenceProfiles() {
        assertEquals("command", LlmInferenceProfile.COMMAND.name)
        assertEquals(1, LlmInferenceProfile.COMMAND.topK)
        assertEquals(0.0f, LlmInferenceProfile.COMMAND.temperature, 0.001f)

        assertEquals("chat", LlmInferenceProfile.CHAT.name)
        assertEquals(40, LlmInferenceProfile.CHAT.topK)
        assertEquals(0.7f, LlmInferenceProfile.CHAT.temperature, 0.001f)
    }

    @Test
    fun testToolDefinitions() {
        val def = LlmToolDefinition(
            name = "remap_filaments",
            description = "Remap filament slots",
            inputSchema = mapOf("type" to "object"),
        )
        assertEquals("remap_filaments", def.name)
        assertEquals("Remap filament slots", def.description)
        assertNotNull(def.inputSchema)

        val call = LlmToolCall(
            name = "remap_filaments",
            arguments = """{"mapping":{"1":"3","2":"4"}}""",
        )
        assertEquals("remap_filaments", call.name)
        assertEquals("""{"mapping":{"1":"3","2":"4"}}""", call.arguments)
    }

    @Test
    fun testAICoreStatusTransitions() {
        val unknown: AICoreStatus = AICoreStatus.Unknown
        val ready: AICoreStatus = AICoreStatus.Ready
        val downloadable: AICoreStatus = AICoreStatus.Downloadable
        val downloading: AICoreStatus = AICoreStatus.Downloading(0.5f, 500L, 1000L)
        val unavailable: AICoreStatus = AICoreStatus.Unavailable("No TPU")

        assertEquals(0.5f, (downloading as AICoreStatus.Downloading).progress, 0.001f)
        assertEquals("No TPU", (unavailable as AICoreStatus.Unavailable).reason)
    }
}
