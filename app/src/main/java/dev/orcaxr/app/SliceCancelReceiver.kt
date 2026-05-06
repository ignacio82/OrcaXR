package dev.orcaxr.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Roadmap E8 — drives the Cancel action on the slicing notification.
 *
 * Manifest-registered (not dynamic) so the action survives the
 * Activity being torn down — exactly the scenario that motivated the
 * foreground service in the first place. A user with the headset off
 * can pull down the shade, hit Cancel, and the slice unwinds cleanly
 * even though no Compose UI is alive.
 *
 * The receiver itself is a one-liner — the heavy lifting is in
 * [SlicerEngine.abort], which holds the JNI mutex around the
 * Print::cancel() call. After the abort signal is sent, libslic3r's
 * pipeline polls the atomic CancelStatus at every cancellation point
 * inside slicing/G-code export and unwinds via a CanceledException
 * that the JNI catches at top level. The slice JNI returns -5 →
 * Kotlin maps to SliceResult.Cancelled → [SliceLifecycle.endSlice]
 * fires from the calling coroutine's `finally` block → service stops.
 */
class SliceCancelReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SliceForegroundService.ACTION_CANCEL) return
        val cancelled = SlicerEngine.abort()
        Log.i("OrcaXR/slice", "SliceCancelReceiver: abort() -> $cancelled")
    }
}
