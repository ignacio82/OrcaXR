package dev.orcaxr.app

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.io.File

/**
 * Shared upload + start sequence used by both the XR send button
 * (MainActivity's BottomRightSummaryPanel.onSendAndPrint) and the
 * mobile PreviewScreen send button. Encapsulates:
 *
 *   1. Apply [PrintOptions] to the local g-code (prepend bed-mesh
 *      block + inject TIMELAPSE_TAKE_FRAME at layer changes).
 *   2. Toggle the Moonraker timelapse component on/off to match the
 *      user's pick (no-op when timelapse is off OR the component
 *      isn't installed — we already gate the UI switch on the probe).
 *   3. Upload the (possibly rewritten) g-code with progress callbacks.
 *   4. POST /printer/print/start.
 *
 * Each phase updates a single [PrinterStatus] via [setStatus] so the
 * caller doesn't have to thread state through. Errors are surfaced as
 * an Error-toned status; the caller decides whether to also toast.
 */
fun runUploadAndStart(
    scope: CoroutineScope,
    ctx: Context,
    cfg: PrinterConfig,
    gcode: File,
    options: PrintOptions,
    setStatus: (String, PrinterStatus) -> Unit,
) {
    setStatus(cfg.id, PrinterStatus("Preparing ${gcode.name}…", PrinterStatusTone.Info))
    android.widget.Toast.makeText(
        ctx,
        "Sending to ${cfg.name}…",
        android.widget.Toast.LENGTH_SHORT,
    ).show()
    scope.launch {
        val client = MoonrakerClient(cfg)

        // (1) Apply g-code injections. No-op when both toggles are off
        // — returns the same File, no disk write.
        val injected = applyPrintOptionsToGcode(gcode, options)
        val sizeKB = injected.length() / 1024
        val remote = "orcaxr-${injected.name}"

        // (2) Toggle Moonraker's timelapse component to match the
        // user's pick. We always send the toggle (true OR false) when
        // the user actively interacted with the option — that way a
        // print with timelapse=off explicitly turns the component
        // off in case a previous job left it on. NotFound just means
        // the component isn't installed — no-op, the macros in the
        // gcode also degrade to no-ops on plain Klipper.
        when (val r = client.setTimelapseEnabled(options.timelapse)) {
            is MoonrakerResult.Ok, is MoonrakerResult.NotFound -> { /* fine */ }
            is MoonrakerResult.AuthError -> {
                setStatus(cfg.id, PrinterStatus(r.message, PrinterStatusTone.Error))
                return@launch
            }
            is MoonrakerResult.HttpError -> {
                // Surface but don't bail — the timelapse toggle is
                // non-critical. The print itself can still go.
                android.util.Log.w(
                    "OrcaXR/send",
                    "Timelapse toggle HTTP ${r.code}: ${r.body.take(200)}",
                )
            }
            is MoonrakerResult.IoError -> {
                android.util.Log.w("OrcaXR/send", "Timelapse toggle io: ${r.message}")
            }
        }

        // (3) Upload with throttled progress callbacks (1%/tick).
        val tickStart = System.currentTimeMillis()
        var lastPct = -1
        val onProgress: (Long, Long) -> Unit = { sent, total ->
            val pct = if (total > 0) ((sent * 100) / total).toInt() else 0
            if (pct != lastPct) {
                lastPct = pct
                val sentKB = sent / 1024
                val elapsed = (System.currentTimeMillis() - tickStart) / 1000
                val msg = "Uploading ${injected.name}… ${sentKB}/${sizeKB} KB ($pct%, ${elapsed}s)"
                setStatus(cfg.id, PrinterStatus(msg, PrinterStatusTone.Info, progress = pct / 100f))
            }
        }
        when (val up = client.uploadGcode(injected, remote, onProgress)) {
            is MoonrakerResult.Ok -> {
                setStatus(cfg.id, PrinterStatus("Starting print…", PrinterStatusTone.Info))
                // (4) Start the print.
                when (val st = client.startPrint(up.value)) {
                    is MoonrakerResult.Ok -> setStatus(
                        cfg.id,
                        PrinterStatus("Print started: ${up.value}", PrinterStatusTone.Success),
                    )
                    is MoonrakerResult.AuthError -> setStatus(cfg.id, PrinterStatus(st.message, PrinterStatusTone.Error))
                    is MoonrakerResult.NotFound -> setStatus(cfg.id, PrinterStatus(st.message, PrinterStatusTone.Error))
                    is MoonrakerResult.HttpError -> setStatus(cfg.id, PrinterStatus("Start HTTP ${st.code}", PrinterStatusTone.Error))
                    is MoonrakerResult.IoError -> setStatus(cfg.id, PrinterStatus("Start: ${st.message}", PrinterStatusTone.Error))
                }
            }
            is MoonrakerResult.AuthError -> setStatus(cfg.id, PrinterStatus(up.message, PrinterStatusTone.Error))
            is MoonrakerResult.NotFound -> setStatus(cfg.id, PrinterStatus(up.message, PrinterStatusTone.Error))
            is MoonrakerResult.HttpError -> setStatus(cfg.id, PrinterStatus("Upload HTTP ${up.code}", PrinterStatusTone.Error))
            is MoonrakerResult.IoError -> setStatus(cfg.id, PrinterStatus("Upload: ${up.message}", PrinterStatusTone.Error))
        }

        // Clean up the injected copy if we created one. Keeping it
        // around bloats the cache for every print.
        if (injected != gcode) injected.delete()
    }
}
