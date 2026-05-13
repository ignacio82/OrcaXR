package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MoonrakerClient
import dev.orcaxr.app.MoonrakerResult
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.PrintSnapshot
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Printer-domain tools. These map 1:1 to the actions a human can take
 * in the Devices panel + the print monitor:
 * - `list_printers` — read the persisted printer list.
 * - `add_printer` — stash a new printer config.
 * - `update_printer` — edit an existing one (host, port, api key, name).
 * - `delete_printer` — drop a printer config.
 * - `get_printer_status` — snapshot one printer's live state via
 *   Moonraker (`/printer/objects/query`).
 * - `ping_printer` — cheap connectivity check (`/printer/info`).
 * - `start_print`, `pause_print`, `resume_print`, `cancel_print` — the
 *   four print-control verbs.
 *
 * Tools that take a `printer_id` accept either the persisted id (UUID)
 * or the human name as a fallback. The fallback matters for an LLM
 * that's reading the printer list and parroting back the name field
 * verbatim.
 */
internal object PrinterTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        ListPrinters(ctx),
        AddPrinter(ctx),
        UpdatePrinter(ctx),
        DeletePrinter(ctx),
        GetPrinterStatus(ctx),
        GetPrintProgress(ctx),
        PingPrinter(ctx),
        StartPrint(ctx),
        SendAndPrint(ctx),
        PausePrint(ctx),
        ResumePrint(ctx),
        CancelPrint(ctx),
    )

    /** Resolve the printer the LLM is referring to. Tries id first, then name (case-insensitive). */
    private suspend fun resolve(ctx: ToolContext, idOrName: String): PrinterConfig? {
        val list = ctx.printers.printers.first()
        return list.firstOrNull { it.id == idOrName }
            ?: list.firstOrNull { it.name.equals(idOrName, ignoreCase = true) }
    }

    private fun encodePrinter(p: PrinterConfig): JSONObject = JSONObject().apply {
        put("id", p.id)
        put("name", p.name)
        put("host", p.host)
        put("port", p.port)
        put("has_api_key", !p.apiKey.isNullOrBlank())
    }

    private fun encodeSnapshot(s: PrintSnapshot): JSONObject = JSONObject().apply {
        put("state", s.state)
        put("filename", s.filename)
        put("message", s.message)
        put("progress", s.progress)
        put("print_duration_sec", s.printDurationSec)
        put("total_duration_sec", s.totalDurationSec)
        if (s.currentLayer != null) put("current_layer", s.currentLayer)
        if (s.totalLayers != null) put("total_layers", s.totalLayers)
        put("nozzle_temp_c", s.nozzleTemp)
        put("nozzle_target_c", s.nozzleTarget)
        put("bed_temp_c", s.bedTemp)
        put("bed_target_c", s.bedTarget)
        if (s.slotLoaded.isNotEmpty()) {
            val arr = JSONArray()
            for (b in s.slotLoaded) arr.put(b)
            put("slot_loaded", arr)
        }
        s.etaSec?.let { put("eta_sec", it) }
        // C7 — digital-twin telemetry. Live Z and the byte position
        // into the active G-code file. Both nullable; missing when
        // Klipper hasn't reported them or no print is active.
        s.liveZmm?.let { put("live_z_mm", it) }
        s.gcodeFilePosition?.let { put("gcode_file_position", it) }
        s.gcodeFileSize?.let { put("gcode_file_size", it) }
    }

    /** Map a [MoonrakerResult] into the {ok, data, error} shape tools return. */
    private fun <T> moonrakerOutcome(
        result: MoonrakerResult<T>,
        successText: () -> String,
        successData: (T) -> JSONObject,
    ): ToolResult {
        return when (result) {
            is MoonrakerResult.Ok -> {
                val body = JSONObject()
                body.put("ok", true)
                body.put("data", successData(result.value))
                ToolResult.ok(successText(), body)
            }
            is MoonrakerResult.AuthError -> errorOutcome("auth_error", result.message)
            is MoonrakerResult.HttpError -> errorOutcome("http_${result.code}", "HTTP ${result.code}: ${result.body.take(200)}")
            is MoonrakerResult.NotFound -> errorOutcome("not_found", result.message)
            is MoonrakerResult.IoError -> errorOutcome("io_error", result.message)
        }
    }

    private fun errorOutcome(code: String, message: String): ToolResult {
        val body = JSONObject()
        body.put("ok", false)
        body.put("error_code", code)
        body.put("error_message", message)
        return ToolResult.error("${code}: $message", body)
    }

    // -------- list_printers --------

    class ListPrinters(private val ctx: ToolContext) : Tool {
        override val name = "list_printers"
        override val description =
            "List all configured Moonraker/Klipper printers (id, name, host, port, whether an API key is set). " +
                "Returns the persisted list — use add_printer to add one and delete_printer to remove."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val printers = ctx.printers.printers.first()
            val arr = JSONArray()
            for (p in printers) arr.put(encodePrinter(p))
            val body = JSONObject().apply {
                put("ok", true)
                put("count", printers.size)
                put("printers", arr)
            }
            val text = if (printers.isEmpty()) "No printers configured."
                else printers.joinToString("\n") { "- ${it.name} (${it.host}:${it.port}) id=${it.id}" }
            return ToolResult.ok(text, body)
        }
    }

    // -------- add_printer --------

    class AddPrinter(private val ctx: ToolContext) : Tool {
        override val name = "add_printer"
        override val description =
            "Add a new Moonraker printer to OrcaXR's persisted list. " +
                "Equivalent to filling out the Add Printer form in the Devices panel."
        override val inputSchema = Schemas.obj(
            required = listOf("name", "host"),
            properties = mapOf(
                "name" to Schemas.string("Display name (e.g. 'Snapmaker U1', 'Centauri Carbon')"),
                "host" to Schemas.string("IP address, mDNS name, or full URL of the Moonraker host"),
                "port" to Schemas.integer("Moonraker port (default 7125)"),
                "api_key" to Schemas.string("Optional Moonraker X-Api-Key. Leave blank if not required."),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val name = args.optString("name").trim()
            val host = args.optString("host").trim()
            if (name.isEmpty() || host.isEmpty()) {
                return ToolResult.error("Both 'name' and 'host' are required.")
            }
            val port = args.optInt("port", 7125).coerceIn(1, 65535)
            val apiKey = args.optString("api_key").ifBlank { null }
            val config = PrinterConfig(
                id = "p_${UUID.randomUUID()}",
                name = name,
                host = host,
                port = port,
                apiKey = apiKey,
            )
            ctx.printers.upsert(config)
            return ToolResult.ok(
                "Added printer '$name' at $host:$port (id=${config.id})",
                JSONObject().apply { put("ok", true); put("printer", encodePrinter(config)) },
            )
        }
    }

    // -------- update_printer --------

    class UpdatePrinter(private val ctx: ToolContext) : Tool {
        override val name = "update_printer"
        override val description =
            "Update a configured printer's name/host/port/api_key. Only fields you supply are changed; " +
                "omit a field to leave it unchanged. Pass api_key as empty string to clear a stored key."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf(
                "printer_id" to Schemas.string("Printer id (or name) from list_printers"),
                "name" to Schemas.string("New display name"),
                "host" to Schemas.string("New host"),
                "port" to Schemas.integer("New port"),
                "api_key" to Schemas.string("New API key (\"\" to clear)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("printer_id").trim()
            val current = resolve(ctx, id)
                ?: return ToolResult.error("No printer matches '$id'.")
            val updated = current.copy(
                name = if (args.has("name")) args.getString("name") else current.name,
                host = if (args.has("host")) args.getString("host") else current.host,
                port = if (args.has("port")) args.getInt("port") else current.port,
                apiKey = if (args.has("api_key")) args.getString("api_key").ifBlank { null } else current.apiKey,
            )
            ctx.printers.upsert(updated)
            return ToolResult.ok(
                "Updated printer '${updated.name}' (id=${updated.id})",
                JSONObject().apply { put("ok", true); put("printer", encodePrinter(updated)) },
            )
        }
    }

    // -------- delete_printer --------

    class DeletePrinter(private val ctx: ToolContext) : Tool {
        override val name = "delete_printer"
        override val description = "Remove a printer from OrcaXR's persisted list."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name) from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("printer_id").trim()
            val current = resolve(ctx, id)
                ?: return ToolResult.error("No printer matches '$id'.")
            ctx.printers.delete(current.id)
            return ToolResult.ok(
                "Deleted printer '${current.name}'",
                JSONObject().apply { put("ok", true); put("deleted_id", current.id) },
            )
        }
    }

    // -------- get_printer_status --------

    class GetPrinterStatus(private val ctx: ToolContext) : Tool {
        override val name = "get_printer_status"
        override val description =
            "Snapshot one printer's current state via Moonraker: print state " +
                "(standby/printing/paused/complete/cancelled/error), progress, layer, hot-end and bed temperatures, " +
                "filament-detect slot status, and ETA."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name) from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("printer_id").trim()
            val printer = resolve(ctx, id)
                ?: return ToolResult.error("No printer matches '$id'.")
            val client = MoonrakerClient(printer)
            val result = client.queryStatus()
            return moonrakerOutcome(
                result,
                successText = {
                    val s = (result as MoonrakerResult.Ok).value
                    "${printer.name}: ${s.state} (${"%.0f".format(s.progress * 100)}%, " +
                        "nozzle ${"%.0f".format(s.nozzleTemp)}/${"%.0f".format(s.nozzleTarget)}°C, " +
                        "bed ${"%.0f".format(s.bedTemp)}/${"%.0f".format(s.bedTarget)}°C)"
                },
                successData = ::encodeSnapshot,
            )
        }
    }

    // -------- get_print_progress --------

    class GetPrintProgress(private val ctx: ToolContext) : Tool {
        override val name = "get_print_progress"
        override val description =
            "Live print progress detail — fraction (0..1), live Z-height in mm, byte position " +
                "into the active gcode file, current vs total layers, ETA seconds, and the " +
                "derived layer index (binary-searched against the in-app parsed toolpath if a " +
                "matching slice is loaded). Useful for the digital-twin loop or for an LLM " +
                "checking whether a print is far enough along to start the next plate."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name)")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("printer_id").trim()
            val printer = resolve(ctx, id)
                ?: return ToolResult.error("No printer matches '$id'.")
            val client = MoonrakerClient(printer)
            val result = client.queryStatus()
            return moonrakerOutcome(
                result,
                successText = {
                    val s = (result as MoonrakerResult.Ok).value
                    val pct = "%.1f".format(s.progress * 100)
                    val eta = s.etaSec?.let { "%.0fs".format(it) } ?: "—"
                    val z = s.liveZmm?.let { "z=%.2fmm".format(it) } ?: "z=?"
                    "${printer.name}: ${s.state} $pct% ($z, eta=$eta)"
                },
                successData = { snap ->
                    JSONObject().apply {
                        put("state", snap.state)
                        put("progress", snap.progress)
                        snap.liveZmm?.let { put("live_z_mm", it) }
                        snap.gcodeFilePosition?.let { put("gcode_file_position", it) }
                        snap.gcodeFileSize?.let { put("gcode_file_size", it) }
                        snap.gcodeFileSize?.let { sz ->
                            snap.gcodeFilePosition?.let { pos ->
                                if (sz > 0) put("byte_progress", pos.toDouble() / sz)
                            }
                        }
                        snap.currentLayer?.let { put("current_layer", it) }
                        snap.totalLayers?.let { put("total_layers", it) }
                        snap.etaSec?.let { put("eta_sec", it) }
                        // Map liveZ → layer index against the WORKSPACE
                        // toolpath (if the user has the matching slice
                        // loaded). Mirrors what the digital-twin auto-
                        // follower does in MainActivity.
                        val ws = dev.orcaxr.app.mcp.WorkspaceModel.get()
                        val parsed = (ws.sliceState.value as? dev.orcaxr.app.SliceUiState.Done)?.parsed
                        val z = snap.liveZmm
                        if (parsed != null && z != null && parsed.layerZs.isNotEmpty()) {
                            val idx = parsed.layerZs.binarySearch(z).let {
                                if (it >= 0) it else -(it + 1) - 1
                            }.coerceIn(0, parsed.layerZs.lastIndex)
                            put("derived_layer_index", idx)
                            put("derived_layer_count", parsed.layerZs.size)
                        }
                    }
                },
            )
        }
    }

    // -------- ping_printer --------

    class PingPrinter(private val ctx: ToolContext) : Tool {
        override val name = "ping_printer"
        override val description =
            "Connectivity / liveness probe via /printer/info. Returns Klippy state (ready/startup/shutdown/error), " +
                "hostname, and software_version. Cheap — call this before mutating prints to check the host is reachable."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name) from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("printer_id").trim()
            val printer = resolve(ctx, id)
                ?: return ToolResult.error("No printer matches '$id'.")
            val result = MoonrakerClient(printer).ping()
            return moonrakerOutcome(
                result,
                successText = {
                    val info = (result as MoonrakerResult.Ok).value
                    "${printer.name}: state=${info.state}, host=${info.hostname}, ver=${info.softwareVersion}"
                },
                successData = { info ->
                    JSONObject().apply {
                        put("state", info.state)
                        put("klippy_state", info.klippyState)
                        put("hostname", info.hostname)
                        put("software_version", info.softwareVersion)
                    }
                },
            )
        }
    }

    // -------- start_print / pause_print / resume_print / cancel_print --------

    class StartPrint(private val ctx: ToolContext) : Tool {
        override val name = "start_print"
        override val description =
            "Begin printing a G-code file already on the printer's filesystem (e.g. uploaded via Mainsail or a previous slice→send). " +
                "Pass the remote filename as it appears in /server/files/list (typically 'gcodes/<file>.gcode'). " +
                "This does NOT upload — for upload+start use send_and_print."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id", "filename"),
            properties = mapOf(
                "printer_id" to Schemas.string("Printer id from list_printers"),
                "filename" to Schemas.string("Remote G-code filename, e.g. 'dragon.gcode'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolve(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            val filename = args.optString("filename").trim()
            if (filename.isEmpty()) return ToolResult.error("'filename' is required.")
            val result = MoonrakerClient(printer).startPrint(filename)
            return moonrakerOutcome(
                result,
                successText = { "${printer.name}: started print of $filename" },
                successData = { JSONObject().apply { put("filename", filename) } },
            )
        }
    }

    /**
     * UI mirror of the BottomRightSummaryPanel "Send & Print" button:
     * apply pre-print options to the most-recently-sliced g-code, push
     * it to the printer, optionally toggle moonraker-timelapse, and
     * start the print. Mirrors OrcaSlicer's pre-print toggles for
     * Klipper hosts (their Bambu-only toggles don't translate; ours are
     * Klipper-native — `BED_MESH_CALIBRATE` and the moonraker-timelapse
     * component).
     */
    class SendAndPrint(private val ctx: ToolContext) : Tool {
        override val name = "send_and_print"
        override val description =
            "Upload the most-recently-sliced G-code to the printer and start the print. Optional pre-print toggles: " +
                "`bed_mesh_calibrate` injects `BED_MESH_CALIBRATE` before the print; `timelapse` injects " +
                "`TIMELAPSE_TAKE_FRAME` at every layer change and enables the moonraker-timelapse component on the host " +
                "(requires the component to be installed; we no-op gracefully when it isn't). Requires that the user has " +
                "already sliced something — read the slice state via the workspace bindings first."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf(
                "printer_id" to Schemas.string("Printer id (or name) from list_printers"),
                "bed_mesh_calibrate" to Schemas.bool("Run BED_MESH_CALIBRATE before the print (adds 30–90 s). Default false."),
                "timelapse" to Schemas.bool("Record a timelapse via the moonraker-timelapse component. Default false."),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("printer_id").trim()
            val printer = resolve(ctx, id)
                ?: return ToolResult.error("No printer matches '$id'.")

            // Pull the latest slice's outputPath off the workspace
            // model. The UI Send & Print button is gated on this being
            // a SliceResult.Success — surface the same precondition to
            // the LLM as a clear error instead of failing later in the
            // upload.
            val ws = dev.orcaxr.app.mcp.WorkspaceModel.get()
            val sliceState = ws.sliceState.value
            val sliced = (sliceState as? dev.orcaxr.app.SliceUiState.Done)?.result
                as? dev.orcaxr.app.SliceResult.Success
                ?: return ToolResult.error(
                    "No sliced output. Slice a model first (the BottomRightSummaryPanel's Slice button, or wait for an in-flight slice to complete)."
                )
            val gcode = java.io.File(sliced.outputPath)
            if (!gcode.exists()) {
                return ToolResult.error("Sliced g-code is missing on disk: ${sliced.outputPath}")
            }

            val options = dev.orcaxr.app.PrintOptions(
                bedMeshCalibrate = args.optBoolean("bed_mesh_calibrate", false),
                timelapse = args.optBoolean("timelapse", false),
            )
            val injected = dev.orcaxr.app.applyPrintOptionsToGcode(gcode, options)
            val client = MoonrakerClient(printer)

            // Toggle timelapse to match the user pick. Same lenient
            // handling as the UI path: not-installed → ignore; auth
            // failures abort because the same key is about to be used
            // for the upload.
            if (options.timelapse) {
                when (val t = client.setTimelapseEnabled(true)) {
                    is MoonrakerResult.Ok, is MoonrakerResult.NotFound -> { /* fine */ }
                    is MoonrakerResult.AuthError -> return errorOutcome("auth_error", t.message)
                    is MoonrakerResult.HttpError -> { /* warn-only */ }
                    is MoonrakerResult.IoError -> { /* warn-only */ }
                }
            }

            val remote = "orcaxr-${injected.name}"
            val upload = client.uploadGcode(injected, remote)
            if (injected != gcode) injected.delete()
            val uploadedAs = (upload as? MoonrakerResult.Ok)?.value
                ?: return moonrakerOutcome(
                    upload,
                    successText = { "${printer.name}: upload ok" },
                    successData = { JSONObject() },
                )
            val start = client.startPrint(uploadedAs)
            return moonrakerOutcome(
                start,
                successText = {
                    val opts = buildString {
                        if (options.bedMeshCalibrate) append(", bed mesh")
                        if (options.timelapse) append(", timelapse")
                    }
                    "${printer.name}: started print of $uploadedAs$opts"
                },
                successData = {
                    JSONObject().apply {
                        put("filename", uploadedAs)
                        put("bed_mesh_calibrate", options.bedMeshCalibrate)
                        put("timelapse", options.timelapse)
                    }
                },
            )
        }
    }

    class PausePrint(private val ctx: ToolContext) : Tool {
        override val name = "pause_print"
        override val description = "Pause the currently-running print on this printer."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolve(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            return moonrakerOutcome(
                MoonrakerClient(printer).pausePrint(),
                successText = { "${printer.name}: pause requested" },
                successData = { JSONObject() },
            )
        }
    }

    class ResumePrint(private val ctx: ToolContext) : Tool {
        override val name = "resume_print"
        override val description = "Resume a paused print on this printer."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolve(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            return moonrakerOutcome(
                MoonrakerClient(printer).resumePrint(),
                successText = { "${printer.name}: resume requested" },
                successData = { JSONObject() },
            )
        }
    }

    class CancelPrint(private val ctx: ToolContext) : Tool {
        override val name = "cancel_print"
        override val description =
            "Cancel the currently-running print on this printer. Klipper homes/disengages then returns to standby."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolve(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            return moonrakerOutcome(
                MoonrakerClient(printer).cancelPrint(),
                successText = { "${printer.name}: cancel requested" },
                successData = { JSONObject() },
            )
        }
    }
}
