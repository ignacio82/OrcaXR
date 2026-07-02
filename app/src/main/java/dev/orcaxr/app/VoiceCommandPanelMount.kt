package dev.orcaxr.app

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.xr.runtime.Session
import dev.orcaxr.app.llm.VoiceInput
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.voice.VoiceCommandPanel
import dev.orcaxr.app.voice.VoiceIntent
import kotlinx.coroutines.launch

/**
 * Roadmap C8 — host for [VoiceCommandPanel] inside MainActivity.
 *
 * Owns the Activity-side wiring that the pure UI panel deliberately
 * doesn't:
 *   - [VoiceInput] lifecycle (start / stop / dispose).
 *   - RECORD_AUDIO permission flow via
 *     [ActivityResultContracts.RequestPermission].
 *   - Mapping each [VoiceIntent] back into either a
 *     [WorkspaceAction] emission (most cases) or a top-nav-flag flip
 *     (Show/Hide Help, Open Settings, "Send to Assistant").
 *   - SpatialPanel mount via [MovablePanelWrapper].
 *
 * Pulled into its own Composable so MainActivity stays readable —
 * the panel needs ~30 lines of state + a 20-branch when-dispatcher,
 * which would otherwise sit awkwardly between the existing
 * Adaptive / Simplify mounts.
 */
@Composable
internal fun VoiceCommandPanelMount(
    onClose: () -> Unit,
    helpToggle: () -> Unit,
    settingsToggle: () -> Unit,
    assistantToggle: () -> Unit,
    session: Session,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val voice = remember { VoiceInput(context.applicationContext) }
    DisposableEffect(Unit) { onDispose { voice.release() } }

    var hasPermission by remember { mutableStateOf(VoiceInput.hasPermission(context)) }
    var isListening by remember { mutableStateOf(false) }
    var partial by remember { mutableStateOf("") }
    var finalText by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasPermission = granted
        if (!granted) error = "Microphone permission denied."
    }

    fun startListening() {
        // Refresh the permission cache — the user may have granted
        // RECORD_AUDIO from settings while the app was foregrounded.
        hasPermission = VoiceInput.hasPermission(context)
        if (!hasPermission) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        error = null
        partial = ""
        finalText = null
        voice.start(
            onPartial = { partial = it },
            onFinal = { f ->
                isListening = false
                partial = ""
                finalText = f
            },
            onError = { msg ->
                isListening = false
                partial = ""
                error = msg
            },
        )
        isListening = true
    }

    fun stopListening() {
        voice.stop()
        isListening = false
    }

    val ws = WorkspaceModel.get()
    fun dispatch(intent: VoiceIntent) {
        when (intent) {
            VoiceIntent.SliceActivePlate -> scope.launch { ws.emit(WorkspaceAction.SliceActivePlate) }
            is VoiceIntent.CancelSlice -> {
                scope.launch { ws.emit(WorkspaceAction.CancelSlice) }
                SlicerEngine.abort()
            }
            VoiceIntent.SaveGcode -> scope.launch { ws.emit(WorkspaceAction.SaveGcodeToDownloads) }
            VoiceIntent.SaveProjectAs3mf -> scope.launch { ws.emit(WorkspaceAction.SaveProject3mf) }
            VoiceIntent.SaveModelAsStl -> scope.launch { ws.emit(WorkspaceAction.SaveModelStl) }
            is VoiceIntent.SetWorkspaceMode -> {
                val mode = when (intent.mode) {
                    "prepare" -> WorkspaceMode.Prepare
                    "preview" -> WorkspaceMode.Preview
                    "devices", "printers" -> WorkspaceMode.Devices
                    else -> WorkspaceMode.Prepare
                }
                scope.launch { ws.emit(WorkspaceAction.SetWorkspaceMode(mode)) }
            }
            is VoiceIntent.SetPreference -> {
                // The two preference toggles wired into WorkspaceAction
                // are SetShowTravels + SetToolpathTubes. The mapper only
                // emits these two keys today; new keys land here as new
                // SetX actions are added.
                val v = intent.value
                when (intent.key) {
                    "show_travels" -> if (v is Boolean) {
                        scope.launch { ws.emit(WorkspaceAction.SetShowTravels(v)) }
                    }
                    "toolpath_tubes" -> if (v is Boolean) {
                        scope.launch { ws.emit(WorkspaceAction.SetToolpathTubes(v)) }
                    }
                }
            }
            is VoiceIntent.SetActivePlate ->
                scope.launch { ws.emit(WorkspaceAction.SetActivePlateId(intent.plateId)) }
            VoiceIntent.AutoArrangePlate ->
                scope.launch { ws.emit(WorkspaceAction.AutoArrangePlate) }
            VoiceIntent.DropToBed -> {
                // DropToBed in the action surface takes a single model
                // id; pull the first selected model. No-op if no model
                // is selected (the panel could surface this, but
                // dropping silently is the safer default).
                val sel = ws.placedModels.value
                    .firstOrNull { it.id in ws.selectedModelIds.value }
                    ?: ws.placedModels.value.firstOrNull()
                if (sel != null) scope.launch { ws.emit(WorkspaceAction.DropToBed(sel.id)) }
            }
            is VoiceIntent.DeleteSelected -> {
                val ids = ws.selectedModelIds.value
                if (ids.isNotEmpty()) {
                    scope.launch { ws.emit(WorkspaceAction.DeleteModels(ids)) }
                }
            }
            VoiceIntent.ClearSelection ->
                scope.launch { ws.emit(WorkspaceAction.SetSelectedModels(emptySet(), additive = false)) }
            VoiceIntent.AutoPositionWipeTower -> {
                // No dedicated WorkspaceAction — call the MCP tool's
                // underlying scorer directly. Persists the picked X/Y
                // into UserPreferences so the next slice picks them up.
                scope.launch {
                    val placed = ws.placedModels.value
                    val plateId = ws.activePlateId.value
                    val parts = placed.filter { it.plateId == plateId }.map { m ->
                        val (w, d) = m.footprintMm()
                        WipeTowerPlacement.AabbXY.of(
                            m.translateXmm, m.translateYmm,
                            w.coerceAtLeast(1f), d.coerceAtLeast(1f),
                        )
                    }
                    val prefs = UserPreferences(context)
                    val pick = WipeTowerPlacement.score(
                        parts = parts, bedW = 270f, bedD = 270f,
                    )
                    prefs.wipeTowerAutoPosition = true
                    prefs.wipeTowerXOverride = pick.xMm
                    prefs.wipeTowerYOverride = pick.yMm
                }
            }
            VoiceIntent.ExportSettings -> {
                scope.launch {
                    val envelope = SettingsBackup.exportJson(context)
                    val downloads = android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_DOWNLOADS,
                    )
                    if (!downloads.exists()) downloads.mkdirs()
                    val ts = java.text.SimpleDateFormat(
                        "yyyyMMdd-HHmmss", java.util.Locale.US,
                    ).format(java.util.Date())
                    val dest = java.io.File(downloads, "orcaxr-settings-$ts.json")
                    dest.writeText(envelope.toString(2))
                }
            }
            is VoiceIntent.AddHandyModel -> {
                val model = HandyModelCatalog.byId(intent.id)
                if (model != null) {
                    scope.launch {
                        val staged = runCatching { HandyModelCatalog.stage(context, model) }.getOrNull()
                        if (staged != null) {
                            ws.emit(
                                WorkspaceAction.LoadModelFromPath(
                                    path = staged.absolutePath,
                                    mode = WorkspaceAction.LoadMode.Replace,
                                ),
                            )
                        }
                    }
                }
            }
            VoiceIntent.ShowHelp, VoiceIntent.HideHelp -> helpToggle()
            VoiceIntent.OpenSettings -> settingsToggle()
            VoiceIntent.Undo, VoiceIntent.Redo -> {
                // Paint undo/redo is per-model. Pick the first selected
                // model; if none selected, no-op (rather than guessing
                // — undo on the wrong model is destructive).
                val sel = ws.selectedModelIds.value.firstOrNull() ?: return
                scope.launch {
                    ws.emit(
                        if (intent == VoiceIntent.Undo) WorkspaceAction.PaintUndo(sel)
                        else WorkspaceAction.PaintRedo(sel),
                    )
                }
            }
        }
    }

    MovablePanelWrapper(
        id = "voice-panel",
        width = 540.dp,
        height = 720.dp,
        initialOffset = androidx.xr.runtime.math.Vector3(1.12f, -0.05f, -0.15f),
        session = session,
    ) {
        VoiceCommandPanel(
            isListening = isListening,
            partial = partial,
            final = finalText,
            error = error,
            hasMicPermission = hasPermission,
            onRequestPermission = {
                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            },
            onStartListening = ::startListening,
            onStopListening = ::stopListening,
            onClose = onClose,
            onDispatch = ::dispatch,
            onDispatchToAssistant = {
                // Hand off to the in-app LLM assistant. The assistant
                // already owns the full MCP tool surface, so anything
                // the keyword mapper missed lands there with the same
                // expressive power.
                assistantToggle()
            },
        )
    }
}
