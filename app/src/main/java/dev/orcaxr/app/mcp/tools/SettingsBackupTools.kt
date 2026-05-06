package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.SettingsBackup
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import org.json.JSONObject
import java.io.File

/**
 * Roadmap B13 — MCP tools wrapping [SettingsBackup].
 *
 * Surfaced as two tools so an LLM can:
 *   1. snapshot the user's current state (`export_settings`),
 *   2. mutate freely (run experiments, try alternate filament
 *      assignments, set up a temp printer for a remote slice),
 *   3. revert via `import_settings(json=<the prior export>, mode="replace")`.
 *
 * The export response includes the JSON inline by default — small
 * enough (low-tens-of-KB for a maxed-out OrcaXR install) that
 * shipping it through the JSON-RPC body is fine. Pass `out_path` to
 * have the bundle written to disk instead, which is helpful for the
 * "I want to email this to support" flow.
 */
internal object SettingsBackupTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        ExportSettings(ctx),
        ImportSettings(ctx),
    )

    class ExportSettings(private val ctx: ToolContext) : Tool {
        override val name = "export_settings"
        override val description =
            "Export every persistent OrcaXR setting (profiles / printers / plates / filaments / " +
                "MCP server config / paint sessions / recent files / user preferences) as a single " +
                "JSON envelope. Returns the JSON inline by default; pass `out_path` to write the " +
                "bundle to a file path inside the app's filesDir / cacheDir / Downloads. The " +
                "envelope's binary DataStore blobs are base64-encoded — round-tripping it back " +
                "through `import_settings` restores byte-identical state. See ROADMAP.md B13."
        override val inputSchema = Schemas.obj(
            required = emptyList(),
            properties = mapOf(
                "out_path" to Schemas.string(
                    "Optional absolute path to write the JSON to. When omitted the JSON is returned " +
                        "inline in the response body. Path must be inside one of: app filesDir, " +
                        "cacheDir, or external Downloads (the export rejects writes elsewhere)."
                ),
                "compact" to JSONObject().apply {
                    put("type", "boolean")
                    put("description", "When true, JSON is unindented (smaller payload). Default false.")
                },
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            val app = ctx.appContext
            val envelope = SettingsBackup.exportJson(app)
            val compact = args.optBoolean("compact", false)
            val text = if (compact) envelope.toString() else envelope.toString(2)
            val outPath = args.optString("out_path", "").ifBlank { null }

            val body = JSONObject().apply {
                put("ok", true)
                put("version", SettingsBackup.VERSION)
                put("size_bytes", text.toByteArray().size)
            }

            if (outPath != null) {
                if (!isPathAllowed(app, outPath)) {
                    return ToolResult.error(
                        "out_path must reside inside app filesDir, cacheDir, or external Downloads",
                    )
                }
                runCatching {
                    val out = File(outPath)
                    out.parentFile?.mkdirs()
                    out.writeText(text)
                }.onFailure { e ->
                    return ToolResult.error("failed to write export: ${e.message}")
                }
                body.put("written_to", outPath)
            } else {
                body.put("envelope", envelope)
            }
            return ToolResult.ok(body.toString(), body)
        }
    }

    class ImportSettings(private val ctx: ToolContext) : Tool {
        override val name = "import_settings"
        override val description =
            "Import a previously-exported settings envelope. Pass `envelope` (inline JSONObject) " +
                "OR `path` (absolute path to a JSON file). `mode='merge'` (default) keeps existing " +
                "stores and only overwrites entries explicitly present in the envelope; " +
                "`mode='replace'` clears each store before writing. " +
                "IMPORTANT: the in-process DataStore objects cache state in memory; the response " +
                "carries `restart_required=true` and the user must restart OrcaXR for the imported " +
                "state to fully take effect. See ROADMAP.md B13."
        override val inputSchema = Schemas.obj(
            required = emptyList(),
            properties = mapOf(
                "envelope" to JSONObject().apply {
                    put("type", "object")
                    put("description", "The JSON envelope returned by export_settings.")
                },
                "path" to Schemas.string(
                    "Absolute path to a JSON file produced by export_settings(out_path=…)."
                ),
                "mode" to Schemas.string(
                    "'merge' (default) keeps current state where the envelope is silent; " +
                        "'replace' clears each store first."
                ),
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            val app = ctx.appContext
            val mode = args.optString("mode", "merge").ifBlank { "merge" }
            if (mode != "merge" && mode != "replace") {
                return ToolResult.error("mode must be 'merge' or 'replace' (got '$mode')")
            }

            val envelope: JSONObject = when {
                args.has("envelope") -> args.optJSONObject("envelope")
                    ?: return ToolResult.error("'envelope' field is not a JSON object")
                args.has("path") -> {
                    val p = args.optString("path", "")
                    if (p.isBlank()) return ToolResult.error("'path' must be non-empty")
                    if (!isPathAllowed(app, p)) {
                        return ToolResult.error(
                            "path must reside inside app filesDir, cacheDir, or external Downloads",
                        )
                    }
                    val text = runCatching { File(p).readText() }
                        .getOrElse { e -> return ToolResult.error("failed to read $p: ${e.message}") }
                    runCatching { JSONObject(text) }
                        .getOrElse { e -> return ToolResult.error("path is not valid JSON: ${e.message}") }
                }
                else -> return ToolResult.error("must provide 'envelope' or 'path'")
            }

            val report = SettingsBackup.importJson(app, envelope, mode)
            val body = JSONObject().apply {
                put("ok", true)
                put("mode", mode)
                put("report", report.toJson())
            }
            return ToolResult.ok(body.toString(), body)
        }
    }

    private fun isPathAllowed(app: android.content.Context, path: String): Boolean {
        if (path.isBlank()) return false
        // Reject empty / traversal — File.absolutePath canonicalizes "." but
        // not ".." in the middle of a path; canonical().startsWith() on the
        // resolved roots is the load-bearing safeguard.
        val canonical = runCatching { File(path).canonicalFile.absolutePath }
            .getOrElse { return false }
        val roots = listOfNotNull(
            app.filesDir.canonicalPath,
            app.cacheDir.canonicalPath,
            app.externalCacheDir?.canonicalPath,
            android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS,
            ).canonicalPath,
        )
        return roots.any { canonical.startsWith(it + File.separator) || canonical == it }
    }

    /** Test seam — base64 encode bytes (used by the unit test fixture). */
    @Suppress("unused")
    fun base64(bytes: ByteArray): String =
        java.util.Base64.getEncoder().encodeToString(bytes)
}
