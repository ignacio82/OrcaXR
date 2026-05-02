package dev.orcaxr.app

import android.app.Application
import dev.orcaxr.app.mcp.McpController

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
        // Watcher idempotently mirrors persisted settings into the
        // bound socket. If the user had MCP enabled in a prior
        // session, this is what brings it back up on launch.
        McpController.get(this).start()
    }
}
