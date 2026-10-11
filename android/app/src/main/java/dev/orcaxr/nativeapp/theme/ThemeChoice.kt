package dev.orcaxr.nativeapp.theme

import android.content.Context
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconToggleButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R

/**
 * Which theme is shown: the browser's switch (`btn-theme`, web/src/main.ts) on a
 * device that has a dark setting of its own. An explicit choice is remembered
 * on this device and outranks everything else, as the browser's does
 * (`setDomTheme`, `storedDomTheme`); without one the app follows the system's
 * dark theme. The browser opens light instead, because a desktop's colour
 * scheme is not a preference about the slicer Orca users know; Android's dark
 * theme is the person's own setting (and an accessibility one), which apps
 * are expected to honour.
 */
object ThemeChoice {
    /** The values the browser stores (`orcaxr.theme`). */
    const val LIGHT = "light"
    const val DARK = "dark"

    /** Whether the dark theme shows, given the [stored] choice (none, or anything unknown, follows the system). */
    fun dark(stored: String?, systemDark: Boolean): Boolean = when (stored) {
        LIGHT -> false
        DARK -> true
        else -> systemDark
    }

    /** What the switch stores when pressed while [dark] shows: the other theme (`setDomTheme(active === 'dark' ? 'light' : 'dark')`). */
    fun toggled(dark: Boolean): String = if (dark) LIGHT else DARK
}

/** The choice as this device keeps it, under the browser's key. */
class ThemePreference(context: Context) {
    private val preferences = context.getSharedPreferences("orcaxr.theme", Context.MODE_PRIVATE)

    var stored: String?
        get() = preferences.getString(KEY, null)?.takeIf { it == ThemeChoice.LIGHT || it == ThemeChoice.DARK }
        set(value) {
            preferences.edit().putString(KEY, value).apply()
        }

    private companion object {
        const val KEY = "orcaxr.theme"
    }
}

/** The theme shown and the switch's action, for the control that offers it. */
class ThemeSwitchState(val dark: Boolean, val toggle: () -> Unit)

val LocalThemeSwitch = compositionLocalOf<ThemeSwitchState?> { null }

/**
 * The browser's theme switch: its `dark_mode` icon, named by what pressing it
 * does ("Switch to dark mode" / "Switch to light mode", the browser's title
 * and label) and pressed while the dark theme shows (its `aria-pressed`).
 */
@Composable
fun ThemeSwitch(modifier: Modifier = Modifier) {
    val state = LocalThemeSwitch.current ?: return
    val label = stringResource(if (state.dark) R.string.theme_switch_light else R.string.theme_switch_dark)
    IconToggleButton(checked = state.dark, onCheckedChange = { state.toggle() }, modifier = modifier.semantics { contentDescription = label }) {
        Icon(painterResource(R.drawable.ic_theme_dark), contentDescription = null, modifier = Modifier.size(20.dp))
    }
}
