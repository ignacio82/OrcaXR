package dev.orcaxr.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Roadmap E8 — foreground service that keeps OrcaXR's process alive
 * while a slice is running so the user can take off the XR headset
 * without losing progress.
 *
 * **Why a separate service from MCP's:** the MCP service stays up for
 * the entire MCP-enabled session (user-toggled). Slicing is bursty —
 * 30-120 s for a typical multi-color print on Galaxy XR (gotcha #23).
 * Mixing them onto one service would tie the MCP server's
 * "I'm running" notification to the slicing notification's bursty
 * lifetime; users who haven't opted into MCP shouldn't see an MCP
 * notification just because they're slicing.
 *
 * **Lifecycle:** the service is started by [SliceLifecycle.beginSlice]
 * before any `nativeSlice` / `nativeSliceMulti` call and stopped by
 * [SliceLifecycle.endSlice] when the call returns (success or failure).
 * The service shows a single "OrcaXR is slicing" notification with a
 * tap-to-open intent that brings the Activity back. No progress
 * percentage in the notification yet — wiring that requires routing
 * `Print::set_status_callback` percent ticks to the notification, which
 * is follow-up work that lands alongside the libslic3r abort hook
 * (currently `cancel_slice` is a no-op for the same reason).
 *
 * `foregroundServiceType="dataSync"` (manifest) — same canonical type
 * MCP uses, justified by "long-running background work the user
 * explicitly opted into."
 *
 * **Cancellation:** the user can dismiss the notification (no Cancel
 * action wired up yet — the libslic3r abort hook needed to honor it
 * lives behind C6's "remaining nice-to-haves" alongside `cancel_slice`).
 * Without that hook, even a Cancel action couldn't actually stop the
 * native code mid-slice.
 */
class SliceForegroundService : Service() {

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var observerJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        startForegroundCompat()
        startProgressObserver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel(this)
        startForegroundCompat()
        // Re-arm the observer if onStartCommand is delivered after
        // an onCreate→onDestroy cycle (rare, but the OS does this).
        if (observerJob == null) startProgressObserver()
        // Slicing is a finite operation. If the OS kills us, the
        // service shouldn't auto-recreate — the slice that triggered
        // the start is gone, and a zombie service with no slice in
        // flight would just confuse the user.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        observerJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    /**
     * Roadmap E8 — observe [SliceLifecycle.progressPercent] +
     * `progressMessage` + `activeLabel` and rebuild the foreground
     * notification on each tick. Coalesced via Flow.combine, so a
     * burst of percent updates near 100% only triggers one
     * NotificationManager.notify per change rather than three.
     */
    private fun startProgressObserver() {
        observerJob = scope.launch {
            combine(
                SliceLifecycle.activeLabel,
                SliceLifecycle.progressPercent,
                SliceLifecycle.progressMessage,
            ) { label, pct, msg -> Triple(label, pct, msg) }
                .collect { (label, pct, msg) ->
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIFICATION_ID, buildNotification(label, pct, msg))
                }
        }
    }

    private fun startForegroundCompat() {
        val notification = buildNotification(
            label = SliceLifecycle.activeLabel.value,
            percent = SliceLifecycle.progressPercent.value,
            message = SliceLifecycle.progressMessage.value,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(label: String?, percent: Int, message: String?): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val safeLabel = label ?: "your model"
        // Title carries the high-signal "% complete" so the user can
        // glance at the lock-screen / shade and read progress without
        // expanding the notification.
        val title = if (percent > 0) "OrcaXR slicing $safeLabel — $percent%"
        else "OrcaXR slicing $safeLabel"
        // Body line uses the libslic3r-emitted phase message
        // ("Generating support material", "Cooling and infill",
        // "G-code export") when present, falling back to the static
        // "tap to view" prompt otherwise.
        val body = (message?.takeIf { it.isNotBlank() } ?: "Tap to view").take(120)
        val builder = Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setContentIntent(openApp)
            .setShowWhen(false)
        if (percent in 1..100) {
            // Determinate progress bar — disabled when percent is 0
            // (most callbacks fire `(percent=0, message="Loading…")`
            // before the JNI reports a real value, and an empty bar
            // looks broken).
            builder.setProgress(100, percent, false)
        }
        // Roadmap E8 — Cancel action. Routes through a tiny
        // BroadcastReceiver so a tap from the lock screen / shade
        // doesn't have to bring the Activity foreground; the receiver
        // calls SlicerEngine.abort() directly.
        val cancelIntent = Intent(this, SliceCancelReceiver::class.java)
            .setAction(ACTION_CANCEL)
        val cancelPending = PendingIntent.getBroadcast(
            this,
            0,
            cancelIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        builder.addAction(
            android.R.drawable.ic_menu_close_clear_cancel,
            "Cancel",
            cancelPending,
        )
        return builder.build()
    }

    companion object {
        private const val NOTIFICATION_ID: Int = 0xC9D
        private const val NOTIFICATION_CHANNEL_ID: String = "orcaxr.slice"
        private const val NOTIFICATION_CHANNEL_NAME: String = "Slicing"
        private const val NOTIFICATION_CHANNEL_DESC: String =
            "Persistent notification shown while OrcaXR is slicing, so the slice " +
                "survives if you take off the headset before it finishes."
        const val ACTION_CANCEL: String = "dev.orcaxr.app.action.SLICE_CANCEL"

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, SliceForegroundService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, SliceForegroundService::class.java))
        }

        fun ensureChannel(ctx: Context) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                NOTIFICATION_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW,
            )
            channel.description = NOTIFICATION_CHANNEL_DESC
            channel.setSound(null, null)
            channel.enableVibration(false)
            nm.createNotificationChannel(channel)
        }
    }
}

/**
 * Process-singleton lifecycle handle for the slice foreground service.
 * Tracks active-slice count + the human-readable label so the
 * notification can show "Slicing dragon.3mf" (label was set by the
 * caller). Re-entrant: nested begins increment a counter; the service
 * stops when the counter returns to 0.
 *
 * Re-entrancy matters because OrcaXR's auto-arrange + adaptive-layer-
 * height paths sometimes trigger an inner slice for previewing inside
 * the outer slice, and we don't want the inner end to tear down the
 * service while the outer slice is still running.
 */
object SliceLifecycle {
    private val active = java.util.concurrent.atomic.AtomicInteger(0)
    private val _activeLabel =
        kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    val activeLabel: kotlinx.coroutines.flow.StateFlow<String?> = _activeLabel

    /**
     * Roadmap E8 — slicing progress (0..100) reported by libslic3r's
     * `Print::set_status_callback`. Mirrored into the foreground
     * notification by [SliceForegroundService] so the user sees
     * "Slicing dragon — 42%" on the lock screen / shade. Reset to 0
     * on every [beginSlice] and on [endSlice] so the next slice
     * starts clean.
     */
    private val _progressPercent =
        kotlinx.coroutines.flow.MutableStateFlow(0)
    val progressPercent: kotlinx.coroutines.flow.StateFlow<Int> = _progressPercent

    /** Phase message paired with the percent ("Generating support material",
     *  "G-code export"). Optional. */
    private val _progressMessage =
        kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    val progressMessage: kotlinx.coroutines.flow.StateFlow<String?> = _progressMessage

    /**
     * Mark a slice as starting. Increments the active counter and
     * starts the foreground service (idempotent — duplicate starts
     * just refresh the notification). Pass the human-readable model
     * name so the notification shows useful text.
     */
    fun beginSlice(ctx: Context, label: String) {
        _activeLabel.value = label
        _progressPercent.value = 0
        _progressMessage.value = null
        if (active.incrementAndGet() == 1) {
            SliceForegroundService.start(ctx)
        }
    }

    /**
     * Mark a slice as finished. Decrements the active counter; when
     * it returns to 0, stops the foreground service.
     */
    fun endSlice(ctx: Context) {
        if (active.decrementAndGet() <= 0) {
            active.set(0) // guard against accidental over-decrement
            _activeLabel.value = null
            _progressPercent.value = 0
            _progressMessage.value = null
            SliceForegroundService.stop(ctx)
        }
    }

    /**
     * Roadmap E8 — push a percent + message into the lifecycle's
     * StateFlows so [SliceForegroundService]'s observer rebuilds the
     * notification. Safe to call from any thread; the underlying
     * StateFlow handles the dispatch. No-op when no slice is in
     * flight.
     */
    fun updateProgress(percent: Int, message: String?) {
        if (active.get() <= 0) return
        _progressPercent.value = percent.coerceIn(0, 100)
        _progressMessage.value = message
    }

    /** Test seam — current active counter value. */
    fun activeCount(): Int = active.get()

    /** Test seam — reset state between unit tests. */
    fun resetForTest() {
        active.set(0)
        _activeLabel.value = null
        _progressPercent.value = 0
        _progressMessage.value = null
    }
}
