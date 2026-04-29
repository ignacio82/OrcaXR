package dev.orcaxr.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Roadmap B5 — Galaxy XR controller binding reference card.
 *
 * Surfaces the bindings the user can't otherwise discover (no on-
 * device tooltip primitive yet, so a discrete help panel is the
 * simplest way to make the input pump's affordances visible).
 * Pure-data layer ([entries]) is exposed so a future Compose UI test
 * can assert binding coverage without instantiating the renderer.
 */
object ControllerHelp {

    /** One binding row: input + the action it triggers + a short
     *  context note (e.g. "only when a slice exists"). */
    data class Entry(val input: String, val action: String, val note: String? = null)

    /** All bindings the input pump consumes today. Order matters —
     *  it's the order the help card renders. Update in the same
     *  commit as a new binding lands so the card stays honest. */
    val entries: List<Entry> = listOf(
        Entry("A button", "Slice — multi-model → sliceMulti, single → runSlice, empty bed → bundled cube"),
        Entry("B button", "Cancel — Preview → Prepare; system back still routes through the OS"),
        Entry(
            input = "X button",
            action = "Toggle Prepare ↔ Preview",
            note = "Toast hint shown when no slice exists yet.",
        ),
        Entry("Y button", "Toggle travel-move visibility in the toolpath preview"),
        Entry(
            input = "Stick · Preview mode",
            action = "Y axis scrubs layers; X axis jumps ±10 layers",
            note = "Stick-up advances forward; stick-down rewinds.",
        ),
        Entry(
            input = "Stick · Prepare mode",
            action = "X / Y nudge the selected model on the bed",
            note = "Velocity ramps with deflection (deadband at 0.1).",
        ),
        Entry(
            input = "Stick · Prepare + held",
            action = "Quarter-turn rotate (X-axis flick = ±90°)",
        ),
    )
}

/**
 * Compact spatial-panel-friendly help card. Renders [ControllerHelp.entries]
 * as a key/value list. Caller decides where to host this — TopNavigationPill
 * launches it as a side panel, AboutPanel embeds it inline.
 */
@Composable
fun ControllerHelpCard(
    onClose: () -> Unit = {},
    showCloseButton: Boolean = true,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF15181B))
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Galaxy XR controller bindings",
                color = Color.White,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            if (showCloseButton) {
                TextButton(onClick = onClose) {
                    Text("Close", color = Color(0xFF7BC8FF))
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            "Hold the controllers normally; the input pump treats both sticks " +
                "equivalently. Auto-repeat is suppressed on every face button so " +
                "holding A doesn't re-trigger a slice.",
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(12.dp))

        for (entry in ControllerHelp.entries) {
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            entry.input,
                            color = Color(0xFF7BC8FF),
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.width(170.dp),
                        )
                        Text(
                            entry.action,
                            color = Color.White,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (entry.note != null) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            entry.note,
                            color = Color(0xFF8E97A2),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(start = 182.dp),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        Text(
            "Hand-tracking still works for laser-grab + paint pick. The controllers " +
                "are additive, not exclusive.",
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.labelSmall,
        )
    }
}
