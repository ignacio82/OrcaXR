package dev.orcaxr.nativeapp.engine

import java.util.Locale

/**
 * Whether this build and this device can slice a plate on the device, as
 * measured now: the engine the APK carries for one of the device's ABIs, and
 * the device's memory ([totalMemory], [availableMemory], [lowMemory] from the
 * system). Platform-free, so the route's rules have JVM tests.
 */
data class LocalEngineState(
    /** The engine commit the APK's engine manifest names, or null when this build carries no engine. */
    val commit: String? = null,
    /** The device ABI the packaged engine runs as; null when none of the device's ABIs is packaged. */
    val abi: String? = null,
    val totalMemory: Long = 0,
    val availableMemory: Long = 0,
    val lowMemory: Boolean = false,
    /** The SHA-256 of [abi]'s verified adapter export manifest (every library and resource the engine loads). */
    val packageSha256: String? = null,
) {
    /** Whether a plate can be sliced here now (each plate's own size is checked when it is staged). */
    val available: Boolean
        get() = commit != null && abi != null && !lowMemory &&
            totalMemory >= LocalSliceBudget.MIN_DEVICE_MEMORY && LocalSliceBudget.largestArchive(availableMemory) > 0

    /** Why a plate cannot be sliced here, in the Prepare area's words; null when it can. */
    val reason: String?
        get() = when {
            commit == null -> LocalEngineWords.NOT_PACKAGED
            abi == null -> LocalEngineWords.NO_ABI
            totalMemory < LocalSliceBudget.MIN_DEVICE_MEMORY -> LocalEngineWords.SMALL_DEVICE
            lowMemory || LocalSliceBudget.largestArchive(availableMemory) <= 0 -> LocalEngineWords.LOW_MEMORY
            else -> null
        }

    companion object {
        val NONE = LocalEngineState()
    }
}

/**
 * The memory a local slice is admitted against. The engine holds the plate's
 * decompressed geometry, its slices and toolpaths; until devices are measured
 * (Phase 6's qualification), a plate is admitted when the device's available
 * memory covers a fixed baseline plus [ARCHIVE_EXPANSION] times its archive,
 * on a device of at least [MIN_DEVICE_MEMORY]. The archive is the canonical
 * one-plate BBS package the external route uploads too.
 */
object LocalSliceBudget {
    /** The engine process's own footprint before a plate: libraries, TBB, configuration. */
    const val BASELINE_BYTES = 256L shl 20
    /** The decompressed geometry and slicing state per archive byte, provisionally. */
    const val ARCHIVE_EXPANSION = 16L
    const val MIN_DEVICE_MEMORY = 1536L shl 20

    fun required(archiveBytes: Long): Long = BASELINE_BYTES + archiveBytes * ARCHIVE_EXPANSION

    /** The largest archive the device's [availableMemory] admits now, or 0. */
    fun largestArchive(availableMemory: Long): Long = ((availableMemory - BASELINE_BYTES) / ARCHIVE_EXPANSION).coerceAtLeast(0)

    fun fits(archiveBytes: Long, state: LocalEngineState): Boolean =
        state.available && required(archiveBytes) <= state.availableMemory
}

/** The local route's own words (the browser has no device engine to describe). */
object LocalEngineWords {
    const val NOT_PACKAGED = "This build of OrcaXR carries no slicing engine of its own."
    const val NO_ABI = "This device's processor is not one the slicing engine was built for."
    const val SMALL_DEVICE = "This device has too little memory to slice on it."
    const val LOW_MEMORY = "This device is low on memory right now."
    const val NOT_STARTED = "The slicing engine did not start."
    const val BACKGROUND = "Android did not allow slicing to start while OrcaXR is in the background."
    const val PREVIOUS_RUNNING = "The previous slicing engine has not stopped yet; try again in a moment."
    const val STARTING = "Slicing project on this device…"

    fun megabytes(bytes: Long): String = String.format(Locale.ROOT, "%.0f MB", bytes / 1048576.0)

    /** The engine as Prepare names it: the pinned Snapmaker Orca commit, shortened as the browser shortens one. */
    fun engine(commit: String) = "Snapmaker Orca at ${commit.take(12)}"

    /** A plate too large for the memory the device has now. */
    fun tooLarge(archiveBytes: Long, state: LocalEngineState) =
        "The plate needs about ${megabytes(LocalSliceBudget.required(archiveBytes))} to slice on this device, " +
            "which has ${megabytes(state.availableMemory)} available now."

    /** An engine process whose library did not match the app's manifest. */
    fun refused(reason: String) = "The slicing engine in this build cannot be used: $reason"
}

/** Where a local job's files live; the editor and the engine's process share these private directories. */
object LocalEngineFiles {
    /** Under the app's no-backup files: jobs are never backed up or restored. */
    const val JOBS = "engine-jobs"
    const val RESOURCES = "engine-resources"
    /** The engine identity manifest the build packaged (build-engine-adapter.py --export). */
    const val MANIFEST = "engine/manifest.json"
    const val RESOURCE_ASSETS = "engine/resources"
    private val JOB = Regex("[0-9a-f]{32}")

    fun validJob(id: String): Boolean = JOB.matches(id)
}
