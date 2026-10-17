package dev.orcaxr.nativeapp.widget

import okhttp3.OkHttpClient
import okhttp3.Request

data class DiscoveredWebcam(
    val uid: String,
    val name: String,
    val service: String,
    val snapshotUrl: String,
    val enabled: Boolean,
    val targetFps: Double = 15.0,
    val aspectRatio: String = "16:9",
    val flipHorizontal: Boolean = false,
    val flipVertical: Boolean = false,
    val rotation: Int = 0,
)

object PrinterCameraDiscovery {
    /**
     * Queries Moonraker /server/webcams/list and returns available cameras.
     */
    fun queryWebcams(
        http: OkHttpClient,
        host: String,
        port: Int,
        apiKey: String? = null,
    ): List<DiscoveredWebcam> {
        val url = "http://$host:$port/server/webcams/list"
        val requestBuilder = Request.Builder().url(url)
        if (!apiKey.isNullOrBlank()) {
            requestBuilder.header("X-Api-Key", apiKey.trim())
        }
        val response = http.newCall(requestBuilder.build()).execute()
        if (!response.isSuccessful) return emptyList()
        val body = response.body?.string() ?: return emptyList()
        return parseWebcamsJson(body)
    }

    /**
     * Parses the Moonraker /server/webcams/list JSON response.
     */
    fun parseWebcamsJson(jsonString: String): List<DiscoveredWebcam> {
        val root = SimpleJson.parse(jsonString) as? Map<*, *> ?: return emptyList()
        val result = root["result"] as? Map<*, *> ?: return emptyList()
        val array = result["webcams"] as? List<*> ?: return emptyList()

        val list = mutableListOf<DiscoveredWebcam>()
        for ((index, item) in array.withIndex()) {
            val obj = item as? Map<*, *> ?: continue
            val name = obj["name"]?.toString() ?: "Camera $index"
            val uid = obj["uid"]?.toString() ?: name
            val service = obj["service"]?.toString() ?: "unknown"
            val snapshotUrl = obj["snapshot_url"]?.toString() ?: ""
            val enabled = obj["enabled"] as? Boolean ?: true
            val targetFps = (obj["target_fps"] as? Number)?.toDouble() ?: 15.0
            val aspectRatio = obj["aspect_ratio"]?.toString() ?: "16:9"
            val flipH = obj["flip_horizontal"] as? Boolean ?: false
            val flipV = obj["flip_vertical"] as? Boolean ?: false
            val rot = (obj["rotation"] as? Number)?.toInt() ?: 0
            list.add(
                DiscoveredWebcam(
                    uid = uid,
                    name = name,
                    service = service,
                    snapshotUrl = snapshotUrl,
                    enabled = enabled,
                    targetFps = targetFps,
                    aspectRatio = aspectRatio,
                    flipHorizontal = flipH,
                    flipVertical = flipV,
                    rotation = rot,
                )
            )
        }
        return list
    }

    /**
     * Resolves candidate snapshot URLs in order of preference.
     * E.g. for /webcam/snapshot.jpg on host 192.168.1.228:
     * - http://192.168.1.228/webcam/snapshot.jpg (web origin / reverse proxy on port 80)
     * - http://192.168.1.228:7125/webcam/snapshot.jpg (direct Moonraker port)
     */
    fun resolveCandidateUrls(host: String, port: Int, snapshotUrl: String): List<String> {
        if (snapshotUrl.startsWith("http://") || snapshotUrl.startsWith("https://")) {
            return listOf(snapshotUrl)
        }
        val path = if (snapshotUrl.startsWith("/")) snapshotUrl else "/$snapshotUrl"
        return listOf(
            "http://$host$path",          // port 80 (standard reverse proxy)
            "http://$host:$port$path",     // direct Moonraker port
        )
    }
}
