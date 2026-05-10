package dev.orcaxr.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Snapmaker U1 / Klipper / Moonraker live-view session.
 *
 * The previous implementation poked `/webcam/?action=snapshot` (the
 * mjpg-streamer / crowsnest URL). That works on stock MainsailOS /
 * FluiddPi but the Snapmaker U1 firmware doesn't run mjpg-streamer —
 * it ships a Moonraker plugin that publishes the camera through the
 * standard `/server/webcams/list` API and serves frames at
 * `/server/files/camera/monitor.jpg`. Crucially, U1's camera goes idle
 * after a few seconds and only refreshes monitor.jpg when something
 * pings `camera.start_monitor` over the Moonraker WebSocket. Without
 * that wake-up, the frame is either 404 or a stale image from minutes
 * ago.
 *
 * A [WebcamSession] handles all of that:
 *
 *  - On first [fetchFrame], queries `/server/webcams/list` to pick up
 *    the printer-advertised snapshot URL, with a static fallback list
 *    that includes both the U1 path and the legacy mjpg path so
 *    Mainsail / Fluidd / Snapmaker / Centauri Carbon all work without
 *    a config switch.
 *  - Spawns a 2 s wake keepalive coroutine the first time it sees a
 *    successful frame from the U1 path (other printers ignore the
 *    WebSocket call — it returns harmlessly).
 *  - Caches the working candidate index across calls so we're not
 *    re-walking the candidate list every frame.
 *  - Switches to the next candidate after [FAIL_THRESHOLD] consecutive
 *    failures so a transient hiccup on the working URL doesn't kill
 *    the live view forever.
 *
 * The same session object is consumed by both the XR
 * `PrintMonitorPanel` and the phone `MonitorScreen` — render fidelity
 * and tear-down behaviour are identical.
 *
 * Sessions are lightweight (one OkHttp client reference, one
 * WebSocket job) but NOT thread-safe across concurrent fetch callers
 * — drive each session from a single coroutine.
 */
class WebcamSession(
    private val printer: PrinterConfig,
    private val baseUrl: String,
    private val httpClient: OkHttpClient,
    private val applyApiKey: (Request.Builder) -> Request.Builder,
) {

    @Volatile private var candidates: List<String>? = null
    @Volatile private var workingIndex: Int = 0
    @Volatile private var consecutiveFailures: Int = 0
    @Volatile private var wakeJob: Job? = null

    /**
     * Fetch one JPEG frame. Returns [MoonrakerResult.Ok] with the raw
     * bytes, [MoonrakerResult.NotFound] only when *every* candidate is
     * confirmed 404 (no webcam configured), or a transient error
     * otherwise.
     */
    suspend fun fetchFrame(): MoonrakerResult<ByteArray> = withContext(Dispatchers.IO) {
        val list = candidates ?: discoverCandidates().also { candidates = it }
        if (list.isEmpty()) return@withContext MoonrakerResult.NotFound("No webcam candidates discovered")

        // Try candidates starting at the cached working index, walking
        // forward modulo the list size. We don't reset workingIndex
        // every call — that's the point of the cache. But we DO bump
        // it forward after FAIL_THRESHOLD strikes so we recover from a
        // candidate that was working but then died.
        repeat(list.size) { offset ->
            val idx = (workingIndex + offset) % list.size
            val url = withCacheBuster(list[idx])
            val result = fetchOne(url)
            if (result is MoonrakerResult.Ok) {
                if (idx != workingIndex) workingIndex = idx
                consecutiveFailures = 0
                return@withContext result
            }
            // 404 from a single candidate isn't conclusive — different
            // firmwares 404 different paths. Keep walking.
        }
        consecutiveFailures++
        // If every candidate has failed too many times, surface a
        // NotFound so the caller can hide the panel cleanly.
        if (consecutiveFailures >= FAIL_THRESHOLD * list.size) {
            MoonrakerResult.NotFound("All webcam candidates failed")
        } else {
            MoonrakerResult.IoError("Webcam fetch failed (transient)")
        }
    }

    /**
     * Start the U1 keepalive WebSocket pulse (`camera.start_monitor`).
     * Idempotent: subsequent calls are no-ops while the prior job is
     * still running. Safe to call on non-Snapmaker hosts — the message
     * is silently ignored.
     */
    fun startWakePulse(scope: CoroutineScope) {
        val existing = wakeJob
        if (existing != null && existing.isActive) return
        wakeJob = scope.launch(Dispatchers.IO) {
            while (isActive) {
                runCatching { wakeOnce() }
                delay(WAKE_INTERVAL_MS)
            }
        }
    }

    /** Stop the keepalive pulse. Safe to call multiple times. */
    fun stopWakePulse() {
        wakeJob?.cancel()
        wakeJob = null
    }

    /**
     * Public one-shot wake — used by [MoonrakerClient.fetchWebcamSnapshot]
     * when the first frame attempt failed and we want to nudge a
     * dormant U1 camera before retrying.
     */
    suspend fun wakeOncePublic() = wakeOnce()

    /**
     * Send a single `camera.start_monitor` over the Moonraker
     * WebSocket. Fire-and-forget: returns once the message has been
     * dispatched (the WebSocket closes itself on the response). Used
     * to pump U1's monitor.jpg refresh; harmless on other firmware.
     */
    private suspend fun wakeOnce() = withContext(Dispatchers.IO) {
        val wsUrl = baseUrl
            .replaceFirst(Regex("^http://"), "ws://")
            .replaceFirst(Regex("^https://"), "wss://")
            .trimEnd('/') + "/websocket"
        val req = Request.Builder().url(wsUrl).let(applyApiKey).build()
        runCatching {
            httpClient.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(WAKE_PAYLOAD)
                    webSocket.close(1000, null)
                }
            })
        }
    }

    private suspend fun discoverCandidates(): List<String> = withContext(Dispatchers.IO) {
        val advertised = runCatching { queryWebcamList() }.getOrNull().orEmpty()
        // Always append the U1 + legacy fallbacks so we recover when
        // the list endpoint is empty / Snapmaker firmware <1.x.
        val fallbacks = listOf(
            "$baseUrl/server/files/camera/monitor.jpg",
            "$baseUrl/webcam/?action=snapshot",
        )
        // Dedupe while preserving order. Advertised wins (it's the
        // printer's own truth); fallbacks fill in.
        (advertised + fallbacks).distinct()
    }

    private fun queryWebcamList(): List<String> {
        val req = Request.Builder()
            .url("$baseUrl/server/webcams/list")
            .header("Accept", "application/json")
            .let(applyApiKey)
            .get()
            .build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return emptyList()
            val body = resp.body?.string().orEmpty()
            val arr = JSONObject(body)
                .optJSONObject("result")
                ?.optJSONArray("webcams") ?: return emptyList()
            val urls = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val cam = arr.optJSONObject(i) ?: continue
                val raw = cam.optString("snapshot_url", "")
                    .ifBlank { cam.optString("snapshotUrl", "") }
                if (raw.isBlank()) continue
                // Resolve relative URLs against base. Try BOTH the
                // "with-port" and "stripped-port" forms because the
                // Snapmaker U1's published snapshot_url is relative
                // and the host typically serves the camera on the
                // same port as Moonraker (80) — but third-party
                // crowsnest installs may serve it on 8080.
                resolve(raw, keepPort = true)?.let(urls::add)
                resolve(raw, keepPort = false)?.let { if (it !in urls) urls.add(it) }
                val streamRaw = cam.optString("stream_url", "")
                    .ifBlank { cam.optString("streamUrl", "") }
                if (streamRaw.isNotBlank()) {
                    // Some firmwares report only stream_url. We can
                    // poll a stream URL too — most multipart MJPEG
                    // streams accept a single GET and respond with the
                    // first frame's headers + JPEG, which our code
                    // happily decodes.
                    resolve(streamRaw, keepPort = true)?.let { if (it !in urls) urls.add(it) }
                }
            }
            return urls
        }
    }

    private fun resolve(value: String, keepPort: Boolean): String? {
        if (value.isBlank()) return null
        if (value.startsWith("http://") || value.startsWith("https://")) return value
        return runCatching {
            val base = URI(baseUrl)
            val host = if (keepPort && base.port != -1) "${base.host}:${base.port}" else base.host
            "${base.scheme}://$host/${value.trimStart('/')}"
        }.getOrNull()
    }

    private fun withCacheBuster(url: String): String {
        // Snapmaker U1's monitor.jpg is heavily cached by intermediate
        // proxies (Mainsail's nginx in particular). A `_cb=<ts>` query
        // param defeats the cache without changing semantics.
        val sep = if ('?' in url) '&' else '?'
        return "$url${sep}_cb=${System.currentTimeMillis()}"
    }

    private fun fetchOne(url: String): MoonrakerResult<ByteArray> {
        val req = Request.Builder()
            .url(url)
            .header("Accept", "image/jpeg, image/*;q=0.9, */*;q=0.5")
            // Many firmwares serve a chunked multipart response on the
            // bare /webcam/?action=stream URL. We tell them we want one
            // frame and bail at the first JPEG marker we see — see
            // extractFirstJpeg.
            .header("Connection", "close")
            .let(applyApiKey)
            .get()
            .build()
        return runCatching {
            httpClient.newCall(req).execute().use { resp ->
                val code = resp.code
                if (resp.isSuccessful) {
                    val ctype = resp.header("Content-Type").orEmpty().lowercase()
                    val raw = resp.body?.bytes() ?: ByteArray(0)
                    if (raw.isEmpty()) return@runCatching MoonrakerResult.IoError("empty body ($url)")
                    val jpeg = if ("multipart" in ctype) extractFirstJpeg(raw) else raw
                    if (jpeg == null) MoonrakerResult.IoError("no JPEG frame in response ($url)")
                    else MoonrakerResult.Ok(jpeg)
                } else if (code == 404) {
                    MoonrakerResult.NotFound("404 ($url)")
                } else if (code == 401 || code == 403) {
                    MoonrakerResult.AuthError("Webcam fetch rejected (HTTP $code).")
                } else {
                    MoonrakerResult.HttpError(code, "")
                }
            }
        }.getOrElse { e ->
            MoonrakerResult.IoError(e.message ?: e::class.simpleName ?: "io error")
        }
    }

    /**
     * Extract the first JPEG frame from a multipart/x-mixed-replace
     * response body. mjpg-streamer-style streams interleave a few text
     * headers (`--boundary`, `Content-Type: image/jpeg`,
     * `Content-Length: …`, blank line) before each JPEG payload. We
     * just walk for the SOI marker (FF D8) and return everything from
     * there to the matching EOI (FF D9). Tolerant of any boundary
     * convention since we ignore the headers entirely.
     */
    private fun extractFirstJpeg(buf: ByteArray): ByteArray? {
        val start = indexOf(buf, byteArrayOf(0xFF.toByte(), 0xD8.toByte()), 0)
        if (start < 0) return null
        val end = indexOf(buf, byteArrayOf(0xFF.toByte(), 0xD9.toByte()), start + 2)
        if (end < 0) return null
        return buf.copyOfRange(start, end + 2)
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int): Int {
        outer@ for (i in from..haystack.size - needle.size) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }

    companion object {
        private const val WAKE_INTERVAL_MS = 2_000L
        private const val FAIL_THRESHOLD = 3

        // Moonraker's WebSocket method to wake the U1 camera.
        // {jsonrpc, id, method, params{domain, interval}}.
        private const val WAKE_PAYLOAD =
            """{"jsonrpc":"2.0","id":1000,"method":"camera.start_monitor","params":{"domain":"lan","interval":0}}"""
    }
}
