package dev.orcaxr.nativeapp.project

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRecovery
import java.text.DateFormat
import java.util.Date
import dev.orcaxr.nativeapp.R

private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

/** The Project area: the open project's name, objects and history, and its document operations. */
@Composable
fun ProjectScreen(model: ProjectModel, modifier: Modifier = Modifier) {
    val view = model.view
    // Any document: providers often report a 3MF or STL only as bytes; the content decides.
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(model::open) }
    val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(model::importModel) }
    val saveAs = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(MIME_3MF)) { uri -> uri?.let(model::saveTo) }
    val suggested = "${view.name.ifBlank { "Untitled project" }}.3mf"
    // "Save" in the unsaved-changes dialog with nowhere to save yet: ask where, then go on.
    val saveBeforeGoingOn = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(MIME_3MF), model::saveAsAnswered)
    val context = LocalContext.current
    LaunchedEffect(model.shareRequest) {
        model.shareRequest?.let { context.startActivity(it); model.shareShown() }
    }
    LaunchedEffect(model.saveAsRequested) { if (model.saveAsRequested) saveBeforeGoingOn.launch(suggested) }

    LazyColumn(
        modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(view.name, style = MaterialTheme.typography.titleLarge)
                val state = stringResource(if (view.dirty) R.string.project_unsaved else R.string.project_saved)
                Text(view.document?.let { "$it · $state" } ?: state, style = MaterialTheme.typography.bodySmall)
                if (model.busy || !view.ready) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
        items(model.recoveries, key = { "recovery:" + it.session }) { entry -> Recovered(entry, model, view.ready && !model.busy) }
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val enabled = view.ready && !model.busy
                OutlinedButton(onClick = model::newProject, enabled = enabled) { Text(stringResource(R.string.project_new)) }
                OutlinedButton(onClick = { open.launch(arrayOf("*/*")) }, enabled = enabled) { Text(stringResource(R.string.project_open)) }
                Button(onClick = { if (!model.save()) saveAs.launch(suggested) }, enabled = enabled) { Text(stringResource(R.string.project_save)) }
                OutlinedButton(onClick = { saveAs.launch(suggested) }, enabled = enabled) { Text(stringResource(R.string.project_save_as)) }
                OutlinedButton(onClick = { import.launch(arrayOf("*/*")) }, enabled = enabled) { Text(stringResource(R.string.project_import)) }
                OutlinedButton(onClick = model::share, enabled = enabled) { Text(stringResource(R.string.project_share)) }
            }
        }
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = model::undo, enabled = view.undo != null && !model.busy) {
                    Text(view.undo?.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.project_undo_named, it) } ?: stringResource(R.string.project_undo))
                }
                OutlinedButton(onClick = model::redo, enabled = view.redo != null && !model.busy) {
                    Text(view.redo?.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.project_redo_named, it) } ?: stringResource(R.string.project_redo))
                }
            }
        }
        item { Text(stringResource(R.string.project_objects), style = MaterialTheme.typography.titleMedium) }
        items(view.rows, key = { "row:" + text(it.key) }) { row -> TreeRow(row) }
        if (view.totalRows > view.rows.size) {
            item { Text(stringResource(R.string.project_more_rows, view.totalRows - view.rows.size), style = MaterialTheme.typography.bodySmall) }
        }
        if (model.recent.isNotEmpty()) {
            item { Text(stringResource(R.string.project_recent), style = MaterialTheme.typography.titleMedium) }
            items(model.recent, key = { "recent:" + it.uri }) { entry ->
                Text(
                    entry.name,
                    Modifier.fillMaxWidth().clickable(enabled = view.ready && !model.busy) { model.openRecent(entry) }.padding(vertical = 8.dp),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
        model.message?.let { message ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(message, Modifier.weight(1f))
                        TextButton(onClick = model::dismissMessage) { Text(stringResource(R.string.device_dismiss)) }
                    }
                }
            }
        }
    }

    model.pendingDiscard?.let { pending ->
        AlertDialog(
            onDismissRequest = { model.answerDiscard(DiscardAnswer.Cancel) },
            title = { Text(stringResource(R.string.project_discard_title, pending.name)) },
            text = { Text(stringResource(R.string.project_discard_detail)) },
            confirmButton = {
                Row {
                    TextButton(onClick = { model.answerDiscard(DiscardAnswer.Discard) }) { Text(stringResource(R.string.project_discard)) }
                    TextButton(onClick = { model.answerDiscard(DiscardAnswer.Save) }) { Text(stringResource(R.string.project_save)) }
                }
            },
            dismissButton = { TextButton(onClick = { model.answerDiscard(DiscardAnswer.Cancel) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
    model.pendingImport?.let { pending ->
        AlertDialog(
            onDismissRequest = { model.answerImport(false) },
            title = { Text(stringResource(R.string.project_import_title, pending.filename)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(stringResource(R.string.project_import_objects, pending.objects))
                    for (notice in pending.notices) Text("• $notice", style = MaterialTheme.typography.bodySmall)
                    if (pending.blocked) Text(stringResource(R.string.project_import_blocked))
                }
            },
            confirmButton = {
                TextButton(onClick = { model.answerImport(true) }, enabled = !pending.blocked) {
                    Text(stringResource(if (pending.acknowledgements.isEmpty()) R.string.project_import_confirm else R.string.project_import_accept))
                }
            },
            dismissButton = { TextButton(onClick = { model.answerImport(false) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
}

@Composable
private fun Recovered(entry: ProjectRecovery.Entry, model: ProjectModel, enabled: Boolean) {
    val captured = remember(entry.capturedAtMs) {
        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(entry.capturedAtMs))
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.project_recovered_title, entry.projectName), style = MaterialTheme.typography.titleSmall)
            Text(
                stringResource(if (entry.damaged) R.string.project_recovered_damaged else R.string.project_recovered_detail, captured),
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!entry.damaged) Button(onClick = { model.restore(entry) }, enabled = enabled) { Text(stringResource(R.string.project_restore)) }
                OutlinedButton(onClick = { model.discardRecovered(entry) }, enabled = enabled) { Text(stringResource(R.string.project_discard)) }
            }
        }
    }
}

@Composable
private fun TreeRow(row: ProjectIntents.ObjectTreeRow) {
    Column(Modifier.fillMaxWidth().padding(start = (16 * row.level.coerceIn(0L, 6L)).toInt().dp)) {
        Text(text(row.label), style = MaterialTheme.typography.bodyLarge)
        (row.description as? ProjectIntents.OptionalText.Value)?.let { Text(text(it.value), style = MaterialTheme.typography.bodySmall) }
    }
}

private const val MIME_3MF = "model/3mf"
