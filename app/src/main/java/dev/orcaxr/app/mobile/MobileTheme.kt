package dev.orcaxr.app.mobile

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.contentColorFor
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.orcaxr.app.ui.InstrumentSans
import dev.orcaxr.app.ui.JetBrainsMono
import dev.orcaxr.app.ui.SpaceGrotesk

/**
 * Material 3 palette for OrcaXR's phone / tablet APK. Mirrors the
 * design-bundle tokens (orcaxr-phone-and-tablet/project/tokens.jsx)
 * exactly so visual parity with the Pixel-frame mockups holds. The XR
 * shell keeps using OrcaXrColorScheme (BgDeep + Mint, dark only) — this
 * scheme is dual (light + dark) and tuned for handheld glare, so the
 * teal stays vibrant against either surface family.
 */
object MobilePalette {
    val BrandMint        = Color(0xFF79D0C7)
    val BrandMintDeep    = Color(0xFF006A60)

    object Dark {
        val Bg              = Color(0xFF0A1626)
        val Surface         = Color(0xFF0F1D30)
        val SurfaceLow      = Color(0xFF0C1828)
        val SurfaceHigh     = Color(0xFF162639)
        val SurfaceHighest  = Color(0xFF1C2E44)
        val Outline         = Color(0xFF34495F)
        val OutlineFaint    = Color(0xFF1F3147)
        val OnSurface       = Color(0xFFE6EEF7)
        val OnSurfaceMute   = Color(0xFF9AB0C8)
        val OnSurfaceDim    = Color(0xFF6B819B)
        val Primary         = BrandMint
        val OnPrimary       = Color(0xFF00322B)
        val PrimaryCtnr     = Color(0xFF1D4A44)
        val OnPrimaryCtnr   = Color(0xFF9BEADF)
        val Secondary       = Color(0xFFB1CCD1)
        val SecondaryCtnr   = Color(0xFF33484D)
        val Error           = Color(0xFFFFB4AB)
        val OnError         = Color(0xFF1A0606)
        val Warn            = Color(0xFFFFB86B)
        val OnWarn          = Color(0xFF3A2300)
        val Success         = Color(0xFF85D6A3)
    }

    object Light {
        val Bg              = Color(0xFFF4FAF9)
        val Surface         = Color(0xFFFFFFFF)
        val SurfaceLow      = Color(0xFFEEF5F3)
        val SurfaceHigh     = Color(0xFFE3EEEC)
        val SurfaceHighest  = Color(0xFFD6E6E3)
        val Outline         = Color(0xFFBCC8C5)
        val OutlineFaint    = Color(0xFFDDE6E4)
        val OnSurface       = Color(0xFF0A1F1C)
        val OnSurfaceMute   = Color(0xFF475553)
        val OnSurfaceDim    = Color(0xFF6B7977)
        val Primary         = BrandMintDeep
        val OnPrimary       = Color(0xFFFFFFFF)
        val PrimaryCtnr     = Color(0xFF9BEADF)
        val OnPrimaryCtnr   = Color(0xFF00201C)
        val Secondary       = Color(0xFF4A635F)
        val SecondaryCtnr   = Color(0xFFCCE8E2)
        val Error           = Color(0xFFBA1A1A)
        val OnError         = Color(0xFFFFFFFF)
        val Warn            = Color(0xFFA85B00)
        val OnWarn          = Color(0xFFFFFFFF)
        val Success         = Color(0xFF1F7A3A)
    }
}

private val MobileDarkColorScheme = darkColorScheme(
    primary = MobilePalette.Dark.Primary,
    onPrimary = MobilePalette.Dark.OnPrimary,
    primaryContainer = MobilePalette.Dark.PrimaryCtnr,
    onPrimaryContainer = MobilePalette.Dark.OnPrimaryCtnr,
    secondary = MobilePalette.Dark.Secondary,
    onSecondary = MobilePalette.Dark.OnPrimary,
    secondaryContainer = MobilePalette.Dark.SecondaryCtnr,
    onSecondaryContainer = MobilePalette.Dark.Secondary,
    tertiary = MobilePalette.Dark.Warn,
    onTertiary = MobilePalette.Dark.OnWarn,
    background = MobilePalette.Dark.Bg,
    onBackground = MobilePalette.Dark.OnSurface,
    surface = MobilePalette.Dark.Surface,
    onSurface = MobilePalette.Dark.OnSurface,
    surfaceVariant = MobilePalette.Dark.SurfaceHigh,
    onSurfaceVariant = MobilePalette.Dark.OnSurfaceMute,
    surfaceContainerLowest = MobilePalette.Dark.Bg,
    surfaceContainerLow = MobilePalette.Dark.SurfaceLow,
    surfaceContainer = MobilePalette.Dark.Surface,
    surfaceContainerHigh = MobilePalette.Dark.SurfaceHigh,
    surfaceContainerHighest = MobilePalette.Dark.SurfaceHighest,
    outline = MobilePalette.Dark.Outline,
    outlineVariant = MobilePalette.Dark.OutlineFaint,
    error = MobilePalette.Dark.Error,
    onError = MobilePalette.Dark.OnError,
)

private val MobileLightColorScheme = lightColorScheme(
    primary = MobilePalette.Light.Primary,
    onPrimary = MobilePalette.Light.OnPrimary,
    primaryContainer = MobilePalette.Light.PrimaryCtnr,
    onPrimaryContainer = MobilePalette.Light.OnPrimaryCtnr,
    secondary = MobilePalette.Light.Secondary,
    onSecondary = MobilePalette.Light.OnPrimary,
    secondaryContainer = MobilePalette.Light.SecondaryCtnr,
    onSecondaryContainer = MobilePalette.Light.Secondary,
    tertiary = MobilePalette.Light.Warn,
    onTertiary = MobilePalette.Light.OnWarn,
    background = MobilePalette.Light.Bg,
    onBackground = MobilePalette.Light.OnSurface,
    surface = MobilePalette.Light.Surface,
    onSurface = MobilePalette.Light.OnSurface,
    surfaceVariant = MobilePalette.Light.SurfaceHigh,
    onSurfaceVariant = MobilePalette.Light.OnSurfaceMute,
    surfaceContainerLowest = MobilePalette.Light.Bg,
    surfaceContainerLow = MobilePalette.Light.SurfaceLow,
    surfaceContainer = MobilePalette.Light.Surface,
    surfaceContainerHigh = MobilePalette.Light.SurfaceHigh,
    surfaceContainerHighest = MobilePalette.Light.SurfaceHighest,
    outline = MobilePalette.Light.Outline,
    outlineVariant = MobilePalette.Light.OutlineFaint,
    error = MobilePalette.Light.Error,
    onError = MobilePalette.Light.OnError,
)

/**
 * Type scale: Space Grotesk for display / headline / title (panel
 * titles), Roboto-class Instrument Sans for body / label, JetBrains
 * Mono for numerics. Same three families the XR shell uses, just
 * scaled differently for handheld viewing distance (~30 cm vs the XR
 * panel's ~70 cm).
 */
private val MobileTypography = Typography(
    displayLarge   = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.Bold,     fontSize = 32.sp, letterSpacing = (-0.5).sp),
    displayMedium  = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.Bold,     fontSize = 28.sp, letterSpacing = (-0.5).sp),
    displaySmall   = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    headlineLarge  = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    headlineMedium = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    headlineSmall  = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    titleLarge     = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleMedium    = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.SemiBold, fontSize = 15.sp, letterSpacing = 0.1.sp),
    titleSmall     = TextStyle(fontFamily = SpaceGrotesk,    fontWeight = FontWeight.Medium,   fontSize = 13.sp, letterSpacing = 0.1.sp),
    bodyLarge      = TextStyle(fontFamily = InstrumentSans,  fontWeight = FontWeight.Normal,   fontSize = 16.sp, letterSpacing = 0.15.sp),
    bodyMedium     = TextStyle(fontFamily = InstrumentSans,  fontWeight = FontWeight.Normal,   fontSize = 14.sp, letterSpacing = 0.2.sp),
    bodySmall      = TextStyle(fontFamily = InstrumentSans,  fontWeight = FontWeight.Normal,   fontSize = 12.sp, letterSpacing = 0.4.sp),
    labelLarge     = TextStyle(fontFamily = InstrumentSans,  fontWeight = FontWeight.SemiBold, fontSize = 14.sp, letterSpacing = 0.1.sp),
    labelMedium    = TextStyle(fontFamily = InstrumentSans,  fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 0.5.sp),
    labelSmall     = TextStyle(fontFamily = InstrumentSans,  fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.5.sp),
)

/** Numeric / kicker / section-label styles that don't fit M3's slots. */
class MobileTextStyles(
    val numeric: TextStyle,
    val numericLarge: TextStyle,
    val kicker: TextStyle,
    val sectionLabel: TextStyle,
)

private fun makeStyles(primary: Color, mute: Color, dim: Color) = MobileTextStyles(
    numeric = TextStyle(
        fontFamily = JetBrainsMono, fontWeight = FontWeight.SemiBold,
        fontSize = 13.sp, letterSpacing = 0.sp,
    ),
    numericLarge = TextStyle(
        fontFamily = JetBrainsMono, fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp, letterSpacing = 0.sp,
    ),
    kicker = TextStyle(
        fontFamily = InstrumentSans, fontWeight = FontWeight.Bold,
        fontSize = 11.sp, letterSpacing = 1.6.sp, color = primary,
    ),
    sectionLabel = TextStyle(
        fontFamily = InstrumentSans, fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp, letterSpacing = 0.6.sp, color = dim,
    ),
)

val LocalMobileTextStyles = staticCompositionLocalOf {
    makeStyles(MobilePalette.BrandMint, MobilePalette.Dark.OnSurfaceMute, MobilePalette.Dark.OnSurfaceDim)
}

/** Indicates whether the active theme is dark, for surface tints that
 *  the M3 ColorScheme can't express by itself (like the `surface`
 *  blend used by the home dashboard's hero card). */
val LocalMobileIsDark = staticCompositionLocalOf { true }

/**
 * Wrap mobile content in OrcaXR's M3 theme. [forceDark] = null follows
 * the system; explicit true / false lets the Settings screen drive a
 * user override.
 */
@Composable
fun OrcaXrMobileTheme(
    forceDark: Boolean? = null,
    content: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val dark = forceDark ?: systemDark
    val scheme = if (dark) MobileDarkColorScheme else MobileLightColorScheme
    val styles = if (dark) {
        makeStyles(MobilePalette.Dark.Primary, MobilePalette.Dark.OnSurfaceMute, MobilePalette.Dark.OnSurfaceDim)
    } else {
        makeStyles(MobilePalette.Light.Primary, MobilePalette.Light.OnSurfaceMute, MobilePalette.Light.OnSurfaceDim)
    }
    MaterialTheme(
        colorScheme = scheme,
        typography = MobileTypography,
    ) {
        CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides
                contentColorFor(MaterialTheme.colorScheme.background),
            LocalMobileTextStyles provides styles,
            LocalMobileIsDark provides dark,
            content = content,
        )
    }
}
