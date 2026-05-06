package dev.orcaxr.app.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Tonal surface card — used as the default container in every screen. */
@Composable
fun MobileCard(
    modifier: Modifier = Modifier,
    tonal: Boolean = true,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val container = if (tonal) MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.surface
    val outline = MaterialTheme.colorScheme.outlineVariant
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier
            .background(container, shape)
            .border(1.dp, outline, shape)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(20.dp),
    ) {
        content()
    }
}

/** Numeric stat, JetBrains Mono. Used in the print monitor + slicer
 *  preview (layer count, time, mass…). */
@Composable
fun MobileMetric(
    label: String,
    value: String,
    unit: String? = null,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        Text(
            text = label.uppercase(),
            style = LocalMobileTextStyles.current.sectionLabel,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                text = value,
                style = LocalMobileTextStyles.current.numericLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (unit != null) {
                Spacer(Modifier.width(4.dp))
                Text(
                    text = unit,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Color swatch for filament slot / paint chip. */
@Composable
fun ColorSwatch(
    hex: String,
    label: String? = null,
    size: Dp = 28.dp,
    showLabel: Boolean = true,
) {
    val color = parseHex(hex) ?: MaterialTheme.colorScheme.surfaceVariant
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(size)
                .background(color, CircleShape)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape),
        )
        if (showLabel && label != null) {
            Spacer(Modifier.width(8.dp))
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

/** Section heading — small caps mint kicker. */
@Composable
fun SectionKicker(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        style = LocalMobileTextStyles.current.kicker,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier,
    )
}

/** Standard horizontal progress bar with rounded edges, tinted teal. */
@Composable
fun MobileProgress(progress: Float, modifier: Modifier = Modifier) {
    LinearProgressIndicator(
        progress = { progress.coerceIn(0f, 1f) },
        color = MaterialTheme.colorScheme.primary,
        trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        strokeCap = ProgressIndicatorDefaults.LinearStrokeCap,
        gapSize = 0.dp,
        drawStopIndicator = {},
        modifier = modifier
            .fillMaxWidth()
            .height(8.dp),
    )
}

/** Status pill — shows a print state (printing, paused, idle). */
@Composable
fun StatusPill(
    label: String,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Surface(
        color = color.copy(alpha = 0.18f),
        shape = RoundedCornerShape(50),
        border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.4f)),
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(color, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(
                label.uppercase(),
                style = LocalMobileTextStyles.current.kicker,
                color = color,
            )
        }
    }
}

/** Empty-state placeholder used by Files / Filament / Monitor. */
@Composable
fun EmptyStateCard(
    title: String,
    body: String,
    cta: String? = null,
    onCta: (() -> Unit)? = null,
) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, overflow = TextOverflow.Visible)
            if (cta != null && onCta != null) {
                Spacer(Modifier.height(4.dp))
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = RoundedCornerShape(50),
                    onClick = onCta,
                ) {
                    Text(
                        cta,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
                    )
                }
            }
        }
    }
}

internal fun parseHex(hex: String): Color? {
    val raw = hex.removePrefix("#").trim()
    return runCatching {
        when (raw.length) {
            6 -> Color(0xFF000000 or raw.toLong(16))
            8 -> Color(raw.toLong(16))
            else -> null
        }
    }.getOrNull()
}

/** A horizontal divider — used between rows in scrollable lists. */
@Composable
fun ThinDivider(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
    )
}

/** Format a duration (seconds) as "Xh YYm" or "YYm SSs". */
fun formatDurationCompact(seconds: Float?): String {
    if (seconds == null || seconds <= 0f || !seconds.isFinite()) return "—"
    val total = seconds.toInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return when {
        h > 0 -> "%dh %02dm".format(h, m)
        m > 0 -> "%dm %02ds".format(m, s)
        else -> "%ds".format(s)
    }
}

/** Pretty-print bytes as KB / MB / GB. */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024L) return "$bytes B"
    if (bytes < 1024L * 1024L) return "%.1f KB".format(bytes / 1024.0)
    if (bytes < 1024L * 1024L * 1024L) return "%.1f MB".format(bytes / 1024.0 / 1024.0)
    return "%.1f GB".format(bytes / 1024.0 / 1024.0 / 1024.0)
}

/** Used by the Slicer screen to render the still preview behind a
 *  loading shimmer when the bake hasn't finished yet. */
@Composable
fun MobileShimmer(modifier: Modifier = Modifier) {
    Box(
        modifier
            .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp))
            .fillMaxSize(),
    )
}
