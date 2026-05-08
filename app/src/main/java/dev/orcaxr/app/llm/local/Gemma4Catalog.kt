package dev.orcaxr.app.llm.local

import android.content.Context
import java.io.File

/**
 * Catalog of downloadable Gemma 4 .litertlm bundles.
 *
 * Two sizes are exposed:
 *  - **E2B** — 2.3B effective parameters (5.1B with embeddings),
 *    ~2.41 GiB on disk. The headset default — Galaxy XR's Adreno GPU
 *    plus the renderer plus libslic3r already saturate the shared
 *    memory bus on a heavy 3MF, and a smaller LM keeps inference
 *    snappy without blowing thermals.
 *  - **E4B** — 4.5B effective parameters (8B with embeddings),
 *    ~3.40 GiB on disk. Higher MMLU-Pro / Codeforces scores; pick
 *    this on a phone form factor (Pixel 10 Pro / Tensor G5) where
 *    the host has 16 GiB RAM and is plugged in. Avoid on the
 *    headset until thermal/battery measurements say otherwise.
 *
 * URL + commit hash pin a specific file revision so the .litertlm
 * the user downloads matches the one OrcaXR was tested against. HF
 * occasionally re-uploads model weights; bumping the hash here is
 * how we adopt a new revision intentionally rather than silently.
 *
 * Resolved download URL pattern:
 *   https://huggingface.co/{modelId}/resolve/{commit}/{file}?download=true
 */
object Gemma4Catalog {

    val E2B: Gemma4Spec = Gemma4Spec(
        size = Gemma4Size.E2B,
        displayName = "Gemma 4 E2B (it)",
        modelId = "litert-community/gemma-4-E2B-it-litert-lm",
        // Pinned 2026-05-08; bump intentionally when adopting a new
        // revision. Verified file size against HF's x-linked-size.
        commitHash = "b4f4f4df93418ddb4aa7da8bf33b584602a5b9f8",
        fileName = "gemma-4-E2B-it.litertlm",
        sizeInBytes = 2_588_147_712L,
    )

    val E4B: Gemma4Spec = Gemma4Spec(
        size = Gemma4Size.E4B,
        displayName = "Gemma 4 E4B (it)",
        modelId = "litert-community/gemma-4-E4B-it-litert-lm",
        // Pinned commit from the OrcaAI companion app's catalog,
        // known-working on Tensor G5. Bump intentionally.
        commitHash = "9695417f248178c63a9f318c6e0c56cb917cb837",
        fileName = "gemma-4-E4B-it.litertlm",
        sizeInBytes = 3_654_467_584L,
    )

    val ALL: List<Gemma4Spec> = listOf(E2B, E4B)

    fun forSize(size: Gemma4Size): Gemma4Spec = when (size) {
        Gemma4Size.E2B -> E2B
        Gemma4Size.E4B -> E4B
    }
}

/** Two on-device Gemma 4 sizes. The DataStore-backed user selection
 *  flows through [Gemma4Size] so the UI, downloader, and engine
 *  loader all agree on one shape. */
enum class Gemma4Size(val storageName: String) {
    E2B("e2b"),
    E4B("e4b"),
    ;
    companion object {
        fun fromStorage(s: String?): Gemma4Size =
            entries.firstOrNull { it.storageName == s } ?: E2B
    }
}

/**
 * Static description of a downloadable .litertlm. Carries everything
 * the worker needs to fetch + verify + place the file plus everything
 * the engine holder needs to load it. Runtime state (download
 * progress, engine handle) lives elsewhere.
 */
data class Gemma4Spec(
    val size: Gemma4Size,
    val displayName: String,
    /** HuggingFace repo id, "<org>/<repo>". */
    val modelId: String,
    /** Pinned HF commit so a re-upload doesn't silently change the file. */
    val commitHash: String,
    /** Bare filename inside the HF repo, also used on disk. */
    val fileName: String,
    /** Expected total bytes. Drives the progress percentage; not validated. */
    val sizeInBytes: Long,
) {
    /** Human-readable size string for UI. */
    val displaySize: String
        get() = "%.2f GiB".format(sizeInBytes / (1024.0 * 1024.0 * 1024.0))

    /** Resolved HuggingFace `resolve` URL with `?download=true`. The
     *  query string forces HF's CDN to return the raw file with proper
     *  Content-Length headers (without it some HF hosts return a
     *  landing page instead of bytes). */
    val downloadUrl: String
        get() = "https://huggingface.co/$modelId/resolve/$commitHash/$fileName?download=true"

    /** Where the model lives on disk once downloaded. External-files
     *  dir matches OrcaAI / google-ai-edge/gallery — no permissions
     *  required and survives app data clears. The commit-hash short
     *  prefix in the path means a future revision lands in a sibling
     *  directory (and a stale download can be GC'd by removing it). */
    fun localFile(context: Context): File {
        val root = context.getExternalFilesDir(null) ?: context.filesDir
        return File(File(File(root, "models"), commitHash.take(12)), fileName)
    }

    /** Partial-download tmp file. Resume reads `Range: bytes=N-` from this size. */
    fun localTmpFile(context: Context): File =
        File(localFile(context).parentFile, "$fileName.gallerytmp")
}
