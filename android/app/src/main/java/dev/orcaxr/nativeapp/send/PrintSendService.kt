package dev.orcaxr.nativeapp.send

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.ContextCompat
import dev.orcaxr.nativeapp.R

/**
 * Foreground service for streaming large G-code files to Moonraker and
 * executing pre-print preparation (homing, bed leveling calibration, etc.).
 *
 * Runs with [ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC] along with a
 * [PowerManager.PARTIAL_WAKE_LOCK] and [WifiManager.WifiLock], so long
 * operations (such as 30MB+ G-code uploads and 8-minute bed mesh probes)
 * do not get killed, suspended, or have their WebSockets severed when the
 * operator locks the screen or the phone enters sleep.
 */
class PrintSendService : Service() {
    companion object {
        const val CHANNEL = "orcaxr_print_send"
        const val NOTIFICATION_ID = 2002
        const val ACTION_START = "dev.orcaxr.nativeapp.send.START"
        const val ACTION_UPDATE = "dev.orcaxr.nativeapp.send.UPDATE"
        const val ACTION_STOP = "dev.orcaxr.nativeapp.send.STOP"
        const val ACTION_CANCEL = "dev.orcaxr.nativeapp.send.CANCEL"

        const val EXTRA_FILENAME = "filename"
        const val EXTRA_PRINTER = "printer"
        const val EXTRA_STATUS = "status"

        /** Invoked if the operator taps "Cancel send" from the notification. */
        @Volatile
        var onCancel: (() -> Unit)? = null

        fun start(context: Context, printerName: String, filename: String) {
            val intent = Intent(context, PrintSendService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_PRINTER, printerName)
                putExtra(EXTRA_FILENAME, filename)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun update(context: Context, status: String) {
            val intent = Intent(context, PrintSendService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_STATUS, status)
            }
            runCatching { context.startService(intent) }
        }

        fun stop(context: Context) {
            val intent = Intent(context, PrintSendService::class.java).apply {
                action = ACTION_STOP
            }
            runCatching { context.startService(intent) }
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var filename: String = ""
    private var printerName: String = ""
    private var currentStatus: String = ""
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                printerName = intent.getStringExtra(EXTRA_PRINTER).orEmpty()
                filename = intent.getStringExtra(EXTRA_FILENAME).orEmpty()
                currentStatus = "Preparing to send…"
                promote()
            }
            ACTION_UPDATE -> {
                intent.getStringExtra(EXTRA_STATUS)?.let { status ->
                    currentStatus = status
                    if (foreground) {
                        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification(status))
                    }
                }
            }
            ACTION_CANCEL -> {
                onCancel?.invoke()
                demote()
            }
            ACTION_STOP -> {
                demote()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        onCancel?.invoke()
        demote()
    }

    private fun promote() {
        if (!foreground) {
            acquireLocks()
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.send_channel), NotificationManager.IMPORTANCE_LOW),
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification(currentStatus), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification(currentStatus))
            }
            foreground = true
        }
    }

    private fun demote() {
        releaseLocks()
        if (foreground) {
            foreground = false
            stopForeground(STOP_FOREGROUND_REMOVE)
        }
        stopSelf()
    }

    private fun acquireLocks() {
        runCatching {
            val power = getSystemService(PowerManager::class.java)
            wakeLock = power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OrcaXR:PrintSend")?.apply {
                setReferenceCounted(false)
                acquire(45 * 60 * 1000L) // 45 minutes maximum send hold
            }
        }
        runCatching {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wifi?.createWifiLock(mode, "OrcaXR:PrintSend")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseLocks() {
        runCatching {
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
        }
        runCatching {
            wifiLock?.let { if (it.isHeld) it.release() }
            wifiLock = null
        }
    }

    private fun notification(status: String): Notification {
        val cancelIntent = PendingIntent.getService(
            this, 0, Intent(this, PrintSendService::class.java).setAction(ACTION_CANCEL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val title = if (filename.isNotEmpty()) filename else if (printerName.isNotEmpty()) printerName else getString(R.string.send_channel)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setContentText(status)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(launchIntent)
            .addAction(Notification.Action.Builder(null, getString(R.string.send_cancel), cancelIntent).build())
            .build()
    }

    override fun onDestroy() {
        demote()
        super.onDestroy()
    }
}
