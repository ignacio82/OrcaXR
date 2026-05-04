package dev.orcaxr.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.llm.LlmAssistantCard

/**
 * App-wide preferences. Lives next to the workspace as a SpatialPanel,
 * toggled from the Settings icon on the top navigation pill.
 *
 * Distinct from the Devices (Printers) panel: Devices is for printer
 * connections + the MCP server toggle (external-client surface).
 * Settings is for things that affect OrcaXR itself — currently just
 * the optional in-app AI assistant. Future cards (theme, units,
 * default printer, telemetry opt-out) belong here too.
 *
 * Layout mirrors PrinterPanel for consistency: dark surface, rounded
 * corners, header row with title + close, description prose, then a
 * vertical-scrolling Column of cards. Each card is self-contained
 * (reads/writes its own settings store) so the panel itself stays a
 * thin host.
 */
@Composable
fun SettingsPanel(
    onClose: () -> Unit,
    /** Open the in-app LLM assistant chat panel. Wired to the same
     *  `assistantShown` flag MainActivity uses for the SpatialPanel
     *  mount; null disables the LlmAssistantCard's "Open Assistant"
     *  button (e.g. flat-shell builds where the panel host isn't
     *  wired). */
    onOpenAssistant: (() -> Unit)? = null,
) {
    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Settings", style = MaterialTheme.typography.titleLarge, color = Color.White)
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleLarge)
                }
            }

            Text(
                "App-wide preferences. Printer connections and the MCP server " +
                    "live in Devices.",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(16.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // In-app LLM assistant — provider picker, per-provider
                // API key, voice toggle, "Open Assistant" button. The
                // card is self-contained (reads/writes LlmSettings
                // directly) and is the same instance that previously
                // lived inside PrinterPanel; only its host changed.
                if (onOpenAssistant != null) {
                    LlmAssistantCard(onOpenAssistant = onOpenAssistant)
                }
                // Future settings cards (theme, default printer,
                // telemetry, etc.) drop in here without further wiring.
            }
        }
    }
}
