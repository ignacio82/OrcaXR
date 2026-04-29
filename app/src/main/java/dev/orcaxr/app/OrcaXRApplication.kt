package dev.orcaxr.app

import android.app.Application

/**
 * Process-global app entry. Used to install the local CrashReporter
 * before any first-paint code runs, so a crash inside MainActivity
 * setup is still captured.
 */
class OrcaXRApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashReporter.install(this)
    }
}
