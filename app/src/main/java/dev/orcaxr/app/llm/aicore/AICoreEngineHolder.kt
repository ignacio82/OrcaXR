package dev.orcaxr.app.llm.aicore

import android.content.Context
import android.util.Log
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Process-singleton wrapper around ML Kit GenAI Prompt
 * (`com.google.mlkit:genai-prompt`) — the entry point into Google's
 * on-device Gemini Nano via AICore. On Pixel-class devices this
 * runs on the Tensor TPU at the OS level, so the LLM doesn't
 * compete with the system compositor or with OrcaXR's own GPU work
 * (Filament toolpath viewer, vision tools) for Adreno cycles. That
 * is precisely the resource contention that freezes the device on
 * the LiteRT-LM/GPU path.
 *
 * Mirrors the lifecycle of [dev.orcaxr.app.llm.local.LiteRtEngineHolder]
 * — `checkStatus` → `downloadFeature` (if needed) → `warmup` →
 * `runInference` → `close`. The two helpers expose deliberately
 * similar shapes so [dev.orcaxr.app.llm.runner.AgentRunner] can
 * route to either one based on the user's selected backend.
 *
 * Only one [GenerativeModel] is alive per process. All inference
 * goes through [inferenceLock] so overlapping requests serialise —
 * matches LiteRT's single-conversation-at-a-time constraint and
 * avoids hammering the shared AICore daemon with parallel sessions.
 *
 * **Why the no-arg `Generation.getClient()` overload.** SpatialFin
 * documented (and we observed independently) that the explicit
 * `Generation.getClient(generationConfig { modelConfig {
 * releaseStage = STABLE; preference = FAST } })` overload throws
 * `ErrorCode 606 FEATURE_NOT_FOUND: Feature 645 is not available`
 * on a stock Pixel 10 Pro. The no-arg client lets AICore pick
 * whichever feature it has provisioned, which is what Google AI
 * Edge Gallery and SpatialFin both ship.
 */
sealed interface AICoreStatus {
    /** Initial state before any probe has run. */
    data object Unknown : AICoreStatus
    /** Device does not support AICore (SDK, SKU, lock state, etc.). */
    data class Unavailable(val reason: String) : AICoreStatus
    /** AICore is present but the feature model needs to be downloaded first. */
    data object Downloadable : AICoreStatus
    /** Download in flight. `bytesDownloaded` may climb without `totalBytes` ever
     *  being known — ML Kit's `DownloadStatus` only reports total at start. */
    data class Downloading(val bytesDownloaded: Long, val totalBytes: Long) : AICoreStatus
    /** Download completed; warmup is in flight (or pending). */
    data object Warming : AICoreStatus
    /** Gemini Nano is ready for inference. */
    data object Ready : AICoreStatus
    /** Terminal failure from the AICore pipeline. */
    data class Error(val message: String) : AICoreStatus
}

object AICoreEngineHolder {

    private const val TAG = "AICoreEngineHolder"

    /** Held by every [runInference] call. ML Kit GenAI shares a
     *  single AICore daemon connection per process; serialising at
     *  this layer keeps the daemon's queue small. */
    val inferenceLock: Mutex = Mutex()

    @Volatile
    private var cachedModel: GenerativeModel? = null

    /**
     * Probe the device for AICore availability. Caches the
     * [GenerativeModel] so the next [runInference] call doesn't
     * re-do the `Generation.getClient()` round trip.
     */
    suspend fun checkStatus(context: Context): AICoreStatus {
        val model = try {
            obtainModel(context)
        } catch (e: Exception) {
            Log.w(TAG, "Generation.getClient failed — treating as Unavailable", e)
            return AICoreStatus.Unavailable(e.message ?: "getClient threw")
        }
        model ?: return AICoreStatus.Unavailable("Generation.getClient returned null")

        return try {
            when (val s = model.checkStatus()) {
                FeatureStatus.AVAILABLE -> AICoreStatus.Ready
                FeatureStatus.DOWNLOADABLE -> AICoreStatus.Downloadable
                FeatureStatus.DOWNLOADING -> AICoreStatus.Downloading(0L, 0L)
                FeatureStatus.UNAVAILABLE -> AICoreStatus.Unavailable("Device reported UNAVAILABLE")
                else -> AICoreStatus.Unavailable("Unknown FeatureStatus: $s")
            }
        } catch (e: Exception) {
            Log.w(TAG, "checkStatus threw", e)
            AICoreStatus.Unavailable(e.message ?: "checkStatus threw")
        }
    }

    /**
     * Kick the feature-model download and stream intermediate
     * statuses. Completes with [AICoreStatus.Warming] when the
     * download lands; the caller then runs [warmup] separately.
     * Errors surface as [AICoreStatus.Error] before the flow
     * completes — they do NOT throw.
     */
    fun downloadFeature(context: Context): Flow<AICoreStatus> {
        val model = try {
            obtainModel(context)
        } catch (e: Exception) {
            Log.w(TAG, "downloadFeature getClient failed", e)
            return flowOf(AICoreStatus.Error(e.message ?: "getClient threw"))
        }
        if (model == null) {
            return flowOf(AICoreStatus.Error("Generation.getClient returned null"))
        }
        return flow {
            model.download().collect { ds: DownloadStatus ->
                emit(
                    when (ds) {
                        is DownloadStatus.DownloadStarted -> AICoreStatus.Downloading(
                            bytesDownloaded = 0L,
                            totalBytes = ds.bytesToDownload,
                        )
                        is DownloadStatus.DownloadProgress -> AICoreStatus.Downloading(
                            bytesDownloaded = ds.totalBytesDownloaded,
                            totalBytes = 0L,
                        )
                        is DownloadStatus.DownloadCompleted -> AICoreStatus.Warming
                        is DownloadStatus.DownloadFailed -> AICoreStatus.Error(
                            ds.e.message ?: "download failed",
                        )
                    },
                )
            }
        }.catch { throwable ->
            Log.w(TAG, "download flow threw", throwable)
            emit(AICoreStatus.Error(throwable.message ?: "download flow failed"))
        }
    }

    /** Optional warmup pass. Cheap on a hot AICore daemon, expensive
     *  on the first invocation after a download. */
    suspend fun warmup(context: Context): AICoreStatus {
        val model = try {
            obtainModel(context) ?: return AICoreStatus.Unavailable("null model during warmup")
        } catch (e: Exception) {
            return AICoreStatus.Error(e.message ?: "warmup getClient failed")
        }
        return try {
            model.warmup()
            AICoreStatus.Ready
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "warmup failed", e)
            AICoreStatus.Error(e.message ?: "warmup failed")
        }
    }

    /**
     * Run a single-shot prompt. Streaming surfaces through
     * [onToken]; each invocation carries the cumulative response so
     * a UI consumer can render incrementally without re-stitching
     * partial chunks itself.
     *
     * Tool calling: the current `mlkit-genai-prompt` beta does not
     * expose tool calling, so OrcaXR uses its existing JSON-envelope
     * protocol — see [dev.orcaxr.app.llm.local.Gemma4Prompt]. The
     * caller passes the rendered text prompt verbatim.
     */
    suspend fun runInference(
        context: Context,
        prompt: String,
        temperature: Float = 0f,
        topK: Int = 1,
        onToken: ((String) -> Unit)? = null,
    ): String = inferenceLock.withLock {
        val model = obtainModel(context) ?: error("AICore model not available")
        val request = generateContentRequest(TextPart(prompt)) {
            this.temperature = temperature.coerceIn(0f, 1f)
            this.topK = topK
            this.candidateCount = 1
        }
        val sb = StringBuilder()
        try {
            model.generateContentStream(request).collect { response ->
                val candidate = response.candidates.firstOrNull() ?: return@collect
                val text = candidate.text
                if (text.isNotEmpty()) {
                    sb.append(text)
                    onToken?.invoke(sb.toString())
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "generateContentStream failed", e)
            throw e
        }
        sb.toString()
    }

    fun close() {
        cachedModel?.runCatching { close() }
        cachedModel = null
    }

    /** True iff the cached [GenerativeModel] is non-null. UI hint
     *  for the assistant card's status row. */
    fun isLoaded(): Boolean = cachedModel != null

    private fun obtainModel(context: Context): GenerativeModel? {
        cachedModel?.let { return it }
        // Ignore [context] for now — Generation.getClient() takes no
        // args. We keep the parameter so the call site reads
        // symmetrically with the LiteRT path.
        @Suppress("UNUSED_PARAMETER") context
        val client = Generation.getClient()
        cachedModel = client
        return client
    }
}
