package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.nativeapp.mcp.McpContent
import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult
import java.util.concurrent.TimeUnit

object VisionTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "capture_viewport_screenshot",
            description = "Capture a high-fidelity screenshot of the 3D viewport or workspace as a Base64 image for visual AI agent inspection.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "format" to mapOf(
                        "type" to "string",
                        "enum" to listOf("png", "jpeg"),
                        "description" to "Image format (default: png).",
                    ),
                    "width" to mapOf(
                        "type" to "integer",
                        "description" to "Target width in pixels (0 for native viewport size).",
                    ),
                    "height" to mapOf(
                        "type" to "integer",
                        "description" to "Target height in pixels (0 for native viewport size).",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val format = (args["format"] as? String)?.lowercase() ?: "png"
            val width = (args["width"] as? Number)?.toInt() ?: 0
            val height = (args["height"] as? Number)?.toInt() ?: 0

            val future = context.captureScreenshot(width, height, format)
            val base64Data = try {
                future.get(10, TimeUnit.SECONDS)
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to capture viewport screenshot: ${t.message}")
            }

            val mimeType = if (format == "jpeg" || format == "jpg") "image/jpeg" else "image/png"
            McpToolResult(
                content = listOf(
                    McpContent.Image(data = base64Data, mimeType = mimeType),
                    McpContent.Text("Captured 3D viewport screenshot ($format)."),
                ),
                isError = false,
            )
        }
    }
}
