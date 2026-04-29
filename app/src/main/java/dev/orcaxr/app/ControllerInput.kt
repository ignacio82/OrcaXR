package dev.orcaxr.app

import androidx.compose.runtime.compositionLocalOf
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sign

enum class ControllerButton { A, B, X, Y }

/**
 * Activity-scoped event sink for Galaxy XR (or any Android gamepad)
 * controller input. Two flow shapes, picked deliberately:
 *
 *  - [buttons] is a [SharedFlow] with replay=0 — late subscribers do
 *    NOT see historical presses. Re-firing a press into a freshly-
 *    composed consumer would be wrong for a discrete event.
 *  - [leftStickX] / [leftStickY] are [StateFlow]s — coalesced snapshot
 *    of the current axis value. Galaxy XR sticks fire at vsync (~72 Hz);
 *    a SharedFlow would flood Compose recomposition. Consumers should
 *    drive a coroutine ticker off `.value`, not collect every emission.
 *
 * Right-stick events are folded into the same `leftStick*` axes today.
 * Per the plan §1, v1 treats both sticks as equivalent; per-hand
 * differentiation is a v2 nicety.
 */
class ControllerInputBus {
    private val _buttons = MutableSharedFlow<ControllerButton>(
        replay = 0,
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val buttons: SharedFlow<ControllerButton> = _buttons.asSharedFlow()

    private val _leftStickX = MutableStateFlow(0f)
    val leftStickX: StateFlow<Float> = _leftStickX.asStateFlow()

    private val _leftStickY = MutableStateFlow(0f)
    val leftStickY: StateFlow<Float> = _leftStickY.asStateFlow()

    fun emitButton(b: ControllerButton) {
        _buttons.tryEmit(b)
    }

    fun setLeftStick(x: Float, y: Float) {
        _leftStickX.value = x.coerceIn(-1f, 1f)
        _leftStickY.value = y.coerceIn(-1f, 1f)
    }

    /** Reset axis snapshots to 0. Call on [android.app.Activity.onPause]
     *  so a stick stuck deflected when the user removes the headset
     *  doesn't keep scrubbing when they put it back on. SharedFlow
     *  doesn't need a reset — replay=0. */
    fun resetAxes() {
        _leftStickX.value = 0f
        _leftStickY.value = 0f
    }
}

/**
 * CompositionLocal used by Compose consumers (layer scrubber, model
 * nudge, etc.) to read controller state without threading the bus
 * through every panel. Owned by [MainActivity], provided once in
 * `setContent`. Default is an inert bus so previews / tests that
 * don't supply one render without crashing.
 */
val LocalControllerInput = compositionLocalOf { ControllerInputBus() }

/**
 * Velocity curve for thumbstick layer scrubbing (plan §3.5).
 *
 * Returns layers per second, signed. The deadband + exponent shape
 * gives near-zero rate at low deflection (precise single-layer
 * stepping when the stick is barely pushed) ramping to [maxLps] at
 * the rim. Linear feels too touchy near zero.
 *
 * @param v       raw stick value in [-1, 1].
 * @param flat    platform-reported deadzone width
 *                (`MotionRange.flat`); below this the result is 0.
 * @param maxLps  layers/second at full deflection. Default 40 lps
 *                clears a 400-layer model in ~10 s.
 * @param exponent applied to the post-deadband magnitude. 2.5 gives
 *                a comfortable ramp; tunable.
 */
fun scrubRate(
    v: Float,
    flat: Float = 0.1f,
    maxLps: Int = 40,
    exponent: Float = 2.5f,
): Float {
    val mag = abs(v)
    if (mag <= flat) return 0f
    val flatClamped = flat.coerceIn(0f, 0.95f)
    val normalized = ((mag - flatClamped) / (1f - flatClamped)).coerceIn(0f, 1f)
    val curved = normalized.toDouble().pow(exponent.toDouble()).toFloat()
    return sign(v) * curved * maxLps.toFloat()
}

/**
 * Compute the next `maxLayer` value for a single tick of the scrub
 * loop. Pure, so the boundary behavior (null → step-in, step-past-top
 * → null) is unit-testable without driving a Compose runtime.
 *
 * @param current     current `maxLayer` (`null` = "show all layers").
 * @param rate        layers/sec from [scrubRate]; sign drives direction.
 * @param topLayer    last valid layer index (zero-based).
 * @return next maxLayer value, or null to mean "show all".
 */
fun nextScrubLayer(current: Int?, rate: Float, topLayer: Int): Int? {
    if (rate == 0f) return current
    if (topLayer <= 0) return current
    if (current == null) {
        // From "show all": pushing down drops to topLayer-1 to make
        // the scrub visibly start; pushing up is a no-op (already
        // showing everything).
        return if (rate < 0f) (topLayer - 1).coerceAtLeast(0) else null
    }
    val step = if (rate > 0f) 1 else -1
    val candidate = current + step
    if (candidate >= topLayer) return null
    return candidate.coerceAtLeast(0)
}

/**
 * Stick-X jump variant. Same null-boundary semantics as
 * [nextScrubLayer] but a fixed step magnitude ([jumpSize] layers
 * per click).
 */
fun nextJumpLayer(current: Int?, signedDirection: Int, topLayer: Int, jumpSize: Int = 10): Int? {
    if (signedDirection == 0 || topLayer <= 0) return current
    val cur = current ?: topLayer
    val candidate = cur + (if (signedDirection > 0) jumpSize else -jumpSize)
    if (candidate >= topLayer) return null
    return candidate.coerceAtLeast(0)
}

/**
 * Step a 90°-snapped rotation by one quarter turn in [signedDirection].
 * Result is normalized to `[0, 360)` so callers can store it as an
 * `Int` and round-trip through [PlacedModel.rotZDeg]'s footprint /
 * draw-order assumptions.
 */
fun nextRotationDeg(current: Int, signedDirection: Int): Int {
    if (signedDirection == 0) return ((current % 360) + 360) % 360
    val step = if (signedDirection > 0) 90 else -90
    return (((current + step) % 360) + 360) % 360
}
