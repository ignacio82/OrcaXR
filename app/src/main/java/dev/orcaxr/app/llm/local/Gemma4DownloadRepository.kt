package dev.orcaxr.app.llm.local

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * WorkManager facade for the Gemma 4 model download flow. The worker
 * is the load-bearing piece; this repository owns the enqueue +
 * cancel + observe handles so the rest of the app doesn't have to
 * know WorkManager exists.
 *
 * State machine:
 *   Idle ──(start)──→ Downloading ──(success)──→ Complete
 *                          │
 *                          ├──(failure)──→ Failed (with reason)
 *                          └──(cancel)───→ Idle
 *
 * Re-enqueueing while a download is already running is a no-op (KEEP
 * policy on the unique work name). Re-enqueueing after a Failed
 * state resumes from the partial `.gallerytmp` because the worker
 * reads the existing tmp size via `Range:`.
 *
 * One repository instance per [Gemma4Spec] (E2B / E4B). The unique
 * work name is shared across sizes — only one Gemma 4 download can
 * run at a time, by design (same external bandwidth, same target
 * directory).
 */
class Gemma4DownloadRepository(
    private val appContext: Context,
    val spec: Gemma4Spec,
) {

    private val workManager: WorkManager = WorkManager.getInstance(appContext)

    /** The model file we ultimately want on disk. Exposed so callers
     *  can check existence without going through this repository. */
    val targetFile = spec.localFile(appContext)

    /** Display-friendly state. Mirrors WorkInfo.State + adds a
     *  "Complete" synthetic when the file already exists. */
    sealed interface Status {
        data object Idle : Status
        data class Downloading(
            val bytesDownloaded: Long,
            val bytesTotal: Long,
            val bytesPerSec: Long,
        ) : Status
        data object Complete : Status
        data class Failed(val reason: String) : Status
    }

    private val externalStatus: MutableStateFlow<Status> =
        MutableStateFlow(initialStatusForFile())

    val status: StateFlow<Status> get() = externalStatus.asStateFlow()

    /** Hot status flow combining on-disk presence + WorkManager state.
     *  Uses getWorkInfosForUniqueWorkFlow (WorkManager 2.10+) so
     *  there's no LiveData ↔ Flow hop. */
    fun statusFlow(): Flow<Status> {
        val workInfoFlow: Flow<WorkInfo?> = workManager
            .getWorkInfosForUniqueWorkFlow(Gemma4DownloadWorker.UNIQUE_WORK_NAME)
            .map { it.firstOrNull() }
        return combine(externalStatus, workInfoFlow) { external, info ->
            // File-on-disk fast-path. Authoritative — covers "user
            // came back to a complete download from a previous run".
            if (isDownloaded()) return@combine Status.Complete
            when (info?.state) {
                WorkInfo.State.RUNNING -> {
                    val p = info.progress
                    Status.Downloading(
                        bytesDownloaded = p.getLong(Gemma4DownloadWorker.PROGRESS_BYTES_DOWNLOADED, 0L),
                        bytesTotal = p.getLong(Gemma4DownloadWorker.PROGRESS_BYTES_TOTAL, spec.sizeInBytes),
                        bytesPerSec = p.getLong(Gemma4DownloadWorker.PROGRESS_BYTES_PER_SEC, 0L),
                    )
                }
                WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED ->
                    Status.Downloading(0L, spec.sizeInBytes, 0L)
                WorkInfo.State.SUCCEEDED -> Status.Complete
                WorkInfo.State.FAILED -> {
                    val reason = info.outputData.getString(Gemma4DownloadWorker.KEY_ERROR) ?: "failed"
                    Status.Failed(reason)
                }
                WorkInfo.State.CANCELLED, null -> external
            }
        }.distinctUntilChanged()
    }

    fun isDownloaded(): Boolean =
        targetFile.exists() && targetFile.length() == spec.sizeInBytes

    fun start(allowMetered: Boolean = false) {
        if (isDownloaded()) {
            externalStatus.value = Status.Complete
            return
        }
        val request = OneTimeWorkRequestBuilder<Gemma4DownloadWorker>()
            .setConstraints(
                Constraints.Builder()
                    // Default to Wi-Fi. 2.4-3.4 GiB on cellular is
                    // unfriendly even on unlimited plans. The UI can
                    // toggle allowMetered to override when the user
                    // is intentionally on a hotspot or willing to
                    // burn data. Expedited jobs only accept network
                    // and storage constraints — adding e.g.
                    // setRequiresBatteryNotLow throws
                    // IllegalArgumentException at .build().
                    .setRequiredNetworkType(
                        if (allowMetered) NetworkType.CONNECTED else NetworkType.UNMETERED
                    )
                    .build(),
            )
            // Expedited so the OS gives us a foreground slot promptly.
            // RUN_AS_NON_EXPEDITED_WORK_REQUEST as fallback so a phone
            // already in doze still picks the work up rather than
            // refusing outright.
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(
                workDataOf(
                    Gemma4DownloadWorker.KEY_URL to spec.downloadUrl,
                    Gemma4DownloadWorker.KEY_OUT_PATH to spec.localFile(appContext).absolutePath,
                    Gemma4DownloadWorker.KEY_TMP_PATH to spec.localTmpFile(appContext).absolutePath,
                    Gemma4DownloadWorker.KEY_TOTAL_BYTES to spec.sizeInBytes,
                    Gemma4DownloadWorker.KEY_DISPLAY_NAME to spec.displayName,
                ),
            )
            .build()
        workManager.enqueueUniqueWork(
            Gemma4DownloadWorker.UNIQUE_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    fun cancel() {
        workManager.cancelUniqueWork(Gemma4DownloadWorker.UNIQUE_WORK_NAME)
        externalStatus.value = Status.Idle
    }

    /** Wipe both the final file and the partial tmp file. The
     *  Devices panel uses this to free 2-3 GiB without uninstalling. */
    fun deleteLocalCopy() {
        spec.localFile(appContext).delete()
        spec.localTmpFile(appContext).delete()
        externalStatus.value = Status.Idle
    }

    private fun initialStatusForFile(): Status =
        if (isDownloaded()) Status.Complete else Status.Idle
}
