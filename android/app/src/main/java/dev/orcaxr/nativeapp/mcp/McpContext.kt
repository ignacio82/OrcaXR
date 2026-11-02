package dev.orcaxr.nativeapp.mcp

import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.preview.PreviewModel
import dev.orcaxr.nativeapp.project.ProjectModel
import java.util.concurrent.CompletableFuture

/**
 * Access interface connecting MCP tools to the live Android application models,
 * UI action runners, navigation, dialog state, logs, and hardware viewport screenshot captures.
 */
interface McpContext {
    val project: ProjectModel?
    val prepare: PrepareModel?
    val device: DeviceModel?
    val preview: PreviewModel?

    /** The active product area name: "workspace", "prepare", "preview", "device", or "project". */
    val activeArea: String

    /** Navigates directly to the specified area name on the UI thread. */
    fun navigateTo(area: String): Boolean

    /** The identifier of any currently active/open dialog (e.g. "send_confirmation", "command_palette", etc.), or null. */
    val activeDialog: String?

    /** Dismisses whatever modal dialog is currently presented. Returns the dismissed dialog name or null. */
    fun dismissActiveDialog(): String?

    /** Runs an application action through the standard catalog gateway. */
    fun runAction(actionId: String): Boolean

    /** Captures an image of the current window or viewport, returning base64 encoded bytes. */
    fun captureScreenshot(width: Int = 0, height: Int = 0, format: String = "png"): CompletableFuture<String>

    /** Runs a block on the Android UI/Main Looper thread. */
    fun runOnMain(block: () -> Unit)

    /** Retrieves recent timestamped log entries from the in-app log ring buffer. */
    fun getRecentLogs(filter: String? = null, limit: Int = 50): List<String>

    /** Dumps the full semantic UI accessibility tree for headless inspection without screenshots. */
    fun getUiTree(): Map<String, Any?>

    /** Gets a flat list of all interactive buttons, switches, checkboxes, inputs, and tabs on screen. */
    fun getInteractiveElements(): List<Map<String, Any?>>

    /** Clicks a visible UI element by matching its text or content description. */
    fun clickElement(target: String, role: String? = null): Boolean

    /** Types text into a targeted or focused input field. */
    fun setTextInput(text: String, target: String? = null): Boolean
}
