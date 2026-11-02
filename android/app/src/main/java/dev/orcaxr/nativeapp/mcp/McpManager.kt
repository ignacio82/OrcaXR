package dev.orcaxr.nativeapp.mcp

import android.content.Context
import dev.orcaxr.nativeapp.mcp.tools.ActionTools
import dev.orcaxr.nativeapp.mcp.tools.DeviceTools
import dev.orcaxr.nativeapp.mcp.tools.PrintSettingsTools
import dev.orcaxr.nativeapp.mcp.tools.SliceTools
import dev.orcaxr.nativeapp.mcp.tools.SystemTools
import dev.orcaxr.nativeapp.mcp.tools.UiTools
import dev.orcaxr.nativeapp.mcp.tools.VisionTools
import dev.orcaxr.nativeapp.mcp.tools.WorkspaceTools

object McpManager : AutoCloseable {
    private var authInstance: McpAuth? = null
    private var registryInstance: McpToolRegistry? = null
    private var jsonRpcInstance: McpJsonRpc? = null
    private var serverInstance: McpServer? = null
    private var contextInstance: McpContext? = null

    val auth: McpAuth? get() = authInstance
    val registry: McpToolRegistry? get() = registryInstance
    val server: McpServer? get() = serverInstance
    val context: McpContext? get() = contextInstance

    val isRunning: Boolean get() = serverInstance?.running ?: false
    val port: Int get() = serverInstance?.port ?: authInstance?.serverPort ?: McpAuth.DEFAULT_PORT
    val token: String get() = authInstance?.token ?: ""
    val clientCount: Int get() = serverInstance?.clientCount ?: 0

    @Synchronized
    fun initialize(appContext: Context, mcpContext: McpContext) {
        try {
            serverInstance?.close()
        } catch (_: Exception) {}
        serverInstance = null

        contextInstance = mcpContext
        val auth = McpAuth(appContext)
        authInstance = auth

        val registry = McpToolRegistry()
        registryInstance = registry

        // Register all functional tool modules
        SystemTools.register(registry, mcpContext)
        WorkspaceTools.register(registry, mcpContext)
        ActionTools.register(registry, mcpContext)
        SliceTools.register(registry, mcpContext)
        PrintSettingsTools.register(registry, mcpContext)
        DeviceTools.register(registry, mcpContext)
        UiTools.register(registry, mcpContext)
        VisionTools.register(registry, mcpContext)

        val jsonRpc = McpJsonRpc(registry)
        jsonRpcInstance = jsonRpc

        val server = McpServer(auth, jsonRpc)
        serverInstance = server

        if (auth.serverEnabled) {
            server.start()
        }
    }

    @Synchronized
    fun start(): Boolean {
        return serverInstance?.start() ?: false
    }

    @Synchronized
    fun stop() {
        serverInstance?.stop()
    }

    @Synchronized
    fun restart(): Boolean {
        stop()
        return start()
    }

    override fun close() {
        stop()
        serverInstance?.close()
        serverInstance = null
    }
}
