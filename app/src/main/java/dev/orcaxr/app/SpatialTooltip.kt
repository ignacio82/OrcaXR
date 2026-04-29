package dev.orcaxr.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.delay

/**
 * Roadmap B6 — small spatial-panel-friendly tooltip primitive.
 *
 * UX shape: a "?" chip the user laser-clicks; a description plate
 * pops up next to it. Tapping again (or clicking outside) dismisses.
 * Compose `Popup` renders into a separate window inside the same
 * SpatialPanel, so the plate can extend past the row's bounds without
 * clipping.
 *
 * The XR pose-tracker's hover events do reach Compose's pointer
 * pipeline as `PointerEventType.Enter / Exit`, but the laser cursor's
 * hand-tracking jitter (~1 cm at typical viewing distance) makes a
 * pure-hover trigger feel twitchy. Tap-to-toggle is the more legible
 * spatial interaction; we still respect the [autoCloseMs] grace so a
 * user who taps and walks away gets the plate back to baseline state.
 *
 * The state machine is exposed via [TooltipState] so a future Compose
 * UI test (Robolectric) can drive open/close transitions without
 * needing the renderer.
 */
@Composable
fun SettingHelpChip(
    description: String,
    state: TooltipState = remember { TooltipState() },
    autoCloseMs: Long = 6_000L,
    modifier: Modifier = Modifier,
) {
    if (description.isBlank()) return

    Box(
        modifier = modifier
            .size(20.dp)
            .background(Color(0xFF2A2F33), CircleShape)
            .clickable { state.toggle() },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "?",
            color = Color(0xFF7BC8FF),
            fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.labelSmall,
        )

        if (state.isOpen) {
            // Auto-dismiss: a stuck-open tooltip is worse than one that
            // closes too eagerly because XR has no easy "click outside"
            // affordance — the user would have to chase the chip again
            // to clear it. autoCloseMs gives the plate a max lifespan
            // even if focus drifts away.
            LaunchedEffect(state.openedAtMs) {
                delay(autoCloseMs)
                state.close()
            }
            Popup(
                properties = PopupProperties(
                    focusable = false,
                    dismissOnBackPress = true,
                    dismissOnClickOutside = true,
                ),
                onDismissRequest = { state.close() },
            ) {
                Surface(
                    color = Color(0xFF2A2F33),
                    shape = RoundedCornerShape(6.dp),
                    shadowElevation = 4.dp,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .padding(PaddingValues(horizontal = 12.dp, vertical = 8.dp))
                            .widthIn(max = 320.dp),
                    ) {
                        Text(
                            description,
                            color = Color(0xFFE8ECEF),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Tooltip-visibility state machine, broken out of the Composable so
 * the open/close transitions stay testable without the renderer.
 */
class TooltipState {
    private var openedAtMsBacking by mutableStateOf<Long?>(null)

    /** True while the popover is showing. */
    val isOpen: Boolean get() = openedAtMsBacking != null

    /** Wall-clock millis when the current open transition fired, or
     *  null when closed. Used by the auto-dismiss LaunchedEffect's
     *  key so a re-open mid-grace resets the timer. */
    val openedAtMs: Long? get() = openedAtMsBacking

    /** Toggle visibility — open when closed, close when open. */
    fun toggle(nowMs: Long = System.currentTimeMillis()) {
        openedAtMsBacking = if (openedAtMsBacking == null) nowMs else null
    }

    fun open(nowMs: Long = System.currentTimeMillis()) {
        openedAtMsBacking = nowMs
    }

    fun close() {
        openedAtMsBacking = null
    }
}
