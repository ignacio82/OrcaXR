package dev.orcaxr.nativeapp

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.DragEvent
import android.view.KeyEvent
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.CoreCompatibility
import dev.orcaxr.core.DocumentOwners
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.device.DeviceScreen
import dev.orcaxr.nativeapp.prepare.FollowSlicing
import dev.orcaxr.nativeapp.exports.ExportCommands
import dev.orcaxr.nativeapp.exports.ExportHost
import dev.orcaxr.nativeapp.exports.ExportModel
import dev.orcaxr.nativeapp.prepare.PrepareCommands
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.prepare.PrepareScreen
import dev.orcaxr.nativeapp.preview.PreviewModel
import dev.orcaxr.nativeapp.preview.PreviewScreen
import dev.orcaxr.nativeapp.project.DropIntake
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.project.ProjectScreen
import dev.orcaxr.nativeapp.send.SendDialog
import dev.orcaxr.nativeapp.shell.AppActions
import dev.orcaxr.nativeapp.shell.CommandPalette
import dev.orcaxr.nativeapp.shell.LocalActionRunner
import dev.orcaxr.nativeapp.shell.LocalActionStates
import dev.orcaxr.nativeapp.shell.LocalCommandPalette
import dev.orcaxr.nativeapp.shell.FocusVisibleTheme
import dev.orcaxr.nativeapp.shell.Navigation
import dev.orcaxr.nativeapp.shell.ShellArea
import dev.orcaxr.nativeapp.shell.ShellBar
import dev.orcaxr.nativeapp.shell.ShellDestination
import dev.orcaxr.nativeapp.shell.ShellLayout
import dev.orcaxr.nativeapp.shell.ShellRail
import dev.orcaxr.nativeapp.shell.Viewport
import dev.orcaxr.nativeapp.theme.LocalThemeSwitch
import dev.orcaxr.nativeapp.theme.OrcaTheme
import dev.orcaxr.nativeapp.theme.ThemeChoice
import dev.orcaxr.nativeapp.theme.ThemePreference
import dev.orcaxr.nativeapp.theme.ThemeSwitchState
import dev.orcaxr.nativeapp.workspace.WorkspaceScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** The shell. Product areas are added only with complete shared workflows: the
 * workspace preview, Prepare's slicing of the active plate on the external
 * slicer (and sending it to the Device area's printer), the Preview area's
 * G-code viewer over the shared G-code preview, the Device area's printers
 * over the shared printer core, and the Project area's documents over the
 * shared project session.
 *
 * The areas follow the plan's order (Prepare, Preview, Device, Project) after
 * the Workspace, which stays first as the home the app opens on: it shows the
 * plate being prepared, as desktop Orca's Prepare view does, and needs no
 * printer, slicer or document before it shows anything.
 *
 * The window's width arranges them ([ShellLayout]): a bottom bar on a phone,
 * a rail from 600 dp, and from 840 dp the area's panel beside the Workspace
 * (or, in Preview, the toolpath view), as the browser's sidebar beside its
 * viewport. Every control is reached with Tab and Shift+Tab and operated with
 * Enter or Space, with its focus shown ([FocusVisibleTheme]); a dialog is a
 * window of its own, so the focus stays in it and wraps. Files dropped on the
 * window load as the browser's drop does ([DropIntake]). Ctrl/⌘ K, from
 * anywhere, opens the browser's command palette ([CommandPalette]) over the
 * area shown; it, the Workspace's toolbar and the context menus run the
 * catalogue's actions as the menus do ([runAction]).
 *
 * It wears the browser's design tokens ([OrcaTheme]): light or dark as the
 * system is, unless the browser's theme switch (in the Workspace) chose one
 * on this device. It draws edge to edge: content stays clear of the system
 * bars and a display cutout, and above the keyboard while one is up.
 */
class MainActivity : ComponentActivity() {
    private val device: DeviceModel by viewModels()
    private val project: ProjectModel by viewModels()
    private val preview: PreviewModel by viewModels()
    private val prepare: PrepareModel by viewModels()
    private val exports: ExportModel by viewModels()
    /** The area shown; an opened or shared document switches to the Project area, a finished slice to Preview. */
    private var area by mutableIntStateOf(R.string.nav_workspace)
    private val themePreference by lazy { ThemePreference(this) }
    /** The theme chosen with the switch on this device, if any (otherwise the system's decides). */
    private var themeChoice by mutableStateOf<String?>(null)
    /** Whether the command palette is open (Ctrl/⌘ K, or a search button). */
    private var palette by mutableStateOf(false)
    /** Whether the keyboard opened it: someone typing on keys needs no on-screen keyboard over it. */
    private var paletteFromKeys = false
    /** Whether the window's arrangement shows the Workspace's 3D view now. */
    private var workspaceShown = true

    /**
     * Runs catalogue action [id] as the menus run it (`ProjectModel.perform`),
     * showing first the area it needs: the Project area for a document action
     * (its pickers and dialogs carry it out), the Workspace for a camera view
     * or a tool that takes its touch.
     */
    private fun runAction(id: String) {
        if (AppActions.needsExport(id)) {
            // The File menu's exports: the system's picker takes the file over whichever area shows.
            exports.perform(id)
            return
        }
        if (AppActions.needsPrepare(id)) {
            // Slice, Slice All Plates, Cancel Slice and Send: the Prepare area carries them out as its buttons do,
            // with their permission prompt, consent, progress and outcome.
            area = R.string.nav_prepare
            prepare.ask(id)
            return
        }
        if (AppActions.needsProject(id)) area = R.string.nav_project
        if (AppActions.needsWorkspace(id) && !workspaceShown) area = R.string.nav_workspace
        project.perform(id)
    }

    /** [action] as the app enables it: the Prepare area's four as its buttons are, from its state and the Device area's;
     * the exports as the core's gate judges them with the Prepare area's facts, one at a time. */
    private fun actionState(action: ProjectActionState): ProjectActionState {
        if (AppActions.needsExport(action.id)) return ExportCommands.state(action, prepare.state.actions, exports.busy)
        if (!AppActions.needsPrepare(action.id)) return action
        val view = project.view
        val plate = view.activePlate
        val facts = PrepareCommands.Facts.of(prepare.state, plate?.id, plate?.objects, view.revision, device.state.connected, device.sendState.busy)
        return PrepareCommands.state(action, facts)
    }

    /** A document another app opened or shared with OrcaXR, if [intent] carries one. */
    private fun incoming(intent: Intent?): Uri? = when (intent?.action) {
        Intent.ACTION_VIEW -> intent.data
        Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= ANDROID_13) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        else -> null
    }

    /** Opens a handed-over document here — or, when another window already holds it, brings that
     * window forward instead (a window opened just for it then closes): one writer per document. */
    private fun handle(intent: Intent?, created: Boolean) {
        val uri = incoming(intent) ?: return
        val holder = DocumentOwners.process.holder(uri.toString())
        if (holder != null && holder !== project.owner) {
            holder.focus()
            if (created) finish()
            return
        }
        area = R.string.nav_project
        project.openIncoming(uri)
    }

    /**
     * Loads the files a drop carries, as the browser's drop does: models and
     * projects one after another through the Project area, G-code in
     * Preview; what cannot be loaded goes to [refuse] in the browser's words.
     * False when the drop carried no file at all (dragged text, say).
     */
    private fun drop(drag: DragEvent, refuse: (String) -> Unit): Boolean {
        val clip = drag.clipData ?: return false
        val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        if (uris.isEmpty()) return false
        // Read access to what was dropped, for as long as this window lives: an import or Open reads it later, on a worker.
        if (uris.any { it.scheme == ContentResolver.SCHEME_CONTENT }) requestDragAndDropPermissions(drag)
        val plan = DropIntake.plan(uris.map { uri ->
            val shared = uri.scheme == ContentResolver.SCHEME_CONTENT
            DropIntake.Dropped(uri.toString(), displayName(uri, shared), if (shared) mimeType(uri) else null, shared)
        })
        if (plan.refusals.isNotEmpty()) refuse(plan.refusals.joinToString("\n"))
        plan.gcode?.let { gcode -> preview.open(uris.first { it.toString() == gcode.uri }) }
        if (plan.project.isNotEmpty()) project.intake(plan.project)
        when (plan.area) {
            ShellArea.Project -> area = R.string.nav_project
            ShellArea.Preview -> area = R.string.nav_preview
            else -> Unit
        }
        return true
    }

    private fun displayName(uri: Uri, shared: Boolean): String = (if (shared) {
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
            }
        } catch (_: RuntimeException) {
            null
        }
    } else {
        null
    }) ?: uri.lastPathSegment ?: "document"

    private fun mimeType(uri: Uri): String? = try {
        contentResolver.getType(uri)
    } catch (_: RuntimeException) {
        null
    }

    override fun onStop() {
        super.onStop()
        // The system may end the app once it is out of sight, and a window closed or swiped
        // away finishes it without asking: keep unsaved work now (not what was just discarded).
        // A swiped-away task's process can be ended moments after this returns, before a capture
        // left running finishes, so the capture is waited for, briefly, as Android itself waits
        // for pending preference writes when an activity stops. A capture still behind longer
        // work goes on; the timed capture has kept all but the last few seconds.
        val capture = project.captureNow() ?: return
        try {
            capture.get(LEAVE_CAPTURE_WAIT_MS, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
        } catch (_: ExecutionException) {
        }
    }

    /**
     * The browser's edit shortcuts (web/src/actions/groups/edit.ts): Ctrl/Meta+Z undoes,
     * Ctrl/Meta+Shift+Z and Ctrl+Y redo, Delete deletes the selected model and Escape
     * deselects all; Ctrl/Meta+C, +X and +V copy, cut and paste a model (the platform's
     * keys; the browser's catalogue leaves them to page text); G, R and S choose the
     * gizmo's Move, Rotate and Scale (`groups/scene.ts`) — only when nothing focused
     * took the key, as the browser leaves a text field its own editing keys. Ctrl/⌘ K and the
     * paint palette's digits are taken before any control ([windowKey]).
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Reached only by keys no focused view consumed.
        val command = event.isCtrlPressed || event.isMetaPressed
        val plain = !command && !event.isShiftPressed && !event.isAltPressed
        val handled = event.repeatCount == 0 && when {
            // With nothing focused, the window's own keys arrive here rather than through the content's preview.
            windowKey(event) -> true
            command && keyCode == KeyEvent.KEYCODE_Z && !event.isShiftPressed -> project.undoShortcut()
            command && keyCode == KeyEvent.KEYCODE_Z && event.isShiftPressed -> project.redoShortcut()
            event.isCtrlPressed && !event.isShiftPressed && keyCode == KeyEvent.KEYCODE_Y -> project.redoShortcut()
            plain && keyCode == KeyEvent.KEYCODE_FORWARD_DEL -> project.deleteShortcut()
            // Escape ends a paint stroke in flight before it deselects, as the browser's painter takes it first.
            plain && keyCode == KeyEvent.KEYCODE_ESCAPE -> project.paint.escape() || project.escapeShortcut()
            // The platform's clipboard keys for the browser's Copy, Cut and Paste of a model.
            command && !event.isShiftPressed && keyCode == KeyEvent.KEYCODE_C -> project.clipboardShortcut("edit_copy")
            command && !event.isShiftPressed && keyCode == KeyEvent.KEYCODE_X -> project.clipboardShortcut("edit_cut")
            command && !event.isShiftPressed && keyCode == KeyEvent.KEYCODE_V -> project.clipboardShortcut("edit_paste")
            // G, R and S choose the gizmo's Move, Rotate and Scale, on the Workspace (the catalogue's shortcuts).
            plain && keyCode == KeyEvent.KEYCODE_G -> gizmoKey("tool_move")
            plain && keyCode == KeyEvent.KEYCODE_R -> gizmoKey("tool_rotate")
            plain && keyCode == KeyEvent.KEYCODE_S -> gizmoKey("tool_scale")
            else -> false
        }
        return handled || super.onKeyDown(keyCode, event)
    }

    /** A gizmo tool's key: the tool, shown on the Workspace, when the core enables it; answers whether it applied. */
    private fun gizmoKey(id: String): Boolean = project.gizmoShortcut(id).also { if (it) runAction(id) }

    /**
     * The keys the browser takes on its window before any control, answering
     * whether [event] was one: Ctrl/⌘ K opens or closes the command palette
     * from anywhere, a text field too (the browser's `keydown` listener on
     * `window`); and `1`–`9` choose the paint palette's numbered rows whenever
     * the paint tool is on, unless a text field takes the typing — whatever
     * control the keyboard focused (a toolbar button, a chip), which used to
     * swallow the digit. The content's root previews every key before the
     * focused control ([onPreviewKeyEvent]); [onKeyDown] takes them when
     * nothing is focused.
     */
    private fun windowKey(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return false
        val command = event.isCtrlPressed || event.isMetaPressed
        if (command && !event.isShiftPressed && !event.isAltPressed && event.keyCode == KeyEvent.KEYCODE_K) {
            paletteFromKeys = !palette
            palette = !palette
            return true
        }
        val plain = !command && !event.isShiftPressed && !event.isAltPressed
        return plain && event.keyCode in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_9 && project.paint.state.active && !typing() &&
            project.paint.chooseNumber(event.keyCode - KeyEvent.KEYCODE_0)
    }

    /** Whether a text field has the typing now (the input method serves one). */
    private fun typing(): Boolean = getSystemService(InputMethodManager::class.java)?.isAcceptingText == true

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(AREA, area)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent, created = false)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        themeChoice = themePreference.stored
        enableEdgeToEdge()
        project.taskId = taskId
        prepare.bind(project)
        exports.bind(project, prepare)
        if (savedInstanceState == null) handle(intent, created = true) else area = savedInstanceState.getInt(AREA, area)
        setContent {
            // Back with unsaved changes, from any area, asks in the Project area first.
            BackHandler(enabled = project.view.dirty) {
                area = R.string.nav_project
                project.leave(::finish)
            }
            // A finished slice opens in Preview, as desktop Orca turns to its preview once a plate is sliced.
            val sliced = prepare.sliced
            LaunchedEffect(sliced) {
                sliced ?: return@LaunchedEffect
                preview.openSlice(sliced.file, sliced.name, sliced.revision)
                area = R.string.nav_preview
                prepare.slicedShown()
            }
            // Output of a state the project has left is withdrawn wherever it is shown.
            val revision = project.view.revision
            LaunchedEffect(revision) { preview.projectChanged(revision) }
            var state by remember { mutableIntStateOf(R.string.workspace_loading) }
            LaunchedEffect(Unit) {
                state = withContext(Dispatchers.Default) {
                    try {
                        CoreCompatibility.verify()
                        R.string.workspace_development
                    } catch (_: LinkageError) {
                        R.string.workspace_unavailable
                    } catch (_: IllegalStateException) {
                        R.string.workspace_unavailable
                    }
                }
            }
            val dark = ThemeChoice.dark(themeChoice, isSystemInDarkTheme())
            // The system bars' icons follow the theme shown, not only the system's.
            LaunchedEffect(dark) {
                val bars = if (dark) SystemBarStyle.dark(TRANSPARENT) else SystemBarStyle.light(TRANSPARENT, TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }
            val switch = remember(dark) {
                ThemeSwitchState(dark) {
                    val chosen = ThemeChoice.toggled(dark)
                    themePreference.stored = chosen
                    themeChoice = chosen
                }
            }
            OrcaTheme(dark) { CompositionLocalProvider(
                LocalThemeSwitch provides switch,
                LocalCommandPalette provides {
                    paletteFromKeys = false
                    palette = true
                },
                LocalActionRunner provides ::runAction,
                LocalActionStates provides remember { { action: ProjectActionState -> actionState(action) } },
            ) { FocusVisibleTheme {
                val ready = state == R.string.workspace_development
                val layout = ShellLayout.of(LocalWindowInfo.current.containerDpSize.width.value.toInt(), shellArea(area))
                workspaceShown = area == R.string.nav_workspace || layout.viewport == Viewport.Workspace
                val snackbar = remember { SnackbarHostState() }
                // A drop's refusals and an export's outcome: each one's own, so the same words shown again show again.
                var refused by remember { mutableStateOf<Refusal?>(null) }
                ExportHost(exports, prepare, show = { refused = Refusal(it) }, run = ::runAction)
                LaunchedEffect(refused) {
                    refused?.let { snackbar.showSnackbar(it.text, withDismissAction = true, duration = SnackbarDuration.Long) }
                }
                // Over the window while a file is dragged across it, as the browser's drop overlay.
                var over by remember { mutableStateOf(false) }
                val target = remember {
                    object : DragAndDropTarget {
                        override fun onEntered(event: DragAndDropEvent) {
                            over = true
                        }

                        override fun onExited(event: DragAndDropEvent) {
                            over = false
                        }

                        override fun onEnded(event: DragAndDropEvent) {
                            over = false
                        }

                        override fun onDrop(event: DragAndDropEvent): Boolean {
                            over = false
                            return drop(event.toAndroidDragEvent()) { refused = Refusal(it) }
                        }
                    }
                }
                Box(
                    Modifier.fillMaxSize()
                        // Before whichever control has the focus: the window's own keys (Ctrl/⌘ K, the paint palette's digits).
                        .onPreviewKeyEvent { event -> windowKey(event.nativeKeyEvent) }
                        .dragAndDropTarget(shouldStartDragAndDrop = { ready }, target = target),
                ) {
                    Scaffold(
                        bottomBar = {
                            // Every area's whole name: a second row when they do not fit one (enlarged text, a long language).
                            if (ready && layout.navigation == Navigation.Bar) ShellBar(AREAS, area) { area = it }
                        },
                        snackbarHost = { SnackbarHost(snackbar) },
                        // Clear of the system bars, a display cutout and (without a bottom bar) the keyboard.
                        contentWindowInsets = WindowInsets.safeDrawing,
                    ) { scaffolded ->
                        // What the Scaffold kept clear is consumed; the keyboard's height beyond it lifts the work area,
                        // so a focused field stays above the keyboard (the bar, if any, stays under it).
                        val padding = Modifier.padding(scaffolded).consumeWindowInsets(scaffolded).imePadding()
                        if (!ready) {
                            Column(Modifier.fillMaxSize().then(padding),
                                verticalArrangement = Arrangement.Center,
                                horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                                Text(stringResource(state), style = MaterialTheme.typography.bodyLarge)
                            }
                        } else if (layout.navigation == Navigation.Rail) {
                            Row(Modifier.fillMaxSize().then(padding)) {
                                // The Scaffold's padding already keeps it clear of the system bars.
                                ShellRail(AREAS, area, { area = it })
                                Work(layout, Modifier.weight(1f).fillMaxHeight())
                            }
                        } else {
                            Work(layout, Modifier.fillMaxSize().then(padding))
                        }
                    }
                    if (over) DropPrompt()
                }
                // A send's confirmation waits above whichever area is shown: the operator may have moved on.
                device.sendConfirmation?.let { pending -> SendDialog(pending.view, device::answerSend) }
                // The command palette, over whichever area is shown, once the app is ready.
                if (palette && ready) {
                    // What the palette's Slice and Send are judged by, kept current while it is open, whichever area shows.
                    FollowSlicing(prepare, project)
                    CommandPalette(project, paletteFromKeys, onDismiss = { palette = false }, run = ::runAction)
                }
            } } }
        }
    }

    /** The work area: the shown area alone, or its panel at the start beside the [ShellLayout.viewport]. */
    @Composable
    private fun Work(layout: ShellLayout, modifier: Modifier) {
        val panel = Modifier.width(layout.panelWidthDp.dp).fillMaxHeight()
        when (layout.viewport) {
            // One arrangement for every area beside the plate, so moving between them keeps its view.
            Viewport.Workspace -> Row(modifier) {
                when (area) {
                    R.string.nav_project -> ProjectScreen(project, prepare, panel)
                    else -> PrepareScreen(prepare, project, device, panel)
                }
                WorkspaceScreen(project, Modifier.weight(1f).fillMaxHeight())
            }
            Viewport.Toolpath -> PreviewScreen(preview, modifier, panelWidth = layout.panelWidthDp.dp, bed = project.view.bed)
            null -> when (area) {
                R.string.nav_device -> DeviceScreen(device, modifier)
                R.string.nav_project -> ProjectScreen(project, prepare, modifier)
                R.string.nav_prepare -> PrepareScreen(prepare, project, device, modifier)
                R.string.nav_preview -> PreviewScreen(preview, modifier, bed = project.view.bed)
                else -> WorkspaceScreen(project, modifier)
            }
        }
    }
}

/** The browser's drop affordance over the window: a dashed outline round its words, read out as they appear. */
@Composable
private fun DropPrompt() {
    val accent = MaterialTheme.colorScheme.primary
    Box(
        Modifier.fillMaxSize().padding(16.dp)
            .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(12.dp))
            .drawBehind {
                val width = 2.dp.toPx()
                drawRoundRect(
                    accent,
                    cornerRadius = CornerRadius(12.dp.toPx()),
                    style = Stroke(width, pathEffect = PathEffect.dashPathEffect(floatArrayOf(8.dp.toPx(), 6.dp.toPx()))),
                )
            }
            .semantics { liveRegion = LiveRegionMode.Polite },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            stringResource(R.string.drop_prompt),
            Modifier.padding(24.dp),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
    }
}

/** What a drop refused (or an export did), shown once. */
private class Refusal(val text: String)

/** The area an `R.string.nav_*` label names. */
private fun shellArea(label: Int): ShellArea = when (label) {
    R.string.nav_prepare -> ShellArea.Prepare
    R.string.nav_preview -> ShellArea.Preview
    R.string.nav_device -> ShellArea.Device
    R.string.nav_project -> ShellArea.Project
    else -> ShellArea.Workspace
}

/** The areas in the bar's and rail's order, with their icons. */
private val AREAS = listOf(
    ShellDestination(R.string.nav_workspace, android.R.drawable.ic_menu_gallery),
    ShellDestination(R.string.nav_prepare, android.R.drawable.ic_menu_upload),
    ShellDestination(R.string.nav_preview, android.R.drawable.ic_menu_view),
    ShellDestination(R.string.nav_device, android.R.drawable.ic_menu_share),
    ShellDestination(R.string.nav_project, android.R.drawable.ic_menu_save),
)

/** System bars drawn over the app's own background: no scrim. */
private const val TRANSPARENT = android.graphics.Color.TRANSPARENT

private const val AREA = "area"
private const val ANDROID_13 = 33

/** How long a stopping activity waits for its unsaved work to be captured; a capture still
 * running then (behind longer work, or a large project) is left to finish on its own. */
private const val LEAVE_CAPTURE_WAIT_MS = 2_000L
