package dev.orcaxr.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import dev.orcaxr.app.mobile.MobileAppState
import dev.orcaxr.app.mobile.MobileShell
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Phone / tablet entry point. Hosts the Material 3 navigation shell
 * (BottomNav on phone, NavRail on tablet) and routes between the nine
 * mobile screens. Reuses the same stores, MoonrakerClient, libslic3r
 * JNI bridge, and pure-Kotlin AiRenderEngine that the XR shell uses;
 * only the presentation layer differs.
 *
 * Activated by [MainActivity] when `Session.create` returns null
 * (i.e. the device is not XR-capable). Not exported as a launcher;
 * MainActivity owns the LAUNCHER intent filter so the system shows a
 * single app icon, and forwards any VIEW / SEND intent to this
 * Activity along with the original Uri data.
 */
class MobileActivity : ComponentActivity() {

    /** Files dropped on us via VIEW / SEND. Drained by the Files screen
     *  and offered as "import this" CTAs. */
    val pendingSharedUris = MutableStateFlow<List<Uri>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // Mirrors MainActivity — Mainsail's nginx in front of Moonraker
        // tears down keepalive on idle sockets. Belt-and-suspenders.
        System.setProperty("http.keepAlive", "false")
        enableEdgeToEdge()

        ingestSharedIntent(intent)

        val appState = MobileAppState(this)

        // Roadmap B14 — drain any VIEW / SEND attached files into the
        // recents list before the shell renders, so a share-to-OrcaXR
        // lands the user on a Files screen with the new file already at
        // the top of the list. Routing into Slicer is a follow-up
        // (would require either a process-singleton "pending file" or
        // an explicit deep-link argument; both are bigger than the
        // current "land in Files" UX warrants).
        lifecycleScope.launch {
            val uris = pendingSharedUris.value
            if (uris.isNotEmpty()) {
                val files = withContext(Dispatchers.IO) {
                    SharedIntentHandler.resolveAll(this@MobileActivity, intent)
                }
                files.forEach { f -> appState.recentFiles.add(f) }
                pendingSharedUris.value = emptyList()
            }
        }

        setContent {
            // Persist user's theme override across config changes AND
            // process death via UserPreferences. A rotation doesn't
            // snap from dark back to system-default, and a kill-and-
            // relaunch keeps the same surface family.
            var forceDarkRaw by rememberSaveable {
                mutableStateOf(appState.prefs.mobileTheme)
            }
            val forceDark: Boolean? = when (forceDarkRaw) {
                THEME_DARK -> true
                THEME_LIGHT -> false
                else -> null
            }
            MobileShell(
                appState = appState,
                forceDark = forceDark,
                onSetForceDark = { v ->
                    val raw = when (v) {
                        true -> THEME_DARK
                        false -> THEME_LIGHT
                        null -> THEME_FOLLOW_SYSTEM
                    }
                    forceDarkRaw = raw
                    appState.prefs.mobileTheme = raw
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        ingestSharedIntent(intent)
    }

    private fun ingestSharedIntent(intent: Intent?) {
        if (intent == null) return
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            Intent.ACTION_SEND -> listOfNotNull(
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri,
            )
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            }
            else -> emptyList()
        }
        if (uris.isNotEmpty()) {
            pendingSharedUris.value = pendingSharedUris.value + uris
        }
    }

    companion object {
        private const val THEME_FOLLOW_SYSTEM = 0
        private const val THEME_DARK = 1
        private const val THEME_LIGHT = 2
    }
}
