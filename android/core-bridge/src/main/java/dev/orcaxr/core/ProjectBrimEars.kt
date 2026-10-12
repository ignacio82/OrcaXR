package dev.orcaxr.core

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.abs

/** One placed brim ear: where it sits in its object's own millimetres, and its front radius. */
data class BrimEarPoint(val positionMm: List<Double>, val headFrontRadiusMm: Double)

/**
 * What the Workspace's brim-ear tool shows (the browser's
 * `OrcaWorkspace.getBrimEarSnapshot`, without the host's own radius and
 * tool state): the one object ears go on — none unless the selection's
 * model parts belong to exactly one object (`brimEarTargetObject`) — its
 * placed ears in order, the indices of those that reach neither the part nor
 * an ear that does, and the base a placed ear sits on (absent without model
 * geometry).
 */
data class BrimEarState(
    val objectId: String? = null,
    val ears: List<BrimEarPoint> = emptyList(),
    val stranded: List<Int> = emptyList(),
    val baseZMm: Double? = null,
)

/** How "Place brim ears automatically" (`brim_ears_auto`) ended. */
sealed interface BrimEarAuto {
    /** No single object to place on: the browser's "Select one model part before placing brim ears on it." */
    data object NoTarget : BrimEarAuto
    /** Its model parts give no layer to read: "That part has no geometry to read corners from." */
    data object NoGeometry : BrimEarAuto
    /** No corner would lift, and the detector's [reason] ("No ears placed. …"). */
    data class NoEars(val reason: String?) : BrimEarAuto
    /** [count] ears placed, one undo entry. */
    data class Placed(val count: Int) : BrimEarAuto
}

/** How "Clear brim ears" (`brim_ears_clear`) ended. */
enum class BrimEarClear { NO_TARGET, NO_EARS, CLEARED }

/**
 * The brim-ear tool's frames and words as the browser's workspace and panel
 * compute them (`OrcaWorkspace`'s brim-ear tool, `BrimEarsPanel`), for the
 * words the browser writes without a message catalogue entry. Its catalogue
 * messages are the app's string resources.
 */
object ProjectBrimEars {
    /** The radius a new tool starts with (`brimEarRadiusMm`), and the pinned gizmo's bounds the commands enforce. */
    const val DEFAULT_RADIUS_MM = 5.0
    const val MIN_RADIUS_MM = 0.1
    const val MAX_RADIUS_MM = 20.0
    /** The automatic placement's detector settings (`DEFAULT_BRIM_EAR_DETECTION`, the radius aside). */
    const val MAX_ANGLE_DEG = 125.0
    const val DETECTION_RADIUS_MM = 1.0

    /**
     * Where a tap met part [volume] — [point] in the part's own millimetres —
     * in its object's own frame, where ears live: the part's transform
     * composed and applied as three.js composes and applies it. The browser
     * reaches the same point through the instance's inverse (`worldToLocal`);
     * the two agree to rounding.
     */
    fun objectPoint(volume: ProjectIntents.Transform, point: List<Double>): List<Double> {
        require(point.size == 3) { "A point has three coordinates" }
        val m = ProjectMeasures.compose(volume)
        val (x, y, z) = point
        val w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15])
        return listOf(
            (m[0] * x + m[4] * y + m[8] * z + m[12]) * w,
            (m[1] * x + m[5] * y + m[9] * z + m[13]) * w,
            (m[2] * x + m[6] * y + m[10] * z + m[14]) * w,
        )
    }

    /** Whether the radius the panel hands over is one an ear may have (`setBrimEarRadius`): finite and within the bounds. */
    fun radiusAllowed(radiusMm: Double): Boolean = radiusMm.isFinite() && radiusMm >= MIN_RADIUS_MM && radiusMm <= MAX_RADIUS_MM

    // ---- The workspace's statuses that no message catalogue entry carries ----

    /** A refused radius. */
    val RADIUS_BOUNDS = "A brim ear radius must be between ${JsText.number(MIN_RADIUS_MM)} and ${JsText.number(MAX_RADIUS_MM)} mm."

    /** An ear placed with a tap. */
    fun placed(radiusMm: Double) = "Placed a ${JsText.number(radiusMm)} mm brim ear."

    /** A tap's or a removal's failure. */
    fun failed(message: String?) = "Brim ear: ${message.orEmpty()}"

    /** No corner would lift. */
    fun noEars(reason: String?) = "No ears placed. ${reason.orEmpty()}".trim()

    /** Ears placed on every corner that would lift. */
    fun autoPlaced(count: Int) =
        "Placed $count brim ear${if (count == 1) "" else "s"} on the corners that would lift; one undo removes them all."

    /** The panel's hint: what a tap does, or why there is nothing to place on. */
    fun hint(hasObject: Boolean) =
        if (hasObject) "Click the model to place an ear; each placement undoes on its own." else "Select one model part to place brim ears on it."

    /** The panel's warning about [stranded] ears, none without any. */
    fun warning(stranded: Int): String? = when {
        stranded <= 0 -> null
        stranded == 1 -> "One ear does not reach the part and will hold nothing down."
        else -> "$stranded ears do not reach the part and will hold nothing down."
    }

    /** One placed ear as the panel lists it: its position, its diameter, and whether it reaches nothing. */
    fun row(ear: BrimEarPoint, stranded: Boolean): String =
        "${ear.positionMm.joinToString(", ") { fixed(it) }} mm · ⌀${fixed(ear.headFrontRadiusMm * 2)} mm" +
            if (stranded) " · does not reach the part" else ""

    /**
     * `Number(value.toFixed(2))` as JavaScript writes it: the exact binary
     * value rounded half up to two decimals, without trailing zeros (and
     * never "-0").
     */
    fun fixed(value: Double): String {
        if (!value.isFinite() || abs(value) >= 1e21) return JsText.number(value)
        val rounded = BigDecimal(value).setScale(2, RoundingMode.HALF_UP)
        if (rounded.signum() == 0) return "0"
        if (abs(value) < 1e12) return rounded.stripTrailingZeros().toPlainString()
        return JsText.number(rounded.toDouble())
    }
}
