package dev.orcaxr.app

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

// Mailbox flow consumed by MainActivity to drive load/slice flows from a
// test harness. The producer side (TestBroadcastReceiver) lives only in
// src/debug/, so in a release build nothing ever calls send() and the
// collector below is permanently idle.
//
// Lives in src/main/ rather than src/debug/ because MainActivity needs to
// be able to reference it under both build variants — making the collector
// itself debug-only would mean two MainActivity copies.
//
// SharedFlow with replay=1 + DROP_OLDEST so an early `am broadcast` that
// fires before the activity's collector subscribes still gets delivered
// when it does (single-slot mailbox semantics).
object TestController {
    sealed class Command {
        data class LoadFile(val path: String) : Command()
        /** Phase G: add a model to the bed alongside the existing
         *  list (does not replace). Used by automated multi-model
         *  tests to drive `runSliceMulti` without UI taps. */
        data class LoadFileAdd(val path: String) : Command()
        data object Slice : Command()
        // Force the filament palette to a specific list of "#RRGGBB"
        // colors. Used by automated tests that need to drive multi-color
        // slicing without going through the printer-selection UI.
        // The MainActivity collector translates this into a
        // filamentEntriesStore.set on the active printer (or first
        // printer if none active).
        data class SetPalette(val colors: List<String>) : Command()
        // Galaxy XR controller plan §6 Phase 1: drive
        // ControllerInputBus axis state from the host harness so
        // hardware-less tests can exercise layer scrubbing and
        // model nudge bindings end-to-end. [x] / [y] are signed
        // [-1, 1]; values outside that range are clamped at the
        // bus boundary.
        data class GamepadAxis(val x: Float, val y: Float) : Command()
        // Same plan / phase: synthesize a face-button press. [button]
        // is one of [ControllerButton] (A/B/X/Y). The bus emits a
        // single [ControllerButton] event regardless of how long the
        // virtual press is held — mirroring the Activity-side
        // `onKeyDown` path which only fires on the initial down (and
        // is gated on `repeatCount == 0`).
        data class GamepadButton(val button: ControllerButton) : Command()
        /** Phase J in-XR painting (`docs/PHASE_J_PAINTING_PLAN.md` §6
         *  J.5). Stamp [slot] (0..32) onto triangle [triangleIdx] of
         *  the model at [modelIndex] in `placedModels`. Bypasses the
         *  controller-laser path entirely — lets a workstation drive
         *  paint via `am broadcast` without paired gamepad hardware,
         *  validates the slice-time round-trip on Galaxy XR before
         *  the InteractableComponent listener gets hooked up. */
        data class Paint(
            val modelIndex: Int,
            val triangleIdx: Int,
            val slot: Int,
        ) : Command()
        /** Phase J: stamp many triangles at once (radius-paint
         *  simulation). Same shape as [Paint] but with an IntArray
         *  of triangle indices. [kind] picks which ByteArray on
         *  PlacedModel to write into:
         *    "color"   = paintFilamentIndex (default; slot 1..32)
         *    "support" = supportFlags (slot 1=ENFORCER, 2=BLOCKER) */
        data class PaintMany(
            val modelIndex: Int,
            val triangleIndices: IntArray,
            val slot: Int,
            val kind: String = "color",
        ) : Command() {
            override fun equals(other: Any?): Boolean {
                if (this === other) return true
                if (other !is PaintMany) return false
                return modelIndex == other.modelIndex &&
                    slot == other.slot &&
                    triangleIndices.contentEquals(other.triangleIndices)
            }
            override fun hashCode(): Int {
                var r = modelIndex
                r = 31 * r + triangleIndices.contentHashCode()
                r = 31 * r + slot
                return r
            }
        }
        /** Phase XR_OBJ_3 — fire libslic3r's auto-orient on the
         *  selected model. Equivalent to tapping the TransformPanel
         *  Auto-orient button; lets a workstation runtime-verify the
         *  JNI integration without putting on the headset. */
        data object AutoOrient : Command()
        /** Phase XR_OBJ_7 — fire libslic3r's arrange() on every
         *  plated model. Equivalent to tapping the radial Arrange
         *  button; lets a workstation runtime-verify the JNI
         *  integration. */
        data object Arrange : Command()
        /** Phase XR_OBJ_4 — attach an additional volume of [type] to
         *  the selected model (or first model if none selected).
         *  Equivalent to tapping "Add part" / "Add modifier" / etc.
         *  and picking [path] in the file picker. Lets a workstation
         *  runtime-verify the multi-volume slice path without UI
         *  taps. */
        data class AddPart(val path: String, val type: ModelVolumeType = ModelVolumeType.MODEL_PART) : Command()
        /** Phase XR_OBJ_5 — run a horizontal-plane cut on the
         *  selected model at [planeZmm]. Equivalent to typing the Z
         *  in CutPanel and tapping Apply. Defaults to the
         *  keep-both-halves + place-on-cut-face attribute set. */
        data class Cut(val planeZmm: Float) : Command()
        /** Phase XR_OBJ_6 — boolean op between the first two plated
         *  models. [op]: 0=Union, 1=Difference, 2=Intersection.
         *  Class name carefully avoids `Boolean` (shadows kotlin's). */
        data class BoolOp(val op: Int) : Command()
        /** Phase XR_OBJ_6 — split the selected (or first) model
         *  into per-component PlacedModels via libslic3r. */
        data object Split : Command()
        /** Phase XR_OBJ_8 — linear clone pattern of the selected
         *  model: [count] copies along [axis] ('x' or 'y') with
         *  [spacingMm] between footprints. */
        data class ClonePattern(val count: Int, val spacingMm: Float, val axis: Char) : Command()
        /** Phase XR_OBJ_4 (final) — set a single per-object config
         *  override on the selected (or first) model. Empty value
         *  removes the key. Lets a workstation runtime-verify the
         *  Object Settings JNI apply without UI. */
        data class SetObjectConfig(val key: String, val value: String) : Command()
    }

    private val _commands = MutableSharedFlow<Command>(
        replay = 1,
        extraBufferCapacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val commands: Flow<Command> = _commands.asSharedFlow()

    fun send(cmd: Command) {
        _commands.tryEmit(cmd)
    }
}
