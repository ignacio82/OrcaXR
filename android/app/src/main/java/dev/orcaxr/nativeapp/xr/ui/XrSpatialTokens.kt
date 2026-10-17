package dev.orcaxr.nativeapp.xr.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Ergonomic spatial design system tokens for Android XR, strictly following
 * DESIGN.md and the XRBlocks spatial UI contract (XrLayout.ts).
 *
 * Key constraints:
 * 1. Physical targets: minimum 58 dp (representing 58 mm target at 1 m distance, ~2.5° arc).
 * 2. Visual hierarchy: deep navy frosted glass panels floating over the 3D scene.
 *    Root panels use 80% opacity, elevated controls use 92%, and recessed surfaces use 55%.
 * 3. Borders: thin 10-20% opacity hairline strokes without heavy drop shadows to avoid
 *    stereoscopic depth conflicts in XR headsets.
 * 4. Radii: 24 dp on parent cards, 8 dp on child controls and chips.
 */
object XrSpatialTokens {
    /** Minimum interactable target size for hand rays and touch pointers in XR (58 mm floor). */
    val MinTouchTarget = 58.dp

    /** Standard corner radius for parent spatial panels (rounded.xl). */
    val CornerRadiusParent = 24.dp

    /** Standard corner radius for child buttons, chips, and controls (rounded.md). */
    val CornerRadiusChild = 8.dp

    /** Standard inner padding for spatial cards. */
    val PanelPadding = 16.dp

    /** Spacing between items inside spatial cards. */
    val ItemSpacing = 8.dp

    // Design System Color Palette (DESIGN.md)
    val ColorMint = Color(0xFF79D0C7)
    val ColorMintBright = Color(0xFF94E2D6)
    val ColorMintDeep = Color(0xFF4DB6AC)
    val ColorWarn = Color(0xFFFFB86B)
    val ColorRed = Color(0xFFF25C5C)
    val ColorBgDeep = Color(0xFF000814)

    // Frosted-glass panel surfaces
    val ColorPanel = Color(0xCC08101E)        // rgba(8, 16, 30, 0.80)
    val ColorPanelStrong = Color(0xEB060C18)  // rgba(6, 12, 24, 0.92)
    val ColorPanelSoft = Color(0x8C141E30)    // rgba(20, 30, 48, 0.55)

    // Hairline boundary strokes
    val ColorLine = Color(0x1AB4C8E6)         // rgba(180, 200, 230, 0.10)
    val ColorLineStrong = Color(0x33B4C8E6)   // rgba(180, 200, 230, 0.20)

    // Text hierarchy
    val ColorText = Color(0xFFEEF2F7)
    val ColorTextMuted = Color(0xFF93A3B8)
    val ColorTextDim = Color(0xFF5C6A82)
}

/** Applies standard frosted-glass spatial card styling to a composable. */
fun Modifier.spatialPanel(
    strong: Boolean = false,
    radius: androidx.compose.ui.unit.Dp = XrSpatialTokens.CornerRadiusParent
): Modifier = this
    .background(
        color = if (strong) XrSpatialTokens.ColorPanelStrong else XrSpatialTokens.ColorPanel,
        shape = RoundedCornerShape(radius)
    )
    .border(
        BorderStroke(1.dp, if (strong) XrSpatialTokens.ColorLineStrong else XrSpatialTokens.ColorLine),
        shape = RoundedCornerShape(radius)
    )
