package dev.orcaxr.app.mobile

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Echo — OrcaXR's orca brand mark. Vector path matches the design
 * bundle's `EchoMark` SVG (orcaxr-phone-and-tablet/project/tokens.jsx),
 * scaled to a 32-unit viewport. One teal silhouette + a small dark eye
 * + a subtle smile arc. Drawn directly with Canvas so we don't have to
 * ship a vector drawable XML for a single mark.
 */
@Composable
fun EchoMark(
    size: Dp = 24.dp,
    color: Color = MaterialTheme.colorScheme.primary,
    eyeColor: Color = MaterialTheme.colorScheme.background,
) {
    Canvas(modifier = Modifier.size(size)) {
        val s = this.size.minDimension / 32f
        val body = Path().apply {
            // M4 18 C 4 9, 12 4, 18 6 C 24 8, 28 14, 28 19 C 28 23, 24 26, 20 25 L 18 28 L 16 24 C 10 24, 4 22, 4 18 Z
            moveTo(4f * s, 18f * s)
            cubicTo(4f * s, 9f * s, 12f * s, 4f * s, 18f * s, 6f * s)
            cubicTo(24f * s, 8f * s, 28f * s, 14f * s, 28f * s, 19f * s)
            cubicTo(28f * s, 23f * s, 24f * s, 26f * s, 20f * s, 25f * s)
            lineTo(18f * s, 28f * s)
            lineTo(16f * s, 24f * s)
            cubicTo(10f * s, 24f * s, 4f * s, 22f * s, 4f * s, 18f * s)
            close()
            fillType = PathFillType.NonZero
        }
        drawPath(body, color)
        // Eye
        drawCircle(
            color = eyeColor,
            radius = 1.6f * s,
            center = Offset(22f * s, 14f * s),
        )
        // Smile arc — quadratic 14,16 -> 18,16 control 16,18
        val smile = Path().apply {
            moveTo(14f * s, 16f * s)
            quadraticBezierTo(16f * s, 18f * s, 18f * s, 16f * s)
        }
        drawPath(smile, eyeColor, style = Stroke(width = 1.2f * s))
    }
}
