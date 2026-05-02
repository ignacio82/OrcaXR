package dev.orcaxr.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.contentColorFor
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.GoogleFont
// Bring the Font(googleFont, fontProvider, weight) factory in under an
// alias — the same `Font(...)` symbol exists in androidx.compose.ui.text.font
// (file/asset/resource overloads) and unqualified the compiler resolves to
// that one and reports "no Font(googleFont = ...) overload."
import androidx.compose.ui.text.googlefonts.Font as GoogleFontFactory
import androidx.compose.ui.unit.sp
import dev.orcaxr.app.R

/**
 * OrcaXR design palette. Tokens mirror the values in the
 * "OrcaXR Spatial UI.html" prototype (see :root in the design's CSS) so a
 * panel can reference, e.g., [OrcaXrColors.Mint] instead of re-quoting
 * `#79D0C7` at every callsite. Hold the values as a plain object so they
 * stay accessible from non-composable code (Surface tints, gradients).
 */
object OrcaXrColors {
    val Mint = Color(0xFF79D0C7)
    val MintBright = Color(0xFF94E2D6)
    val MintDeep = Color(0xFF4DB6AC)
    val Warn = Color(0xFFFFB86B)
    val Red = Color(0xFFF25C5C)

    /** Deep navy used as the base behind translucent panels. */
    val BgDeep = Color(0xFF000814)

    /** Semi-translucent dark navy — the panel default ("--panel"). */
    val Panel = Color(0xCC08101E)

    /** Stronger panel variant for chips / pills ("--panel-strong"). */
    val PanelStrong = Color(0xEB060C18)

    /** Soft elevated surface inside a panel ("--panel-soft"). */
    val PanelSoft = Color(0x8C141E30)

    /** Hairline border ("--line"). */
    val Line = Color(0x1AB4C8E6)

    /** Slightly stronger hairline ("--line-strong"). */
    val LineStrong = Color(0x33B4C8E6)

    val Text = Color(0xFFEEF2F7)
    val TextMuted = Color(0xFF93A3B8)
    val TextDim = Color(0xFF5C6A82)
}

/**
 * Google Fonts provider. Resolves to the Play Services downloadable-fonts
 * authority; the certificate hashes live in res/values/font_certs.xml.
 *
 * Wrapped in a top-level `val` because the Provider is otherwise rebuilt on
 * every call to [orcaXrFont]; the GoogleFont constructor doesn't allocate
 * but the Provider does and Compose stability inference benefits from a
 * single referentially-stable instance.
 */
private val GoogleFontProvider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = R.array.com_google_android_gms_fonts_certs,
)

private fun orcaXrFont(name: String, weight: FontWeight): Font =
    GoogleFontFactory(googleFont = GoogleFont(name), fontProvider = GoogleFontProvider, weight = weight)

/** Body / UI font — Instrument Sans (design's `--font-family`). */
val InstrumentSans = FontFamily(
    orcaXrFont("Instrument Sans", FontWeight.Normal),
    orcaXrFont("Instrument Sans", FontWeight.Medium),
    orcaXrFont("Instrument Sans", FontWeight.SemiBold),
    orcaXrFont("Instrument Sans", FontWeight.Bold),
)

/** Display / panel-title font — Space Grotesk. */
val SpaceGrotesk = FontFamily(
    orcaXrFont("Space Grotesk", FontWeight.Medium),
    orcaXrFont("Space Grotesk", FontWeight.SemiBold),
    orcaXrFont("Space Grotesk", FontWeight.Bold),
)

/** Numerics / monospace font — JetBrains Mono. */
val JetBrainsMono = FontFamily(
    orcaXrFont("JetBrains Mono", FontWeight.Normal),
    orcaXrFont("JetBrains Mono", FontWeight.Medium),
    orcaXrFont("JetBrains Mono", FontWeight.SemiBold),
)

/**
 * Typography wired against the three design fonts. Display / Headline /
 * Title slots use Space Grotesk (the design's panel-title font); Body /
 * Label slots use Instrument Sans (the design's UI font). Numerics get a
 * dedicated `numeric` style instead of overloading bodyMedium so the
 * common case (a regular text label) doesn't accidentally render in the
 * monospace face — callers opt in via [OrcaXrTypography.numeric] /
 * [OrcaXrTypography.kicker].
 */
private val SpatialUiTypography = Typography(
    displayLarge = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.Bold,    fontSize = 32.sp, letterSpacing = 0.sp),
    displayMedium = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.Bold,   fontSize = 26.sp, letterSpacing = 0.sp),
    displaySmall = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, letterSpacing = 0.sp),
    headlineLarge = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, letterSpacing = 0.sp),
    headlineMedium = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, letterSpacing = 0.sp),
    headlineSmall = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, letterSpacing = 0.sp),
    titleLarge = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, letterSpacing = 0.sp),
    titleMedium = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, letterSpacing = 0.1.sp),
    titleSmall = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.Medium,   fontSize = 13.sp, letterSpacing = 0.1.sp),
    bodyLarge = TextStyle(fontFamily = InstrumentSans, fontWeight = FontWeight.Normal,  fontSize = 15.sp, letterSpacing = 0.sp),
    bodyMedium = TextStyle(fontFamily = InstrumentSans, fontWeight = FontWeight.Normal, fontSize = 13.sp, letterSpacing = 0.sp),
    bodySmall = TextStyle(fontFamily = InstrumentSans, fontWeight = FontWeight.Normal,  fontSize = 11.sp, letterSpacing = 0.1.sp),
    labelLarge = TextStyle(fontFamily = InstrumentSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 0.1.sp),
    labelMedium = TextStyle(fontFamily = InstrumentSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.5.sp),
    labelSmall = TextStyle(fontFamily = InstrumentSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp, letterSpacing = 0.5.sp),
)

/**
 * Project-specific styles that don't fit into the Material3 [Typography]
 * scale (uppercase mint kicker, monospace numeric value). Routed through a
 * CompositionLocal so a panel can write `LocalOrcaXrTypography.current.numeric`
 * without dragging the FontFamily around.
 */
class OrcaXrTextStyles(
    val numeric: TextStyle,
    val kicker: TextStyle,
    val sectionLabel: TextStyle,
    val sliceButton: TextStyle,
)

private val DefaultOrcaXrTextStyles = OrcaXrTextStyles(
    // Tabular nums for any aligned number column ("3h 24m", "42.6 g · 14.2 m").
    numeric = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight.SemiBold,
        fontSize = 12.sp,
        letterSpacing = 0.sp,
    ),
    // Uppercase mint hint over a section ("READY", "PREVIEW").
    kicker = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.Bold,
        fontSize = 10.sp,
        letterSpacing = 1.6.sp,
        color = OrcaXrColors.Mint,
    ),
    // Uppercase muted label ("PRINTER", "PRINTER FILAMENTS").
    sectionLabel = TextStyle(
        fontFamily = InstrumentSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        letterSpacing = 0.6.sp,
        color = OrcaXrColors.TextDim,
    ),
    sliceButton = TextStyle(
        fontFamily = SpaceGrotesk,
        fontWeight = FontWeight.Bold,
        fontSize = 15.sp,
        letterSpacing = 0.1.sp,
    ),
)

val LocalOrcaXrTextStyles = staticCompositionLocalOf { DefaultOrcaXrTextStyles }

/**
 * Material3 ColorScheme bound to OrcaXR tokens. The XR shell's MaterialTheme
 * call below feeds this through to every Compose panel — `Color.White` /
 * `Color(0xFF15181B)` literals scattered across UiPanels.kt should migrate
 * to MaterialTheme.colorScheme.* as panels get touched, but the legacy
 * literals stay readable in the meantime because the palette shifted in
 * the same direction (cool-dark-on-mint).
 */
val OrcaXrColorScheme = darkColorScheme(
    primary = OrcaXrColors.Mint,
    onPrimary = Color(0xFF001A18),
    primaryContainer = OrcaXrColors.MintDeep,
    onPrimaryContainer = Color(0xFF001A18),
    secondary = OrcaXrColors.MintBright,
    onSecondary = Color(0xFF001A18),
    tertiary = OrcaXrColors.Warn,
    onTertiary = Color(0xFF1A1000),
    error = OrcaXrColors.Red,
    onError = Color(0xFF1A0606),
    background = OrcaXrColors.BgDeep,
    onBackground = OrcaXrColors.Text,
    surface = Color(0xFF0A1426),
    onSurface = OrcaXrColors.Text,
    surfaceVariant = Color(0xFF14213A),
    onSurfaceVariant = OrcaXrColors.TextMuted,
    outline = OrcaXrColors.LineStrong,
    outlineVariant = OrcaXrColors.Line,
)

/**
 * Wrap a Composable subtree in the OrcaXR theme: palette + typography +
 * extended text styles. Replaces the inline `MaterialTheme(colorScheme =
 * OrcaXrColorScheme)` block in [dev.orcaxr.app.MainActivity].
 *
 * Re-asserts [androidx.compose.material3.LocalContentColor] explicitly —
 * the GEMINI.md gotcha #4 (a missing LocalContentColor provider lets a
 * SpatialPanel's content surface paint with `Color.Unspecified`) is the
 * reason this is wrapped in a CompositionLocalProvider rather than a
 * bare MaterialTheme call.
 */
@Composable
fun OrcaXrTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = OrcaXrColorScheme,
        typography = SpatialUiTypography,
    ) {
        CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides
                contentColorFor(MaterialTheme.colorScheme.background),
            LocalOrcaXrTextStyles provides DefaultOrcaXrTextStyles,
            content = content,
        )
    }
}
