package dev.orcaxr.nativeapp.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The app's Material theme, built from the browser's design tokens
 * ([OrcaTokens], generated from web/src/ui/tokens.ts and the stylesheet by
 * tools/cross-platform/android-tokens.mjs): the flat shell's light or dark
 * colours, its type ramp and radii. [OrcaTheme] puts it in force;
 * [LocalOrcaTheme] gives code the browser's own roles where Material has none
 * (the window chrome, the viewport's wash, the plate). Material 1.4 keeps its
 * motion scheme internal, so components move as Material's do (the browser's
 * motion tokens are generated for the app's own animations, of which there are
 * none yet); Compose scales every animation by the system's animator duration
 * scale, which is the app's reduced motion.
 */
object OrcaThemes {
    /** The theme's tokens. */
    fun tokens(dark: Boolean): OrcaThemeTokens = if (dark) OrcaTokens.dark else OrcaTokens.light

    /**
     * Material's colour roles from the browser's: the window is `bg` (the
     * browser's areas are pages on its grey), cards `bgCard`, menus and dialogs
     * `bgElevated`; the accent is primary and the selected-row tint the
     * containers; the status colours are error and tertiary (warnings); field
     * and switch boundaries are `strokeStrong`, the 3:1 control boundary.
     */
    fun colorScheme(dark: Boolean): ColorScheme {
        val c = tokens(dark).color
        // Snackbars sit on the inverse surface (the theme's text colour): their accent is the other theme's teal that reads on it.
        val inversePrimary = if (dark) OrcaTokens.light.color.accent2 else OrcaTokens.dark.color.accentSoft
        // Every role is set: Material's own light or dark defaults only fill roles it adds later.
        return (if (dark) darkColorScheme() else lightColorScheme()).copy(
            primary = Color(c.accent), onPrimary = Color(c.onAccent),
            primaryContainer = Color(c.selection), onPrimaryContainer = Color(c.text), inversePrimary = Color(inversePrimary),
            secondary = Color(c.accent2), onSecondary = Color(c.onAccent),
            secondaryContainer = Color(c.selection), onSecondaryContainer = Color(c.text),
            tertiary = Color(c.warn), onTertiary = Color(c.onAccent),
            tertiaryContainer = Color(c.warnSurface), onTertiaryContainer = Color(c.text),
            background = Color(c.bg), onBackground = Color(c.text), surface = Color(c.bg), onSurface = Color(c.text),
            surfaceVariant = Color(c.surface), onSurfaceVariant = Color(c.textMuted), surfaceTint = Color(c.accent),
            inverseSurface = Color(c.text), inverseOnSurface = Color(c.bgCard),
            error = Color(c.danger), onError = Color(c.onAccent), errorContainer = Color(c.dangerSurface), onErrorContainer = Color(c.text),
            outline = Color(c.strokeStrong), outlineVariant = Color(c.stroke), scrim = Color.Black,
            surfaceBright = Color(c.bgCard), surfaceDim = Color(c.bg),
            surfaceContainerLowest = Color(c.bgCard), surfaceContainerLow = Color(c.bgSunken),
            surfaceContainer = Color(c.bgElevated), surfaceContainerHigh = Color(c.bgElevated), surfaceContainerHighest = Color(c.bgCard),
        )
    }

    /** A browser text role as a Compose style: its size, weight and line height, the shell's sans (or mono) family, no tracking. */
    fun style(role: OrcaTextRole): TextStyle = TextStyle(
        fontFamily = family(if (role.mono) OrcaTokens.mono else OrcaTokens.sans),
        fontWeight = FontWeight(role.weight),
        fontSize = role.sizeSp.sp,
        lineHeight = role.lineHeightSp?.sp ?: TextStyle.Default.lineHeight,
        letterSpacing = 0.sp,
    )

    private fun family(family: OrcaFamily): FontFamily = when (family) {
        OrcaFamily.SANS -> FontFamily.SansSerif
        OrcaFamily.MONO -> FontFamily.Monospace
        OrcaFamily.SERIF -> FontFamily.Serif
    }

    /**
     * Material's type roles from the browser's stylesheet, each the role of the
     * same purpose: titles are its page titles (and nothing it draws is larger),
     * section headings its card bands and inspector sections, body its 13 px,
     * small body its field notes, labels its buttons, field labels and units.
     */
    val typography: Typography = OrcaTokens.type.let { t ->
        val title = style(t.pageTitle)
        Typography(
            displayLarge = title, displayMedium = title, displaySmall = title,
            headlineLarge = title, headlineMedium = title, headlineSmall = title, titleLarge = title,
            titleMedium = style(t.cardHeading), titleSmall = style(t.sectionHeading),
            bodyLarge = style(t.body), bodyMedium = style(t.body), bodySmall = style(t.note),
            labelLarge = style(t.button), labelMedium = style(t.fieldLabel), labelSmall = style(t.unit),
        )
    }

    /** The flat shell's radii: 3 dp on a field, 4 on a menu or chip, 6 on a card, sheet or dialog. */
    val shapes = Shapes(
        extraSmall = RoundedCornerShape(OrcaTokens.RADIUS_SM.dp),
        small = RoundedCornerShape(OrcaTokens.RADIUS_MD.dp),
        medium = RoundedCornerShape(OrcaTokens.RADIUS_LG.dp),
        large = RoundedCornerShape(OrcaTokens.RADIUS_LG.dp),
        extraLarge = RoundedCornerShape(OrcaTokens.RADIUS_LG.dp),
    )
}

/** The theme in force, with the browser's roles Material has no name for. */
@Immutable
class OrcaThemeState(val dark: Boolean) {
    val tokens: OrcaThemeTokens = OrcaThemes.tokens(dark)

    /** The window chrome: the bar and rail, as the browser's tab strip. */
    val chrome: Color get() = Color(tokens.color.bgChrome)
    val viewportTop: Color get() = Color(tokens.viewportTop)
    val viewportBottom: Color get() = Color(tokens.viewportBottom)
}

val LocalOrcaTheme = staticCompositionLocalOf { OrcaThemeState(dark = false) }

/** Puts the browser's light or [dark] theme in force for [content]. */
@Composable
fun OrcaTheme(dark: Boolean, content: @Composable () -> Unit) {
    val scheme = remember(dark) { OrcaThemes.colorScheme(dark) }
    val state = remember(dark) { OrcaThemeState(dark) }
    MaterialTheme(colorScheme = scheme, shapes = OrcaThemes.shapes, typography = OrcaThemes.typography) {
        CompositionLocalProvider(LocalOrcaTheme provides state, content = content)
    }
}
