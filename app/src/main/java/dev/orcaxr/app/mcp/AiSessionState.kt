package dev.orcaxr.app.mcp

import dev.orcaxr.app.AiRenderEngine
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * AI-driven paint pillar (C9 milestone 2) — process-scoped session
 * state for vision tools. Holds:
 *  - named camera presets the LLM created via `name_view`
 *  - the most-recent render token (so the LLM can refer to "the
 *    camera I just rendered from" without re-providing the matrix)
 *  - bounded render artifact cache keyed by content hash, so
 *    identical re-renders are O(1) lookups
 *  - triangle-id maps per render token (for `resolve_image_pixel`)
 *
 * Lifetime: per app run. Restarting OrcaXR resets the session, which
 * is intentional — triangle IDs survive only as long as the source
 * file is unchanged, and the cleanest contract is "AI session = one
 * app run".
 */
internal class AiSessionState internal constructor() {

    data class RenderArtifact(
        val token: String,
        val pngBytes: ByteArray,
        val widthPx: Int,
        val heightPx: Int,
        /** Camera spec the render was produced from; the LLM passes
         *  this back to `paint_projected_mask` so the tool knows the
         *  exact view+projection without trusting a named preset to
         *  match. */
        val camera: AiRenderEngine.CameraSpec,
        /** For TriangleId mode: per-pixel decoded ID array (-1 = bg). */
        val triangleIdMap: IntArray?,
        /** Wall-clock epoch ms — used by the LRU eviction. */
        val createdAtMs: Long,
    )

    private val artifacts = ConcurrentHashMap<String, RenderArtifact>()
    private val cameraPresets = ConcurrentHashMap<String, AiRenderEngine.CameraSpec>()
    @Volatile var lastRenderToken: String? = null
        private set

    /** Cap on the LRU. Each artifact is bounded above by 1 MB
     *  (enforced by the tool side via the 1024×1024 render cap), so
     *  50 entries = ~50 MB worst case. */
    private val maxArtifacts = 50

    fun saveArtifact(art: RenderArtifact) {
        artifacts[art.token] = art
        lastRenderToken = art.token
        if (artifacts.size > maxArtifacts) {
            evictOldest()
        }
    }

    fun getArtifact(token: String): RenderArtifact? = artifacts[token]

    fun saveCameraPreset(name: String, camera: AiRenderEngine.CameraSpec) {
        cameraPresets[name] = camera
    }

    fun getCameraPreset(name: String): AiRenderEngine.CameraSpec? = cameraPresets[name]

    fun listCameraPresetNames(): List<String> = cameraPresets.keys.sorted()

    fun clearAll() {
        artifacts.clear()
        cameraPresets.clear()
        lastRenderToken = null
    }

    private fun evictOldest() {
        // ConcurrentHashMap iteration is weakly consistent — fine for
        // an LRU that only has to be approximately right.
        val sorted = artifacts.values.sortedBy { it.createdAtMs }
        val removeCount = sorted.size - maxArtifacts + 1
        for (i in 0 until removeCount.coerceAtLeast(0)) {
            artifacts.remove(sorted[i].token)
        }
    }

    companion object {
        @Volatile private var instance: AiSessionState? = null

        fun get(): AiSessionState {
            instance?.let { return it }
            return synchronized(this) {
                instance ?: AiSessionState().also { instance = it }
            }
        }

        /**
         * Stable content-hash for a render request. Identical inputs
         * map to the same token, so re-rendering the same view is a
         * cache hit. SHA-256 truncated to 16 hex chars (8 bytes) —
         * collision probability ~negligible at the rate the LLM
         * issues renders.
         */
        fun contentToken(
            modelId: String,
            mode: String,
            camera: AiRenderEngine.CameraSpec,
            paintContentVersion: Int,
        ): String {
            val md = MessageDigest.getInstance("SHA-256")
            md.update(modelId.toByteArray())
            md.update(mode.toByteArray())
            md.update(intToBytes(camera.widthPx))
            md.update(intToBytes(camera.heightPx))
            for (v in camera.viewMatrixRowMajor) md.update(floatToBytes(v))
            for (v in camera.projMatrixRowMajor) md.update(floatToBytes(v))
            md.update(intToBytes(paintContentVersion))
            val full = md.digest()
            val sb = StringBuilder(16)
            for (i in 0 until 8) sb.append(String.format("%02x", full[i]))
            return sb.toString()
        }

        private fun intToBytes(v: Int): ByteArray = byteArrayOf(
            (v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte(),
        )

        private fun floatToBytes(v: Float): ByteArray =
            intToBytes(java.lang.Float.floatToRawIntBits(v))
    }
}
