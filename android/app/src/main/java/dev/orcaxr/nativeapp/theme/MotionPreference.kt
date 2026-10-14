package dev.orcaxr.nativeapp.theme

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf

/** Preference storage for reduce-motion. */
class MotionPreference(context: Context) {
    private val preferences = context.getSharedPreferences("orcaxr.motion", Context.MODE_PRIVATE)

    var reduceMotion: Boolean
        get() = preferences.getBoolean(KEY, false)
        set(value) {
            preferences.edit().putBoolean(KEY, value).apply()
        }

    private companion object {
        const val KEY = "orcaxr.reduce_motion"
    }
}

val LocalReduceMotion = compositionLocalOf { false }

/** Wraps [content] with [LocalReduceMotion] indicating whether motion should be suppressed. */
@Composable
fun OrcaMotionScope(
    reduceMotion: Boolean,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalReduceMotion provides reduceMotion,
        content = content,
    )
}
