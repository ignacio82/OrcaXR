package dev.orcaxr.nativeapp.ai

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ImagePart
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import dev.orcaxr.nativeapp.mcp.McpJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class AICoreEngine(private val context: Context) : LlmEngine {
    override val backendName: String = "Gemini Nano (Tensor TPU)"
    override val backendKind: LlmBackend = LlmBackend.AICORE

    companion object {
        private const val TAG = "AICoreEngine"
        private val mutex = Mutex()
        @Volatile private var cachedModel: GenerativeModel? = null

        suspend fun checkStatus(): AICoreStatus {
            val model = try {
                obtainModel()
            } catch (t: Throwable) {
                Log.w(TAG, "checkStatus failed to obtain model", t)
                return AICoreStatus.Unavailable(t.message ?: "Could not get AICore client")
            }
            if (model == null) return AICoreStatus.Unavailable("AICore client unavailable")

            return try {
                when (model.checkStatus()) {
                    FeatureStatus.AVAILABLE -> AICoreStatus.Ready
                    FeatureStatus.DOWNLOADABLE -> AICoreStatus.Downloadable
                    FeatureStatus.DOWNLOADING -> AICoreStatus.Downloading(0f, 0L, 0L)
                    FeatureStatus.UNAVAILABLE -> AICoreStatus.Unavailable("AICore reports UNAVAILABLE")
                    else -> AICoreStatus.Unavailable("Unknown FeatureStatus")
                }
            } catch (t: Throwable) {
                Log.w(TAG, "checkStatus threw", t)
                AICoreStatus.Unavailable(t.message ?: "checkStatus error")
            }
        }

        fun downloadFeature(): Flow<AICoreStatus> {
            val model = obtainModel() ?: return flow {
                emit(AICoreStatus.Error("AICore client not available"))
            }

            return flow {
                model.download()
                    .collect { ds ->
                        when (ds) {
                            is DownloadStatus.DownloadStarted -> emit(
                                AICoreStatus.Downloading(0f, 0L, ds.bytesToDownload)
                            )
                            is DownloadStatus.DownloadProgress -> emit(
                                AICoreStatus.Downloading(0f, ds.totalBytesDownloaded, 0L)
                            )
                            is DownloadStatus.DownloadCompleted -> emit(AICoreStatus.Warming)
                            is DownloadStatus.DownloadFailed -> emit(
                                AICoreStatus.Error(ds.e.message ?: "Download failed")
                            )
                        }
                    }
            }.catch { t ->
                Log.w(TAG, "downloadFeature error", t)
                emit(AICoreStatus.Error(t.message ?: "Download flow error"))
            }
        }

        suspend fun warmup(): AICoreStatus {
            val model = obtainModel() ?: return AICoreStatus.Unavailable("Model unavailable")
            return try {
                model.warmup()
                AICoreStatus.Ready
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                Log.w(TAG, "warmup failed", t)
                AICoreStatus.Error(t.message ?: "warmup failed")
            }
        }

        private fun obtainModel(): GenerativeModel? {
            cachedModel?.let { return it }
            return try {
                val client = Generation.getClient()
                cachedModel = client
                client
            } catch (t: Throwable) {
                Log.w(TAG, "Generation.getClient() failed", t)
                null
            }
        }
    }

    override suspend fun runInference(
        prompt: String,
        images: List<Bitmap>,
        profile: LlmInferenceProfile,
        onToken: ((String) -> Unit)?,
    ): String = mutex.withLock {
        val model = obtainModel() ?: error("AICore model unavailable")
        val image = images.firstOrNull()

        val request = if (image != null) {
            generateContentRequest(ImagePart(image), TextPart(prompt)) {
                temperature = profile.temperature.coerceIn(0f, 1f)
                topK = profile.topK
                candidateCount = 1
            }
        } else {
            generateContentRequest(TextPart(prompt)) {
                temperature = profile.temperature.coerceIn(0f, 1f)
                topK = profile.topK
                candidateCount = 1
            }
        }

        val sb = StringBuilder()
        try {
            model.generateContentStream(request)
                .onEach { response ->
                    val text = response.candidates.firstOrNull()?.text.orEmpty()
                    if (text.isNotEmpty()) {
                        sb.append(text)
                        onToken?.invoke(sb.toString())
                    }
                }
                .collect { /* consume */ }
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            Log.e(TAG, "generateContentStream failed", t)
            throw t
        }
        sb.toString()
    }

    override suspend fun runToolCall(
        prompt: String,
        tools: List<LlmToolDefinition>,
        profile: LlmInferenceProfile,
    ): LlmToolCall? {
        val toolsDesc = tools.joinToString("\n\n") { t ->
            "Tool: ${t.name}\nDescription: ${t.description}\nParameters JSON Schema: ${McpJson.stringify(t.inputSchema)}"
        }

        val structuredPrompt = """
You are OrcaXR AI, an expert 3D printing and slicing assistant.
Given the user's request and current workspace context, determine if an available tool should be called.

AVAILABLE TOOLS:
$toolsDesc

INSTRUCTIONS:
- If a tool should be executed, respond with valid JSON ONLY in this exact format:
  {"tool": "<tool_name>", "arguments": { ... }}
- If no tool is needed or more information is required, respond with valid JSON in this format:
  {"response": "<conversational text for user>"}
- Output strictly JSON, with no markdown code blocks or surrounding text.

USER REQUEST:
$prompt
""".trim()

        val raw = runInference(structuredPrompt, profile = profile)
        return parseToolCallJson(raw)
    }

    override fun close() {
        // AICore client is process-scoped, don't close singleton
    }

    private fun parseToolCallJson(raw: String): LlmToolCall? {
        val clean = raw.trim().removeSurrounding("```json", "```").removeSurrounding("```", "```").trim()
        val start = clean.indexOf('{')
        val end = clean.lastIndexOf('}')
        if (start < 0 || end <= start) return null

        val jsonStr = clean.substring(start, end + 1)
        val map = McpJson.parseObject(jsonStr) ?: return null
        val tool = map["tool"] as? String ?: return null
        val args = map["arguments"]
        val argsJson = if (args is Map<*, *>) {
            @Suppress("UNCHECKED_CAST")
            McpJson.stringify(args as Map<String, Any?>)
        } else {
            "{}"
        }
        return LlmToolCall(name = tool, arguments = argsJson)
    }
}
