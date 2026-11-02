package dev.orcaxr.nativeapp.ai

import android.graphics.Bitmap
import java.io.File

enum class LlmBackend { AICORE, LITERT, NONE }

data class LlmInferenceProfile(
    val name: String,
    val topK: Int,
    val topP: Float,
    val temperature: Float,
) {
    companion object {
        val COMMAND = LlmInferenceProfile(
            name = "command",
            topK = 1,
            topP = 0.1f,
            temperature = 0.0f,
        )
        val CHAT = LlmInferenceProfile(
            name = "chat",
            topK = 40,
            topP = 0.95f,
            temperature = 0.7f,
        )
    }
}

data class LlmToolCall(
    val name: String,
    val arguments: String,
)

data class LlmToolDefinition(
    val name: String,
    val description: String,
    val inputSchema: Map<String, Any>,
)

sealed interface AICoreStatus {
    data object Unknown : AICoreStatus
    data class Unavailable(val reason: String) : AICoreStatus
    data object Downloadable : AICoreStatus
    data class Downloading(val progress: Float, val bytesDownloaded: Long, val totalBytes: Long) : AICoreStatus
    data object Warming : AICoreStatus
    data object Ready : AICoreStatus
    data class Error(val message: String) : AICoreStatus
}

sealed interface DownloadState {
    data object Idle : DownloadState
    data class Downloading(val progress: Float, val bytesDownloaded: Long, val totalBytes: Long) : DownloadState
    data class Ready(val file: File) : DownloadState
    data class Error(val message: String) : DownloadState
}

interface LlmEngine {
    val backendName: String
    val backendKind: LlmBackend

    suspend fun runInference(
        prompt: String,
        images: List<Bitmap> = emptyList(),
        profile: LlmInferenceProfile = LlmInferenceProfile.CHAT,
        onToken: ((String) -> Unit)? = null,
    ): String

    suspend fun runToolCall(
        prompt: String,
        tools: List<LlmToolDefinition>,
        profile: LlmInferenceProfile = LlmInferenceProfile.COMMAND,
    ): LlmToolCall?

    fun close()
}
