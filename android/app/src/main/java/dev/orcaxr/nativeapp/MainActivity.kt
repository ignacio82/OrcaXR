package dev.orcaxr.nativeapp

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import dev.orcaxr.core.CoreCompatibility
import dev.orcaxr.core.DocumentOwners
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.device.DeviceScreen
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.prepare.PrepareScreen
import dev.orcaxr.nativeapp.preview.PreviewModel
import dev.orcaxr.nativeapp.preview.PreviewScreen
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.project.ProjectScreen
import dev.orcaxr.nativeapp.workspace.WorkspaceScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The shell. Product areas are added only with complete shared workflows: the
 * workspace preview, Prepare's slicing of the active plate on the external
 * slicer, the Preview area's G-code viewer over the shared G-code preview,
 * the Device area's printers over the shared printer core, and the Project
 * area's documents over the shared project session.
 *
 * The areas follow the plan's order (Prepare, Preview, Device, Project) after
 * the Workspace, which stays first as the home the app opens on: it shows the
 * plate being prepared, as desktop Orca's Prepare view does, and needs no
 * printer, slicer or document before it shows anything. */
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

    override fun onStop() {
        super.onStop()
        // The system may end the app once it is out of sight, and a window closed or swiped
        // away finishes it without asking: keep unsaved work now (not what was just discarded).
        project.captureNow()
    }

    /**
     * The browser's edit shortcuts (web/src/actions/groups/edit.ts): Ctrl/Meta+Z undoes,
     * Ctrl/Meta+Shift+Z and Ctrl+Y redo — only when nothing focused took the key, as the
     * browser leaves a text field its own editing keys.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Reached only by keys no focused view consumed.
        val command = event.isCtrlPressed || event.isMetaPressed
        val handled = event.repeatCount == 0 && when {
            command && keyCode == KeyEvent.KEYCODE_Z && !event.isShiftPressed -> project.undoShortcut()
            command && keyCode == KeyEvent.KEYCODE_Z && event.isShiftPressed -> project.redoShortcut()
            event.isCtrlPressed && !event.isShiftPressed && keyCode == KeyEvent.KEYCODE_Y -> project.redoShortcut()
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
            MaterialTheme {
                Scaffold(
                    bottomBar = {
                        if (state == R.string.workspace_development) {
                            NavigationBar {
                                for ((label, icon) in listOf(
                                    R.string.nav_workspace to android.R.drawable.ic_menu_gallery,
                                    R.string.nav_prepare to android.R.drawable.ic_menu_upload,
                                    R.string.nav_preview to android.R.drawable.ic_menu_view,
                                    R.string.nav_device to android.R.drawable.ic_menu_share,
                                    R.string.nav_project to android.R.drawable.ic_menu_save,
                                )) {
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
                ) { padding ->
                    if (area == R.string.nav_device && state == R.string.workspace_development) {
                        DeviceScreen(device, Modifier.fillMaxSize().padding(padding))
                    } else if (area == R.string.nav_project && state == R.string.workspace_development) {
                        ProjectScreen(project, Modifier.fillMaxSize().padding(padding))
                    } else if (area == R.string.nav_prepare && state == R.string.workspace_development) {
                        PrepareScreen(prepare, project.view, Modifier.fillMaxSize().padding(padding))
                    } else if (area == R.string.nav_preview && state == R.string.workspace_development) {
                        PreviewScreen(preview, Modifier.fillMaxSize().padding(padding))
                    } else if (state == R.string.workspace_development) {
                        Box(Modifier.fillMaxSize().padding(padding)) {
                            WorkspaceScreen(project, Modifier.fillMaxSize())
                            if (resources.getBoolean(R.bool.viewport_experiment_enabled)) {
                                TextButton(
                                    onClick = { startActivity(Intent().setClassName(this@MainActivity, "$packageName.ViewportExperimentActivity")) },
                                    modifier = Modifier.align(Alignment.BottomEnd),
                                ) { Text(stringResource(R.string.open_viewport_experiment)) }
                            }
                        }
                    } else {
                        Column(Modifier.fillMaxSize().padding(padding),
                            verticalArrangement = Arrangement.Center,
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                            Text(stringResource(state), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            }
        }
    }
}

private const val AREA = "area"
private const val ANDROID_13 = 33
