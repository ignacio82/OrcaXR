package dev.orcaxr.nativeapp.ai

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.tool
import dev.orcaxr.nativeapp.mcp.McpJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@OptIn(ExperimentalApi::class)
class LiteRtEngine(
    private val engine: Engine,
    override val backendName: String,
) : LlmEngine {
    override val backendKind: LlmBackend = LlmBackend.LITERT

    companion object {
        private const val TAG = "LiteRtEngine"
        private val inferenceMutex = Mutex()

        fun initialize(
            context: Context,
            modelPath: String,
            maxTokens: Int = 4096,
        ): LiteRtEngine? {
            val totalStart = System.currentTimeMillis()
            Log.i(TAG, "Initializing LiteRT engine: model=$modelPath maxTokens=$maxTokens")

            val cacheDir = if (modelPath.startsWith("/data/local/tmp")) context.cacheDir.absolutePath else null
            val nativeLibDir = context.applicationInfo.nativeLibraryDir

            fun tryBackend(name: String, backend: Backend): Engine? {
                val t0 = System.currentTimeMillis()
                val isGpu = backend is Backend.GPU
                val isNpu = backend is Backend.NPU
                return try {
                    val config = EngineConfig(
                        modelPath = modelPath,
                        backend = backend,
                        visionBackend = if (isGpu) Backend.GPU() else null,
                        audioBackend = if (isGpu || isNpu) Backend.CPU() else null,
                        maxNumTokens = maxTokens,
                        cacheDir = cacheDir,
                    )
                    val eng = Engine(config)
                    eng.initialize()
                    Log.i(TAG, "LiteRT: $name backend initialized in ${System.currentTimeMillis() - t0} ms")
                    eng
                } catch (t: Throwable) {
                    Log.w(TAG, "LiteRT: $name backend failed after ${System.currentTimeMillis() - t0} ms: ${t.message}")
                    null
                }
            }

            // Probing backends: NPU -> GPU -> CPU
            val backends = buildList {
                val hasDispatch = File(nativeLibDir).listFiles()?.any { it.name.startsWith("libLiteRtDispatch") } == true
                if (hasDispatch) {
                    add("NPU" to Backend.NPU(nativeLibraryDir = nativeLibDir))
                }
                add("GPU" to Backend.GPU())
                add("CPU" to Backend.CPU())
            }

            for ((name, backend) in backends) {
                val eng = tryBackend(name, backend)
                if (eng != null) {
                    Log.i(TAG, "LiteRT engine ready on $name in ${System.currentTimeMillis() - totalStart} ms")
                    return LiteRtEngine(eng, name)
                }
            }

            Log.e(TAG, "LiteRT: all backends failed")
            return null
        }
    }

    override suspend fun runInference(
        prompt: String,
        images: List<Bitmap>,
        profile: LlmInferenceProfile,
        onToken: ((String) -> Unit)?,
    ): String {
        inferenceMutex.lock()

        val contents = mutableListOf<Content>()
        for (bitmap in images) {
            val stream = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
            contents.add(Content.ImageBytes(stream.toByteArray()))
        }
        if (prompt.isNotEmpty()) contents.add(Content.Text(prompt))

        val conversation = try {
            engine.createConversation(
                ConversationConfig(
                    samplerConfig = SamplerConfig(
                        topK = profile.topK,
                        topP = profile.topP.toDouble(),
                        temperature = profile.temperature.toDouble(),
                    ),
                ),
            )
        } catch (t: Throwable) {
            inferenceMutex.unlock()
            throw t
        }

        return try {
            suspendCancellableCoroutine { continuation ->
                val sb = StringBuilder()
                try {
                    conversation.sendMessageAsync(
                        Contents.of(contents),
                        object : MessageCallback {
                            override fun onMessage(message: Message) {
                                sb.append(message.toString())
                                onToken?.invoke(sb.toString())
                            }

                            override fun onDone() {
                                conversation.close()
                                inferenceMutex.unlock()
                                continuation.resume(sb.toString())
                            }

                            override fun onError(throwable: Throwable) {
                                conversation.close()
                                inferenceMutex.unlock()
                                Log.e(TAG, "LiteRT inference error", throwable)
                                continuation.resumeWithException(throwable)
                            }
                        },
                    )
                } catch (t: Throwable) {
                    conversation.close()
                    inferenceMutex.unlock()
                    continuation.resumeWithException(t)
                }
            }
        } catch (c: CancellationException) {
            throw c
        }
    }

    override suspend fun runToolCall(
        prompt: String,
        tools: List<LlmToolDefinition>,
        profile: LlmInferenceProfile,
    ): LlmToolCall? {
        inferenceMutex.lock()

        val openApiTools = tools.map { def ->
            val toolJson = McpJson.stringify(
                mapOf(
                    "type" to "function",
                    "function" to mapOf(
                        "name" to def.name,
                        "description" to def.description,
                        "parameters" to def.inputSchema,
                    ),
                ),
            )
            val apiTool = object : OpenApiTool {
                override fun getToolDescriptionJsonString(): String = toolJson
                override fun execute(paramsJsonString: String): String = ""
            }
            tool(apiTool)
        }

        val conversation = try {
            engine.createConversation(
                ConversationConfig(
                    tools = openApiTools,
                    automaticToolCalling = false,
                    samplerConfig = SamplerConfig(
                        topK = profile.topK,
                        topP = profile.topP.toDouble(),
                        temperature = profile.temperature.toDouble(),
                    ),
                ),
            )
        } catch (t: Throwable) {
            inferenceMutex.unlock()
            throw t
        }

        return try {
            suspendCancellableCoroutine { continuation ->
                var lastMsg: Message? = null
                try {
                    conversation.sendMessageAsync(
                        prompt,
                        object : MessageCallback {
                            override fun onMessage(message: Message) {
                                lastMsg = message
                            }

                            override fun onDone() {
                                conversation.close()
                                inferenceMutex.unlock()
                                val call = lastMsg?.toolCalls?.firstOrNull()
                                val parsed = call?.let {
                                    LlmToolCall(name = it.name, arguments = McpJson.stringify(it.arguments))
                                }
                                continuation.resume(parsed)
                            }

                            override fun onError(throwable: Throwable) {
                                conversation.close()
                                inferenceMutex.unlock()
                                Log.e(TAG, "LiteRT tool inference error", throwable)
                                continuation.resumeWithException(throwable)
                            }
                        },
                    )
                } catch (t: Throwable) {
                    conversation.close()
                    inferenceMutex.unlock()
                    continuation.resumeWithException(t)
                }
            }
        } catch (c: CancellationException) {
            throw c
        }
    }

    override fun close() {
        engine.close()
    }
}
