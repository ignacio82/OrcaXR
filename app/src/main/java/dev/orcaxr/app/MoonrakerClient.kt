package dev.orcaxr.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Klipper printers expose Moonraker — a small HTTP/WebSocket gateway
 * documented at https://moonraker.readthedocs.io. Both targets we care
 * about (Snapmaker U1, Elegoo Centauri Carbon) ship Klipper + Moonraker
 * by default, so this one client covers both.
 *
 * Implementation note: this used to be a thin wrapper around Android's
 * HttpURLConnection. On the user's LAN every Moonraker probe via
 * HttpURLConnection failed with `SocketException("closed")` while
 * `curl` from the same headset shell answered fine — Mainsail's nginx
 * tears down keepalive aggressively and HttpURLConnection's pool
 * disliked it (Connection: close + http.keepAlive=false didn't fix it).
 * OkHttp handles the same connections cleanly, so we use that.
 *
 * All public entry points run on `Dispatchers.IO`.
 */
class MoonrakerClient(
    private val printer: PrinterConfig,
    private val connectTimeoutMs: Long = 5_000L,
    /**
     * Upload timeout for both read AND write halves of a `/server/files/
     * upload` POST. 180 s covers a worst-case 17 MB dragon gcode over
     * a slow Wi-Fi link (~5 Mbps = ~30 s body transfer) plus
     * Moonraker's validate+write+respond cycle on a Pi-class host
     * (~5–15 s). Field bug: the previous 60 s value combined with a
     * 5 s readTimeout caused "Upload timeout" failures even on healthy
     * uploads where the body had already arrived.
     */
    private val uploadTimeoutMs: Long = 180_000L,
) {

    private val TAG: String = "OrcaXR/moonraker"


    private val http: OkHttpClient = sharedClient
        .newBuilder()
        .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
        .writeTimeout(uploadTimeoutMs, TimeUnit.MILLISECONDS)
        // Moonraker fronted by Mainsail's nginx misbehaves with
        // keepalive on Android XR — first read on a pooled socket
        // throws "closed" before responseCode lands. Disabling
        // pooling matches what curl does (one socket per request).
        .connectionPool(okhttp3.ConnectionPool(0, 1, TimeUnit.SECONDS))
        .retryOnConnectionFailure(true)
        .build()

    companion object {
        private val sharedClient = OkHttpClient()

        /**
         * Try several common ports against this printer's host until one
         * answers `/printer/info`. Returns the [PrinterConfig] that
         * actually worked (so callers can persist the corrected port)
         * plus the ping result.
         */
        suspend fun probe(printer: PrinterConfig): Pair<PrinterConfig, MoonrakerResult<PrinterInfo>> {
            val candidates = linkedSetOf(printer.port, 8080, 80, 7125).filter { it > 0 }
            var lastFailure: MoonrakerResult<PrinterInfo> =
                MoonrakerResult.IoError("no port candidates")
            for (port in candidates) {
                val cfg = printer.copy(port = port)
                val result = MoonrakerClient(cfg).ping()
                if (result is MoonrakerResult.Ok) return cfg to result
                lastFailure = result
            }
            return printer to lastFailure
        }

        /** Plain TCP connect probe. Used by SubnetScanner to fast-reject dead IPs. */
        suspend fun isPortOpen(host: String, port: Int, timeoutMs: Int = 250): Boolean =
            withContext(Dispatchers.IO) {
                runCatching {
                    java.net.Socket().use { s ->
                        s.connect(java.net.InetSocketAddress(host, port), timeoutMs)
                        s.isConnected
                    }
                }.getOrDefault(false)
            }
    }

    /** GET /printer/info — also doubles as a connection / auth probe. */
    suspend fun ping(): MoonrakerResult<PrinterInfo> = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(baseUrl() + "/printer/info")
            .header("Accept", "application/json")
            .applyApiKey()
            .get()
            .build()
        execute(req) { body ->
            val obj = JSONObject(body).optJSONObject("result") ?: JSONObject()
            MoonrakerResult.Ok(
                PrinterInfo(
                    state = obj.optString("state", "unknown"),
                    klippyState = obj.optString("klippy_state", "unknown"),
                    hostname = obj.optString("hostname", ""),
                    softwareVersion = obj.optString("software_version", ""),
                ),
            )
        }
    }

    /**
     * POST /server/files/upload — multipart with `file` (G-code bytes)
     * and `print=false`. Returns the filename Moonraker assigned.
     *
     * The shared `http` client uses a 5 s readTimeout — too tight for
     * large multipart uploads where, after the bytes are sent,
     * Moonraker still has to validate + write to disk + respond. On
     * the Snapmaker U1 the 17 MB dragon gcode took ~7 s of
     * post-body processing in the field, hitting the 5 s readTimeout
     * with "Upload timeout (…/server/files/upload)" before the
     * 200 OK arrived. We use a separate client here with the upload
     * timeout applied to BOTH read and write directions, plus a
     * total per-call cap via Call.timeout() so a stuck connection
     * eventually surfaces instead of hanging forever.
     */
    suspend fun uploadGcode(
        local: File,
        remoteName: String = local.name,
        /**
         * Optional progress callback. Fires from the OkHttp write thread
         * (NOT the main thread) every time the request body sink writes
         * a chunk. `bytesSent` is monotonic, `totalBytes` is the file
         * size. Throttle on the caller side if you're updating Compose
         * state — emissions are at multipart-buffer granularity (8 KB
         * by default).
         */
        onProgress: ((bytesSent: Long, totalBytes: Long) -> Unit)? = null,
    ): MoonrakerResult<String> =
        withContext(Dispatchers.IO) {
            if (!local.exists()) return@withContext MoonrakerResult.IoError("file not found: ${local.absolutePath}")
            val sizeKB = local.length() / 1024
            android.util.Log.i(TAG, "uploadGcode start: ${local.name} ${sizeKB}KB → ${baseUrl()}/server/files/upload")
            val t0 = System.currentTimeMillis()

            // Wrap the file's RequestBody so OkHttp pushes a
            // "bytesSent" tick after each chunk write. Multipart adds a
            // small header/footer overhead (~200 bytes per part) — we
            // just count the file body itself for the user-facing
            // progress bar; the boundary bytes are noise.
            val totalBytes = local.length()
            val rawBody = local.asRequestBody("application/octet-stream".toMediaType())
            val countingBody = if (onProgress == null) rawBody else object : okhttp3.RequestBody() {
                override fun contentType() = rawBody.contentType()
                override fun contentLength() = totalBytes
                override fun writeTo(sink: okio.BufferedSink) {
                    // Stream the file in 64 KB chunks and tick after
                    // each. We don't go through ForwardingSink + okio
                    // .buffer() because okio's top-level buffer()
                    // function is renamed across okio versions and we
                    // don't want to depend on the exact API surface.
                    // Direct read+write+flush is just as fast for files
                    // and gives us a deterministic progress cadence.
                    val chunk = ByteArray(64 * 1024)
                    var sent = 0L
                    java.io.FileInputStream(local).use { fis ->
                        while (true) {
                            val n = fis.read(chunk)
                            if (n <= 0) break
                            sink.write(chunk, 0, n)
                            sent += n
                            onProgress(sent, totalBytes)
                        }
                    }
                    sink.flush()
                }
            }

            val mp = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart(
                    "file",
                    remoteName,
                    countingBody,
                )
                .addFormDataPart("print", "false")
                .build()

            val req = Request.Builder()
                .url(baseUrl() + "/server/files/upload")
                .header("Accept", "application/json")
                .applyApiKey()
                .post(mp)
                .build()

            // Dedicated upload client — readTimeout matches uploadTimeoutMs
            // so the post-body server processing window is generous, not
            // gated by the 5 s connect-timeout-style readTimeout the rest
            // of the API uses for short JSON responses.
            val uploadClient = http.newBuilder()
                .readTimeout(uploadTimeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(uploadTimeoutMs, TimeUnit.MILLISECONDS)
                .callTimeout(uploadTimeoutMs * 2, TimeUnit.MILLISECONDS)
                .build()

            try {
                uploadClient.newCall(req).execute().use { response ->
                    val elapsedMs = System.currentTimeMillis() - t0
                    val code = response.code
                    val body = response.body?.string().orEmpty()
                    android.util.Log.i(TAG, "uploadGcode done: HTTP $code in ${elapsedMs}ms (${sizeKB}KB)")
                    when {
                        response.isSuccessful -> {
                            val item = JSONObject(body).optJSONObject("item") ?: JSONObject()
                            MoonrakerResult.Ok(item.optString("path", remoteName))
                        }
                        code == 401 || code == 403 -> MoonrakerResult.AuthError(
                            "Moonraker rejected the API key (HTTP $code).",
                        )
                        code == 404 -> MoonrakerResult.NotFound(
                            "Upload endpoint not found (HTTP 404). Is this a Moonraker host?",
                        )
                        code == 413 -> MoonrakerResult.HttpError(
                            413,
                            "Upload too large (HTTP 413). Increase nginx client_max_body_size.",
                        )
                        else -> MoonrakerResult.HttpError(code, body)
                    }
                }
            } catch (e: Throwable) {
                val elapsedMs = System.currentTimeMillis() - t0
                val why = e.message ?: e::class.simpleName ?: "io error"
                android.util.Log.e(TAG, "uploadGcode failed in ${elapsedMs}ms: $why", e)
                MoonrakerResult.IoError("$why (after ${elapsedMs}ms, ${sizeKB}KB)")
            }
        }

    /**
     * GET /printer/objects/query — bundle of subscriptions: print_stats
     * (state, filename, durations, layer info), virtual_sdcard
     * (progress 0..1), display_status (progress + slicer message),
     * extruder + heater_bed (current/target). One round-trip per poll
     * tick, ~1 KB response — cheap.
     */
    suspend fun queryStatus(): MoonrakerResult<PrintSnapshot> = withContext(Dispatchers.IO) {
        // Moonraker's /printer/objects/query accepts the object set
        // either as a POST body or as URL params (`?print_stats=` etc.).
        // The URL-param form is simpler and works with no body.
        //
        // Phase I.2: also subscribe to `filament_detect` so the
        // PrintMonitorPanel can surface "Slot N empty" badges during
        // active prints (Snapmaker U1 firmware ≥ v1.2 exposes per-tool
        // runout there). Non-Snapmaker Klipper hosts return no
        // filament_detect block — that path falls back to an empty
        // List<Boolean>, badges hide.
        val url = baseUrl() + "/printer/objects/query" +
            "?print_stats&virtual_sdcard&display_status&extruder&heater_bed&filament_detect"
        val req = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .applyApiKey()
            .get()
            .build()
        execute(req) { body ->
            val status = JSONObject(body)
                .optJSONObject("result")
                ?.optJSONObject("status")
                ?: JSONObject()
            MoonrakerResult.Ok(PrintSnapshot.parse(status))
        }
    }

    /** POST /printer/print/start?filename=… — kicks off the print. */
    suspend fun startPrint(remoteName: String): MoonrakerResult<Unit> = withContext(Dispatchers.IO) {
        val encoded = URLEncoder.encode(remoteName, "UTF-8")
        // Moonraker accepts an empty body for start; some firmwares
        // are picky about Content-Length so we send a zero-length body
        // explicitly rather than letting OkHttp infer.
        postEmpty("/printer/print/start?filename=$encoded")
    }

    /** POST /printer/print/pause — Klipper interprets via PAUSE macro. */
    suspend fun pausePrint(): MoonrakerResult<Unit> = withContext(Dispatchers.IO) {
        postEmpty("/printer/print/pause")
    }

    /** POST /printer/print/resume — Klipper interprets via RESUME macro. */
    suspend fun resumePrint(): MoonrakerResult<Unit> = withContext(Dispatchers.IO) {
        postEmpty("/printer/print/resume")
    }

    /** POST /printer/print/cancel — stops the print and parks. */
    suspend fun cancelPrint(): MoonrakerResult<Unit> = withContext(Dispatchers.IO) {
        postEmpty("/printer/print/cancel")
    }

    /**
     * Read the printer's currently-loaded filament slots via the
     * Snapmaker U1 firmware's `print_task_config` Klipper object.
     * The U1 keeps per-tool color/type/vendor in this object whenever
     * the user has assigned filaments via the printer's touchscreen
     * (or via a previous Bambu/MakerWorld import). Firmware ≥ v1.2.0
     * exposes it; older firmware returns an empty result and we
     * report [MoonrakerResult.NotFound] so the caller can prompt
     * the user to enter filaments manually.
     *
     * Response shape (parallel arrays indexed by tool slot 0..N):
     * ```
     * "filament_color_rgba": ["E72F1DFF", "1F8FE7FF", ...]
     * "filament_type":       ["PLA",      "PETG",     ...]
     * "filament_sub_type":   ["Basic",    "HF",       ...]
     * "filament_vendor":     ["Bambu",    "Polymaker",...]
     * "filament_exist":      [1,          1,          ...]
     * ```
     *
     * Slot color hex is `RRGGBBAA` (no `#`); we strip the alpha and
     * prepend `#` to match the rest of OrcaXR's [FilamentEntry]
     * convention. Unknown / "Default" filament types fall back to
     * "PLA" so the picker UI shows something selectable.
     */
    suspend fun queryFilamentSlots(): MoonrakerResult<List<FilamentSlot>> = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(baseUrl() + "/printer/objects/query?print_task_config=&filament_detect=")
            .header("Accept", "application/json")
            .applyApiKey()
            .get()
            .build()
        execute(req) { body ->
            val status = JSONObject(body)
                .optJSONObject("result")
                ?.optJSONObject("status")
                ?: JSONObject()
            val cfg = status.optJSONObject("print_task_config")
            if (cfg == null) {
                MoonrakerResult.NotFound(
                    "Printer didn't expose print_task_config. " +
                        "Update Snapmaker firmware to v1.2.0 or later, " +
                        "or fall back to manual filament entry."
                )
            } else {
                MoonrakerResult.Ok(parseFilamentSlots(cfg))
            }
        }
    }

    /**
     * GET /webcam/?action=snapshot — Mainsail/Fluidd's crowsnest proxy
     * exposes a JPEG snapshot of the configured stream at this URL.
     * Returns the raw bytes; caller decodes via BitmapFactory.
     *
     * If the printer doesn't have a webcam configured (or
     * crowsnest/mjpgstreamer isn't running) the response is a 404 and
     * we report NotFound — UI hides the preview cleanly.
     */
    suspend fun fetchWebcamSnapshot(): MoonrakerResult<ByteArray> = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(baseUrl() + "/webcam/?action=snapshot")
            .header("Accept", "image/jpeg")
            .applyApiKey()
            .get()
            .build()
        try {
            http.newCall(req).execute().use { response ->
                val code = response.code
                when {
                    response.isSuccessful -> {
                        val bytes = response.body?.bytes() ?: ByteArray(0)
                        if (bytes.isEmpty()) MoonrakerResult.IoError("empty body (${req.url})")
                        else MoonrakerResult.Ok(bytes)
                    }
                    code == 404 -> MoonrakerResult.NotFound("No webcam at /webcam/?action=snapshot")
                    code == 401 || code == 403 -> MoonrakerResult.AuthError(
                        "Webcam fetch rejected (HTTP $code).",
                    )
                    else -> MoonrakerResult.HttpError(code, "")
                }
            }
        } catch (e: Throwable) {
            MoonrakerResult.IoError(e.message ?: e::class.simpleName ?: "io error")
        }
    }

    private fun postEmpty(path: String): MoonrakerResult<Unit> {
        val req = Request.Builder()
            .url(baseUrl() + path)
            .header("Accept", "application/json")
            .applyApiKey()
            .post("".toRequestBody(null))
            .build()
        return execute(req) { _ -> MoonrakerResult.Ok(Unit) }
    }

    private fun Request.Builder.applyApiKey(): Request.Builder {
        val key = printer.apiKey
        if (!key.isNullOrBlank()) header("X-Api-Key", key)
        return this
    }

    private inline fun <T> execute(
        request: Request,
        crossinline onOk: (String) -> MoonrakerResult<T>,
    ): MoonrakerResult<T> {
        return try {
            http.newCall(request).execute().use { response ->
                val code = response.code
                val body = response.body?.string().orEmpty()
                when {
                    response.isSuccessful -> onOk(body)
                    code == 401 || code == 403 -> MoonrakerResult.AuthError(
                        "Moonraker rejected the API key (HTTP $code). Check the X-Api-Key in the printer's moonraker.conf.",
                    )
                    code == 404 -> MoonrakerResult.NotFound(
                        "Endpoint not found (HTTP 404). Is this a Moonraker host?",
                    )
                    else -> MoonrakerResult.HttpError(code, body)
                }
            }
        } catch (e: Throwable) {
            val why = e.message ?: e::class.simpleName ?: "io error"
            MoonrakerResult.IoError("$why (${request.url})")
        }
    }

    private fun baseUrl(): String {
        val raw = printer.host.trim().trimEnd('/')
        val withScheme = if (raw.startsWith("http://") || raw.startsWith("https://")) raw else "http://$raw"
        return when {
            raw.contains(':') && !raw.startsWith("http") -> withScheme
            printer.port == 80 || printer.port == 0 -> withScheme
            else -> "$withScheme:${printer.port}"
        }
    }
}

/** Minimal subset of Moonraker's printer/info payload we currently surface. */
data class PrinterInfo(
    val state: String,
    val klippyState: String,
    val hostname: String,
    val softwareVersion: String,
)

/**
 * One poll's worth of live print state. Fields are nullable when
 * Moonraker hasn't reported them (e.g. `print_stats.info.current_layer`
 * only shows up if the slicer emitted `SET_PRINT_STATS_INFO` — Orca
 * does, so we usually have it during a print).
 *
 * `state` follows Klipper's print_stats.state: `standby` / `printing`
 * / `paused` / `complete` / `cancelled` / `error`.
 */
data class PrintSnapshot(
    val state: String,
    val filename: String,
    val message: String,
    val progress: Float,           // 0..1, from virtual_sdcard preferred over display_status
    val printDurationSec: Float,   // time spent extruding (excludes pauses)
    val totalDurationSec: Float,   // wall-clock since print start
    val currentLayer: Int?,
    val totalLayers: Int?,
    val nozzleTemp: Float,
    val nozzleTarget: Float,
    val bedTemp: Float,
    val bedTarget: Float,
    /**
     * Phase I.2 — per-slot runout state. true = filament present,
     * false = empty (the U1 firmware reports this via
     * `filament_detect.filament_exist`, parallel to the slot indices
     * in [queryFilamentSlots]). Empty list = printer didn't expose
     * it (older firmware, non-Snapmaker Klipper); the UI hides the
     * runout badges in that case rather than guessing.
     */
    val slotLoaded: List<Boolean> = emptyList(),
) {
    val isActive: Boolean get() = state == "printing" || state == "paused"

    /** Linear-extrapolation ETA. Crude but useful in the first few minutes. */
    val etaSec: Float? get() {
        if (progress <= 0f || progress >= 1f) return null
        if (printDurationSec <= 0f) return null
        return printDurationSec / progress - printDurationSec
    }

    companion object {
        fun parse(status: JSONObject): PrintSnapshot {
            val ps = status.optJSONObject("print_stats") ?: JSONObject()
            val sdcard = status.optJSONObject("virtual_sdcard") ?: JSONObject()
            val display = status.optJSONObject("display_status") ?: JSONObject()
            val ex = status.optJSONObject("extruder") ?: JSONObject()
            val bed = status.optJSONObject("heater_bed") ?: JSONObject()

            val info = ps.optJSONObject("info") ?: JSONObject()
            val curLayer = info.opt("current_layer")?.takeIf { it !is JSONObject }
                ?.toString()?.toIntOrNull()
            val totalLayer = info.opt("total_layer")?.takeIf { it !is JSONObject }
                ?.toString()?.toIntOrNull()

            // virtual_sdcard.progress is more accurate than
            // display_status.progress in practice (the latter caps at
            // 0.0 if the slicer doesn't send M73). Prefer it; fall
            // back to display_status when sdcard hasn't started.
            val sdProgress = sdcard.opt("progress")?.toString()?.toFloatOrNull() ?: 0f
            val dispProgress = display.opt("progress")?.toString()?.toFloatOrNull() ?: 0f
            val progress = if (sdProgress > 0f) sdProgress else dispProgress

            // Phase I.2 — per-slot runout state from filament_detect
            // (U1 firmware ≥ 1.2). The same accept-bool-or-int dance
            // as parseFilamentSlots so older firmware reporting
            // 0/1 ints isn't silently dropped. Empty when the
            // printer didn't expose the object (non-Snapmaker
            // Klipper hosts).
            val detect = status.optJSONObject("filament_detect")
            val slotLoaded: List<Boolean> = if (detect == null) emptyList() else {
                val a = detect.optJSONArray("filament_exist")
                if (a == null) emptyList() else (0 until a.length()).map { i ->
                    when (val v = a.opt(i)) {
                        is Boolean -> v
                        is Int -> v != 0
                        is Number -> v.toInt() != 0
                        is String -> v.equals("true", ignoreCase = true) || v == "1"
                        else -> true   // be permissive on missing entries
                    }
                }
            }

            return PrintSnapshot(
                state = ps.optString("state", "unknown"),
                filename = ps.optString("filename", ""),
                message = ps.optString("message", "").ifBlank { display.optString("message", "") },
                progress = progress.coerceIn(0f, 1f),
                printDurationSec = ps.opt("print_duration")?.toString()?.toFloatOrNull() ?: 0f,
                totalDurationSec = ps.opt("total_duration")?.toString()?.toFloatOrNull() ?: 0f,
                currentLayer = curLayer,
                totalLayers = totalLayer,
                nozzleTemp = ex.opt("temperature")?.toString()?.toFloatOrNull() ?: 0f,
                nozzleTarget = ex.opt("target")?.toString()?.toFloatOrNull() ?: 0f,
                bedTemp = bed.opt("temperature")?.toString()?.toFloatOrNull() ?: 0f,
                bedTarget = bed.opt("target")?.toString()?.toFloatOrNull() ?: 0f,
                slotLoaded = slotLoaded,
            )
        }
    }
}

/**
 * One filament loaded into the printer's tool slot N. Sourced from
 * the Snapmaker U1's `print_task_config` Klipper object via
 * [MoonrakerClient.queryFilamentSlots]. Empty slots (no filament
 * loaded) are excluded from the returned list — `slotIndex` is the
 * physical tool number and may have gaps.
 *
 * `colorHex` is `#RRGGBB` (alpha stripped from the firmware's RGBA).
 * `material` is normalised to a value the [FilamentEntry] type
 * picker recognises (PLA / PETG / ABS / TPU / ASA / PA / PVA);
 * unknown vendor extensions like "Basic" or "HF" are folded into
 * the closest base material.
 */
data class FilamentSlot(
    val slotIndex: Int,
    val colorHex: String,
    val material: String,
    val vendor: String,
)

private fun parseFilamentSlots(cfg: JSONObject): List<FilamentSlot> {
    fun arr(key: String): List<String> {
        val a = cfg.optJSONArray(key) ?: return emptyList()
        return (0 until a.length()).map { a.optString(it, "") }
    }
    fun bools(key: String): List<Boolean> {
        // U1 firmware (1.3.x) returns true/false JSON booleans here,
        // but earlier docs / older firmware sometimes used 0/1 ints.
        // Accept either: optBoolean handles JSON `true`/`false`,
        // optInt handles `1`/`0`. Both fall back to "loaded" so we
        // err on the side of showing a slot rather than dropping it.
        val a = cfg.optJSONArray(key) ?: return emptyList()
        return (0 until a.length()).map {
            val v = a.opt(it)
            when (v) {
                is Boolean -> v
                is Int -> v != 0
                is Number -> v.toInt() != 0
                is String -> v.equals("true", ignoreCase = true) || v == "1"
                else -> true
            }
        }
    }
    val colors = arr("filament_color_rgba")
    val types = arr("filament_type")
    val vendors = arr("filament_vendor")
    val exists = bools("filament_exist")
    val n = colors.size
    if (n == 0) return emptyList()
    return (0 until n).mapNotNull { i ->
        // Skip explicitly-empty slots. If filament_exist isn't
        // populated (older firmware), assume loaded — better to
        // show a slot the user can dismiss than to silently drop it.
        val loaded = if (i < exists.size) exists[i] else true
        if (!loaded) return@mapNotNull null
        FilamentSlot(
            slotIndex = i,
            colorHex = normalizeRgbaHex(colors.getOrNull(i) ?: ""),
            material = normalizeMaterial(types.getOrNull(i) ?: ""),
            vendor = vendors.getOrNull(i).orEmpty(),
        )
    }
}

/** Convert "RRGGBBAA" (or "RRGGBB", or "#RRGGBB") to "#RRGGBB". */
private fun normalizeRgbaHex(raw: String): String {
    val cleaned = raw.trim().trimStart('#').uppercase()
    val rgb = when {
        cleaned.length >= 6 -> cleaned.substring(0, 6)
        else -> "FFFFFF"
    }
    return "#$rgb"
}

/**
 * Normalise the firmware's filament_type field to a string the
 * FilamentEntry picker understands. Snapmaker / Bambu firmware
 * sometimes carries vendor sub-types ("PLA Basic", "PLA-CF",
 * "PETG-HF") — collapse to the base material. Unknown values
 * default to PLA so the picker doesn't show a blank type.
 */
private fun normalizeMaterial(raw: String): String {
    val upper = raw.trim().uppercase()
    return when {
        upper.startsWith("PLA") -> "PLA"
        upper.startsWith("PETG") -> "PETG"
        upper.startsWith("ABS") -> "ABS"
        upper.startsWith("ASA") -> "ASA"
        upper.startsWith("TPU") -> "TPU"
        upper.startsWith("PA") -> "PA"
        upper.startsWith("PVA") -> "PVA"
        else -> "PLA"
    }
}

/** Discriminated result so callers can branch on the failure mode. */
sealed interface MoonrakerResult<out T> {
    data class Ok<T>(val value: T) : MoonrakerResult<T>
    data class HttpError(val code: Int, val body: String) : MoonrakerResult<Nothing>
    data class AuthError(val message: String) : MoonrakerResult<Nothing>
    data class NotFound(val message: String) : MoonrakerResult<Nothing>
    data class IoError(val message: String) : MoonrakerResult<Nothing>
}
