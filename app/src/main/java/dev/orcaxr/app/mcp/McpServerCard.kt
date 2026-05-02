package dev.orcaxr.app.mcp

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Settings card for the MCP server. Drops into the Devices panel above
 * the printer list.
 *
 * What it shows:
 * - On/off switch — flips the persisted `enabled` flag and the
 *   controller picks it up.
 * - Bound port + LAN URLs (one row per detected interface). Tap any
 *   row to copy that URL to the clipboard so an MCP client config
 *   (Claude Desktop, etc.) can paste it.
 * - Bearer token, masked by default with a "show" / "copy" / "rotate"
 *   button row. Generated on first enable.
 *
 * The card is intentionally self-contained — it reaches into the
 * [McpController] singleton itself rather than taking a dozen
 * callbacks. That's a small break from the unidirectional pattern in
 * the rest of `UiPanels.kt`, but the MCP plumbing is genuinely
 * orthogonal to the workspace state, and the alternative (lifting all
 * three state flows into MainActivity for one card) was uglier.
 */
@Composable
fun McpServerCard(
    modifier: Modifier = Modifier,
    /**
     * Optional escape hatch for the Share button on Android XR. The
     * system share sheet is a 2D Activity that won't render while the
     * shell is in full-space mode (the chooser opens behind the
     * SpatialPanels and the user sees "nothing happens"). Pass a
     * callback that calls `session.scene.requestHomeSpaceMode()` so
     * the OS pops the user back to home space before the chooser
     * launches. Null = best-effort (tap may silently fail in XR).
     */
    onRequestHomeSpaceMode: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val controller = remember { McpController.get(context) }
    val settings = remember { controller.settings() }
    val scope = rememberCoroutineScope()
    val clipboard: ClipboardManager = LocalClipboardManager.current

    val enabled by settings.enabled.collectAsState(initial = false)
    val port by settings.port.collectAsState(initial = McpSettings.DEFAULT_PORT)
    val apiKey by settings.apiKey.collectAsState(initial = null)

    var showKey by remember { mutableStateOf(false) }
    var lanIps by remember { mutableStateOf<List<String>>(emptyList()) }
    var statusBlurb by remember { mutableStateOf<String?>(null) }

    // Refresh LAN addresses whenever the toggle flips on; cheap call.
    LaunchedEffect(enabled) {
        lanIps = if (enabled) McpServer.lanAddresses() else emptyList()
        statusBlurb = if (enabled && lanIps.isEmpty())
            "Server running but no LAN address detected — check Wi-Fi."
        else null
    }

    Surface(
        color = Color(0xFF12253A),
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "MCP server",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        if (enabled) {
                            "Listening on :$port — point Claude Desktop / any MCP client at the URL below."
                        } else {
                            "Lets an LLM (Claude, Gemini) drive OrcaXR over JSON-RPC. Off by default."
                        },
                        color = Color(0xFFB6BEC8),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Switch(
                    checked = enabled,
                    onCheckedChange = { newValue ->
                        scope.launch {
                            if (newValue) {
                                // Generate a key on first enable so the
                                // user has one to paste right away.
                                settings.ensureApiKey()
                            }
                            settings.setEnabled(newValue)
                        }
                    },
                    colors = SwitchDefaults.colors(
                        checkedTrackColor = Color(0xFF4F8FF7),
                        checkedThumbColor = Color.White,
                    ),
                )
            }

            if (enabled) {
                Spacer(Modifier.height(12.dp))

                // LAN URLs.
                if (lanIps.isEmpty()) {
                    Text(
                        statusBlurb ?: "Determining LAN address…",
                        color = Color(0xFFCCAA66),
                        style = MaterialTheme.typography.labelSmall,
                    )
                } else {
                    Text(
                        "Server URL — tap to copy",
                        color = Color(0xFFB6BEC8),
                        style = MaterialTheme.typography.labelSmall,
                    )
                    Spacer(Modifier.height(4.dp))
                    for (ip in lanIps) {
                        val url = "http://$ip:$port/mcp"
                        Surface(
                            color = Color(0xFF0F1A28),
                            shape = RoundedCornerShape(6.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp)
                                .clickable { clipboard.setText(AnnotatedString(url)) },
                        ) {
                            Text(
                                url,
                                color = Color.White,
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                // Bearer token.
                Text(
                    "Bearer token (Authorization: Bearer …)",
                    color = Color(0xFFB6BEC8),
                    style = MaterialTheme.typography.labelSmall,
                )
                Spacer(Modifier.height(4.dp))
                val keyValue = apiKey
                Surface(
                    color = Color(0xFF0F1A28),
                    shape = RoundedCornerShape(6.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        Text(
                            when {
                                keyValue == null -> "(generating…)"
                                showKey -> keyValue
                                else -> "•".repeat(keyValue.length.coerceAtMost(32))
                            },
                            color = Color.White,
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { showKey = !showKey },
                        shape = RoundedCornerShape(8.dp),
                    ) { Text(if (showKey) "Hide" else "Show") }
                    OutlinedButton(
                        onClick = {
                            keyValue?.let { clipboard.setText(AnnotatedString(it)) }
                        },
                        enabled = keyValue != null,
                        shape = RoundedCornerShape(8.dp),
                    ) { Text("Copy") }
                    OutlinedButton(
                        onClick = {
                            val key = keyValue ?: return@OutlinedButton
                            val url = lanIps.firstOrNull()?.let { "http://$it:$port/mcp" }
                                ?: "http://<headset-lan-ip>:$port/mcp"
                            val snippet = buildShareSnippet(url, key, lanIps, port)
                            // Belt-and-braces: clipboard always, share
                            // sheet opportunistically. On Galaxy XR the
                            // system share chooser is a 2D Activity that
                            // can't render in full-space; the
                            // `onRequestHomeSpaceMode` hook drops the
                            // shell out of immersive so the chooser
                            // surfaces. If even that fails (no app
                            // handles ACTION_SEND, weird OEM gap, etc.),
                            // the toast tells the user the snippet is
                            // already on the clipboard.
                            clipboard.setText(AnnotatedString(snippet))
                            onRequestHomeSpaceMode?.invoke()
                            val send = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, "OrcaXR MCP server connection")
                                putExtra(Intent.EXTRA_TEXT, snippet)
                            }
                            val chooser = Intent.createChooser(send, "Share OrcaXR MCP server")
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            val launched = runCatching { context.startActivity(chooser) }.isSuccess
                            android.widget.Toast.makeText(
                                context,
                                if (launched) "Snippet copied + opening share sheet…"
                                else "Snippet copied to clipboard (share sheet unavailable).",
                                android.widget.Toast.LENGTH_LONG,
                            ).show()
                        },
                        enabled = keyValue != null,
                        shape = RoundedCornerShape(8.dp),
                    ) { Text("Share") }
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                settings.rotateApiKey()
                                // Rebind the running server so the new
                                // key takes effect immediately.
                                controller.refresh()
                            }
                        },
                        shape = RoundedCornerShape(8.dp),
                    ) { Text("Rotate") }
                }

                statusBlurb?.let { blurb ->
                    Spacer(Modifier.height(8.dp))
                    Text(
                        blurb,
                        color = Color(0xFFCCAA66),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }

                Spacer(Modifier.height(8.dp))
                Text(
                    "Auth-free: initialize, ping, tools/list. " +
                        "Auth-required: tools/call. The server only listens on Wi-Fi — " +
                        "rotate the token if you suspect anything else has it. " +
                        "Share opens the Android share sheet (Quick Share, Messages, …) " +
                        "with a self-contained snippet you can hand to another Claude / AI.",
                    color = Color(0xFF9AA5B1),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

/**
 * Build the markdown blob the Share button drops onto the clipboard.
 * Designed to be paste-and-go: a receiving Claude (or any LLM that
 * speaks MCP) gets the URL, the token, and a one-liner that wires
 * OrcaXR into Claude Code's MCP config without any further
 * back-and-forth. Multi-IP setups list every detected LAN address —
 * the user picks the one that's actually reachable.
 */
internal fun buildShareSnippet(
    primaryUrl: String,
    token: String,
    lanIps: List<String>,
    port: Int,
): String = buildString {
    appendLine("OrcaXR MCP server (running on my Android XR headset).")
    appendLine()
    appendLine("Endpoint:")
    appendLine("  $primaryUrl")
    if (lanIps.size > 1) {
        appendLine("Alternate LAN URLs (pick one that's reachable from your machine):")
        for (ip in lanIps.drop(1)) appendLine("  http://$ip:$port/mcp")
    }
    appendLine("Bearer token (Authorization: Bearer …):")
    appendLine("  $token")
    appendLine()
    appendLine("To register it with Claude Code, run:")
    appendLine("  claude mcp add --transport http orcaxr \\")
    appendLine("    $primaryUrl \\")
    appendLine("    --header \"Authorization: Bearer $token\"")
    appendLine()
    appendLine("Then `tools/list` over MCP returns the OrcaXR surface")
    appendLine("(load_model_from_path, paint_split_plane, slice_active_plate, …).")
}
