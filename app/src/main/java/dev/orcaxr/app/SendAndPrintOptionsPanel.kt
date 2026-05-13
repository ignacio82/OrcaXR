package dev.orcaxr.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.ui.OrcaXrColors
import java.io.File

/**
 * The "Send & Print" button is split into two phases: open the options
 * sheet, then on confirm run the upload + start sequence. This carries
 * the in-flight data between the two so the confirm path doesn't have
 * to re-derive what printer / what file the user is sending.
 */
data class SendOptionsRequest(
    val printer: PrinterConfig,
    val gcode: File,
)

/**
 * Modal panel shown between tapping "Send & Print" and the actual
 * upload+start sequence. Mirrors OrcaSlicer's pre-print toggles
 * (Timelapse / Auto Bed Leveling / etc.) for Klipper + Moonraker
 * targets.
 *
 * Today's toggles:
 *  - **Bed mesh calibrate** — always available (every Klipper config
 *    we ship supports BED_MESH_CALIBRATE).
 *  - **Timelapse** — gated on the moonraker-timelapse component being
 *    installed. Caller passes `timelapseAvailable=false` when it's not,
 *    and the switch greys out with a "Install moonraker-timelapse to
 *    enable" hint so the user understands why.
 *
 * Caller-owned state: this composable is stateless w.r.t. the toggle
 * values so its parent (MainActivity's onSendAndPrint scope, or the
 * mobile PreviewScreen's send button) can both surface the picks AND
 * route them into [applyPrintOptionsToGcode]. Internal state is just
 * the working copy held in [options].
 */
@Composable
fun SendAndPrintOptionsPanel(
    printerName: String,
    initialOptions: PrintOptions,
    timelapseAvailable: Boolean,
    onConfirm: (PrintOptions) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var options by remember { mutableStateOf(initialOptions) }

    // If timelapse becomes unavailable while the panel is open (e.g.,
    // the printer goes offline mid-pick), force the toggle off so the
    // user doesn't confirm a setting that can't be applied.
    LaunchedEffect(timelapseAvailable) {
        if (!timelapseAvailable && options.timelapse) {
            options = options.copy(timelapse = false)
        }
    }

    Surface(
        color = OrcaXrColors.PanelStrong,
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, OrcaXrColors.LineStrong),
        modifier = modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 20.dp, vertical = 16.dp)
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Send & Print",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                "Target: $printerName",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )

            OptionRow(
                title = "Bed mesh calibrate",
                subtitle = "Runs BED_MESH_CALIBRATE before the print. Adds 30–90 s but compensates for thermal drift on cold restarts.",
                checked = options.bedMeshCalibrate,
                onCheckedChange = { options = options.copy(bedMeshCalibrate = it) },
            )

            OptionRow(
                title = "Timelapse",
                subtitle = if (timelapseAvailable) {
                    "Capture a frame every layer change and render an mp4 when the print finishes."
                } else {
                    "Install the moonraker-timelapse component on the printer to enable."
                },
                checked = options.timelapse,
                enabled = timelapseAvailable,
                onCheckedChange = { options = options.copy(timelapse = it) },
            )

            Spacer(modifier = Modifier.weight(1f))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onCancel) {
                    Text("Cancel", color = Color(0xFFB6BEC8))
                }
                Button(
                    onClick = { onConfirm(options) },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFF4F8FF7),
                        contentColor = Color.White,
                    ),
                    contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
                ) {
                    Text("Send & Print", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun OptionRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
) {
    Surface(
        color = Color(0xFF12253A),
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    title,
                    color = if (enabled) Color.White else Color(0xFF8290A0),
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    subtitle,
                    color = if (enabled) Color(0xFFB6BEC8) else Color(0xFF6E7A89),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            Switch(
                checked = checked,
                onCheckedChange = onCheckedChange,
                enabled = enabled,
                colors = SwitchDefaults.colors(
                    checkedTrackColor = Color(0xFF4F8FF7),
                    checkedThumbColor = Color.White,
                ),
            )
        }
    }
}
