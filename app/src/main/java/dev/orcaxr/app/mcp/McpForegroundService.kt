package dev.orcaxr.app.mcp

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
import android.util.Log
import dev.orcaxr.app.MainActivity

/**
 * Foreground service that keeps the [McpServer] alive when the user
 * takes off the XR headset (or otherwise backgrounds OrcaXR). Without
 * this the OS reaps the Application singleton after a few minutes idle
 * and any companion app driving the slicer over MCP loses connection.
 *
 * The service is a thin wrapper: it shows the persistent notification
 * Android requires for a foreground service, then delegates the actual
 * socket binding to [McpController]. The server lives in the singleton
 * controller exactly as before — this service just gives the OS a
 * reason not to kill the process. When the user disables MCP from
 * Devices → MCP, [McpController] calls [Context.stopService] and the
 * notification + server both go away.
 *
 * `foregroundServiceType="dataSync"` (manifest) — the canonical pick
 * for "long-running networked work the user explicitly opted into."
 * Android 14+ requires a type to be declared.
 */
class McpForegroundService : Service() {

    private val tag: String = "OrcaXR/mcp/svc"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Idempotent: McpController.start()'s settings watcher may emit
        // multiple `enabled=true` ticks (port change, key rotate). Each
        // start command refreshes the notification and asks the
        // controller to (re)bind the socket using the latest snapshot.
        ensureChannel(this)
        startForegroundCompat()
        McpController.get(applicationContext).onForegroundServiceStarted()
        // START_STICKY: if the OS does kill us under extreme memory
        // pressure, ask it to recreate the service. Recreation re-runs
        // onCreate → notification → controller bind, so the user gets
        // back online without manual intervention.
        return START_STICKY
    }

    override fun onDestroy() {
        // The user flipped the MCP toggle off (or the OS is shutting us
        // down). Hand control back to the controller so it can release
        // its socket — keeping the controller authoritative about the
        // server's state means tests + UI keep working unchanged.
        McpController.get(applicationContext).onForegroundServiceStopped()
        super.onDestroy()
        Log.i(tag, "Service destroyed")
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 (API 34) requires us to repeat the foreground
            // service type at startForeground time. The manifest type
            // (dataSync) is the floor; this call must match.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val openApp =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val port = McpController.boundPortStatic()
        val title =
            if (port > 0) "OrcaXR MCP server running" else "OrcaXR MCP server starting…"
        val text =
            if (port > 0) "Listening on port $port. Tap to open OrcaXR."
            else "Binding socket. Tap to open OrcaXR."
        return Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth) // placeholder; small server-y glyph
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openApp)
            .setShowWhen(false)
            .build()
    }

    companion object {
        private const val NOTIFICATION_ID: Int = 0xC9C
        private const val NOTIFICATION_CHANNEL_ID: String = "orcaxr.mcp.server"
        private const val NOTIFICATION_CHANNEL_NAME: String = "MCP server"
        private const val NOTIFICATION_CHANNEL_DESC: String =
            "Persistent notification while OrcaXR's MCP server is running, " +
                "so it stays alive when you take off the headset."

        fun start(ctx: Context) {
            val intent = Intent(ctx, McpForegroundService::class.java)
            // startForegroundService is the Android 8+ entry point for
            // launching a service that intends to call startForeground
            // shortly. The 5-second deadline applies regardless of how
            // the service was kicked off — onCreate's startForeground
            // call covers it.
            ctx.startForegroundService(intent)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, McpForegroundService::class.java))
        }

        fun ensureChannel(ctx: Context) {
            val nm =
                ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // No need to track first-create state — duplicate creation
            // calls are no-ops once the channel exists.
            val channel =
                NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    NOTIFICATION_CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW,
                )
            channel.description = NOTIFICATION_CHANNEL_DESC
            // Silent — this is a "I'm here" status, not an alert.
            channel.setSound(null, null)
            channel.enableVibration(false)
            nm.createNotificationChannel(channel)
        }
    }
}
