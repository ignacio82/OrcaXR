package dev.orcaxr.app.llm.local

import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

/**
 * Process-singleton owner of the active LiteRT-LM Engine. One Engine
 * at a time — `Engine.initialize()` mmaps a multi-GB .litertlm
 * bundle and runs GPU/NPU dispatcher compilation, so we only ever
 * keep one alive.
 *
 * Lifecycle:
 *  - `getOrLoad(size)` — returns the active engine, lazy-loading
 *    or re-loading if the requested size differs from the current
 *    one. Must be called from a coroutine because `initialize()` is
 *    blocking and we always run it on `Dispatchers.IO`.
 *  - `inferenceLock` — the LiteRT-LM Conversation API allows only
 *    one active conversation at a time and closing it doesn't
 *    interrupt an in-flight GPU op. Every caller must hold this
 *    mutex while running inference.
 *  - `unload()` — release the Engine and its GPU/NPU resources.
 *    Used when the user switches away from Local backend or wipes
 *    the model.
 *
 * **GPU-then-NPU, no CPU.** Galaxy XR's Adreno is the headset's
 * only fast path. AICore (Tensor TPU) doesn't apply — there's no
 * Tensor in the headset SoC, and on phones the Tensor TPU is
 * allowlist-gated to Google's first-party apps. Gemma 4 on a CPU
 * runs at single-digit tokens/sec; we refuse to fall back rather
 * than ship a degraded experience.
 *
 * Engine creation is synchronous (`runCatching` on the inline
 * `tryBackend` path) so a failing GPU init returns a deterministic
 * error to the caller rather than hanging the dispatch.
 */
object LiteRtEngineHolder {

    private const val TAG = "LiteRtEngineHolder"

    /** Default max tokens per inference call. Generous enough that a
     *  Gemma 4 thinking-block + JSON-envelope response fits, tight
     *  enough that runaway generation is bounded. */
    private const val DEFAULT_MAX_TOKENS = 4096

    @OptIn(ExperimentalApi::class)
    @Volatile
    private var current: Active? = null

    /** Held by every inference call. LiteRT-LM only supports one
     *  Conversation at a time and the engine is process-shared. */
    val inferenceLock: Mutex = Mutex()

    @OptIn(ExperimentalApi::class)
    data class Active(
        val size: Gemma4Size,
        val engine: Engine,
        val backendName: String,
        val modelPath: String,
    )

    /**
     * Return the active engine for [size]. Lazy-loads on first call;
     * if a different size is currently loaded it's unloaded and the
     * requested size is brought up. Throws [LocalEngineUnavailable]
     * when the .litertlm file isn't on disk yet (the UI must trigger
     * the download first) or when both GPU and NPU init fail.
     */
    @OptIn(ExperimentalApi::class)
    suspend fun getOrLoad(context: Context, size: Gemma4Size): Active =
        withContext(Dispatchers.IO) {
            val existing = current
            if (existing != null && existing.size == size) return@withContext existing
            // Different size requested — close the old one before
            // loading the new one. mmap'd weights add up to GB; we
            // can't keep both alive on a 12-16 GiB device.
            if (existing != null) {
                Log.i(TAG, "swapping engine ${existing.size} → $size")
                runCatching { existing.engine.close() }
                current = null
            }
            val spec = Gemma4Catalog.forSize(size)
            val file = spec.localFile(context.applicationContext)
            if (!file.isFile || file.length() != spec.sizeInBytes) {
                throw LocalEngineUnavailable(
                    "Gemma 4 ${size.name} weights not on disk. Download from Devices → AI assistant.",
                )
            }
            val instance = initializeEngine(context, file)
                ?: throw LocalEngineUnavailable(
                    "Failed to initialize Gemma 4 ${size.name}. " +
                        "GPU/NPU dispatch refused; CPU is intentionally unsupported."
                )
            val active = Active(
                size = size,
                engine = instance.engine,
                backendName = instance.backendName,
                modelPath = file.absolutePath,
            )
            current = active
            active
        }

    @OptIn(ExperimentalApi::class)
    suspend fun unload() = withContext(Dispatchers.IO) {
        val existing = current ?: return@withContext
        Log.i(TAG, "unload engine ${existing.size}")
        runCatching { existing.engine.close() }
        current = null
    }

    /** True iff an Engine is currently loaded. UI uses this to decide
     *  whether the "active" badge shows on the model picker tile. */
    fun isLoaded(): Boolean = current != null

    /** Currently-loaded model size, or null. */
    fun loadedSize(): Gemma4Size? = current?.size

    /** Backend name reported by LiteRT-LM ("GPU" / "NPU"). UI hint. */
    fun backendName(): String? = current?.backendName

    /** Current model on-disk path. */
    fun modelPath(): String? = current?.modelPath

    @OptIn(ExperimentalApi::class)
    private data class Instance(val engine: Engine, val backendName: String)

    @OptIn(ExperimentalApi::class)
    private fun initializeEngine(context: Context, file: File): Instance? {
        val totalStart = System.currentTimeMillis()
        val modelPath = file.absolutePath
        Log.i(TAG, "init model=$modelPath maxTokens=$DEFAULT_MAX_TOKENS")

        val cacheDir =
            if (modelPath.startsWith("/data/local/tmp")) context.cacheDir.absolutePath else null
        val nativeLibDir = context.applicationInfo.nativeLibraryDir

        // Inline (no watchdog thread). LiteRT-LM's native Engine
        // state is tied to the calling thread — abandoning a
        // watchdog or returning the engine across thread boundaries
        // risks SIGSEGV during later inference. Caller is on
        // Dispatchers.IO so this won't block the UI even on a 5-15s
        // GPU compile.
        fun tryBackend(label: String, build: () -> Backend): Instance? {
            val t0 = System.currentTimeMillis()
            Log.i(TAG, "trying $label backend…")
            return try {
                val backend = build()
                val config =
                    EngineConfig(
                        modelPath = modelPath,
                        backend = backend,
                        // Vision subgraph routes to GPU even when LM
                        // is on NPU — Gemma 4's vision encoder is
                        // ~150M params, cheap, and the GPU path is
                        // the only one with stable image-handling on
                        // current LiteRT-LM. Audio routes to CPU
                        // (unused for now but matches OrcaAI's
                        // working config).
                        visionBackend = Backend.GPU(),
                        audioBackend = Backend.CPU(),
                        maxNumTokens = DEFAULT_MAX_TOKENS,
                        cacheDir = cacheDir,
                    )
                val eng = Engine(config)
                eng.initialize()
                Log.i(
                    TAG,
                    "$label ready in ${System.currentTimeMillis() - t0} ms " +
                        "(total=${System.currentTimeMillis() - totalStart} ms)",
                )
                Instance(eng, label)
            } catch (t: Throwable) {
                Log.w(
                    TAG,
                    "$label init failed after ${System.currentTimeMillis() - t0} ms: ${t.message}",
                    t,
                )
                null
            }
        }

        // GPU first: works on Galaxy XR's Adreno and on Mali devices.
        // NPU only as a hint to vendor-flavored APKs that bundle a
        // libLiteRtDispatch_*.so blob; on stock Galaxy XR / Pixel
        // this is expected to fail quickly (no dispatch lib).
        tryBackend("GPU") { Backend.GPU() }?.let { return it }
        tryBackend("NPU") { Backend.NPU(nativeLibraryDir = nativeLibDir) }?.let { return it }
        Log.e(
            TAG,
            "GPU and NPU init both failed after ${System.currentTimeMillis() - totalStart} ms — refusing CPU.",
        )
        return null
    }
}

/**
 * Thrown when the Local backend is selected but can't run — either
 * the .litertlm file isn't on disk yet, or LiteRT-LM refuses to
 * dispatch to GPU/NPU. The UI shows the message verbatim; users
 * resolve by downloading the model or switching backends.
 */
class LocalEngineUnavailable(message: String) : Exception(message)
