package dev.orcaxr.core

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sqrt

// ---- Split -------------------------------------------------------------------------------

/**
 * What "Split to Objects" will replace, shown before it splits (the
 * browser's `CanonicalSplitToObjectsConfirmation`): the object's name, how
 * it splits, its volumes and triangles and every instance the split
 * replaces. It is bound to the state and selection it was read from: once
 * either changes, [ProjectWorkspace.splitSelectedToObjects] refuses it as
 * stale.
 */
class SplitConfirmation internal constructor(
    val objectName: String,
    val strategy: SplitStrategy,
    val volumeCount: Int,
    val triangleCount: Long,
    val affectedInstanceIds: List<String>,
    internal val revision: Long,
    internal val hash: String,
    internal val selection: ProjectSelectionView,
    internal val plateId: String,
    internal val objectId: String,
    internal val primaryInstanceId: String,
)

/** A Split to Objects that committed: the objects and instances it made, in the browser's order. */
data class SplitToObjectsResult(val objectIds: List<String>, val instanceIds: List<String>)

/** A Split to Parts that committed: how many parts the object now has, and its name. */
data class SplitToPartsResult(val partCount: Int, val objectName: String)

// ---- Simplify ----------------------------------------------------------------------------

/**
 * The Simplify panel's controls (`SimplifyConfiguration`): decimate by
 * triangle count ([useCount], removing [decimateRatio] percent) or by the
 * quadric error allowed ([maxError]).
 */
data class SimplifyConfiguration(val useCount: Boolean, val decimateRatio: Double, val maxError: Double) {
    companion object {
        /** The panel's starting values (`main.ts`'s `requested`). */
        val DEFAULT = SimplifyConfiguration(useCount = true, decimateRatio = 50.0, maxError = 1.0)
    }
}

/**
 * One part's decimation, computed and shown but not installed (the
 * browser's `PreparedSimplify`): the volume and the mesh it had then, and
 * the result — the very payload Apply installs, its bytes paged by [mesh]
 * (float32 positions, then uint32 indices).
 */
class SimplifyPart internal constructor(
    val volumeId: String,
    val beforeTriangles: Long,
    val afterTriangles: Long,
    val vertexCount: Long,
    val stoppedOnError: Boolean,
    internal val digest: String,
    internal val byteLength: Long,
    internal val assetId: String,
    internal val topologyRevision: Double,
    internal val revision: Long,
    internal var run: ProjectVolumeSimplify?,
) {
    /** The decimated mesh's payload; null once the preview is gone. */
    fun mesh(): ByteArray? = synchronized(this) {
        val held = run ?: return null
        val bytes = ByteArray(byteLength.toInt())
        var start = 0L
        while (start < byteLength) {
            val page = held.mesh(start, minOf(ProjectVolumeSimplify.MAX_PAGE, byteLength - start))
            page.copyInto(bytes, start.toInt())
            start += page.size
        }
        bytes
    }

    internal fun release() = synchronized(this) {
        run?.close()
        run = null
    }
}

/** A simplify preview: every part decimated with [configuration], none installed yet. */
class SimplifyPreview internal constructor(val configuration: SimplifyConfiguration, val parts: List<SimplifyPart>) {
    val beforeTriangles: Long get() = parts.sumOf { it.beforeTriangles }
    val afterTriangles: Long get() = parts.sumOf { it.afterTriangles }
    /** Some part stopped at the error limit before reaching the target. */
    val stoppedOnError: Boolean get() = parts.any { it.stoppedOnError }
}

/** What a Preview did. */
sealed interface SimplifyPreviewResult {
    /** Nothing selected to simplify ("Select a model to simplify."). */
    data object NothingSelected : SimplifyPreviewResult
    /** No part would lose a triangle, by count or by error. */
    data class NothingToSimplify(val byCount: Boolean) : SimplifyPreviewResult
    data class Previewing(val preview: SimplifyPreview) : SimplifyPreviewResult
}

/** What installing a preview, or simplifying at once, did: parts changed and the triangles before and after. */
data class SimplifyApplied(val parts: Int, val beforeTriangles: Long, val afterTriangles: Long)

/**
 * The statuses the browser's workspace composes for its model tools from
 * templates its message catalogue does not carry
 * (`CanonicalSplitToObjectsFlow`, `OrcaWorkspace`, `SimplifyPanel`): the
 * same words here, numbers written as JavaScript writes integers.
 */
object ModelToolStatus {
    /** `errorMessage`: line breaks and tabs as one space, trimmed; nothing left is "Unknown error". */
    fun reason(message: String?): String = ProjectNames.trim((message ?: "").replace(Regex("[\r\n\t]+"), " ")).ifEmpty { "Unknown error" }
    fun splitUnavailable(message: String?) = "Split to Objects unavailable: ${reason(message)}"
    /** The confirmation's question (main.ts's `window.confirm`), its first paragraph. */
    fun splitQuestion(objectName: String) = "Split “$objectName” into separate objects?"
    /** The confirmation's detail: [triangles] is the triangle count as the host's locale writes it (`toLocaleString()`). */
    fun splitDetail(promote: Boolean, volumeCount: Int, triangles: String, instances: Int) =
        (if (promote) "$volumeCount existing volumes will be promoted" else "$triangles triangles will be separated by connected body") +
            " across all $instances instance${if (instances == 1) "" else "s"}.\n\nThe original object will be replaced in one undoable edit."
    const val SPLIT_CANCELLED = "Split to Objects cancelled; the project was not changed."
    fun splitDone(objectName: String, objects: Int, instances: Int) =
        "Split $objectName into $objects objects across all $instances instance${if (instances == 1) "" else "s"} in one undoable edit."
    fun splitFailed(message: String?) = "Split to Objects failed: ${reason(message)}. The project was not changed."
    fun simplifyFailed(message: String?) = "Simplify failed: ${message.orEmpty()}"
    const val NOTHING_WITHIN_ERROR = "Nothing to simplify within that error limit."
    fun simplifyPreview(before: Long, after: Long) = "Simplify preview: $before → $after triangles. Apply keeps it; cancel restores the model."
    fun simplified(parts: Int, before: Long, after: Long) =
        "Simplified $parts part(s): $before → $after triangles. Painting was reset; undo restores both."

    /** The Simplify panel's status while it previews: the share removed rounded as `Math.round` rounds. */
    fun previewing(parts: Int, before: Long, after: Long, stoppedOnError: Boolean): String {
        val share = if (before > 0) jsRound((before - after).toDouble() / before * 100).toLong() else 0L
        return "Previewing $parts part(s): $before → $after triangles ($share% removed)." +
            if (stoppedOnError) " Stopped at the error limit before reaching the target." else ""
    }

    fun measurePicked(summary: String) = "Measure: picked $summary."
    fun measureFailed(message: String?) = "Measure failed: ${message.orEmpty()}"

    /** `Math.round`: the nearest integer, a half toward +∞. */
    fun jsRound(value: Double): Double {
        val floor = kotlin.math.floor(value)
        return if (value - floor >= 0.5) floor + 1 else floor
    }
}

// ---- Measure -----------------------------------------------------------------------------

/** One picked feature in printer millimetres, with the workspace's one-line description and the instance it was picked on. */
data class MeasurePick(val feature: ProjectIntents.SurfaceFeature, val summary: String, val instanceId: String) {
    /** A circle's diameter (mm), as the readout lists it. */
    val diameterMm: Double? get() = (feature as? ProjectIntents.SurfaceFeature.Circle)?.value?.radius?.let { it * 2 }
}

/** What a Measure pick found: a feature, or a hole an uneven scale distorts, which the browser reports in [Uneven.message] alone. */
sealed interface MeasurePickResult {
    data class Picked(val pick: MeasurePick) : MeasurePickResult
    data class Uneven(val message: String) : MeasurePickResult
}

/** What the Measure panel says to do next (`getMeasureSnapshot`'s hint). */
enum class MeasureHint { FIRST, SECOND, NEXT, CHOOSE_TOOL }

/** A readout row's label in the Measure panel. */
enum class MeasureRowLabel { DISTANCE, DISTANCE_INFINITE, XYZ, ANGLE, DIAMETER }

data class MeasureRow(val label: MeasureRowLabel, val value: String)

/** The line the workspace draws between the two points it measured between, with the distance beside it. */
data class MeasureAnnotation(val from: List<Double>, val to: List<Double>, val label: String)

/** The Measure panel's state: the picks, its readout rows, its hint and the drawn annotation. */
data class MeasureReadout(
    val picks: List<MeasurePick>,
    val rows: List<MeasureRow>,
    val hint: MeasureHint,
    /** Two circles in non-parallel planes: the engine's solver, which this build does not carry, is needed. */
    val unsupported: Boolean,
    val annotation: MeasureAnnotation?,
)

/** Numbers as JavaScript writes them (`Number::toString`), for the browser's words and fields. */
object JsText {
    /** [value]'s shortest round-trip digits, written as JavaScript writes them. */
    fun number(value: Double): String {
        if (value.isNaN()) return "NaN"
        if (value.isInfinite()) return if (value > 0) "Infinity" else "-Infinity"
        if (value == 0.0) return "0"
        val decimal = BigDecimal(abs(value).toString()).stripTrailingZeros()
        val digits = decimal.unscaledValue().toString()
        val k = digits.length
        val n = k - decimal.scale()
        val sign = if (value < 0) "-" else ""
        return sign + when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val exponent = n - 1
                digits.substring(0, 1) + (if (k > 1) "." + digits.substring(1) else "") + "e" + (if (exponent > 0) "+" else "-") + abs(exponent)
            }
        }
    }
}

/**
 * The Measure tool's readout and frames, as the browser's workspace and
 * panel compute them (`OrcaWorkspace.getMeasureSnapshot`, `MeasurePanel`),
 * over the shared core's features and measurement.
 */
object ProjectMeasures {
    /**
     * `Number(value.toFixed(3))` as JavaScript writes it: the exact binary
     * value rounded half up to three decimals, without trailing zeros (and
     * never "-0"). A decimal of at most fifteen significant digits is its
     * own shortest round trip, so below 10¹² the rounded decimal is the text;
     * beyond, the nearest double's shortest digits are written.
     */
    fun format(value: Double): String {
        if (!value.isFinite() || abs(value) >= 1e21) return JsText.number(value)
        val fixed = BigDecimal(value).setScale(3, RoundingMode.HALF_UP)
        if (fixed.signum() == 0) return "0"
        if (abs(value) < 1e12) return fixed.stripTrailingZeros().toPlainString()
        return JsText.number(fixed.toDouble())
    }

    /**
     * Where a volume's mesh lies in printer millimetres (row-major 4 × 4):
     * its instance's transform after the volume's own, each `T · R · S` as
     * three.js composes it from the canonical transform (the quaternion
     * normalized by its reciprocal length, a zero one the identity) and
     * multiplied as three.js multiplies. The workspace reaches the same frame
     * through its scene root's inverse, which agrees to rounding.
     */
    fun placedTransform(instance: ProjectIntents.Transform, volume: ProjectIntents.Transform): List<Double> {
        val m = multiply(compose(instance), compose(volume))
        return listOf(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15])
    }

    /** `Matrix4.compose` (column-major) of a canonical transform. */
    private fun compose(transform: ProjectIntents.Transform): DoubleArray {
        var (x, y, z, w) = transform.rotation
        val length = sqrt(x * x + y * y + z * z + w * w)
        if (length == 0.0) {
            x = 0.0; y = 0.0; z = 0.0; w = 1.0
        } else {
            val inverse = 1 / length
            x *= inverse; y *= inverse; z *= inverse; w *= inverse
        }
        val (sx, sy, sz) = transform.scale
        val (px, py, pz) = transform.translationMm
        val x2 = x + x; val y2 = y + y; val z2 = z + z
        val xx = x * x2; val xy = x * y2; val xz = x * z2
        val yy = y * y2; val yz = y * z2; val zz = z * z2
        val wx = w * x2; val wy = w * y2; val wz = w * z2
        return doubleArrayOf(
            (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0,
            (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0.0,
            (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0.0,
            px, py, pz, 1.0,
        )
    }

    /** `Matrix4.multiplyMatrices(a, b)` (column-major), term for term. */
    private fun multiply(a: DoubleArray, b: DoubleArray): DoubleArray = DoubleArray(16) { index ->
        val column = index / 4
        val row = index % 4
        a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3]
    }

    /**
     * The panel's readout of [picks] (at most two) with the measurement of a
     * pair ([result]), while the tool is [active] or not: the distance — the
     * bounded feature's, else its line's or plane's — its X/Y/Z parts and the
     * angle, then every circle's diameter; the next step's hint; and the
     * annotation drawn between the measured points.
     */
    fun readout(active: Boolean, picks: List<MeasurePick>, result: ProjectIntents.MeasureResult?): MeasureReadout {
        val rows = ArrayList<MeasureRow>()
        var annotation: MeasureAnnotation? = null
        val measured = if (picks.size >= 2) result else null
        if (measured != null) {
            val strict = (measured.distanceStrict as? ProjectIntents.OptionalMeasureDistance.Value)?.value
            val distance = strict ?: (measured.distanceInfinite as? ProjectIntents.OptionalMeasureDistance.Value)?.value
            if (distance != null) {
                val text = "${format(distance.distance)} mm"
                rows += MeasureRow(if (strict != null) MeasureRowLabel.DISTANCE else MeasureRowLabel.DISTANCE_INFINITE, text)
                annotation = MeasureAnnotation(distance.from, distance.to, text)
            }
            (measured.distanceXyz as? ProjectIntents.OptionalVector.Value)?.value?.let { xyz ->
                rows += MeasureRow(MeasureRowLabel.XYZ, xyz.joinToString(" / ") { "${format(it)} mm" })
            }
            (measured.angle as? ProjectIntents.OptionalMeasureAngle.Value)?.value?.let { angle ->
                rows += MeasureRow(MeasureRowLabel.ANGLE, "${format(angle.angle * 180 / PI)}°")
            }
        }
        for (pick in picks) pick.diameterMm?.let { rows += MeasureRow(MeasureRowLabel.DIAMETER, "${format(it)} mm") }
        val hint = when {
            picks.size >= 2 -> MeasureHint.NEXT
            !active -> MeasureHint.CHOOSE_TOOL
            picks.isEmpty() -> MeasureHint.FIRST
            else -> MeasureHint.SECOND
        }
        return MeasureReadout(picks, rows, hint, measured?.unsupported == true, annotation)
    }
}
