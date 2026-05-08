package dev.orcaxr.app

import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AI paint pillar — Milestone 8b. Opt-in native re-implementation of
 * [AiMaskProjection.project] for `paint_projected_mask`.
 *
 * Why opt-in: the Kotlin path is the canonical, well-tested
 * implementation; the native path is a parity port whose output must
 * match the Kotlin reference triangle-for-triangle. Until that
 * parity is verified on a real device (via the `benchmark_native_bvh`
 * MCP tool), the Kotlin path stays the default and `enabled` is
 * false. Flip via [setEnabled] (also exposed as the
 * `set_native_bvh_enabled` MCP tool).
 *
 * Loading model: the JNI symbol lives inside `libslic3r_jni.so` —
 * already loaded by [SlicerEngine] on production paths. We do NOT
 * trigger an extra `loadLibrary` here so the JVM unit-test path
 * (where `libslic3r_jni.so` isn't loaded) keeps working: the first
 * call to [projectMask] surfaces the absence as `isAvailable=false`
 * and the caller falls back to the Kotlin path. On Android, by the
 * time anything calls [projectMask], `SlicerEngine` has been
 * referenced (load_model_from_path / list_placed_models / ...) and
 * the .so is in memory — the `external` declaration resolves.
 */
internal object NativeBvh {

    private const val TAG = "NativeBvh"

    /**
     * False until [setEnabled] flips it. Default off — the Kotlin
     * path is canonical until on-device parity is confirmed.
     */
    private val enabledFlag = AtomicBoolean(false)

    /** Cached probe result: null until first probe; true if the JNI
     *  symbol resolved at least once; false if [UnsatisfiedLinkError]
     *  was caught. The probe runs lazily inside [projectMask] so we
     *  don't force a `loadLibrary` here on the JVM test path. */
    @Volatile private var probedAvailable: Boolean? = null

    /** Whether the native path is currently selected. Both the toggle
     *  AND the JNI probe must succeed. */
    val isEnabledAndAvailable: Boolean
        get() = enabledFlag.get() && (probedAvailable == true)

    fun isEnabled(): Boolean = enabledFlag.get()

    /** Diagnostic: the last probe result. null = never probed. */
    fun probedAvailableOrNull(): Boolean? = probedAvailable

    fun setEnabled(value: Boolean) {
        enabledFlag.set(value)
    }

    /**
     * For each "on" pixel in [mask], unproject through [camera] and
     * intersect against the BVH inside C++. Returns the same shape
     * as [AiMaskProjection.project]: sorted, deduplicated triangle
     * indices.
     *
     * Returns null when the native call cannot run (the JNI symbol
     * isn't resolved, or an internal error occurred). Callers should
     * fall back to the Kotlin path.
     */
    fun projectMask(
        bvhArrays: BvhArrays,
        camera: AiRenderEngine.CameraSpec,
        mask: BooleanArray,
        depthMode: AiMaskProjection.DepthMode,
        backFaceFilter: Boolean,
    ): IntArray? {
        if (probedAvailable == false) return null
        val w = camera.widthPx
        val h = camera.heightPx
        if (mask.size != w * h) return null
        val (depthOrdinal, thickness) = encodeDepthMode(depthMode) ?: return null

        // Pack the boolean mask into a byte buffer (0/1) so the JNI
        // can read it as raw bytes.
        val packed = ByteArray(mask.size)
        for (i in mask.indices) packed[i] = if (mask[i]) 1.toByte() else 0.toByte()

        return try {
            val out = nativeProjectMask(
                positions = bvhArrays.positions,
                triIdx = bvhArrays.triIdx,
                nodeAabb = bvhArrays.nodeAabb,
                nodeLeft = bvhArrays.nodeLeft,
                nodeRight = bvhArrays.nodeRight,
                nodeLeafStart = bvhArrays.nodeLeafStart,
                nodeLeafEnd = bvhArrays.nodeLeafEnd,
                viewMatrix = camera.viewMatrixRowMajor,
                projMatrix = camera.projMatrixRowMajor,
                widthPx = w,
                heightPx = h,
                mask = packed,
                depthModeOrdinal = depthOrdinal,
                thicknessMm = thickness,
                backFaceFilter = backFaceFilter,
            )
            probedAvailable = true
            out
        } catch (t: UnsatisfiedLinkError) {
            // JNI symbol absent — JVM unit-test environment, or the
            // .so didn't load. Pin the probe so subsequent calls
            // skip immediately, and let the caller fall back.
            probedAvailable = false
            Log.w(TAG, "native BVH unavailable; falling back to Kotlin: ${t.message}")
            null
        } catch (t: Throwable) {
            // Any other error (out-of-memory in the C++ vector,
            // primitive-array pin failure) — log and fall back.
            probedAvailable = true   // symbol resolved; the call itself failed
            Log.w(TAG, "native BVH call failed; falling back to Kotlin", t)
            null
        }
    }

    /** Encode a [DepthMode] for the JNI ordinal arg + thickness
     *  side-channel. Mirrors [AiMaskProjection.DepthMode] cases.
     *  Returns null on an unsupported mode (defensive — every
     *  current case is supported). */
    private fun encodeDepthMode(
        depthMode: AiMaskProjection.DepthMode,
    ): Pair<Int, Float>? = when (depthMode) {
        AiMaskProjection.DepthMode.FrontFacingOnly -> 0 to 0f
        AiMaskProjection.DepthMode.AllHits         -> 1 to 0f
        AiMaskProjection.DepthMode.AnyFacing       -> 2 to 0f
        is AiMaskProjection.DepthMode.FrontPlusThin -> 3 to depthMode.thicknessMm
    }

    /**
     * BVH primitive-array view. The Kotlin [MeshBvh] holds these
     * exact arrays as private fields; an internal accessor on
     * [MeshBvh] exposes them so this class can hand them to the
     * native call without copying.
     */
    data class BvhArrays(
        val positions: FloatArray,    // 9 * triCount
        val triIdx: IntArray,         // triCount
        val nodeAabb: FloatArray,     // 6 * nodeCount
        val nodeLeft: IntArray,       // nodeCount
        val nodeRight: IntArray,      // nodeCount
        val nodeLeafStart: IntArray,  // nodeCount
        val nodeLeafEnd: IntArray,    // nodeCount
    ) {
        // Identity-based equality is fine — these arrays are
        // immutable-by-convention BVH internals. Override is just to
        // suppress the data-class IntelliJ warning.
        override fun equals(other: Any?): Boolean = this === other
        override fun hashCode(): Int = System.identityHashCode(this)
    }

    @JvmStatic
    private external fun nativeProjectMask(
        positions: FloatArray,
        triIdx: IntArray,
        nodeAabb: FloatArray,
        nodeLeft: IntArray,
        nodeRight: IntArray,
        nodeLeafStart: IntArray,
        nodeLeafEnd: IntArray,
        viewMatrix: FloatArray,
        projMatrix: FloatArray,
        widthPx: Int,
        heightPx: Int,
        mask: ByteArray,
        depthModeOrdinal: Int,
        thicknessMm: Float,
        backFaceFilter: Boolean,
    ): IntArray
}
