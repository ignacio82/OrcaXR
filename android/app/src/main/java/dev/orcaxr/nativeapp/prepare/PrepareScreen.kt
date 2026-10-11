package dev.orcaxr.nativeapp.prepare

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.pluralMessage
import dev.orcaxr.nativeapp.project.FilamentList
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.send.SendGuard
import dev.orcaxr.nativeapp.send.SendWords

/**
 * The Prepare area: the active plate, the external slicer it is sliced on
 * (the browser's External Slicer settings — URL, token, connect, on/off,
 * remove, the attested engine or why not), the route a slice takes and why,
 * the shared preflight's issues as the browser's panel shows them, and
 * "Slice" / "Cancel Slice" with the job's progress. The first slice on an
 * endpoint asks before uploading; a finished slice opens in Preview, and one
 * whose project changed afterwards is marked out of date. A current slice
 * goes to the printer the Device area connected ("Send to Printer", through
 * [device]'s shared workflow), with the send's progress and outcome below.
 */
@Composable
fun PrepareScreen(model: PrepareModel, project: ProjectModel, device: DeviceModel, modifier: Modifier = Modifier) {
    val view = project.view
    val profiles = project.profilesView
    val state = model.state
    val send = device.sendState
    val connection = state.connection
    val plate = view.activePlate
    val context = LocalContext.current
    // The preflight follows the project while this area is shown.
    LaunchedEffect(view.revision, plate, profiles) { model.refreshPreflight() }
    // A draft the field edits; the connected endpoint replaces it once canonical.
    var url by rememberSaveable(connection.endpoint) { mutableStateOf(connection.endpoint) }
    // Android 17 asks for the local network first; the check then says what it reached.
    var connecting by rememberSaveable { mutableStateOf<String?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        connecting?.let(model::connect)
        connecting = null
    }
    val connect = { candidate: String ->
        val granted = Build.VERSION.SDK_INT < ANDROID_17 ||
            context.checkSelfPermission(LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            model.connect(candidate)
        } else {
            connecting = candidate
            permission.launch(LOCAL_NETWORK)
        }
    }
    var hidden by remember { mutableStateOf(emptySet<String>()) }
    val job = state.job
    val preflight = state.preflight?.takeIf { it.plateId == plate?.id }
    val blocked = preflight?.canSlice == false
    val canSlice = connection.enabled && plate != null && plate.objects > 0 && job == null && !blocked

    LazyColumn(
        modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text(
                plate?.let { stringResource(R.string.prepare_plate, it.name, it.objects) } ?: stringResource(R.string.prepare_no_plate),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() },
            )
        }
        item {
            ProfilePickers(
                profiles,
                enabled = !project.busy,
                onMachine = project::chooseMachine,
                onProcess = project::chooseProcess,
                onFilament = project::chooseFilament,
            )
        }
        item {
            FilamentList(
                view,
                profiles,
                enabled = !project.busy,
                onAdd = project::addFilament,
                onRemove = project::removeFilament,
                onColor = project::recolorFilament,
                onNozzle = project::setFilamentNozzle,
            )
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.prepare_external_slicer), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text(stringResource(R.string.prepare_url)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = state.token,
                    onValueChange = model::setToken,
                    label = { Text(stringResource(R.string.prepare_token)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    stringResource(if (state.remember) R.string.prepare_token_remembered else R.string.prepare_token_session),
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = { connect(url) }, enabled = url.isNotBlank() && connection.phase != SlicerPhase.Probing) {
                        Text(stringResource(R.string.prepare_connect))
                    }
                    OutlinedButton(onClick = model::remove, enabled = connection.endpoint.isNotEmpty()) {
                        Text(stringResource(R.string.prepare_remove))
                    }
                }
                if (connection.endpoint.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Switch(
                            checked = connection.enabled,
                            onCheckedChange = model::setEnabled,
                            enabled = connection.phase != SlicerPhase.Probing,
                        )
                        Text(stringResource(R.string.prepare_enabled))
                    }
                }
                Text(
                    PrepareWords.status(connection),
                    style = MaterialTheme.typography.labelLarge,
                    color = if (connection.enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(PrepareWords.hint(connection), style = MaterialTheme.typography.bodySmall)
            }
        }
        item { Text(PrepareWords.route(connection), style = MaterialTheme.typography.bodyMedium) }
        if (preflight != null && preflight.cards.isNotEmpty()) {
            // Hidden issues stay hidden through recomputes while the fault stands, as the browser's panel keeps them.
            val present = preflight.cards.map { it.id }.toSet()
            val shown = preflight.cards.filter { it.id !in hidden }
            item { Text(stringResource(R.string.prepare_preflight), style = MaterialTheme.typography.titleMedium) }
            items(shown, key = { "issue:${it.id}" }) { card -> IssueCard(card) { hidden = (hidden intersect present) + card.id } }
            val hiddenCount = preflight.cards.size - shown.size
            if (hiddenCount > 0) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(pluralMessage(R.plurals.prepare_hidden_issues, hiddenCount), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { hidden = emptySet() }) { Text(stringResource(R.string.prepare_show)) }
                    }
                }
            }
            if (preflight.total > preflight.cards.size) {
                item { Text(stringResource(R.string.project_more_rows, (preflight.total - preflight.cards.size).toInt())) }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = model::slice, enabled = canSlice) { Text(stringResource(R.string.prepare_slice)) }
                OutlinedButton(onClick = model::cancel, enabled = job != null && !job.cancelling) {
                    Text(stringResource(R.string.prepare_cancel))
                }
            }
        }
        if (job != null) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val percent = job.percent
                    if (percent != null) {
                        LinearProgressIndicator(progress = { (percent / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    } else {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                    Text(PrepareWords.progress(job.message), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        state.status?.let { status ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(status, Modifier.weight(1f))
                        TextButton(onClick = model::dismissStatus) { Text(stringResource(R.string.device_dismiss)) }
                    }
                }
            }
        }
        state.result?.let { result ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(result.name, style = MaterialTheme.typography.titleSmall)
                        Text(stringResource(R.string.prepare_sliced_on, result.endpoint), style = MaterialTheme.typography.bodySmall)
                        if (result.revision != view.revision) {
                            // Output for a state the project has left is never previewed or sent.
                            Text(PrepareWords.OUT_OF_DATE, color = MaterialTheme.colorScheme.error)
                        } else {
                            val current = SendGuard.current(state.result, result, view.activePlate?.id, view.revision)
                            val connected = device.state.connected
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = model::showResult) { Text(stringResource(R.string.nav_preview)) }
                                // One button, as the browser's: "Cancel send" while a send runs.
                                if (send.busy) {
                                    OutlinedButton(onClick = device::cancelSend) { Text(stringResource(R.string.send_cancel)) }
                                } else {
                                    Button(onClick = { device.send(model.sendable()) }, enabled = current && connected) {
                                        Text(stringResource(R.string.send_action))
                                    }
                                }
                            }
                            if (!connected && !send.busy) Text(SendWords.CONNECT_FIRST, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
        if (send.status != null || send.busy) {
            // The send's progress and outcome, as the browser's status line words them.
            item {
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(send.status.orEmpty(), Modifier.weight(1f))
                        if (send.busy) {
                            // Here when the slice was withdrawn or left behind mid-send, so the send can still be stopped.
                            if (state.result?.revision != view.revision) {
                                TextButton(onClick = device::cancelSend) { Text(stringResource(R.string.send_cancel)) }
                            }
                        } else {
                            TextButton(onClick = device::dismissSend) { Text(stringResource(R.string.device_dismiss)) }
                        }
                    }
                }
            }
        }
    }

    state.consentFor?.let { endpoint ->
        AlertDialog(
            onDismissRequest = { model.answerConsent(false) },
            title = { Text(PrepareWords.consentTitle(endpoint)) },
            text = { Text(PrepareWords.CONSENT_DETAIL) },
            confirmButton = { TextButton(onClick = { model.answerConsent(true) }) { Text(stringResource(R.string.prepare_upload)) } },
            dismissButton = { TextButton(onClick = { model.answerConsent(false) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
}

/** One issue, as the browser's preflight card: severity and code, message, help, path, entities, and Hide. */
@Composable
private fun IssueCard(card: PreflightCard, onHide: () -> Unit) {
    val tone = if (card.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (card.error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.tertiaryContainer,
        ),
        border = BorderStroke(1.dp, tone),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Text(card.heading, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.labelLarge)
                TextButton(onClick = onHide) { Text(stringResource(R.string.prepare_hide)) }
            }
            Text(card.message, style = MaterialTheme.typography.bodyMedium)
            Text(card.help, style = MaterialTheme.typography.bodySmall)
            card.path?.let { Text(stringResource(R.string.prepare_path, it), style = MaterialTheme.typography.bodySmall) }
            for (entity in card.entities) Text("• $entity", style = MaterialTheme.typography.bodySmall)
        }
    }
}

private const val ANDROID_17 = 37
private const val LOCAL_NETWORK = Manifest.permission.ACCESS_LOCAL_NETWORK
