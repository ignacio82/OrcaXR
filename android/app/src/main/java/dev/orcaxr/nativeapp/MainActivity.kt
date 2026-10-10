package dev.orcaxr.nativeapp

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.DragEvent
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.CoreCompatibility
import dev.orcaxr.core.DocumentOwners
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.device.DeviceScreen
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.prepare.PrepareScreen
import dev.orcaxr.nativeapp.preview.PreviewModel
import dev.orcaxr.nativeapp.preview.PreviewScreen
import dev.orcaxr.nativeapp.project.DropIntake
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.project.ProjectScreen
import dev.orcaxr.nativeapp.send.SendDialog
import dev.orcaxr.nativeapp.shell.FocusVisibleTheme
import dev.orcaxr.nativeapp.shell.Navigation
import dev.orcaxr.nativeapp.shell.ShellArea
import dev.orcaxr.nativeapp.shell.ShellLayout
import dev.orcaxr.nativeapp.shell.Viewport
import dev.orcaxr.nativeapp.workspace.WorkspaceScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
 * window load as the browser's drop does ([DropIntake]).
 */
class MainActivity : ComponentActivity() {
    private val device: DeviceModel by viewModels()
    private val project: ProjectModel by viewModels()
    private val preview: PreviewModel by viewModels()
    private val prepare: PrepareModel by viewModels()
    /** The area shown; an opened or shared document switches to the Project area, a finished slice to Preview. */
    private var area by mutableIntStateOf(R.string.nav_workspace)

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
        project.captureNow()
    }

    /**
     * The browser's edit shortcuts (web/src/actions/groups/edit.ts): Ctrl/Meta+Z undoes,
     * Ctrl/Meta+Shift+Z and Ctrl+Y redo, Delete deletes the selected model and Escape
     * deselects all — only when nothing focused took the key, as the browser leaves a
     * text field its own editing keys.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Reached only by keys no focused view consumed.
        val command = event.isCtrlPressed || event.isMetaPressed
        val plain = !command && !event.isShiftPressed && !event.isAltPressed
        val handled = event.repeatCount == 0 && when {
            command && keyCode == KeyEvent.KEYCODE_Z && !event.isShiftPressed -> project.undoShortcut()
            command && keyCode == KeyEvent.KEYCODE_Z && event.isShiftPressed -> project.redoShortcut()
            event.isCtrlPressed && !event.isShiftPressed && keyCode == KeyEvent.KEYCODE_Y -> project.redoShortcut()
            plain && keyCode == KeyEvent.KEYCODE_FORWARD_DEL -> project.deleteShortcut()
            plain && keyCode == KeyEvent.KEYCODE_ESCAPE -> project.escapeShortcut()
            else -> false
        }
        return handled || super.onKeyDown(keyCode, event)
    }

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
        enableEdgeToEdge()
        project.taskId = taskId
        prepare.bind(project)
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
            FocusVisibleTheme {
                val ready = state == R.string.workspace_development
                val layout = ShellLayout.of(LocalWindowInfo.current.containerDpSize.width.value.toInt(), shellArea(area))
                val snackbar = remember { SnackbarHostState() }
                // A drop's refusals: each drop's own, so the same words dropped again show again.
                var refused by remember { mutableStateOf<Refusal?>(null) }
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
                Box(Modifier.fillMaxSize().dragAndDropTarget(shouldStartDragAndDrop = { ready }, target = target)) {
                    Scaffold(
                        bottomBar = {
                            if (ready && layout.navigation == Navigation.Bar) {
                                NavigationBar {
                                    for ((label, icon) in AREAS) {
                                        NavigationBarItem(
                                            selected = area == label,
                                            onClick = { area = label },
                                            icon = { Icon(painterResource(icon), contentDescription = null) },
                                            // One line: five areas leave a narrow phone little room per label.
                                            label = { Text(stringResource(label), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis) },
                                        )
                                    }
                                }
                            }
                        },
                        snackbarHost = { SnackbarHost(snackbar) },
                    ) { padding ->
                        if (!ready) {
                            Column(Modifier.fillMaxSize().padding(padding),
                                verticalArrangement = Arrangement.Center,
                                horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                                Text(stringResource(state), style = MaterialTheme.typography.bodyLarge)
                            }
                        } else if (layout.navigation == Navigation.Rail) {
                            Row(Modifier.fillMaxSize().padding(padding)) {
                                // The Scaffold's padding already keeps it clear of the system bars.
                                NavigationRail(windowInsets = WindowInsets(0, 0, 0, 0)) {
                                    for ((label, icon) in AREAS) {
                                        NavigationRailItem(
                                            selected = area == label,
                                            onClick = { area = label },
                                            icon = { Icon(painterResource(icon), contentDescription = null) },
                                            label = { Text(stringResource(label), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis) },
                                        )
                                    }
                                }
                                Work(layout, Modifier.weight(1f).fillMaxHeight())
                            }
                        } else {
                            Work(layout, Modifier.fillMaxSize().padding(padding))
                        }
                    }
                    if (over) DropPrompt()
                }
                // A send's confirmation waits above whichever area is shown: the operator may have moved on.
                device.sendConfirmation?.let { pending -> SendDialog(pending.view, device::answerSend) }
            }
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
                    R.string.nav_project -> ProjectScreen(project, panel)
                    else -> PrepareScreen(prepare, project, device, panel)
                }
                WorkspaceScreen(project, Modifier.weight(1f).fillMaxHeight())
            }
            Viewport.Toolpath -> PreviewScreen(preview, modifier, panelWidth = layout.panelWidthDp.dp)
            null -> when (area) {
                R.string.nav_device -> DeviceScreen(device, modifier)
                R.string.nav_project -> ProjectScreen(project, modifier)
                R.string.nav_prepare -> PrepareScreen(prepare, project, device, modifier)
                R.string.nav_preview -> PreviewScreen(preview, modifier)
                else -> Box(modifier) {
                    WorkspaceScreen(project, Modifier.fillMaxSize())
                    if (resources.getBoolean(R.bool.viewport_experiment_enabled)) {
                        TextButton(
                            onClick = { startActivity(Intent().setClassName(this@MainActivity, "$packageName.ViewportExperimentActivity")) },
                            modifier = Modifier.align(Alignment.BottomEnd),
                        ) { Text(stringResource(R.string.open_viewport_experiment)) }
                    }
                }
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

/** What a drop refused, shown once. */
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
    R.string.nav_workspace to android.R.drawable.ic_menu_gallery,
    R.string.nav_prepare to android.R.drawable.ic_menu_upload,
    R.string.nav_preview to android.R.drawable.ic_menu_view,
    R.string.nav_device to android.R.drawable.ic_menu_share,
    R.string.nav_project to android.R.drawable.ic_menu_save,
)

private const val AREA = "area"
private const val ANDROID_13 = 33
