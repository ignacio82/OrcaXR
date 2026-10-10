package dev.orcaxr.nativeapp.device

import android.graphics.BitmapFactory
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import dev.orcaxr.core.PrinterStorage
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.shell.tabMovesFocus
import kotlinx.coroutines.delay

private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

/** The tabs a connected printer offers, by their names' resources. */
enum class DeviceTab(@StringRes val label: Int) {
    Status(R.string.device_tab_status),
    Files(R.string.device_tab_files),
    History(R.string.device_tab_history),
    Console(R.string.device_tab_console),
    Camera(R.string.device_tab_camera),
}

@Composable
fun FilesTab(model: DeviceModel) {
    val view = model.files
    LaunchedEffect(Unit) { if (view.listing == null) model.openFolder("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (view.path.isNotEmpty()) {
                OutlinedButton(onClick = { model.openFolder(view.path.substringBeforeLast('/', "")) }) { Text("Up") }
            }
            OutlinedButton(onClick = { model.openFolder(view.path) }) { Text("Refresh files") }
        }
        Text(if (view.path.isEmpty()) "gcodes" else "gcodes/${view.path}", style = MaterialTheme.typography.labelLarge)
        val listing = view.listing
        if (listing != null) {
            val folder = text(listing.path)
            val join = { name: String -> if (folder.isEmpty()) name else "$folder/$name" }
            for (directory in listing.directories) {
                val name = text(directory.name)
                Text("📁 $name", Modifier.fillMaxWidth().clickable { model.openFolder(join(name)) }.padding(vertical = 6.dp))
            }
            for (file in listing.files) {
                val name = text(file.name)
                val size = (file.sizeBytes as? ProjectIntents.OptionalFinite.Value)
                    ?.let { (PrinterStorage.size(it.value) as? ProjectIntents.OptionalText.Value)?.let { s -> text(s.value) } }
                Column(Modifier.fillMaxWidth().clickable { model.selectFile(join(name)) }.padding(vertical = 6.dp)) {
                    Text(name, style = MaterialTheme.typography.bodyLarge)
                    size?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            }
            if (listing.directories.isEmpty() && listing.files.isEmpty()) Text(stringResource(R.string.device_folder_empty))
        }
        view.selected?.let { metadata ->
            val path = text(metadata.path)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(path.substringAfterLast('/'), style = MaterialTheme.typography.titleMedium)
                    (metadata.slicer as? ProjectIntents.OptionalPrinterReplyText.Value)?.let { Text("Sliced by ${text(it.value)}") }
                    (metadata.estimatedSeconds as? ProjectIntents.OptionalFinite.Value)?.let {
                        Text("Estimated ${(it.value / 60).toLong()} min", style = MaterialTheme.typography.bodySmall)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { model.printFile(path) }) { Text("Print this file") }
                        OutlinedButton(onClick = { model.deleteFile(path) }) { Text("Delete file") }
                    }
                }
            }
        }
    }
}

@Composable
fun HistoryTab(model: DeviceModel) {
    val view = model.history
    LaunchedEffect(Unit) { if (view.pager == null) model.loadHistory() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (view.totals.isNotEmpty()) Text(view.totals, style = MaterialTheme.typography.bodySmall)
        for ((job, jobView) in view.jobs) {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(text(job.filename), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    Text(text(jobView.status), style = MaterialTheme.typography.labelMedium)
                }
                Text(text(jobView.facts), style = MaterialTheme.typography.bodySmall)
                if (!job.fileExists) Text(stringResource(R.string.device_no_longer_on_printer), style = MaterialTheme.typography.bodySmall)
            }
        }
        view.pager?.let { pager ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { model.loadHistory(pager.previousStart) }, enabled = pager.hasPrevious) { Text("Newer") }
                Text(text(pager.label), Modifier.weight(1f).padding(top = 12.dp), style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { model.loadHistory(pager.nextStart) }, enabled = pager.hasNext) { Text("Older") }
            }
        }
    }
}

@Composable
fun ConsoleTab(model: DeviceModel) {
    val view = model.console
    var script by rememberSaveable { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.fillMaxWidth().heightIn(min = 120.dp)) {
            if (view.lines.isEmpty()) Text("Responses from the printer appear here.", style = MaterialTheme.typography.bodySmall)
            for (line in view.lines.takeLast(CONSOLE_SHOWN)) {
                val prefix = when (line.kind) {
                    ProjectIntents.ConsoleLineKind.Sent -> "› "
                    ProjectIntents.ConsoleLineKind.Error -> "! "
                    ProjectIntents.ConsoleLineKind.Received -> ""
                }
                Text(prefix + text(line.text), style = MaterialTheme.typography.bodySmall)
            }
        }
        // Several lines of G-code: Tab still moves on rather than typing into the script.
        OutlinedTextField(script, { script = it }, label = { Text("G-code") }, modifier = Modifier.fillMaxWidth().tabMovesFocus())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { model.sendScript(script); script = "" }, enabled = script.isNotBlank()) { Text("Send") }
            OutlinedButton(onClick = model::loadMacros) { Text("Show macros") }
        }
        for (macro in view.macros) MacroRow(model, macro)
    }
}

@Composable
private fun MacroRow(model: DeviceModel, macro: ProjectIntents.PrinterMacro) {
    val values = remember(macro) { mutableStateMapOf<String, String>() }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text(macro.name), style = MaterialTheme.typography.titleSmall)
            (macro.description as? ProjectIntents.OptionalPrinterReplyText.Value)?.let { Text(text(it.value), style = MaterialTheme.typography.bodySmall) }
            for (parameter in macro.parameters) {
                val name = text(parameter.name)
                val default = (parameter.defaultValue as? ProjectIntents.OptionalPrinterReplyText.Value)?.let { text(it.value) }
                OutlinedTextField(
                    values[name] ?: "", { values[name] = it }, singleLine = true,
                    label = { Text(if (default != null) "$name (default $default)" else name) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            TextButton(onClick = { model.runMacro(macro, values.toMap()) }) { Text("Run ${text(macro.name)}") }
        }
    }
}

@Composable
fun CameraTab(model: DeviceModel) {
    val view = model.cameras
    LaunchedEffect(Unit) { if (view.cameras.isEmpty()) model.loadCameras() }
    // Frames are fetched only while the camera is on screen and the app is in front.
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val camera = view.cameras.getOrNull(view.selected)
    LaunchedEffect(camera, lifecycle.isAtLeast(Lifecycle.State.RESUMED)) {
        if (camera == null || !lifecycle.isAtLeast(Lifecycle.State.RESUMED)) return@LaunchedEffect
        while (true) {
            model.fetchFrame()
            delay(model.pollIntervalMs())
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (view.cameras.isEmpty()) Text("This printer reports no camera.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            view.cameras.forEachIndexed { index, each ->
                OutlinedButton(onClick = { model.selectCamera(index) }, enabled = index != view.selected) { Text(text(each.name)) }
            }
        }
        camera?.let { selected ->
            Text(view.description, style = MaterialTheme.typography.bodySmall)
            (selected.unsupportedReason as? ProjectIntents.OptionalPrinterReplyText.Value)?.let { Text(text(it.value)) }
            val bitmap = remember(view.frame) { view.frame?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
            if (bitmap != null) {
                Image(
                    bitmap.asImageBitmap(),
                    contentDescription = "Latest frame from ${text(selected.name)}",
                    modifier = Modifier.fillMaxWidth().graphicsLayer {
                        // How the camera is mounted.
                        rotationZ = selected.rotationDegrees.toFloat()
                        scaleX = if (selected.flipHorizontal) -1f else 1f
                        scaleY = if (selected.flipVertical) -1f else 1f
                    },
                )
            } else if (view.failure == null) {
                Text("Waiting for the first frame…", style = MaterialTheme.typography.bodySmall)
            }
            view.failure?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

private const val CONSOLE_SHOWN = 40
