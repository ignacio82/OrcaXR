package dev.orcaxr.nativeapp.widget

import android.content.Context
import android.content.SharedPreferences

data class CameraWidgetConfig(
    val printerId: String,
    val printerName: String,
    val printerHost: String,
    val printerPort: Int,
    val cameraUid: String,
    val cameraName: String,
    val cameraSnapshotUrl: String? = null,
)

object PrinterCameraWidgetPrefs {
    private const val PREFS_NAME = "orcaxr_printer_camera_widgets"
    private const val KEY_PRINTER_ID = "printer_id_"
    private const val KEY_PRINTER_NAME = "printer_name_"
    private const val KEY_PRINTER_HOST = "printer_host_"
    private const val KEY_PRINTER_PORT = "printer_port_"
    private const val KEY_CAMERA_UID = "camera_uid_"
    private const val KEY_CAMERA_NAME = "camera_name_"
    private const val KEY_SNAPSHOT_URL = "snapshot_url_"
    private const val KEY_LAST_UPDATE = "last_update_"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun saveConfig(context: Context, appWidgetId: Int, config: CameraWidgetConfig) {
        prefs(context).edit()
            .putString(KEY_PRINTER_ID + appWidgetId, config.printerId)
            .putString(KEY_PRINTER_NAME + appWidgetId, config.printerName)
            .putString(KEY_PRINTER_HOST + appWidgetId, config.printerHost)
            .putInt(KEY_PRINTER_PORT + appWidgetId, config.printerPort)
            .putString(KEY_CAMERA_UID + appWidgetId, config.cameraUid)
            .putString(KEY_CAMERA_NAME + appWidgetId, config.cameraName)
            .putString(KEY_SNAPSHOT_URL + appWidgetId, config.cameraSnapshotUrl)
            .apply()
    }

    fun updateSnapshotUrl(context: Context, appWidgetId: Int, url: String) {
        prefs(context).edit().putString(KEY_SNAPSHOT_URL + appWidgetId, url).apply()
    }

    fun loadConfig(context: Context, appWidgetId: Int): CameraWidgetConfig? {
        val sp = prefs(context)
        val printerId = sp.getString(KEY_PRINTER_ID + appWidgetId, null) ?: return null
        val printerName = sp.getString(KEY_PRINTER_NAME + appWidgetId, "Printer") ?: "Printer"
        val printerHost = sp.getString(KEY_PRINTER_HOST + appWidgetId, "") ?: ""
        val printerPort = sp.getInt(KEY_PRINTER_PORT + appWidgetId, 7125)
        val cameraUid = sp.getString(KEY_CAMERA_UID + appWidgetId, "") ?: ""
        val cameraName = sp.getString(KEY_CAMERA_NAME + appWidgetId, "") ?: ""
        val snapshotUrl = sp.getString(KEY_SNAPSHOT_URL + appWidgetId, null)
        return CameraWidgetConfig(
            printerId = printerId,
            printerName = printerName,
            printerHost = printerHost,
            printerPort = printerPort,
            cameraUid = cameraUid,
            cameraName = cameraName,
            cameraSnapshotUrl = snapshotUrl,
        )
    }

    fun saveLastUpdated(context: Context, appWidgetId: Int, timeMs: Long) {
        prefs(context).edit().putLong(KEY_LAST_UPDATE + appWidgetId, timeMs).apply()
    }

    fun getLastUpdated(context: Context, appWidgetId: Int): Long =
        prefs(context).getLong(KEY_LAST_UPDATE + appWidgetId, 0L)

    fun deleteConfig(context: Context, appWidgetId: Int) {
        prefs(context).edit()
            .remove(KEY_PRINTER_ID + appWidgetId)
            .remove(KEY_PRINTER_NAME + appWidgetId)
            .remove(KEY_PRINTER_HOST + appWidgetId)
            .remove(KEY_PRINTER_PORT + appWidgetId)
            .remove(KEY_CAMERA_UID + appWidgetId)
            .remove(KEY_CAMERA_NAME + appWidgetId)
            .remove(KEY_SNAPSHOT_URL + appWidgetId)
            .remove(KEY_LAST_UPDATE + appWidgetId)
            .apply()
    }
}
