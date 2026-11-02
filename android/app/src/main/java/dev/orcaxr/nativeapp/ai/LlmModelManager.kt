package dev.orcaxr.nativeapp.ai

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class LlmModelManager(
    private val context: Context,
    val downloadManager: LlmDownloadManager = LlmDownloadManager(context),
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val _aiCoreStatus = MutableStateFlow<AICoreStatus>(AICoreStatus.Unknown)
    val aiCoreStatus: StateFlow<AICoreStatus> = _aiCoreStatus.asStateFlow()

    private val _activeEngine = MutableStateFlow<LlmEngine?>(null)
    val activeEngine: StateFlow<LlmEngine?> = _activeEngine.asStateFlow()

    val downloadState: StateFlow<DownloadState> = downloadManager.downloadState

    companion object {
        private const val TAG = "LlmModelManager"
        @Volatile private var instance: LlmModelManager? = null

        fun getInstance(context: Context): LlmModelManager {
            return instance ?: synchronized(this) {
                instance ?: LlmModelManager(context.applicationContext).also { instance = it }
            }
        }
    }

    init {
        scope.launch {
            probeAiCore()
        }
        scope.launch {
            downloadManager.downloadState.collect { ds ->
                if (_activeEngine.value?.backendKind == LlmBackend.AICORE) return@collect
                if (ds is DownloadState.Ready && _activeEngine.value == null) {
                    initLiteRt(ds.file.absolutePath)
                }
            }
        }
    }

    suspend fun probeAiCore() = withContext(Dispatchers.IO) {
        val status = AICoreEngine.checkStatus()
        Log.i(TAG, "AICore probed status: $status")
        _aiCoreStatus.value = status
        if (status is AICoreStatus.Ready && _activeEngine.value == null) {
            _activeEngine.value = AICoreEngine(context)
        }
    }

    fun downloadAiCore() {
        scope.launch {
            AICoreEngine.downloadFeature().collect { status ->
                _aiCoreStatus.value = status
                if (status is AICoreStatus.Warming) {
                    val warmed = AICoreEngine.warmup()
                    _aiCoreStatus.value = warmed
                    if (warmed is AICoreStatus.Ready && _activeEngine.value == null) {
                        _activeEngine.value = AICoreEngine(context)
                    }
                }
            }
        }
    }

    fun downloadLiteRtModel() {
        scope.launch {
            downloadManager.downloadModel()
        }
    }

    suspend fun ensureInitialized(): LlmEngine? = withContext(Dispatchers.Default) {
        _activeEngine.value?.let { return@withContext it }

        // 1. Try AICore first (Tensor TPU fast path)
        val aiCore = AICoreEngine.checkStatus()
        _aiCoreStatus.value = aiCore
        if (aiCore is AICoreStatus.Ready) {
            val engine = AICoreEngine(context)
            _activeEngine.value = engine
            return@withContext engine
        }

        // 2. Try LiteRT (Gemma)
        val ds = downloadManager.downloadState.value
        if (ds is DownloadState.Ready) {
            val engine = LiteRtEngine.initialize(context, ds.file.absolutePath)
            if (engine != null) {
                _activeEngine.value = engine
                return@withContext engine
            }
        }

        null
    }

    private suspend fun initLiteRt(modelPath: String) = withContext(Dispatchers.Default) {
        val engine = LiteRtEngine.initialize(context, modelPath)
        if (engine != null && _activeEngine.value == null) {
            _activeEngine.value = engine
        }
    }

    fun close() {
        _activeEngine.value?.close()
        _activeEngine.value = null
    }
}
