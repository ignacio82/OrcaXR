package dev.orcaxr.nativeapp.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent

class PrinterCameraWidgetProvider : AppWidgetProvider() {

    companion object {
        const val ACTION_REFRESH = "dev.orcaxr.nativeapp.widget.ACTION_REFRESH"
    }

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        for (appWidgetId in appWidgetIds) {
            PrinterCameraWidgetFetcher.fetchAndUpdateAsync(context, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            val appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                PrinterCameraWidgetFetcher.showRefreshing(context, appWidgetId)
                PrinterCameraWidgetFetcher.fetchAndUpdateAsync(context, appWidgetId)
            }
        }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        for (appWidgetId in appWidgetIds) {
            PrinterCameraWidgetPrefs.deleteConfig(context, appWidgetId)
        }
    }
}
