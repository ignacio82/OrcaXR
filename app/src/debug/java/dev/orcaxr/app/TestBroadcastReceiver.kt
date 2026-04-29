package dev.orcaxr.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

// DEBUG-ONLY end-to-end test surface.
//
// Lives only in app/src/debug/. AGP excludes the entire src/debug/ source set
// from release builds, so this class doesn't even compile into a release APK
// — and the manifest entry that exports it is in
// src/debug/AndroidManifest.xml, which AGP only merges for debug variants.
// Two layers of "release-safe": the symbol isn't there AND the export isn't
// declared. Any change that moves either of these into src/main/ would ship
// a wide-open remote-control hatch to end users — DO NOT do that.
//
// What it does: lets a host workstation drive OrcaXR via `adb shell am
// broadcast` so an automated harness (or an AI assistant in a /loop) can
// load a 3MF and tap Slice without a human in the headset. Commands are
// pushed onto TestController.commands (which lives in src/main/ so
// MainActivity can collect from it under both build variants); the
// collector in MainActivity invokes the same onFileSelected / runSlice
// handlers the UI does — no parallel state path.
//
// Usage from a workstation:
//   adb shell am broadcast \
//     -a dev.orcaxr.app.test.LOAD_3MF \
//     --es path "/storage/emulated/0/Download/Quick Share/dragon.3mf" \
//     -p dev.orcaxr.app
//
//   adb shell am broadcast \
//     -a dev.orcaxr.app.test.SLICE \
//     -p dev.orcaxr.app
//
// `-p dev.orcaxr.app` restricts the broadcast to OrcaXR (otherwise Android 14+
// blocks unrestricted broadcasts to background apps).

class TestBroadcastReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Belt-and-suspenders: even though the manifest entry is debug-only,
        // double-check at runtime so a future src/main/ leak still no-ops.
        if (!BuildConfig.DEBUG) {
            Log.w(TAG, "fired in non-debug build — ignoring")
            return
        }
        when (intent.action) {
            ACTION_LOAD -> {
                val path = intent.getStringExtra("path")
                if (path.isNullOrBlank()) {
                    Log.e(TAG, "LOAD_3MF missing 'path' extra")
                    return
                }
                Log.i(TAG, "LOAD_3MF $path")
                TestController.send(TestController.Command.LoadFile(path))
            }
            ACTION_LOAD_ADD -> {
                val path = intent.getStringExtra("path")
                if (path.isNullOrBlank()) {
                    Log.e(TAG, "LOAD_ADD missing 'path' extra")
                    return
                }
                Log.i(TAG, "LOAD_ADD $path")
                TestController.send(TestController.Command.LoadFileAdd(path))
            }
            ACTION_SLICE -> {
                Log.i(TAG, "SLICE")
                TestController.send(TestController.Command.Slice)
            }
            ACTION_SET_PALETTE -> {
                val csv = intent.getStringExtra("colors")
                if (csv.isNullOrBlank()) {
                    Log.e(TAG, "SET_PALETTE missing 'colors' extra (csv #RRGGBB,#RRGGBB,...)")
                    return
                }
                // Adb shell strips '#' (comment char) from --es values. Re-add
                // it so libslic3r's filament_colour parser accepts each entry —
                // unhashed strings are silently dropped, collapsing the palette
                // to a single default and breaking MMU segmentation.
                val colors = csv.split(",")
                    .map { it.trim() }
                    .filter { it.isNotBlank() }
                    .map { if (it.startsWith("#")) it else "#$it" }
                if (colors.isEmpty()) {
                    Log.e(TAG, "SET_PALETTE: no colors parsed from '$csv'")
                    return
                }
                Log.i(TAG, "SET_PALETTE ${colors.size} colors: $colors")
                TestController.send(TestController.Command.SetPalette(colors))
            }
            ACTION_GAMEPAD_AXIS -> {
                val x = intent.getFloatExtra("x", Float.NaN)
                val y = intent.getFloatExtra("y", Float.NaN)
                if (x.isNaN() || y.isNaN()) {
                    Log.e(TAG, "GAMEPAD_AXIS missing 'x' / 'y' float extras")
                    return
                }
                Log.i(TAG, "GAMEPAD_AXIS x=$x y=$y")
                TestController.send(TestController.Command.GamepadAxis(x, y))
            }
            ACTION_GAMEPAD_BUTTON -> {
                val name = intent.getStringExtra("button")?.uppercase()
                val button = when (name) {
                    "A" -> ControllerButton.A
                    "B" -> ControllerButton.B
                    "X" -> ControllerButton.X
                    "Y" -> ControllerButton.Y
                    else -> {
                        Log.e(TAG, "GAMEPAD_BUTTON: 'button' extra must be A/B/X/Y, got '$name'")
                        return
                    }
                }
                Log.i(TAG, "GAMEPAD_BUTTON $button")
                TestController.send(TestController.Command.GamepadButton(button))
            }
            ACTION_PAINT -> {
                val model = intent.getIntExtra("model", 0)
                val tri = intent.getIntExtra("tri", -1)
                val slot = intent.getIntExtra("slot", -1)
                if (tri < 0 || slot < 0) {
                    Log.e(TAG, "PAINT missing 'tri' / 'slot' int extras (model defaults to 0)")
                    return
                }
                Log.i(TAG, "PAINT model=$model tri=$tri slot=$slot")
                TestController.send(TestController.Command.Paint(model, tri, slot))
            }
            ACTION_PAINT_MANY -> {
                val model = intent.getIntExtra("model", 0)
                val slot = intent.getIntExtra("slot", -1)
                // Triangles passed as a comma-separated string under "tris" so
                // adb shell can produce the values without IntArray heroics.
                val csv = intent.getStringExtra("tris")
                if (csv.isNullOrBlank() || slot < 0) {
                    Log.e(TAG, "PAINT_MANY needs 'tris' (csv int) and 'slot' (int)")
                    return
                }
                val tris = csv.split(",")
                    .mapNotNull { it.trim().toIntOrNull() }
                    .toIntArray()
                if (tris.isEmpty()) {
                    Log.e(TAG, "PAINT_MANY: no integers parsed from '$csv'")
                    return
                }
                val kind = intent.getStringExtra("kind")?.trim()?.lowercase() ?: "color"
                Log.i(TAG, "PAINT_MANY model=$model slot=$slot count=${tris.size} kind=$kind")
                TestController.send(TestController.Command.PaintMany(model, tris, slot, kind))
            }
            ACTION_AUTO_ORIENT -> {
                Log.i(TAG, "AUTO_ORIENT")
                TestController.send(TestController.Command.AutoOrient)
            }
            ACTION_ARRANGE -> {
                Log.i(TAG, "ARRANGE")
                TestController.send(TestController.Command.Arrange)
            }
            ACTION_ADD_PART -> {
                val path = intent.getStringExtra("path")
                if (path.isNullOrBlank()) {
                    Log.e(TAG, "ADD_PART missing 'path' extra")
                    return
                }
                // Optional type override: part / modifier / negative /
                // enforcer / blocker. Defaults to MODEL_PART.
                val typeStr = intent.getStringExtra("type")?.trim()?.lowercase()
                val type = when (typeStr) {
                    null, "", "part", "model_part" -> ModelVolumeType.MODEL_PART
                    "modifier", "parameter_modifier" -> ModelVolumeType.PARAMETER_MODIFIER
                    "negative", "negative_volume" -> ModelVolumeType.NEGATIVE_VOLUME
                    "enforcer", "support_enforcer" -> ModelVolumeType.SUPPORT_ENFORCER
                    "blocker", "support_blocker" -> ModelVolumeType.SUPPORT_BLOCKER
                    else -> {
                        Log.e(TAG, "ADD_PART unknown type '$typeStr', defaulting to MODEL_PART")
                        ModelVolumeType.MODEL_PART
                    }
                }
                Log.i(TAG, "ADD_PART path=$path type=$type")
                TestController.send(TestController.Command.AddPart(path, type))
            }
            ACTION_CUT -> {
                val z = intent.getFloatExtra("z", Float.NaN)
                if (z.isNaN()) {
                    Log.e(TAG, "CUT missing 'z' float extra")
                    return
                }
                Log.i(TAG, "CUT z=$z")
                TestController.send(TestController.Command.Cut(z))
            }
            ACTION_BOOLEAN -> {
                val opStr = intent.getStringExtra("op")?.trim()?.lowercase()
                val op = when (opStr) {
                    null, "", "union", "u" -> 0
                    "difference", "diff", "minus", "d" -> 1
                    "intersection", "isect", "i" -> 2
                    else -> {
                        Log.e(TAG, "BOOLEAN unknown op '$opStr', defaulting to UNION")
                        0
                    }
                }
                Log.i(TAG, "BOOLEAN op=$op ($opStr)")
                TestController.send(TestController.Command.BoolOp(op))
            }
            ACTION_SPLIT -> {
                Log.i(TAG, "SPLIT")
                TestController.send(TestController.Command.Split)
            }
            ACTION_CLONE_PATTERN -> {
                val count = intent.getIntExtra("count", 0)
                val spacing = intent.getFloatExtra("spacing", Float.NaN)
                val axis = (intent.getStringExtra("axis") ?: "x").firstOrNull() ?: 'x'
                if (count <= 0 || spacing.isNaN()) {
                    Log.e(TAG, "CLONE_PATTERN missing 'count' (int) or 'spacing' (float)")
                    return
                }
                Log.i(TAG, "CLONE_PATTERN count=$count spacing=$spacing axis=$axis")
                TestController.send(TestController.Command.ClonePattern(count, spacing, axis))
            }
            ACTION_SET_OBJECT_CONFIG -> {
                val key = intent.getStringExtra("key")
                val value = intent.getStringExtra("value") ?: ""
                if (key.isNullOrBlank()) {
                    Log.e(TAG, "SET_OBJECT_CONFIG missing 'key'")
                    return
                }
                Log.i(TAG, "SET_OBJECT_CONFIG $key=$value")
                TestController.send(TestController.Command.SetObjectConfig(key, value))
            }
            else -> Log.w(TAG, "unknown action ${intent.action}")
        }
    }

    companion object {
        private const val TAG = "OrcaXR/test"
        const val ACTION_LOAD = "dev.orcaxr.app.test.LOAD_3MF"
        /** Phase G — append a model to the plate without replacing. */
        const val ACTION_LOAD_ADD = "dev.orcaxr.app.test.LOAD_ADD"
        const val ACTION_SLICE = "dev.orcaxr.app.test.SLICE"
        const val ACTION_SET_PALETTE = "dev.orcaxr.app.test.SET_PALETTE"
        /** Galaxy XR controller §6 Phase 1: synthesize stick deflection. */
        const val ACTION_GAMEPAD_AXIS = "dev.orcaxr.app.test.GAMEPAD_AXIS"
        /** Galaxy XR controller §6 Phase 1: synthesize face-button press. */
        const val ACTION_GAMEPAD_BUTTON = "dev.orcaxr.app.test.GAMEPAD_BUTTON"
        /** Phase J §6 J.5: stamp one triangle of a plated model with a
         *  filament slot. Bypasses the laser-paint pipeline; lets the
         *  slice-time round-trip be validated from a workstation. */
        const val ACTION_PAINT = "dev.orcaxr.app.test.PAINT"
        /** Phase J §6 J.5: stamp many triangles at once (CSV via
         *  `--es tris "1,2,3"`). Simulates a brush-radius BFS expansion
         *  without driving the actual BVH adjacency. */
        const val ACTION_PAINT_MANY = "dev.orcaxr.app.test.PAINT_MANY"
        /** Phase XR_OBJ_3 — fire libslic3r's auto-orient on the selected
         *  model. Validates the orient(ModelObject*) JNI from a
         *  workstation without putting on the headset. */
        const val ACTION_AUTO_ORIENT = "dev.orcaxr.app.test.AUTO_ORIENT"
        /** Phase XR_OBJ_7 — fire libslic3r's arrange() over every
         *  plated model. Validates the nativeArrange JNI from a
         *  workstation. */
        const val ACTION_ARRANGE = "dev.orcaxr.app.test.ARRANGE"
        /** Phase XR_OBJ_4 — attach a MODEL_PART volume to the
         *  selected model. `--es path "/sdcard/...stl"`. */
        const val ACTION_ADD_PART = "dev.orcaxr.app.test.ADD_PART"
        /** Phase XR_OBJ_5 — cut the selected model at z=Z mm.
         *  `--ef z 12.5` selects the cut height. */
        const val ACTION_CUT = "dev.orcaxr.app.test.CUT"
        /** Phase XR_OBJ_6 — boolean op between first two plated
         *  models. `--es op union|difference|intersection`
         *  (defaults to union). */
        const val ACTION_BOOLEAN = "dev.orcaxr.app.test.BOOLEAN"
        /** Phase XR_OBJ_6 — split the selected model into per-
         *  component PlacedModels. */
        const val ACTION_SPLIT = "dev.orcaxr.app.test.SPLIT"
        /** Phase XR_OBJ_8 — linear clone pattern. `--ei count 4
         *  --ef spacing 5 --es axis x`. */
        const val ACTION_CLONE_PATTERN = "dev.orcaxr.app.test.CLONE_PATTERN"
        /** Phase XR_OBJ_4 (final) — set a per-object config override.
         *  `--es key layer_height --es value 0.4`. Empty value
         *  clears. */
        const val ACTION_SET_OBJECT_CONFIG = "dev.orcaxr.app.test.SET_OBJECT_CONFIG"
    }
}
