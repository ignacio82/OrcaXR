package dev.orcaxr.app

import android.app.Application
import android.util.Log
import dev.orcaxr.app.mcp.McpController
import kotlinx.coroutines.CoroutineExceptionHandler

/**
 * Process-global app entry. Used to install the local CrashReporter
 * before any first-paint code runs, so a crash inside MainActivity
 * setup is still captured. Also boots the MCP server controller — the
 * controller is a no-op until the user enables the server from the
 * Devices panel, so this is free for users who never opt in.
 */
class OrcaXRApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashReporter.install(this)
        // Audit H_PIXEL10 (2026-05-07) — coroutine-launched failures
        // (e.g. `scope.launch { stageUriBounded(); recents.add(); ... }`
        // in FilesScreen) propagate to the dispatcher's default handler,
        // which on Android is Thread.UncaughtExceptionHandler — i.e.
        // CrashReporter — but the throwing-thread name there is the
        // dispatch worker, not the originating Compose scope, which
        // makes the JSON record harder to interpret. Install a
        // process-global CoroutineExceptionHandler so Application.app
        // is the explicit context: every uncaught coroutine exception
        // hits CrashReporter.recordCrash with a stable thread label
        // before the OS kills the process. This does NOT swallow the
        // crash — after recording we rethrow on the original thread
        // so debuggerd / the OS error dialog still fires.
        appCoroutineExceptionHandler = CoroutineExceptionHandler { ctx, throwable ->
            val name = ctx[kotlinx.coroutines.CoroutineName]?.name ?: "unnamed-coroutine"
            Log.e(TAG, "uncaught coroutine exception in [$name]", throwable)
            runCatching { CrashReporter.recordCrash(this, Thread.currentThread(), throwable) }
            throw throwable
        }
        // Watcher idempotently mirrors persisted settings into the
        // bound socket. If the user had MCP enabled in a prior
        // session, this is what brings it back up on launch.
        //
        // Audit H_PIXEL10 (2026-05-07) — wrap in runCatching so an
        // MCP start-up failure (e.g. port already in use, settings
        // DataStore corruption, dependent class init failing on a
        // specific OEM Android build) doesn't take down Application
        // .onCreate. If MCP fails to start the user can still use
        // the slicer; the past-crash dialog will surface the cause
        // on the NEXT launch.
        runCatching { McpController.get(this).start() }
            .onFailure { Log.e(TAG, "McpController.start failed; continuing without MCP", it) }
    }

    companion object {
        private const val TAG = "OrcaXR/app"

        /**
         * Process-singleton handler for unhandled coroutine
         * exceptions. Set in [onCreate]; stays non-null for the
         * Application's lifetime. UI scopes that want every uncaught
         * throw routed into the on-disk crash log can append it to
         * their context (`scope.launch(appCoroutineExceptionHandler)
         * { ... }`).
         */
        @Volatile
        var appCoroutineExceptionHandler: CoroutineExceptionHandler? = null
            private set
    }
}
