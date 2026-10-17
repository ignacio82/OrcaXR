package dev.orcaxr.nativeapp.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.view.View
import android.widget.RemoteViews
import dev.orcaxr.core.AppCredentialVault
import dev.orcaxr.core.PrinterDirectory
import dev.orcaxr.nativeapp.MainActivity
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.device.PreferencesTextStore
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object PrinterCameraWidgetFetcher {
    private val worker = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    private const val MAX_IMAGE_WIDTH = 800
    private const val MAX_IMAGE_HEIGHT = 600

    fun fetchAndUpdateAsync(context: Context, appWidgetId: Int) {
        val app = context.applicationContext
        worker.execute {
            try {
                fetchAndUpdate(app, appWidgetId)
            } catch (t: Throwable) {
                android.util.Log.e("OrcaXRWidget", "Failed widget update for $appWidgetId", t)
                showError(app, appWidgetId, t.message ?: "Update failed")
            }
        }
    }

    fun showRefreshing(context: Context, appWidgetId: Int) {
        val manager = AppWidgetManager.getInstance(context)
        val views = RemoteViews(context.packageName, R.layout.widget_printer_camera)
        views.setViewVisibility(R.id.widget_progress, View.VISIBLE)
        views.setTextViewText(R.id.widget_subtitle, context.getString(R.string.widget_camera_loading))
        manager.partiallyUpdateAppWidget(appWidgetId, views)
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun fetchAndUpdate(context: Context, appWidgetId: Int) {
        var config = PrinterCameraWidgetPrefs.loadConfig(context, appWidgetId)
        val manager = AppWidgetManager.getInstance(context)

        // If no config saved, try to discover default printer
        if (config == null) {
            val store = PreferencesTextStore(context, "orcaxr.printers", "directory")
            val directory = PrinterDirectory.load(store.read())
            val printer = directory.printers.firstOrNull {
                text(directory.defaultId).isNotEmpty() && text(directory.defaultId) == text(it.id)
            } ?: directory.printers.firstOrNull()

            if (printer == null) {
                showEmpty(context, appWidgetId)
                return
            }

            val pId = text(printer.id)
            val pName = text(printer.name)
            val pHost = text(printer.host)
            val pPort = printer.port.toInt()

            val webcams = try {
                val apiKey = AppCredentialVault.shared(context).current.printerApiKeys
                    .firstOrNull { text(it.key) == pId }?.let { text(it.secret) }
                PrinterCameraDiscovery.queryWebcams(http, pHost, pPort, apiKey)
            } catch (_: Exception) {
                emptyList()
            }
            val webcam = webcams.firstOrNull { it.enabled && it.snapshotUrl.isNotEmpty() }

            config = CameraWidgetConfig(
                printerId = pId,
                printerName = pName,
                printerHost = pHost,
                printerPort = pPort,
                cameraUid = webcam?.uid ?: "default",
                cameraName = webcam?.name.orEmpty(),
                cameraSnapshotUrl = webcam?.snapshotUrl,
            )
            PrinterCameraWidgetPrefs.saveConfig(context, appWidgetId, config)
        }

        val apiKey = AppCredentialVault.shared(context).current.printerApiKeys
            .firstOrNull { text(it.key) == config.printerId }?.let { text(it.secret) }

        var rotDegrees = 0
        var flipH = false
        var flipV = false

        // Resolve snapshot URL
        val snapshotUrl = config.cameraSnapshotUrl
        val candidateUrls = if (!snapshotUrl.isNullOrEmpty()) {
            PrinterCameraDiscovery.resolveCandidateUrls(config.printerHost, config.printerPort, snapshotUrl)
        } else {
            val webcams = PrinterCameraDiscovery.queryWebcams(http, config.printerHost, config.printerPort, apiKey)
            val matched = webcams.firstOrNull { it.uid == config.cameraUid }
                ?: webcams.firstOrNull { it.enabled && it.snapshotUrl.isNotEmpty() }
            if (matched != null) {
                rotDegrees = matched.rotation
                flipH = matched.flipHorizontal
                flipV = matched.flipVertical
                PrinterCameraWidgetPrefs.saveConfig(
                    context,
                    appWidgetId,
                    config.copy(cameraSnapshotUrl = matched.snapshotUrl, cameraName = matched.name),
                )
                PrinterCameraDiscovery.resolveCandidateUrls(config.printerHost, config.printerPort, matched.snapshotUrl)
            } else {
                emptyList()
            }
        }

        if (candidateUrls.isEmpty()) {
            showError(context, appWidgetId, context.getString(R.string.widget_camera_no_cameras))
            return
        }

        var imageBytes: ByteArray? = null
        var lastError: Exception? = null

        for (candidate in candidateUrls) {
            try {
                val fetchUrl = if (candidate.contains("?")) {
                    "$candidate&orcaxr_frame=${System.currentTimeMillis()}"
                } else {
                    "$candidate?orcaxr_frame=${System.currentTimeMillis()}"
                }
                val builder = Request.Builder().url(fetchUrl)
                if (!apiKey.isNullOrBlank()) {
                    builder.header("X-Api-Key", apiKey.trim())
                }
                val response = http.newCall(builder.build()).execute()
                if (response.isSuccessful) {
                    val bytes = response.body?.bytes()
                    if (bytes != null && bytes.isNotEmpty()) {
                        imageBytes = bytes
                        break
                    }
                }
            } catch (e: Exception) {
                lastError = e
            }
        }

        if (imageBytes == null) {
            showError(context, appWidgetId, lastError?.message ?: context.getString(R.string.widget_camera_error))
            return
        }

        val bitmap = decodeSampledBitmap(imageBytes, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, rotDegrees, flipH, flipV)
        if (bitmap == null) {
            showError(context, appWidgetId, context.getString(R.string.widget_camera_error))
            return
        }

        val views = RemoteViews(context.packageName, R.layout.widget_printer_camera)
        views.setViewVisibility(R.id.widget_progress, View.GONE)
        views.setViewVisibility(R.id.widget_placeholder, View.GONE)
        views.setViewVisibility(R.id.widget_camera_image, View.VISIBLE)
        views.setImageViewBitmap(R.id.widget_camera_image, bitmap)
        val title = if (config.cameraName.isNotEmpty()) {
            "${config.printerName} · ${config.cameraName}"
        } else {
            config.printerName
        }
        views.setTextViewText(R.id.widget_title, title)
        views.setTextViewText(R.id.widget_subtitle, context.getString(R.string.widget_camera_updated_just_now))

        setupIntents(context, appWidgetId, config.printerId, views)
        PrinterCameraWidgetPrefs.saveLastUpdated(context, appWidgetId, System.currentTimeMillis())
        manager.updateAppWidget(appWidgetId, views)
    }

    private fun decodeSampledBitmap(
        bytes: ByteArray,
        reqWidth: Int,
        reqHeight: Int,
        rotation: Int,
        flipH: Boolean,
        flipV: Boolean,
    ): Bitmap? {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        if (options.outWidth <= 0 || options.outHeight <= 0) return null

        var inSampleSize = 1
        val height = options.outHeight
        val width = options.outWidth
        if (height > reqHeight || width > reqWidth) {
            val halfHeight = height / 2
            val halfWidth = width / 2
            while (halfHeight / inSampleSize >= reqHeight && halfWidth / inSampleSize >= reqWidth) {
                inSampleSize *= 2
            }
        }

        val decodeOptions = BitmapFactory.Options().apply {
            this.inSampleSize = inSampleSize
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOptions) ?: return null

        if (rotation == 0 && !flipH && !flipV) {
            return raw
        }

        val matrix = Matrix()
        if (flipH) matrix.postScale(-1f, 1f)
        if (flipV) matrix.postScale(1f, -1f)
        if (rotation != 0) matrix.postRotate(rotation.toFloat())

        val transformed = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
        if (transformed != raw) {
            raw.recycle()
        }
        return transformed
    }

    private fun setupIntents(context: Context, appWidgetId: Int, printerId: String, views: RemoteViews) {
        val refreshIntent = Intent(context, PrinterCameraWidgetProvider::class.java).apply {
            action = PrinterCameraWidgetProvider.ACTION_REFRESH
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        }
        val refreshPending = PendingIntent.getBroadcast(
            context,
            appWidgetId,
            refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        views.setOnClickPendingIntent(R.id.widget_btn_refresh, refreshPending)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_NAV_AREA, "device")
            putExtra(MainActivity.EXTRA_PRINTER_ID, printerId)
            putExtra(MainActivity.EXTRA_DEVICE_TAB, "camera")
        }
        val openPending = PendingIntent.getActivity(
            context,
            appWidgetId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        views.setOnClickPendingIntent(R.id.widget_camera_image, openPending)
        views.setOnClickPendingIntent(R.id.widget_placeholder, openPending)
    }

    private fun showEmpty(context: Context, appWidgetId: Int) {
        val manager = AppWidgetManager.getInstance(context)
        val views = RemoteViews(context.packageName, R.layout.widget_printer_camera)
        views.setViewVisibility(R.id.widget_progress, View.GONE)
        views.setViewVisibility(R.id.widget_camera_image, View.GONE)
        views.setViewVisibility(R.id.widget_placeholder, View.VISIBLE)
        views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_camera_name))
        views.setTextViewText(R.id.widget_subtitle, context.getString(R.string.widget_camera_no_printers))
        views.setTextViewText(R.id.widget_placeholder_text, context.getString(R.string.widget_camera_no_printers))

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_NAV_AREA, "device")
        }
        val openPending = PendingIntent.getActivity(
            context,
            appWidgetId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        views.setOnClickPendingIntent(R.id.widget_root, openPending)
        manager.updateAppWidget(appWidgetId, views)
    }

    private fun showError(context: Context, appWidgetId: Int, message: String) {
        val manager = AppWidgetManager.getInstance(context)
        val views = RemoteViews(context.packageName, R.layout.widget_printer_camera)
        views.setViewVisibility(R.id.widget_progress, View.GONE)
        views.setTextViewText(R.id.widget_subtitle, message)
        views.setTextViewText(R.id.widget_placeholder_text, message)
        val config = PrinterCameraWidgetPrefs.loadConfig(context, appWidgetId)
        setupIntents(context, appWidgetId, config?.printerId ?: "", views)
        manager.partiallyUpdateAppWidget(appWidgetId, views)
    }
}
