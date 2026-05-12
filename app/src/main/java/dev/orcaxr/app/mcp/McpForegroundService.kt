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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

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
 * `foregroundServiceType="specialUse"` (manifest) — the MCP server is
 * an always-on local listener the user explicitly opted into via
 * Devices → MCP, expected to stay up across a full session. The
 * `dataSync` type used to be the home for this kind of work, but on
 * Android 15+ (API 35+) `dataSync` carries a 6-hour-per-24h cumulative
 * cap and starts throwing ForegroundServiceStartNotAllowedException on
 * the next refresh once the cap is exhausted. `specialUse` has no such
 * cap; the manifest ships PROPERTY_SPECIAL_USE_FGS_SUBTYPE alongside
 * to justify the choice.
 */
class McpForegroundService : Service() {

    private val tag: String = "OrcaXR/mcp/svc"

    /**
     * Refreshes the notification when (a) the controller binds /
     * unbinds the socket, or (b) the workspace activity attaches /
     * detaches. The "OrcaXR MCP — tap to resume" prompt only makes
     * sense once we know the renderer dropped, so we have to react
     * to both signals; building the notification once at onCreate
     * would freeze the copy.
     */
    private val refresherScope: CoroutineScope =
        CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var refresher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        if (!startForegroundCompat()) {
            // Couldn't enter the foreground (quota exhausted, OS
            // denied the launch, etc.). onStartCommand below already
            // refuses to bind the socket in that case; this just
            // makes onCreate-only spawn paths consistent.
            stopSelf()
            return
        }
        startNotificationRefresher()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Idempotent: McpController.start()'s settings watcher may emit
        // multiple `enabled=true` ticks (port change, key rotate). Each
        // start command refreshes the notification and asks the
        // controller to (re)bind the socket using the latest snapshot.
        ensureChannel(this)
        if (!startForegroundCompat()) {
            // The OS rejected our promotion to foreground. The service
            // is still alive as a plain background Service, but we
            // refuse to bind the MCP socket in that state — without a
            // foreground promotion the process will be reaped within
            // seconds and a half-bound listener would leave clients
            // hanging mid-RPC. Bail cleanly; the next user action that
            // triggers McpController will retry.
            stopSelf(startId)
            return START_NOT_STICKY
        }
        McpController.get(applicationContext).onForegroundServiceStarted()
        // START_STICKY: if the OS does kill us under extreme memory
        // pressure, ask it to recreate the service. Recreation re-runs
        // onCreate → notification → controller bind, so the user gets
        // back online without manual intervention.
        return START_STICKY
    }

    /**
     * Android 15+ time-limit hook. specialUse foreground services
     * don't normally hit this (specialUse has no cumulative cap), but
     * the override is cheap insurance — if a future Android revision
     * adds one, or the OS hits the limit for a different reason
     * (battery saver policy, etc.), we shut down cleanly instead of
     * being force-killed mid-RPC.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(tag, "onTimeout(startId=$startId, type=$fgsType) — stopping cleanly")
        stopSelf(startId)
    }

    override fun onDestroy() {
        // Stop the refresher first so it doesn't try to re-emit the
        // notification while the system is tearing the service down.
        refresher?.cancel()
        refresherScope.cancel()
        // The user flipped the MCP toggle off (or the OS is shutting us
        // down). Hand control back to the controller so it can release
        // its socket — keeping the controller authoritative about the
        // server's state means tests + UI keep working unchanged.
        McpController.get(applicationContext).onForegroundServiceStopped()
        super.onDestroy()
        Log.i(tag, "Service destroyed")
    }

    /**
     * Subscribe to controller running-state and workspace attach-state
     * and re-emit the foreground notification whenever either changes.
     * `distinctUntilChanged` avoids redundant notify() calls (the
     * channel is IMPORTANCE_LOW and silenced anyway, but skipping
     * no-op refreshes is cheap insurance against an
     * Android-version-quirk that pops a heads-up on every notify).
     */
    private fun startNotificationRefresher() {
        if (refresher != null) return
        val ctl = McpController.get(applicationContext)
        val ws = WorkspaceModel.get()
        refresher = refresherScope.launch {
            ctl.serverRunning
                .combine(ws.attached) { running, attached -> running to attached }
                .distinctUntilChanged()
                .collect { (running, attached) ->
                    refreshNotification(running, attached)
                }
        }
    }

    private fun refreshNotification(running: Boolean, attached: Boolean) {
        val notification = buildNotification(running, attached)
        val nm =
            getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        try {
            nm.notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // Android 13+ POST_NOTIFICATIONS denial — startForeground
            // is already through (the OS lets the initial foreground
            // notification past even without the runtime grant), but
            // subsequent notify() calls can be refused. Logging only;
            // the original notification stays visible.
            Log.w(tag, "notify refused: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /**
     * Promote this service to the foreground. Returns true on success,
     * false on failure (the OS denied the promotion — typically a quota
     * miss). On false the caller MUST stop the service: a service that
     * fails startForeground but keeps running is a background Service
     * the OS will reap within seconds.
     */
    private fun startForegroundCompat(): Boolean {
        val notification = buildNotification()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14 (API 34) requires us to repeat the foreground
                // service type at startForeground time. The manifest type
                // (specialUse) is the floor; this call must match.
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (e: Exception) {
            // Catches ForegroundServiceStartNotAllowedException
            // (Android 12+: launched-from-background denial; Android
            // 15+: dataSync time-limit exhaustion) plus any future
            // SecurityException the platform adds. Logged but never
            // rethrown — taking down the process for a missed
            // foreground promotion is exactly the bug we're fixing.
            Log.w(tag, "startForeground denied: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
    }

    private fun buildNotification(
        running: Boolean = McpController.get(applicationContext).serverRunning.value,
        attached: Boolean = WorkspaceModel.get().attached.value,
    ): Notification {
        val openApp =
            PendingIntent.getActivity(
                this,
                0,
                // FLAG_ACTIVITY_NEW_TASK is required when launching an
                // Activity from a non-Activity Context (us, the
                // Service); SINGLE_TOP routes the tap into onNewIntent
                // when the activity is already alive in PiP / paused
                // state instead of spawning a duplicate.
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val port = McpController.boundPortStatic()
        val (title, text) = notificationContent(running, attached, port)
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

        /**
         * Pure helper that maps (running, attached, port) → (title,
         * body) for the foreground notification. Lifted out of
         * [buildNotification] so unit tests can pin the copy without
         * having to spin up a Service. Three meaningful states:
         *
         *  - !running                 → "starting / binding socket"
         *  - running && attached      → normal "listening on N"
         *  - running && !attached     → recovery prompt — taps land
         *    the user back into the Activity that owns the workspace,
         *    re-running the WorkspaceBinding DisposableEffect so
         *    `attached` flips true again and paint/render tools work.
         */
        internal fun notificationContent(
            running: Boolean,
            attached: Boolean,
            port: Int,
        ): Pair<String, String> = when {
            !running -> "OrcaXR MCP server starting…" to
                "Binding socket. Tap to open OrcaXR."
            attached -> "OrcaXR MCP server running" to
                if (port > 0) "Listening on port $port. Tap to focus OrcaXR."
                else "Listening. Tap to focus OrcaXR."
            else -> "OrcaXR MCP — tap to resume" to
                "Renderer detached. Tap to reattach the workspace " +
                    "(paint / slice tools need the activity in foreground)."
        }

        fun start(ctx: Context) {
            val intent = Intent(ctx, McpForegroundService::class.java)
            // startForegroundService is the Android 8+ entry point for
            // launching a service that intends to call startForeground
            // shortly. The 5-second deadline applies regardless of how
            // the service was kicked off — onCreate's startForeground
            // call covers it. Caller-side denials
            // (ForegroundServiceStartNotAllowedException for
            // background-launch policy, SecurityException for missing
            // permissions) are caught here so a stricter OS revision
            // can't crash the toggling code path.
            try {
                ctx.startForegroundService(intent)
            } catch (e: Exception) {
                Log.w("OrcaXR/mcp/svc", "startForegroundService denied: ${e.javaClass.simpleName}: ${e.message}")
            }
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
