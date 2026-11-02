package dev.orcaxr.nativeapp.ai

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class LlmDownloadManager(
    private val context: Context,
    private val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build(),
) {
    private val _downloadState = MutableStateFlow<DownloadState>(DownloadState.Idle)
    val downloadState: StateFlow<DownloadState> = _downloadState.asStateFlow()

    private val modelDir = File(context.filesDir, "models").apply { mkdirs() }
    val modelFile = File(modelDir, MODEL_FILE_NAME)
    private val tempFile = File(modelDir, "$MODEL_FILE_NAME.tmp")
    private var downloadJob: Job? = null

    companion object {
        private const val TAG = "LlmDownloadManager"
        const val MODEL_FILE_NAME = "gemma-4-E2B-it.litertlm"
        const val MODEL_URL =
            "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm" +
            "/resolve/7fa1d78473894f7e736a21d920c3aa80f950c0db" +
            "/gemma-4-E2B-it.litertlm?download=true"
        private const val PROGRESS_INTERVAL_MS = 250L
    }

    init {
        val devOverride = File("/data/local/tmp", MODEL_FILE_NAME)
        val genericOverride = File("/data/local/tmp", "model.litertlm")
        when {
            devOverride.exists() && devOverride.length() > 0 -> {
                Log.i(TAG, "Using /data/local/tmp override: ${devOverride.absolutePath} (${devOverride.length()} bytes)")
                _downloadState.value = DownloadState.Ready(devOverride)
            }
            genericOverride.exists() && genericOverride.length() > 0 -> {
                Log.i(TAG, "Using /data/local/tmp generic override: ${genericOverride.absolutePath}")
                _downloadState.value = DownloadState.Ready(genericOverride)
            }
            modelFile.exists() && modelFile.length() > 0 -> {
                Log.i(TAG, "Found existing model file: ${modelFile.absolutePath} (${modelFile.length()} bytes)")
                _downloadState.value = DownloadState.Ready(modelFile)
            }
            else -> {
                _downloadState.value = DownloadState.Idle
            }
        }
    }

    suspend fun downloadModel() = withContext(Dispatchers.IO) {
        if (modelFile.exists() && modelFile.length() > 0) {
            _downloadState.value = DownloadState.Ready(modelFile)
            return@withContext
        }

        _downloadState.value = DownloadState.Downloading(0f, 0L, 0L)
        try {
            val resumeFrom = if (tempFile.exists()) tempFile.length() else 0L
            val reqBuilder = Request.Builder()
                .url(MODEL_URL)
                .header("Accept-Encoding", "identity")

            if (resumeFrom > 0) {
                reqBuilder.header("Range", "bytes=$resumeFrom-")
                Log.i(TAG, "Resuming model download from byte $resumeFrom")
            }

            val response = okHttpClient.newCall(reqBuilder.build()).execute()
            val code = response.code

            if (code != 200 && code != 206) {
                _downloadState.value = DownloadState.Error("HTTP $code: ${response.message}")
                response.close()
                return@withContext
            }

            val body = response.body ?: run {
                _downloadState.value = DownloadState.Error("Empty response body")
                return@withContext
            }

            val contentLength = body.contentLength()
            val totalBytes = if (code == 206 && contentLength > 0) resumeFrom + contentLength else contentLength
            var downloadedBytes = resumeFrom
            var lastProgressTime = System.currentTimeMillis()

            FileOutputStream(tempFile, code == 206 && resumeFrom > 0).use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        out.write(buffer, 0, read)
                        downloadedBytes += read
                        val now = System.currentTimeMillis()
                        if (now - lastProgressTime >= PROGRESS_INTERVAL_MS && totalBytes > 0) {
                            val progress = (downloadedBytes.toFloat() / totalBytes).coerceIn(0f, 1f)
                            _downloadState.value = DownloadState.Downloading(progress, downloadedBytes, totalBytes)
                            lastProgressTime = now
                        }
                    }
                }
            }

            tempFile.renameTo(modelFile)
            _downloadState.value = DownloadState.Ready(modelFile)
            Log.i(TAG, "Model downloaded successfully to ${modelFile.absolutePath}")
        } catch (c: CancellationException) {
            Log.i(TAG, "Model download cancelled")
            throw c
        } catch (t: Throwable) {
            Log.e(TAG, "Model download failed", t)
            _downloadState.value = DownloadState.Error(t.message ?: "Download failed")
        }
    }

    fun deleteModel() {
        if (tempFile.exists()) tempFile.delete()
        if (modelFile.exists()) modelFile.delete()
        _downloadState.value = DownloadState.Idle
    }
}
