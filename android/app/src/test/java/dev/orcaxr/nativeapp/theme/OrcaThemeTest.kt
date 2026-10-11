package dev.orcaxr.nativeapp.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import kotlin.math.pow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app's theme against the browser's tokens: the generated values are the
 * browser's (tools/cross-platform/android-tokens.mjs checks them against
 * tokens.ts; here they are checked as the theme uses them), Material's roles
 * take the browser roles of the same purpose, and every pair the app draws —
 * and every pair the browser draws — meets WCAG 2.2 AA in both themes.
 */
class OrcaThemeTest {
    /** WCAG 2.x relative luminance of an opaque colour. */
    private fun luminance(argb: Long): Double {
        fun channel(shift: Int): Double {
            val value = ((argb shr shift) and 0xFF) / 255.0
            return if (value <= .04045) value / 12.92 else ((value + .055) / 1.055).pow(2.4)
        }
        assertEquals("opaque", 0xFFL, (argb shr 24) and 0xFF)
        return .2126 * channel(16) + .7152 * channel(8) + .0722 * channel(0)
    }

    private fun contrast(a: Long, b: Long): Double {
        val (light, dark) = listOf(luminance(a), luminance(b)).sortedDescending()
        return (light + .05) / (dark + .05)
    }

    private fun Color.argb(): Long = toArgb().toLong() and 0xFFFFFFFFL

    @Test fun contrastIsWcagRelativeLuminance() {
        assertEquals(21.0, contrast(0xFFFFFFFF, 0xFF000000), 1e-9)
        // The WCAG reference: #767676 is the lightest grey at 4.5:1 on white.
        assertTrue(contrast(0xFF767676, 0xFFFFFFFF) >= 4.5)
        assertTrue(contrast(0xFF777777, 0xFFFFFFFF) < 4.5)
    }

    @Test fun theGeneratedTokensAreTheBrowsers() {
        // Spot values of web/src/ui/tokens.ts; the generator holds every one in CI.
        assertEquals(0xFFE9EBEC, OrcaTokens.light.color.bg)
        assertEquals(0xFF191C1E, OrcaTokens.dark.color.bg)
        assertEquals(0xFF262E30, OrcaTokens.light.color.text)
        assertEquals(0xFFF4F6F7, OrcaTokens.light.viewportTop)
        assertEquals(0xFF15181A, OrcaTokens.dark.viewportBottom)
        assertEquals(listOf(3, 4, 6), listOf(OrcaTokens.RADIUS_SM, OrcaTokens.RADIUS_MD, OrcaTokens.RADIUS_LG))
        assertEquals(listOf(5, 8, 12, 20, 24), listOf(OrcaTokens.SPACE_XS, OrcaTokens.SPACE_SM, OrcaTokens.SPACE_MD, OrcaTokens.SPACE_LG, OrcaTokens.SPACE_XL))
        assertEquals(listOf(120, 150, 200), listOf(OrcaTokens.MOTION_FAST_MS, OrcaTokens.MOTION_BASE_MS, OrcaTokens.MOTION_SLOW_MS))
        // The stylesheet's 13 px body and the narrow window's 12.5 px tabs.
        assertEquals(13f, OrcaTokens.type.body.sizeSp)
        assertEquals(OrcaTextRole(12.5f, 600, null), OrcaTokens.type.tab)
        // Toolpath roles carry meaning: they never change with the theme.
        assertEquals(OrcaTokens.light.color.roleOuterWall, OrcaTokens.dark.color.roleOuterWall)
        assertEquals(OrcaFamily.SANS, OrcaTokens.sans)
        assertEquals(OrcaFamily.MONO, OrcaTokens.mono)
    }

    @Test fun materialRolesAreTheBrowsersOfTheSamePurpose() {
        for (dark in listOf(false, true)) {
            val c = OrcaThemes.tokens(dark).color
            val scheme = OrcaThemes.colorScheme(dark)
            val expected = mapOf(
                "primary" to (scheme.primary to c.accent),
                "onPrimary" to (scheme.onPrimary to c.onAccent),
                "background" to (scheme.background to c.bg),
                "onBackground" to (scheme.onBackground to c.text),
                "surface" to (scheme.surface to c.bg),
                "onSurfaceVariant" to (scheme.onSurfaceVariant to c.textMuted),
                "secondaryContainer" to (scheme.secondaryContainer to c.selection),
                "error" to (scheme.error to c.danger),
                "tertiary" to (scheme.tertiary to c.warn),
                "outline" to (scheme.outline to c.strokeStrong),
                "outlineVariant" to (scheme.outlineVariant to c.stroke),
                "surfaceContainer" to (scheme.surfaceContainer to c.bgElevated),
                "surfaceContainerHigh" to (scheme.surfaceContainerHigh to c.bgElevated),
                "surfaceContainerHighest" to (scheme.surfaceContainerHighest to c.bgCard),
            )
            for ((role, pair) in expected) assertEquals("$role (dark=$dark)", pair.second, pair.first.argb())
        }
    }

    @Test fun typographyIsTheStylesheets() {
        val type = OrcaThemes.typography
        assertEquals(17.sp, type.titleLarge.fontSize)
        assertEquals(FontWeight(700), type.titleLarge.fontWeight)
        assertEquals(12.5.sp, type.titleMedium.fontSize)
        assertEquals(13.sp, type.bodyMedium.fontSize)
        assertEquals(11.sp, type.bodySmall.fontSize)
        assertEquals(15.95.sp, type.bodySmall.lineHeight)
        assertEquals(12.5.sp, type.labelLarge.fontSize)
        assertEquals(0.sp, type.labelLarge.letterSpacing)
        assertEquals(FontFamily.SansSerif, type.bodyMedium.fontFamily)
        // Nothing the browser draws is larger than its page title.
        assertEquals(type.titleLarge, type.displayLarge)
    }

    @Test fun everyPairTheBrowserDrawsMeetsWcagAa() {
        for ((name, tokens) in listOf("light" to OrcaTokens.light, "dark" to OrcaTokens.dark)) {
            val failures = OrcaTokens.contrastPairs.mapNotNull { pair ->
                val ratio = contrast(tokens.color.role(pair.fg), tokens.color.role(pair.bg))
                if (ratio < pair.use.minimum) "${pair.fg} on ${pair.bg} ${"%.2f".format(ratio)}" else null
            }
            assertEquals("$name: browser pairs below WCAG AA", emptyList<String>(), failures)
        }
    }

    /**
     * The pairs the app's components draw, by Material role: text 4.5:1 on every
     * surface it sits on (pages, cards, menus and dialogs, the selected row, the
     * status containers, the viewport's wash, the window chrome, a snackbar),
     * and 3:1 for what finds a control or its state — field and switch
     * boundaries, checked controls and the focus ring, the shown area's
     * indicator, unchecked boxes, an issue card's edge.
     */
    @Test fun everyPairTheAppDrawsMeetsWcagAa() {
        for (dark in listOf(false, true)) {
            val s: ColorScheme = OrcaThemes.colorScheme(dark)
            val t = OrcaThemes.tokens(dark)
            val chrome = t.color.bgChrome
            val text = 4.5
            val ui = 3.0
            val pairs = listOf(
                Triple("onBackground/background", s.onBackground to s.background, text),
                Triple("onSurfaceVariant/background", s.onSurfaceVariant to s.background, text),
                Triple("onSurface/card", s.onSurface to s.surfaceContainerHighest, text),
                Triple("onSurfaceVariant/card", s.onSurfaceVariant to s.surfaceContainerHighest, text),
                Triple("onSurface/menu", s.onSurface to s.surfaceContainer, text),
                Triple("onSurface/dialog", s.onSurface to s.surfaceContainerHigh, text),
                Triple("onSurfaceVariant/dialog", s.onSurfaceVariant to s.surfaceContainerHigh, text),
                Triple("primary/background", s.primary to s.background, text),
                Triple("primary/card", s.primary to s.surfaceContainerHighest, text),
                Triple("primary/dialog", s.primary to s.surfaceContainerHigh, text),
                Triple("onPrimary/primary", s.onPrimary to s.primary, text),
                Triple("error/background", s.error to s.background, text),
                Triple("error/card", s.error to s.surfaceContainerHighest, text),
                Triple("error/dialog", s.error to s.surfaceContainerHigh, text),
                Triple("onSecondaryContainer/secondaryContainer", s.onSecondaryContainer to s.secondaryContainer, text),
                Triple("onSurfaceVariant/secondaryContainer", s.onSurfaceVariant to s.secondaryContainer, text),
                Triple("onTertiaryContainer/tertiaryContainer", s.onTertiaryContainer to s.tertiaryContainer, text),
                Triple("onErrorContainer/errorContainer", s.onErrorContainer to s.errorContainer, text),
                Triple("inverseOnSurface/inverseSurface", s.inverseOnSurface to s.inverseSurface, text),
                Triple("inversePrimary/inverseSurface", s.inversePrimary to s.inverseSurface, text),
                Triple("onBackground/viewportTop", s.onBackground to Color(t.viewportTop), text),
                Triple("onBackground/viewportBottom", s.onBackground to Color(t.viewportBottom), text),
                Triple("onSurface/chrome", s.onSurface to Color(chrome), text),
                Triple("onSurfaceVariant/chrome", s.onSurfaceVariant to Color(chrome), text),
                Triple("outline/background", s.outline to s.background, ui),
                Triple("outline/card", s.outline to s.surfaceContainerHighest, ui),
                Triple("outline/dialog", s.outline to s.surfaceContainerHigh, ui),
                Triple("primary/chrome", s.primary to Color(chrome), ui),
                Triple("onPrimary/primary", s.onPrimary to s.primary, ui),
                Triple("onSurfaceVariant/dialog", s.onSurfaceVariant to s.surfaceContainerHigh, ui),
                Triple("error/errorContainer", s.error to s.errorContainer, ui),
                Triple("tertiary/tertiaryContainer", s.tertiary to s.tertiaryContainer, ui),
            )
            val failures = pairs.mapNotNull { (name, colours, minimum) ->
                val ratio = contrast(colours.first.argb(), colours.second.argb())
                if (ratio < minimum) "$name ${"%.2f".format(ratio)}" else null
            }
            assertEquals("dark=$dark: app pairs below WCAG AA", emptyList<String>(), failures)
        }
    }
}
