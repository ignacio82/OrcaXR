package dev.orcaxr.app

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.orcaxr.app.mcp.McpController
import dev.orcaxr.app.mcp.McpShareSnippet
import dev.orcaxr.app.mcp.RemoteMcpEndpoint
import dev.orcaxr.app.mcp.RemoteMcpStore
import dev.orcaxr.app.mobile.MobileAppState
import dev.orcaxr.app.mobile.MobileShell
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

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

    /**
     * Most-recently-staged shared file's absolute path. The shell
     * watches this and, when non-null, routes the user directly into
     * the Slicer screen with the file pre-loaded — closes the
     * share-to-OrcaXR UX loop without a manual "go to Files, tap
     * the new entry" step.
     */
    val pendingSlicerFile = MutableStateFlow<String?>(null)

    /**
     * Most-recently-received OrcaXR MCP grant (the snippet the XR
     * headset's Devices → MCP → Share button drops onto a Quick Share
     * intent). The shell watches this and, when non-null, raises a
     * one-shot "Use this remote MCP?" confirmation dialog so the user
     * sees that the share landed and can review the URL+token before
     * the phone starts trusting it. Drained by the dialog so a
     * recomposition doesn't re-prompt.
     */
    val pendingRemoteMcp = MutableStateFlow<RemoteMcpEndpoint?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // Mirrors MainActivity — Mainsail's nginx in front of Moonraker
        // tears down keepalive on idle sockets. Belt-and-suspenders.
        System.setProperty("http.keepAlive", "false")
        enableEdgeToEdge()

        ingestSharedIntent(intent)

        observeMcpForLifecycle()

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
                val files = SharedIntentHandler.resolveAllBounded(this@MobileActivity, intent)
                files.forEach { f -> appState.recentFiles.add(f) }
                files.firstOrNull()?.let { pendingSlicerFile.value = it.absolutePath }
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
                pendingSlicerFile = pendingSlicerFile,
                pendingRemoteMcp = pendingRemoteMcp,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        ingestSharedIntent(intent)
    }

    /**
     * Home-button (and gesture nav home-swipe) hook. We use this
     * exclusively for opt-into PiP: when the MCP server is running,
     * shrink the workspace into a PiP window instead of letting the
     * activity go to onStop. While in PiP the activity stays in
     * RESUMED, so the WorkspaceBinding DisposableEffect doesn't fire,
     * `attached` stays true, and an LLM driving OrcaXR over MCP can
     * keep using the renderer-backed tools (paint_*, render_view,
     * find_feature_anchors, etc.) while the user does something else
     * on the phone. Gated on serverRunning so non-MCP users still
     * get the standard "back to launcher" home behavior.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return
        val ctl = McpController.get(this)
        if (!ctl.serverRunning.value) return
        if (isInPictureInPictureMode) return
        val params = PictureInPictureParams.Builder()
            // 16:9 keeps the workspace readable in the PiP slab — the
            // shell is mostly the GL surface plus a thin chrome
            // strip; a square would crop the chrome.
            .setAspectRatio(Rational(16, 9))
            .build()
        try {
            enterPictureInPictureMode(params)
        } catch (e: IllegalStateException) {
            // Some OEM skins reject PiP under specific conditions
            // (split-screen, lock-task, etc.). Logged but never
            // rethrown — falling back to normal background is
            // strictly safer than crashing the home-button path.
            Log.w("OrcaXR/Mobile", "enterPictureInPictureMode rejected: ${e.message}")
        }
    }

    /**
     * Bind two MCP-driven activity behaviors together:
     *  1. FLAG_KEEP_SCREEN_ON while the server is running — without
     *     this, screen-timeout drops the activity into onStop, the
     *     WorkspaceBinding DisposableEffect runs onDispose, and the
     *     remote MCP client suddenly gets "OrcaXR not attached" on
     *     every paint / render call. Toggling the flag in lockstep
     *     with the server means battery is only burned while the
     *     user genuinely opted into a remotely-driven session.
     *  2. (Hooked from onUserLeaveHint above — left here as a
     *     reading-order anchor, no work to do in this method.)
     *
     * Uses repeatOnLifecycle(STARTED) so the collector is paused
     * when the activity is in PiP-only-not-visible / stopped state
     * — when the user comes back, it resumes from the latest value
     * (StateFlow conflates) and re-applies the flag.
     */
    private fun observeMcpForLifecycle() {
        val ctl = McpController.get(this)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                ctl.serverRunning.collect { running ->
                    if (running) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }
            }
        }
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
        // Quick-Share-an-MCP-grant path. SEND with text/plain + an
        // EXTRA_TEXT that contains the OrcaXR signature line is
        // unambiguous; everything else (a Twitter link, a regular
        // SMS) is silently ignored by the parser.
        if (intent.action == Intent.ACTION_SEND &&
            (intent.type == "text/plain" || intent.type == null)
        ) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)
            McpShareSnippet.parse(text)?.let { endpoint ->
                pendingRemoteMcp.value = endpoint
                lifecycleScope.launch {
                    runCatching {
                        RemoteMcpStore(this@MobileActivity).set(endpoint)
                    }
                }
            }
        }
    }

    companion object {
        private const val THEME_FOLLOW_SYSTEM = 0
        private const val THEME_DARK = 1
        private const val THEME_LIGHT = 2
    }
}
