package dev.orcaxr.nativeapp.device

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.R

private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

/** The Device area: saved printers, the active one's key and connection, its status and job commands. */
@Composable
fun DeviceScreen(model: DeviceModel, modifier: Modifier = Modifier) {
    val state = model.state
    val context = LocalContext.current
    // A permission changed in the system settings is read again on return.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) model.refresh() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    var askedOnce by rememberSaveable { mutableStateOf(false) }
    // Set while the permission is asked for so a search can follow.
    var finding by rememberSaveable { mutableStateOf(false) }
    val findNeedsPermission = stringResource(R.string.device_find_needs_permission)
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        askedOnce = true
        model.refresh()
        if (finding) {
            finding = false
            if (granted) model.findPrinters() else model.notify(findNeedsPermission)
        }
    }
    val find = {
        if (Build.VERSION.SDK_INT >= ANDROID_17 && !state.localNetworkGranted) {
            finding = true
            permission.launch(LOCAL_NETWORK)
        } else {
            model.findPrinters()
        }
    }
    var adding by rememberSaveable { mutableStateOf(false) }
    var tab by rememberSaveable { mutableStateOf(DeviceTab.Status) }
    var removing by rememberSaveable { mutableStateOf(false) }

    LazyColumn(
        modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Text(stringResource(R.string.device_printers), style = MaterialTheme.typography.titleLarge) }
        if (state.printers.isEmpty()) {
            item { Text(stringResource(R.string.device_no_printers)) }
        }
        items(state.printers, key = { it.id }) { printer ->
            Row(
                Modifier.fillMaxWidth().selectable(
                    selected = printer.id == state.activeId,
                    onClick = { model.activate(printer.id) },
                    role = Role.RadioButton,
                ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = printer.id == state.activeId, onClick = null)
                Column(Modifier.padding(start = 8.dp)) {
                    Text(printer.name, style = MaterialTheme.typography.bodyLarge)
                    Text(printer.address, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { adding = true }) { Text(stringResource(R.string.device_add_printer)) }
                OutlinedButton(onClick = find, enabled = !state.discovery.searching) { Text(stringResource(R.string.device_find_printers)) }
            }
        }
        if (state.discovery.searching) {
            item { Text(stringResource(R.string.device_finding), style = MaterialTheme.typography.bodySmall) }
        } else if (state.discovery.searched && state.discovery.proposals.isEmpty()) {
            item { Text(stringResource(R.string.device_found_none), style = MaterialTheme.typography.bodySmall) }
        }
        items(state.discovery.proposals, key = { "found:${it.key}" }) { proposal -> Proposal(proposal, model) }
        if (state.activeId != null) {
            if (state.localNetworkBlocked) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.device_local_network_needed))
                            val activity = context as? Activity
                            val canAsk = !askedOnce || activity?.shouldShowRequestPermissionRationale(LOCAL_NETWORK) == true
                            if (canAsk && Build.VERSION.SDK_INT >= ANDROID_17) {
                                Button(onClick = { permission.launch(LOCAL_NETWORK) }) {
                                    Text(stringResource(R.string.device_local_network_allow))
                                }
                            } else {
                                // Denied for good: only the system settings can change it now.
                                Button(onClick = {
                                    context.startActivity(
                                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                                    )
                                }) { Text(stringResource(R.string.device_open_settings)) }
                            }
                        }
                    }
                }
            }
            item { CredentialFields(state, model) }
            if (state.connected) {
                item {
                    PrimaryTabRow(selectedTabIndex = tab.ordinal) {
                        for (each in DeviceTab.entries) {
                            Tab(selected = tab == each, onClick = { tab = each }, text = { Text(each.label) })
                        }
                    }
                }
            }
            item {
                when (if (state.connected) tab else DeviceTab.Status) {
                    DeviceTab.Status -> Connection(state, model)
                    DeviceTab.Files -> FilesTab(model)
                    DeviceTab.History -> HistoryTab(model)
                    DeviceTab.Console -> ConsoleTab(model)
                    DeviceTab.Camera -> CameraTab(model)
                }
            }
            item {
                TextButton(onClick = { removing = true }) { Text(stringResource(R.string.device_remove_printer)) }
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

    if (adding) AddPrinterDialog(onDismiss = { adding = false }) { name, address, port ->
        adding = false
        model.addPrinter(name, address, port)
    }
    if (removing) {
        val name = state.printers.firstOrNull { it.id == state.activeId }?.name.orEmpty()
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text(stringResource(R.string.device_remove_title, name)) },
            text = { Text(stringResource(R.string.device_remove_detail)) },
            confirmButton = { TextButton(onClick = { removing = false; model.removeActive() }) { Text(stringResource(R.string.device_remove)) } },
            dismissButton = { TextButton(onClick = { removing = false }) { Text(stringResource(R.string.device_keep)) } },
        )
    }
    model.ask?.let { pending ->
        AlertDialog(
            onDismissRequest = { model.answerAsk(false) },
            title = { Text(pending.title) },
            text = { Text(pending.detail) },
            confirmButton = { TextButton(onClick = { model.answerAsk(true) }) { Text(pending.confirm) } },
            dismissButton = { TextButton(onClick = { model.answerAsk(false) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
    model.confirmation?.let { pending ->
        val intent = pending.intent
        AlertDialog(
            onDismissRequest = { model.answer(false) },
            title = { Text(stringResource(R.string.device_confirm_title, text(intent.printerLabel))) },
            text = { Text(state.commands.firstOrNull { it.command == intent.command }?.let { text(it.label) }.orEmpty()) },
            confirmButton = { TextButton(onClick = { model.answer(true) }) { Text(stringResource(R.string.device_confirm)) } },
            dismissButton = { TextButton(onClick = { model.answer(false) }) { Text(stringResource(R.string.device_do_not)) } },
        )
    }
}

@Composable
private fun Proposal(proposal: ProposalRow, model: DeviceModel) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(proposal.name, style = MaterialTheme.typography.titleSmall)
            Text(proposal.address, style = MaterialTheme.typography.bodySmall)
            Text(
                stringResource(if (proposal.needsKey) R.string.device_found_needs_key else R.string.device_found_verified),
                style = MaterialTheme.typography.bodySmall,
            )
            if (proposal.savedAs != null) {
                Text(stringResource(R.string.device_found_saved, proposal.savedAs), style = MaterialTheme.typography.labelMedium)
            } else {
                TextButton(onClick = { model.addDiscovered(proposal.key) }) { Text(stringResource(R.string.device_found_add, proposal.name)) }
            }
        }
    }
}

@Composable
private fun CredentialFields(state: DeviceState, model: DeviceModel) {
    // A draft the field edits; it is the active printer's key once applied.
    var key by remember(state.activeId, state.apiKey) { mutableStateOf(state.apiKey) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = key,
            onValueChange = { key = it },
            label = { Text(stringResource(R.string.device_api_key)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { model.setApiKey(key) }, enabled = key.trim() != state.apiKey) {
                Text(stringResource(R.string.device_save_key))
            }
            Switch(checked = state.remember, onCheckedChange = model::setRemember)
            Text(stringResource(R.string.device_remember))
        }
        TextButton(onClick = model::forgetCredentials) { Text(stringResource(R.string.device_forget)) }
    }
}

@Composable
private fun Connection(state: DeviceState, model: DeviceModel) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(state.connection, style = MaterialTheme.typography.labelLarge)
            state.summary?.let { summary ->
                Text(text(summary.headline), style = MaterialTheme.typography.titleMedium)
                Text(text(summary.detail), style = MaterialTheme.typography.bodyMedium)
                (summary.progressLabel as? ProjectIntents.OptionalText.Value)?.let { Text(text(it.value)) }
                for (fact in summary.facts) Text("${text(fact.label)}: ${text(fact.value)}", style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.connected || state.connecting) {
                    OutlinedButton(onClick = model::disconnect) { Text(stringResource(R.string.device_disconnect)) }
                } else {
                    Button(onClick = model::connect) { Text(stringResource(R.string.device_connect)) }
                }
            }
            // Every command the printer could take, with why one is not available now.
            for (command in state.commands) {
                OutlinedButton(onClick = { model.command(command.command) }, enabled = command.allowed) { Text(text(command.label)) }
                (command.reason as? ProjectIntents.OptionalText.Value)?.let {
                    Text(text(it.value), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun AddPrinterDialog(onDismiss: () -> Unit, onAdd: (String, String, Int?) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var address by rememberSaveable { mutableStateOf("") }
    var port by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.device_add_printer)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.device_printer_name)) }, singleLine = true)
                OutlinedTextField(address, { address = it }, label = { Text(stringResource(R.string.device_printer_address)) }, singleLine = true)
                OutlinedTextField(
                    port, { port = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.device_printer_port)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onAdd(name, address, port.toIntOrNull()) }) { Text(stringResource(R.string.device_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.device_cancel)) } },
    )
}

private const val ANDROID_17 = 37
private const val LOCAL_NETWORK = Manifest.permission.ACCESS_LOCAL_NETWORK
