package dev.orcaxr.app.llm.runner

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.orcaxr.app.R

/**
 * Foreground service that keeps OrcaXR's process alive while the
 * in-app assistant is mid-turn.
 *
 * Why this exists: the chat panel runs an arbitrary number of MCP
 * tool calls per user message — slicing, painting, rendering,
 * Moonraker uploads, vision-API round-trips. A single turn can take
 * tens of seconds. Without a foreground service, the OS will tear
 * down the Activity (and the process) the moment the user takes off
 * the headset or the screen sleeps, killing the in-flight tool
 * dispatch and leaving the workspace in a half-mutated state.
 *
 * Tap target: the notification re-launches MainActivity so the user
 * can return to the conversation. Cancel action stops the run via
 * AgentRunner.
 *
 * Lifecycle: [AgentRunner] starts this when a turn begins and stops
 * it when the runner enters Idle. Not exported — only OrcaXR's own
 * runner binds it.
 *
 * `foregroundServiceType="specialUse"` (manifest) — sharing a single
 * `dataSync` quota with [dev.orcaxr.app.mcp.McpForegroundService]
 * meant a long-lived MCP session would exhaust the 6h/24h cap and
 * deny startForeground for both. The agent runner is per-turn but
 * fires repeatedly; specialUse keeps it independent.
 */
class AgentForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
        // Wrapped because Android 15+ can deny startForeground when an
        // FGS-quota is exhausted or the app is in a restricted launch
        // state. Crashing here would kill the entire process mid-turn,
        // dropping any in-flight slice / paint / upload — far worse
        // than running this turn without the foreground promotion.
        val promoted = try {
            startForeground(
                NOTIFICATION_ID,
                buildNotification(title, text),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "startForeground denied: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
        if (intent?.action == ACTION_CANCEL) {
            Log.i(TAG, "cancel action received")
            // The runner is the source of truth — service just
            // forwards the user's cancel intent to it.
            AgentRunner.get(applicationContext).cancel(reason = "user")
            stopSelfCompat()
            return START_NOT_STICKY
        }
        if (!promoted) {
            // Without foreground promotion the OS will reap the
            // process within seconds. Stop cleanly so the runner
            // notices and continues without leaking a phantom service.
            stopSelfCompat()
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    /**
     * Android 15+ time-limit hook. specialUse has no cumulative cap
     * today, but if the OS ever asks us to wind down (battery saver,
     * future revision adding a cap), do it gracefully instead of
     * being force-killed.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "onTimeout(startId=$startId, type=$fgsType) — stopping cleanly")
        stopSelfCompat()
    }

    override fun onDestroy() {
        Log.i(TAG, "destroyed")
        super.onDestroy()
    }

    private fun buildNotification(title: String, text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "AI assistant turn",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Keeps the in-app assistant alive while it's responding."
                    setShowBadge(false)
                },
            )
        }
        // Tap returns to MainActivity (the XR shell). On phones the
        // forwarded MobileActivity also wakes through the same
        // launcher target.
        val openIntent =
            packageManager.getLaunchIntentForPackage(packageName)
                ?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val openPi = openIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        val cancelIntent = Intent(this, AgentForegroundService::class.java).apply {
            action = ACTION_CANCEL
        }
        val cancelPi = PendingIntent.getService(
            this,
            1,
            cancelIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Stop", cancelPi)
        if (openPi != null) builder.setContentIntent(openPi)
        return builder.build()
    }

    private fun stopSelfCompat() {
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    companion object {
        private const val TAG = "OrcaXR/llm/svc"
        private const val CHANNEL_ID = "orcaxr_llm_agent_channel"
        private const val NOTIFICATION_ID = 4203
        private const val ACTION_CANCEL = "dev.orcaxr.app.action.LLM_AGENT_CANCEL"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val DEFAULT_TITLE = "OrcaXR assistant working…"
        private const val DEFAULT_TEXT = "Driving slicer tools — keep the app open."

        /** Start the service for the duration of a turn. Idempotent
         *  — repeated start calls update the notification text but
         *  don't duplicate the foreground binding. */
        fun start(context: Context, title: String? = null, text: String? = null) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                if (title != null) putExtra(EXTRA_TITLE, title)
                if (text != null) putExtra(EXTRA_TEXT, text)
            }
            // startForegroundService is required from background on
            // Android 8+. The service has 5s to call startForeground
            // with a matching ServiceInfo type — onStartCommand does
            // that immediately.
            runCatching { context.startForegroundService(intent) }
                .onFailure { Log.w(TAG, "start failed: ${it.message}") }
        }

        /** Stop the service. No-op when not running. */
        fun stop(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java)
            runCatching { context.stopService(intent) }
        }
    }
}
