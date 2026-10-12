package dev.orcaxr.nativeapp.prepare

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.pluralMessage
import dev.orcaxr.nativeapp.project.FilamentList
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.project.VirtualFilamentAuthorDialog
import dev.orcaxr.nativeapp.project.VirtualFilamentDeleteDialog
import dev.orcaxr.nativeapp.project.VirtualFilamentLibraryPanel
import kotlinx.coroutines.launch
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.send.SendWords

/**
 * The Prepare area: the active plate, the external slicer it can be sliced on
 * (the browser's External Slicer settings — URL, token, connect, on/off,
 * remove, the attested engine or why not), the route a slice takes and why
 * (that slicer when it is on, else this device's own engine),
 * the shared preflight's issues as the browser's panel shows them, and
 * "Slice" / "Cancel Slice" / "Slice All Plates" (enabled as the core enables
 * them) with the job's progress. The first slice on an endpoint asks before
 * uploading; a finished slice opens in Preview — after Slice All Plates the
 * active plate's, each plate's result listed — and one whose project
 * changed afterwards is marked out of date. A current slice
 * goes to the printer the Device area connected ("Send to Printer", through
 * [device]'s shared workflow), with the send's progress and outcome below.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PrepareScreen(model: PrepareModel, project: ProjectModel, device: DeviceModel, modifier: Modifier = Modifier) {
    val view = project.view
    val profiles = project.profilesView
    val state = model.state
    val send = device.sendState
    val connection = state.connection
    val plate = view.activePlate
    val context = LocalContext.current
    // The preflight, and the core's gate on the slice actions, follow the project while this area is shown.
    FollowSlicing(model, project)
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
    // Slicing on this device shows its progress and Cancel in a notification, which Android 13 lets
    // the app post only once the operator allows it: asked once, before the first local slice.
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.slice() }
    val allNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.sliceAll() }
    val slice = {
        val ask = Build.VERSION.SDK_INT >= ANDROID_13 && sliceRoute(connection, state.local) == SliceRouteKind.Local &&
            context.checkSelfPermission(NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && model.askNotifications()
        if (ask) notifications.launch(NOTIFICATIONS) else model.slice()
    }
    var hidden by remember { mutableStateOf(emptySet<String>()) }
    val job = state.job
    val preflight = state.preflight?.takeIf { it.plateId == plate?.id }
    // The route the rule chooses (the external slicer turned on, or this device's engine); none offers no Slice.
    val route = sliceRoute(connection, state.local)
    // Slice, Slice All Plates, Cancel Slice and Send to Printer enabled as the command palette enables them.
    val facts = PrepareCommands.Facts.of(state, plate?.id, plate?.objects, view.revision, device.state.connected, send.busy)
    val canSlice = PrepareCommands.canSlice(facts)
    val canSliceAll = PrepareCommands.canSliceAll(facts)
    val sliceAll = {
        val ask = Build.VERSION.SDK_INT >= ANDROID_13 && route == SliceRouteKind.Local &&
            context.checkSelfPermission(NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && model.askNotifications()
        if (ask) allNotifications.launch(NOTIFICATIONS) else model.sliceAll()
    }
    // What the command palette or a plate's menu asked, carried out as this area's button for it is, once shown;
    // what has stopped being possible meanwhile says why on the status line instead.
    LaunchedEffect(model.asked) {
        val asked = model.asked ?: return@LaunchedEffect
        if (!PrepareCommands.enabled(asked, facts)) {
            model.answered(PrepareCommands.reason(asked, facts))
            return@LaunchedEffect
        }
        model.answered()
        when (asked) {
            PrepareCommands.SLICE -> slice()
            PrepareCommands.SLICE_ALL -> sliceAll()
            PrepareCommands.CANCEL -> model.cancel()
            PrepareCommands.SEND -> device.send(model.sendable())
        }
    }

    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    Column(modifier.fillMaxWidth()) {
        // Slice and its progress stay above the list, as the browser keeps Slice in its toolbar: the
        // profiles, filaments and the virtual library run to several screens before the slice's own words.
        // While the keyboard is up the bar steps aside, so the field being typed in keeps the room above it
        // (in landscape the keyboard leaves little).
        // Above the list in z as well: a list item scrolled partly under the bar (a text field's
        // bounds are not clipped to the list) otherwise covers the bar's progress and status lines
        // for accessibility services, which leave out what they take to be covered.
        if (!WindowInsets.isImeVisible) Column(Modifier.fillMaxWidth().zIndex(1f).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // Slice and Cancel Slice as the browser's toolbar has them, Slice All Plates (its menu's) beside them.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = slice, enabled = canSlice) { Text(stringResource(R.string.prepare_slice)) }
                OutlinedButton(onClick = model::cancel, enabled = PrepareCommands.canCancel(facts)) {
                    Text(stringResource(R.string.prepare_cancel))
                }
                OutlinedButton(onClick = sliceAll, enabled = canSliceAll) { Text(stringResource(R.string.prepare_slice_all)) }
            }
            if (job != null) {
                val percent = job.percent
                if (percent != null) {
                    LinearProgressIndicator(progress = { (percent / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                Text(PrepareWords.progress(job.message), style = MaterialTheme.typography.bodyMedium)
            }
            state.status?.let { status ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(status, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = model::dismissStatus) { Text(stringResource(R.string.device_dismiss)) }
                }
            }
            if (send.status != null || send.busy) {
                // The send's progress and outcome, as the browser's status line words them.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(send.status.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    if (send.busy) {
                        // Beside "Press Cancel send to stop.", whatever the list shows (a withdrawn slice too).
                        TextButton(onClick = device::cancelSend) { Text(stringResource(R.string.send_cancel)) }
                    } else {
                        TextButton(onClick = device::dismissSend) { Text(stringResource(R.string.device_dismiss)) }
                    }
                }
            }
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp),
            state = list,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text(
                    plate?.let { stringResource(R.string.prepare_plate, it.name, it.objects) } ?: stringResource(R.string.prepare_no_plate),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics { heading() },
                )
            }
            // The slice's result (and its Send) first: after a slice it is what the operator came back for.
            state.result?.let { result ->
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(result.name, style = MaterialTheme.typography.titleSmall)
                            Text(
                                if (result.local) stringResource(R.string.prepare_sliced_locally) else stringResource(R.string.prepare_sliced_on, result.endpoint),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (result.revision != view.revision) {
                                // Output for a state the project has left is never previewed or sent.
                                Text(PrepareWords.OUT_OF_DATE, color = MaterialTheme.colorScheme.error)
                            } else {
                                val connected = device.state.connected
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = model::showResult) { Text(stringResource(R.string.nav_preview)) }
                                    // While a send runs, its Cancel send is the status line's, above the list, beside the
                                    // words that name it (the browser's one button turns into it there).
                                    Button(onClick = { device.send(model.sendable()) }, enabled = PrepareCommands.canSend(facts)) {
                                        Text(stringResource(R.string.send_action))
                                    }
                                }
                                if (!connected && !send.busy) Text(SendWords.CONNECT_FIRST, style = MaterialTheme.typography.bodySmall)
                            }
                            // After Slice All Plates: every plate's own result, and which one Preview and Send take.
                            if (state.plates.isNotEmpty()) {
                                Text(stringResource(R.string.prepare_sliced_plates), Modifier.semantics { heading() }, style = MaterialTheme.typography.labelLarge)
                                for (sliced in state.plates) Text(sliced.row, style = MaterialTheme.typography.bodySmall)
                                Text(stringResource(R.string.prepare_sliced_shown, result.plateName), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
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
                    onOpenLibrary = { scope.launch { list.animateScrollToItem(LIBRARY_ITEM + if (state.result != null) 1 else 0) } },
                )
            }
            item(key = "virtual-filaments") {
                VirtualFilamentLibraryPanel(
                    view.virtualFilaments,
                    project.virtualStatus,
                    project.virtualFailure,
                    busy = project.busy || project.virtualBusy,
                    onOpen = project::openVirtualFilament,
                    onToggle = project::toggleVirtualFilament,
                    onDelete = project::askDeleteVirtualFilament,
                )
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.prepare_external_slicer), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
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
                        // The whole row is the switch, so it is named by its words.
                        val usable = connection.phase != SlicerPhase.Probing
                        Row(
                            Modifier.toggleable(value = connection.enabled, enabled = usable, role = Role.Switch, onValueChange = model::setEnabled),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Switch(checked = connection.enabled, onCheckedChange = null, enabled = usable)
                            Text(stringResource(R.string.prepare_enabled))
                        }
                    }
                    Text(
                        PrepareWords.status(connection),
                        style = MaterialTheme.typography.labelLarge,
                        color = if (connection.enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(PrepareWords.hint(connection, state.local), style = MaterialTheme.typography.bodySmall)
                }
            }
            item { Text(PrepareWords.route(connection, state.local), style = MaterialTheme.typography.bodyMedium) }
            if (preflight != null && preflight.cards.isNotEmpty()) {
                // Hidden issues stay hidden through recomputes while the fault stands, as the browser's panel keeps them.
                val present = preflight.cards.map { it.id }.toSet()
                val shown = preflight.cards.filter { it.id !in hidden }
                item { Text(stringResource(R.string.prepare_preflight), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium) }
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
        }
    }

    project.virtualAuthor?.let { dialog ->
        VirtualFilamentAuthorDialog(
            dialog,
            view.revision,
            onType = project::typeVirtualFilament,
            onTriangle = project::pickTriangle,
            onSubmit = project::submitVirtualFilament,
            onClose = project::closeVirtualFilament,
        )
    }
    project.virtualDelete?.let { dialog ->
        VirtualFilamentDeleteDialog(dialog, view.revision, onConfirm = project::deleteVirtualFilament, onClose = project::closeDeleteVirtualFilament)
    }

    state.consentFor?.let { endpoint ->
        AlertDialog(
            onDismissRequest = { model.answerConsent(false) },
            title = { Text(PrepareWords.consentTitle(endpoint)) },
            // Enlarged text scrolls inside the dialog rather than pushing its buttons away.
            text = { Text(PrepareWords.CONSENT_DETAIL, Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { TextButton(onClick = { model.answerConsent(true) }) { Text(stringResource(R.string.prepare_upload)) } },
            dismissButton = { TextButton(onClick = { model.answerConsent(false) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
}

/**
 * Keeps what the slice actions are judged by current while shown — the
 * Prepare area, or the command palette over any area: the active plate's
 * preflight as the project and its profiles change, and Slice, Slice All
 * Plates and Cancel Slice as the core enables them (the browser's registry
 * gate), read again whenever what it judges changes: the project, a slice
 * running, a blocking preflight.
 */
@Composable
fun FollowSlicing(model: PrepareModel, project: ProjectModel) {
    val view = project.view
    val plate = view.activePlate
    LaunchedEffect(view.revision, plate, project.profilesView) { model.refreshPreflight() }
    val blocked = model.state.preflight?.takeIf { it.plateId == plate?.id }?.canSlice == false
    LaunchedEffect(view.revision, plate?.id, model.state.job != null, blocked) { model.refreshActions() }
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

/** The virtual filament library's place in the list: after the plate, the pickers and the filaments (and a slice's result, when one shows). */
private const val LIBRARY_ITEM = 3
private const val ANDROID_17 = 37
private const val ANDROID_13 = 33
private const val NOTIFICATIONS = Manifest.permission.POST_NOTIFICATIONS
private const val LOCAL_NETWORK = Manifest.permission.ACCESS_LOCAL_NETWORK
