package dev.orcaxr.app

import java.io.File

/**
 * Per-job toggles the user picks just before sending a slice to a
 * Moonraker printer. OrcaSlicer's send-to-printer dialog exposes
 * Timelapse / Auto Bed Leveling / Nozzle Offset / Use AMS, but all four
 * of those are Bambu-only (they ride Bambu's proprietary cloud/LAN
 * protocol). OrcaXR targets Klipper + Moonraker, so we translate the
 * idea into Klipper-native equivalents:
 *
 *  - [bedMeshCalibrate] → inject `BED_MESH_CALIBRATE` at the top of the
 *    g-code so it runs before the slicer's start script. Adds 30-90 s
 *    to the start of the print but compensates for bed thermal drift.
 *  - [timelapse] → inject `TIMELAPSE_TAKE_FRAME` after every layer-
 *    change marker the slicer already emits, plus a final
 *    `TIMELAPSE_RENDER` after the print finishes. Caller is expected to
 *    also POST `/machine/timelapse/settings {enabled: true}` so the
 *    moonraker-timelapse component actually renders the captured
 *    frames; if the component isn't installed the macros expand to
 *    no-op `M118` lines that don't crash Klipper.
 *
 * Default is "both off" — print-and-go behaves exactly like before.
 */
data class PrintOptions(
    val bedMeshCalibrate: Boolean = false,
    val timelapse: Boolean = false,
) {
    companion object {
        val Default = PrintOptions()
    }
}

/**
 * Read [source] line-by-line and write a sibling g-code file with the
 * [options]-driven injections applied. Returns the new file (suffixed
 * `.orcaxr.gcode`) when any injection happened, or [source] verbatim
 * when [options] is fully off (avoids an unnecessary copy on the
 * happy path).
 *
 * Injection points:
 *  - Bed mesh: a four-line block prepended at the top of the file. Runs
 *    before the slicer's start g-code, which re-homes idempotently.
 *  - Timelapse: `TIMELAPSE_TAKE_FRAME` after every `; CHANGE_LAYER` or
 *    `;LAYER_CHANGE` marker (OrcaSlicer's two reserved tags — see
 *    libslic3r/GCode/GCodeProcessor.cpp Reserved_Tags). A single
 *    `TIMELAPSE_RENDER` is appended after the last line so the
 *    component starts the render at print end.
 *
 * Memory note: streams line-by-line so 50 MB multicolor g-code files
 * don't sit in RAM. The cost is one extra pass over the file; on a
 * Snapmaker U1 this is ~250 ms for a 17 MB file on the headset's
 * eMMC. Acceptable for a one-time pre-upload pass.
 */
fun applyPrintOptionsToGcode(source: File, options: PrintOptions): File {
    if (!options.bedMeshCalibrate && !options.timelapse) return source

    val out = File(source.parentFile, source.nameWithoutExtension + ".orcaxr.gcode")
    out.bufferedWriter().use { w ->
        // Bed mesh block at the very top. M400 flushes Klipper's move
        // queue so the calibration probe sequence doesn't race with any
        // queued moves from a previous job — defensive but cheap.
        if (options.bedMeshCalibrate) {
            w.appendLine("; --- OrcaXR pre-print: bed mesh calibrate ---")
            w.appendLine("G28")
            w.appendLine("BED_MESH_CALIBRATE")
            w.appendLine("M400")
            w.appendLine("; --- end OrcaXR pre-print ---")
        }

        source.bufferedReader().use { r ->
            var line = r.readLine()
            while (line != null) {
                w.appendLine(line)
                if (options.timelapse && isLayerChangeMarker(line)) {
                    w.appendLine("TIMELAPSE_TAKE_FRAME")
                }
                line = r.readLine()
            }
        }

        if (options.timelapse) {
            w.appendLine("; --- OrcaXR post-print: render timelapse ---")
            w.appendLine("TIMELAPSE_RENDER")
        }
    }
    return out
}

/** OrcaSlicer's two layer-change reserved tags. Match the comment line
 *  with leading whitespace tolerated; some post-processors normalize
 *  spacing. */
private fun isLayerChangeMarker(line: String): Boolean {
    val trimmed = line.trimStart()
    return trimmed.startsWith("; CHANGE_LAYER") || trimmed.startsWith(";LAYER_CHANGE")
}
