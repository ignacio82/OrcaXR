package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Detect bilateral symmetry of a mesh against the X/Y/Z bbox-center
 * planes. Used by `paint_with_mirror axis="auto"` so the LLM doesn't
 * have to guess which axis a model is symmetric across — Pikachu and
 * the Stanford Bunny are bilateral-X, a top-cone-down Christmas tree
 * is bilateral-X *and* bilateral-Z, an asymmetric handheld scanner
 * is bilateral-on-none-of-them.
 *
 * Algorithm: random-sample S triangle centroids. For each candidate
 * axis, for each sample, reflect across the bbox-center plane on
 * that axis and find the nearest sampled centroid. Count as a "match"
 * when the nearest-neighbor distance is below a fraction of the bbox
 * diagonal. Score = matches / S; best axis = argmax.
 *
 * Why sampling vs brute-force-all-triangles: for a 1.4M-tri dragon
 * the naïve O(triCount²) check is 2 trillion ops. With S=1024 we get
 * S² × 3 = ~3M ops per call — well under 100ms. The score saturates
 * at the sampling resolution, which is perfect for a confidence
 * indicator (we don't need pixel-perfect symmetry, just "is the
 * mesh visibly bilateral").
 */
internal object SymmetryTools {

    /** Default sample size — large enough to give confidence ±0.03,
     *  small enough that 3 axes × S² fits in a couple-million-op
     *  budget on Galaxy XR arm64. */
    private const val DEFAULT_SAMPLE_COUNT = 1024

    /** Match tolerance, expressed as a fraction of the bbox diagonal.
     *  At 1/200 a Pikachu Funko (≈100mm tall, diagonal ≈170mm) tolerates
     *  ±0.85mm centroid drift between bilateral pairs — looser than
     *  most CAD source meshes need but appropriate for STL imports
     *  whose vertex precision is float-truncated. */
    private const val MATCH_TOLERANCE_FRACTION = 1f / 200f

    /** Confidence threshold above which a symmetry plane is considered
     *  "real". Below this we still return per-axis scores but the
     *  best_axis is null so paint_with_mirror axis="auto" fails closed. */
    private const val SYMMETRIC_THRESHOLD = 0.65f

    fun all(ws: WorkspaceModel): List<Tool> = listOf(DetectSymmetry(ws))

    class DetectSymmetry(private val ws: WorkspaceModel) : Tool {
        override val name = "detect_symmetry"
        override val description =
            "Score bilateral symmetry of the model across the X / Y / Z bbox-center planes. " +
                "Returns per-axis scores (0..1) and the best-scoring axis when at least one " +
                "axis crosses the threshold. Result is cached on the model so subsequent " +
                "paint_with_mirror axis=\"auto\" calls don't re-sample. Use BEFORE paint_with_mirror " +
                "to confirm the model is actually bilateral on the axis you want — a Pikachu Funko " +
                "is bilateral-X (cheeks pair across X), a top-cone-down Christmas tree is bilateral " +
                "on X AND Z, an asymmetric handheld is bilateral on none. Confidence below " +
                "${SYMMETRIC_THRESHOLD} means the model is NOT symmetric on that axis — pick a " +
                "different one or paint each side independently."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "sample_count" to Schemas.integer(
                    "Number of triangle centroids to test (default $DEFAULT_SAMPLE_COUNT, max 4096). " +
                        "Higher = more confident, slower (S² nearest-neighbor lookups per axis).",
                ),
                "tolerance_fraction" to Schemas.number(
                    "Match tolerance as a fraction of bbox diagonal (default ${MATCH_TOLERANCE_FRACTION}). " +
                        "Tighter = stricter; loosen for STL imports with float-precision drift.",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            if (bvh.triCount == 0) return ToolResult.error("Mesh has zero triangles.")
            val sampleCount = args.optInt("sample_count", DEFAULT_SAMPLE_COUNT)
                .coerceIn(64, 4096)
                .coerceAtMost(bvh.triCount)
            val tolFrac = (args.optDouble("tolerance_fraction", MATCH_TOLERANCE_FRACTION.toDouble()))
                .toFloat().coerceIn(1e-6f, 1f)
            val report = analyze(bvh, sampleCount, tolFrac)
            AiSessionState.get().saveSymmetry(modelId, report)
            val perAxis = JSONObject()
            for ((k, v) in report.perAxisScores) perAxis.put(k, v.toDouble())
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("best_axis", report.bestAxis ?: JSONObject.NULL)
                put("confidence", report.confidence.toDouble())
                put("per_axis_scores", perAxis)
                put("sample_count", report.sampleCount)
                put("plane_offset_mm", report.planeOffsetMm.toDouble())
                put("symmetric_threshold", SYMMETRIC_THRESHOLD.toDouble())
                if (report.bestAxis != null) {
                    put("hint",
                        "Use paint_with_mirror axis=\"${report.bestAxis}\" or axis=\"auto\". " +
                            "The mirror plane is the bbox center on that axis.")
                } else {
                    put("hint",
                        "No axis is symmetric within tolerance. paint_with_mirror axis=\"auto\" " +
                            "will fail closed; paint each side explicitly.")
                }
            }
            val text = if (report.bestAxis != null) {
                "Symmetry: best=${report.bestAxis} (conf=${"%.2f".format(report.confidence)}); " +
                    "scores ${report.perAxisScores.entries.joinToString { "${it.key}=${"%.2f".format(it.value)}" }}"
            } else {
                "No bilateral symmetry detected (best=${report.perAxisScores.maxByOrNull { it.value }?.value ?: 0f})"
            }
            return ToolResult.ok(text, body)
        }
    }

    /**
     * Compute the symmetry report. Pure function — same input → same
     * output (modulo the seeded sampling).
     *
     * Returns per-axis match fractions plus the best axis if one
     * crosses [SYMMETRIC_THRESHOLD]. The plane offset is the bbox
     * center on the chosen axis (or 0 when no best axis).
     */
    fun analyze(
        bvh: MeshBvh,
        sampleCount: Int,
        tolFraction: Float,
    ): AiSessionState.SymmetryReport {
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cx = geom.bboxCenteredPreview.centerX
        val cy = geom.bboxCenteredPreview.centerY
        val cz = geom.bboxCenteredPreview.centerZ
        val diag = geom.bboxCenteredPreview.diagonal.coerceAtLeast(1e-6f)
        val tol = diag * tolFraction
        val tolSq = tol * tol

        // Deterministic uniform sampling: stride through the triangle
        // index space so the same model gets the same samples each call
        // (test reproducibility) without the cost of a full RNG.
        val stride = max(1, bvh.triCount / sampleCount)
        val effective = (bvh.triCount + stride - 1) / stride
        val sx = FloatArray(effective)
        val sy = FloatArray(effective)
        val sz = FloatArray(effective)
        var i = 0
        var t = 0
        while (i < effective && t < bvh.triCount) {
            val c = bvh.triangleCentroid(t)
            sx[i] = c.x; sy[i] = c.y; sz[i] = c.z
            i++
            t += stride
        }
        val n = i  // actual sample count after stride truncation

        val scoreX = scoreAxis(sx, sy, sz, n, axisIdx = 0, center = cx, tolSq = tolSq)
        val scoreY = scoreAxis(sx, sy, sz, n, axisIdx = 1, center = cy, tolSq = tolSq)
        val scoreZ = scoreAxis(sx, sy, sz, n, axisIdx = 2, center = cz, tolSq = tolSq)

        val scores = mapOf("x" to scoreX, "y" to scoreY, "z" to scoreZ)
        val (bestK, bestV) = scores.maxByOrNull { it.value }!!
        val bestAxis = if (bestV >= SYMMETRIC_THRESHOLD) bestK else null
        val planeOffset = when (bestAxis) {
            "x" -> cx
            "y" -> cy
            "z" -> cz
            else -> 0f
        }
        return AiSessionState.SymmetryReport(
            bestAxis = bestAxis,
            confidence = bestV,
            perAxisScores = scores,
            sampleCount = n,
            planeOffsetMm = planeOffset,
            createdAtMs = System.currentTimeMillis(),
        )
    }

    /** For axis [axisIdx] with mirror plane at [center], score how
     *  many of the [n] samples have a mirror-partner within [tolSq]
     *  squared distance. Brute force O(n²) — fine at n ≤ 1024. */
    private fun scoreAxis(
        sx: FloatArray, sy: FloatArray, sz: FloatArray, n: Int,
        axisIdx: Int, center: Float, tolSq: Float,
    ): Float {
        if (n == 0) return 0f
        var matched = 0
        for (i in 0 until n) {
            val mxx = if (axisIdx == 0) 2f * center - sx[i] else sx[i]
            val myy = if (axisIdx == 1) 2f * center - sy[i] else sy[i]
            val mzz = if (axisIdx == 2) 2f * center - sz[i] else sz[i]
            // Find nearest sample to (mxx, myy, mzz). The sample i
            // itself is included so a perfectly-on-plane triangle
            // matches itself — that's correct: the plane intersection
            // is part of the symmetry.
            var bestSq = Float.POSITIVE_INFINITY
            for (j in 0 until n) {
                val dx = sx[j] - mxx
                val dy = sy[j] - myy
                val dz = sz[j] - mzz
                val d2 = dx * dx + dy * dy + dz * dz
                if (d2 < bestSq) {
                    bestSq = d2
                    if (bestSq < tolSq) break  // early-out
                }
            }
            if (bestSq <= tolSq) matched++
        }
        return matched.toFloat() / n.toFloat()
    }
}
