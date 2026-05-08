package dev.orcaxr.app.llm.local

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.orcaxr.app.R
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Foreground CoroutineWorker that streams a Gemma 4 `.litertlm`
 * bundle from HuggingFace to disk with HTTP `Range:` resume +
 * progress reporting.
 *
 * Mirrors the OrcaAI companion app's `ModelDownloadWorker` (which
 * itself mirrors `google-ai-edge/gallery`'s pattern) — same
 * protocol semantics: write to `<file>.gallerytmp`, on retry send
 * `Range: bytes=<existing>-` with `Accept-Encoding: identity`,
 * accept either 200 (full transfer) or 206 (partial), rename to
 * final filename on completion. Foreground service so the OS doesn't
 * kill the download when the user backgrounds the app or doffs the
 * headset — 2.4 GiB on home Wi-Fi is roughly 4-8 minutes, well past
 * the doze window if we relied on a normal background work request.
 *
 * Inputs (Worker data):
 *   KEY_URL          (required) — full https URL to fetch
 *   KEY_OUT_PATH     (required) — final file absolute path
 *   KEY_TMP_PATH     (required) — tmp file absolute path (Range writes here)
 *   KEY_TOTAL_BYTES  (optional) — expected size (drives progress %)
 *   KEY_DISPLAY_NAME (optional) — model name shown in the notification
 *
 * Outputs (Worker progress):
 *   PROGRESS_BYTES_DOWNLOADED  — running total
 *   PROGRESS_BYTES_TOTAL       — total (echoed; useful when the worker
 *                                infers Content-Length on the fly)
 *   PROGRESS_BYTES_PER_SEC     — moving-average rate
 *
 * Output (Result.success / Result.failure):
 *   On success the final file exists at KEY_OUT_PATH, sized exactly
 *   KEY_TOTAL_BYTES. On failure setOutputData carries KEY_ERROR with
 *   a short reason string.
 */
class Gemma4DownloadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun getForegroundInfo(): ForegroundInfo = createForegroundInfo(0L, 0L)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val url = inputData.getString(KEY_URL) ?: return@withContext fail("missing url")
        val outPath = inputData.getString(KEY_OUT_PATH) ?: return@withContext fail("missing out_path")
        val tmpPath = inputData.getString(KEY_TMP_PATH) ?: return@withContext fail("missing tmp_path")
        val expectedTotal = inputData.getLong(KEY_TOTAL_BYTES, -1L)
        val displayName = inputData.getString(KEY_DISPLAY_NAME) ?: "Gemma 4"

        val outFile = File(outPath)
        val tmpFile = File(tmpPath)
        outFile.parentFile?.mkdirs()
        tmpFile.parentFile?.mkdirs()

        // Idempotency — if the final file is already there at the
        // expected size, declare success immediately so a re-enqueue
        // is a no-op.
        if (outFile.exists() && (expectedTotal <= 0 || outFile.length() == expectedTotal)) {
            Log.i(TAG, "already complete at $outPath")
            return@withContext Result.success(workDataOf(KEY_OUT_PATH to outPath))
        }

        var conn: HttpURLConnection? = null
        var raf: RandomAccessFile? = null
        try {
            setForeground(createForegroundInfo(tmpFile.length(), expectedTotal, displayName))
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 30_000
                readTimeout = 60_000
                instanceFollowRedirects = true
                // Disable gzip — Range only makes sense on identity
                // bodies and HF's CDN sometimes returns gzipped
                // responses with surprising Content-Length when
                // Accept-Encoding is omitted.
                setRequestProperty("Accept-Encoding", "identity")
                val resumeFrom = tmpFile.length()
                if (resumeFrom > 0L) {
                    setRequestProperty("Range", "bytes=$resumeFrom-")
                    Log.i(TAG, "resuming from $resumeFrom bytes")
                }
            }
            val responseCode = conn.responseCode
            if (responseCode !in 200..299) {
                return@withContext fail("HTTP $responseCode from $url")
            }
            // 206 = partial resumed; 200 = full transfer (server
            // ignored Range or the tmp was empty). On 200 with a
            // pre-existing tmp file we have to truncate — otherwise
            // we'd append duplicate bytes from offset 0.
            val isPartial = responseCode == 206
            val contentLen = conn.contentLengthLong
            val totalBytes = when {
                isPartial -> {
                    // Content-Range: bytes <start>-<end>/<total>
                    val cr = conn.getHeaderField("Content-Range")
                    cr?.substringAfter('/')?.trim()?.toLongOrNull()
                        ?: (tmpFile.length() + contentLen).coerceAtLeast(expectedTotal)
                }
                contentLen > 0 -> contentLen
                else -> expectedTotal
            }
            val startOffset = if (isPartial) tmpFile.length() else 0L
            if (!isPartial && tmpFile.exists()) {
                tmpFile.delete()
            }
            raf = RandomAccessFile(tmpFile, "rw").apply { seek(startOffset) }

            conn.inputStream.use { input ->
                val buf = ByteArray(BUFFER_BYTES)
                var downloaded = startOffset
                var lastProgressMs = 0L
                val rateWindow = ArrayDeque<Pair<Long, Long>>()
                while (true) {
                    if (isStopped) {
                        Log.i(TAG, "cancelled at $downloaded / $totalBytes")
                        return@withContext Result.failure(workDataOf(KEY_ERROR to "cancelled"))
                    }
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n == 0) continue
                    raf.write(buf, 0, n)
                    downloaded += n
                    val now = System.currentTimeMillis()
                    if (now - lastProgressMs >= PROGRESS_REPORT_INTERVAL_MS) {
                        rateWindow.addLast(now to downloaded)
                        while (rateWindow.size > RATE_WINDOW_SAMPLES) rateWindow.removeFirst()
                        val rate = computeRate(rateWindow)
                        setProgress(workDataOf(
                            PROGRESS_BYTES_DOWNLOADED to downloaded,
                            PROGRESS_BYTES_TOTAL to totalBytes,
                            PROGRESS_BYTES_PER_SEC to rate,
                        ))
                        runCatching {
                            setForeground(
                                createForegroundInfo(downloaded, totalBytes, displayName, rate),
                            )
                        }
                        lastProgressMs = now
                    }
                }
            }
            raf.close()
            raf = null
            // Move tmp → final atomically. If the rename loses fall
            // back to copy + delete; on internal storage rename
            // should always succeed.
            if (!tmpFile.renameTo(outFile)) {
                tmpFile.copyTo(outFile, overwrite = true)
                tmpFile.delete()
            }
            Log.i(TAG, "complete $outPath (${outFile.length()} bytes)")
            return@withContext Result.success(workDataOf(KEY_OUT_PATH to outPath))
        } catch (e: Exception) {
            Log.e(TAG, "download failed", e)
            // Don't delete the tmp file — a retry resumes from where
            // this attempt left off via the Range header.
            return@withContext Result.retry()
        } finally {
            runCatching { raf?.close() }
            runCatching { conn?.disconnect() }
        }
    }

    private fun computeRate(samples: ArrayDeque<Pair<Long, Long>>): Long {
        if (samples.size < 2) return 0L
        val (t0, b0) = samples.first()
        val (t1, b1) = samples.last()
        val dt = (t1 - t0).coerceAtLeast(1L)
        return ((b1 - b0) * 1000L) / dt
    }

    private fun createForegroundInfo(
        downloaded: Long = 0L,
        total: Long = 0L,
        modelName: String = "Gemma 4",
        bytesPerSec: Long = 0L,
    ): ForegroundInfo {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Local AI model download",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "On-device LLM weights download."
                    setShowBadge(false)
                },
            )
        }
        val pct = if (total > 0) ((downloaded * 100L) / total).toInt().coerceIn(0, 100) else 0
        val mb = downloaded / 1_048_576L
        val totalMb = total / 1_048_576L
        val mbps = bytesPerSec / 1_048_576.0
        val sub = if (total > 0) "%d / %d MB · %.1f MB/s".format(mb, totalMb, mbps) else "$mb MB"
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Downloading $modelName")
            .setContentText(sub)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setProgress(100, pct, total <= 0)
            .setOnlyAlertOnce(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    private fun fail(reason: String): Result =
        Result.failure(workDataOf(KEY_ERROR to reason))

    companion object {
        private const val TAG = "Gemma4DownloadWorker"

        const val UNIQUE_WORK_NAME = "orcaxr_gemma4_download"

        const val KEY_URL = "url"
        const val KEY_OUT_PATH = "out_path"
        const val KEY_TMP_PATH = "tmp_path"
        const val KEY_TOTAL_BYTES = "total_bytes"
        const val KEY_DISPLAY_NAME = "display_name"
        const val KEY_ERROR = "error"

        const val PROGRESS_BYTES_DOWNLOADED = "bytes_downloaded"
        const val PROGRESS_BYTES_TOTAL = "bytes_total"
        const val PROGRESS_BYTES_PER_SEC = "bytes_per_sec"

        // 1 MiB read buffer. HF's CDN responds in 64 KiB chunks but
        // a larger app-side buffer keeps the per-write loop tight.
        private const val BUFFER_BYTES = 1 shl 20
        private const val PROGRESS_REPORT_INTERVAL_MS = 250L
        private const val RATE_WINDOW_SAMPLES = 5
        private const val NOTIFICATION_ID = 4202
        private const val CHANNEL_ID = "orcaxr_gemma4_download_channel"
    }
}
