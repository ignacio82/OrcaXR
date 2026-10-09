package dev.orcaxr.nativeapp

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
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
import dev.orcaxr.core.CoreCompatibility
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.device.DeviceScreen
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.project.ProjectScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The shell. Product areas are added only with complete shared workflows: the
 * workspace preview, the Project area's documents over the shared project
 * session, and the Device area's printers over the shared printer core. */
class MainActivity : ComponentActivity() {
    private val device: DeviceModel by viewModels()
    private val project: ProjectModel by viewModels()
    /** The area shown; an opened or shared document switches to the Project area. */
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

    private fun handle(intent: Intent?) {
        val uri = incoming(intent) ?: return
        area = R.string.nav_project
        project.openIncoming(uri)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(AREA, area)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handle(intent) else area = savedInstanceState.getInt(AREA, area)
        setContent {
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
                                    R.string.nav_project to android.R.drawable.ic_menu_save,
                                    R.string.nav_device to android.R.drawable.ic_menu_share,
                                )) {
                                    NavigationBarItem(
                                        selected = area == label,
                                        onClick = { area = label },
                                        icon = { Icon(painterResource(icon), contentDescription = null) },
                                        label = { Text(stringResource(label)) },
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
                    } else {
                        Column(Modifier.fillMaxSize().padding(padding),
                            verticalArrangement = Arrangement.Center,
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                            Text(stringResource(state), style = MaterialTheme.typography.bodyLarge)
                            if (state == R.string.workspace_development && resources.getBoolean(R.bool.viewport_experiment_enabled)) {
                                TextButton(onClick = {
                                    startActivity(Intent().setClassName(this@MainActivity, "$packageName.ViewportExperimentActivity"))
                                }) { Text(stringResource(R.string.open_viewport_experiment)) }
                            }
                        }
                    }
                }
            }
        }
    }
}

private const val AREA = "area"
private const val ANDROID_13 = 33
