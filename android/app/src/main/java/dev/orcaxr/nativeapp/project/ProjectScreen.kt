package dev.orcaxr.nativeapp.project

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.PointerKeyboardModifiers
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.isShiftPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.ActionArrangement
import dev.orcaxr.core.ActionPresentation
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectNames
import dev.orcaxr.core.ProjectPlateState
import dev.orcaxr.core.ProjectRecovery
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.TransformTool
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.shell.ActionMenuItem
import dev.orcaxr.nativeapp.shell.ActionSections
import dev.orcaxr.nativeapp.shell.ActionTooltip
import dev.orcaxr.nativeapp.exports.ExportCommands
import dev.orcaxr.nativeapp.prepare.FollowSlicing
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.shell.AppActions
import dev.orcaxr.nativeapp.shell.LocalActionRunner
import dev.orcaxr.nativeapp.shell.LocalActionStates
import dev.orcaxr.nativeapp.shell.LocalCommandPalette
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import java.text.DateFormat
import java.util.Date

private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

/** The Project area: the open project's name, objects and history, its document operations and its exports
 * (judged with [prepare]'s facts: the published slice, a slice running). */
@Composable
fun ProjectScreen(model: ProjectModel, prepare: PrepareModel, modifier: Modifier = Modifier) {
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
    // A document action asked from elsewhere (the command palette, the Workspace's Save): this area's pickers and dialogs carry it out.
    LaunchedEffect(model.documentRequest) {
        val request = model.documentRequest ?: return@LaunchedEffect
        model.documentShown()
        when (request) {
            "file_new_project" -> model.newProject()
            "file_open_project" -> open.launch(arrayOf("*/*"))
            "file_import_model" -> import.launch(arrayOf("*/*"))
            "file_save_project" -> if (!model.save()) saveAs.launch(suggested)
            "file_save_project_as" -> saveAs.launch(suggested)
        }
    }
    var renaming by remember { mutableStateOf<Renaming?>(null) }
    // The column's width decides whether a setting's name and control share a line.
    var widthDp by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current

    LazyColumn(
        modifier.fillMaxWidth().padding(horizontal = 16.dp).onSizeChanged { widthDp = with(density) { it.width.toDp().value.toInt() } },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(view.name, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
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
                ExportMenu(view, model, prepare)
                // The browser's command palette, from this page too (its strip's search button).
                val openPalette = LocalCommandPalette.current
                ActionTooltip(stringResource(R.string.palette_open_hint)) {
                    OutlinedButton(onClick = openPalette, modifier = Modifier.pointerHoverIcon(PointerIcon.Hand)) {
                        Icon(painterResource(OrcaActionGlyphs.search), contentDescription = null, modifier = Modifier.size(16.dp))
                        Text(stringResource(R.string.palette_open), Modifier.padding(start = 6.dp))
                    }
                }
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
                EditMenu(view, model)
                AddMenu(view, model)
            }
        }
        item { Text(stringResource(R.string.project_plates), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium) }
        itemsIndexed(view.plateList, key = { _, plate -> "plate:" + plate.id }) { index, plate ->
            PlateRow(plate, index, view, model) { renaming = Renaming.Plate(plate.id, plate.name) }
        }
        item {
            OutlinedButton(onClick = { model.perform("add_plate") }, enabled = !model.busy && ProjectEditing.enabled(view, "add_plate")) {
                Text(stringResource(R.string.project_add_plate))
            }
        }
        item { Text(stringResource(R.string.project_objects), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium) }
        items(view.rows, key = { "row:" + text(it.key) }) { row -> TreeRow(row, view, model) { renaming = Renaming.Entity(it.entity, it.name) } }
        if (view.totalRows > view.rows.size) {
            item { Text(stringResource(R.string.project_more_rows, view.totalRows - view.rows.size), style = MaterialTheme.typography.bodySmall) }
        }
        // The selection's filament, one press away (the browser's selection filament bar).
        item(key = "filament-bar") {
            SelectionFilamentBar(view.filaments, model.filamentStatus, model.busy) { id, name -> model.assignFilament(id, name) }
        }
        // The transform inspector of the selected instance, under the tree.
        view.inspector?.let { inspector ->
            items(TransformInspector.TOOLS, key = { "inspector:" + it.name }) { tool ->
                InspectorTool(tool, inspector.fields(tool).texts, model.inspectorEdits, ProjectEditing.enabled(view, TransformInspector.action(tool))) {
                    model.editTransform(tool, it)
                }
            }
        }
        // The semantic editor's volume roles for the selected part (a hint for an object, instance or range).
        volumeRoleItems(model.inspector)
        // The inspector's other panels, as the tree's Settings and Layer ranges rows open them.
        inspectorPanel(model.inspector, settingsSideBySide(widthDp))
        // The browser's Tools: the Simplify panel.
        item(key = "simplify") { SimplifyPanel(view, model) }
        if (model.recent.isNotEmpty()) {
            item { Text(stringResource(R.string.project_recent), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium) }
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

    renaming?.let { request -> RenameDialog(request, model) { renaming = null } }
    model.pendingSplit?.let { confirmation -> SplitDialog(confirmation, model) }
    model.pendingDiscard?.let { pending ->
        AlertDialog(
            onDismissRequest = { model.answerDiscard(DiscardAnswer.Cancel) },
            title = { Text(stringResource(R.string.project_discard_title, pending.name)) },
            text = { Text(stringResource(R.string.project_discard_detail), Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = {
                Row {
                    TextButton(onClick = { model.answerDiscard(DiscardAnswer.Discard) }) { Text(stringResource(R.string.project_discard)) }
                    TextButton(onClick = { model.answerDiscard(DiscardAnswer.Save) }) { Text(stringResource(R.string.project_guard_save)) }
                }
            },
            dismissButton = { TextButton(onClick = { model.answerDiscard(DiscardAnswer.Cancel) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
    model.pendingConflict?.let { pending ->
        AlertDialog(
            onDismissRequest = { model.answerConflict(ConflictAnswer.Cancel) },
            title = { Text(stringResource(R.string.project_conflict_title, pending.name)) },
            text = { Text(stringResource(R.string.project_conflict_detail), Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = {
                Row {
                    TextButton(onClick = { model.answerConflict(ConflictAnswer.Overwrite) }) { Text(stringResource(R.string.project_overwrite)) }
                    TextButton(onClick = { model.answerConflict(ConflictAnswer.SaveAs) }) { Text(stringResource(R.string.project_save_as)) }
                }
            },
            dismissButton = { TextButton(onClick = { model.answerConflict(ConflictAnswer.Cancel) }) { Text(stringResource(R.string.device_cancel)) } },
        )
    }
    model.pendingImport?.let { pending ->
        AlertDialog(
            onDismissRequest = { model.answerImport(false) },
            title = { Text(stringResource(R.string.project_import_title, pending.filename)) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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

/** What the rename dialog renames: an object or part of the tree, or a plate of the plate bar. */
private sealed interface Renaming {
    val name: String
    data class Entity(val entity: ProjectIntents.ObjectTreeEntity, override val name: String) : Renaming
    data class Plate(val id: String, override val name: String) : Renaming
}

/** The browser's Edit menu: its selection and object edits, enabled as the core enables them. */
@Composable
private fun EditMenu(view: ProjectView, model: ProjectModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = view.ready && !model.busy) { Text(stringResource(R.string.project_edit_menu)) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            fun choose(action: ProjectActionState) {
                open = false
                model.perform(action.id)
            }
            for (action in ProjectEditing.editMenu(view)) ActionMenuItem(action, onClick = { choose(action) })
            HorizontalDivider()
            // Placement: on the selection (centre and scale to fit the active plate's models when
            // none is selected), Lay flat a tool that stays on until it is chosen again.
            for (action in ProjectEditing.placementMenu(view)) ToolMenuItem(action, model) { choose(action) }
            HorizontalDivider()
            // The model tools: split and simplify on the selection, Measure a tool that stays on until it is chosen again.
            for (action in ProjectEditing.toolsMenu(view)) ToolMenuItem(action, model) { choose(action) }
        }
    }
}

/**
 * The browser's File menu exports and Download All Plates: each enabled as
 * the core's gate judges it with the Prepare area's facts (read afresh while
 * the menu is open), carried out by the shell's export host — the system's
 * picker takes the file.
 */
@Composable
private fun ExportMenu(view: ProjectView, model: ProjectModel, prepare: PrepareModel) {
    var open by remember { mutableStateOf(false) }
    val run = LocalActionRunner.current
    val states = LocalActionStates.current
    Box {
        OutlinedButton(onClick = { open = true }, enabled = view.ready && !model.busy) { Text(stringResource(R.string.export_menu)) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            // What the exports are judged by: the published slice, a slice running, a blocking preflight.
            FollowSlicing(prepare, model)
            for (id in ExportCommands.MENU) {
                val action = states(prepare.state.actions[id] ?: ProjectActionState(id, id, false))
                ActionMenuItem(action, onClick = {
                    open = false
                    run(id)
                })
            }
        }
    }
}

/** A menu entry that may be a Workspace tool (Lay flat, Measure): checked while it is on, and choosable then to end it. */
@Composable
private fun ToolMenuItem(action: ProjectActionState, model: ProjectModel, onClick: () -> Unit) {
    val on = model.toolActive(action.id)
    Box(if (AppActions.isTool(action.id)) Modifier.semantics { selected = on } else Modifier) {
        ActionMenuItem(action, enabled = action.enabled || on, trailing = if (on) "✓" else null, onClick = onClick)
    }
}

/**
 * One transform tool of the inspector, as the browser's Tool Settings panel
 * shows it: the tool's title and its X, Y and Z fields with the selected
 * instance's values ([shown], two decimals). A field holding the focus keeps
 * what is typed; Done or leaving a changed field submits the tool's three
 * texts ([onEdit]); every other field follows the selection, and after each
 * edit ([edits]) — a refused one too — shows its value again.
 */
@Composable
private fun InspectorTool(tool: TransformTool, shown: List<String>, edits: Int, enabled: Boolean, onEdit: (List<String>) -> Unit) {
    val title = stringResource(
        when (tool) {
            TransformTool.MOVE -> R.string.project_inspector_move
            TransformTool.ROTATE -> R.string.project_inspector_rotate
            TransformTool.SCALE -> R.string.project_inspector_scale
        },
    )
    val axes = listOf(stringResource(R.string.project_inspector_x), stringResource(R.string.project_inspector_y), stringResource(R.string.project_inspector_z))
    var focused by remember { mutableStateOf<Int?>(null) }
    var typed by remember { mutableStateOf(shown) }
    // The focused field's text at its last change (or when it took the focus): the input's `change` fires for a new text only.
    var since by remember { mutableStateOf("") }
    LaunchedEffect(shown, edits) { typed = TransformInspector.follow(shown, typed, focused) }
    val focus = LocalFocusManager.current
    fun submit(axis: Int) {
        val texts = TransformInspector.change(since, typed, axis) ?: return
        since = typed[axis]
        onEdit(texts)
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (axis in 0 until TransformInspector.AXES) {
                val description = "$title ${axes[axis]}"
                OutlinedTextField(
                    value = typed[axis],
                    onValueChange = { next -> typed = typed.toMutableList().also { it[axis] = next } },
                    label = { Text(axes[axis]) },
                    singleLine = true,
                    enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                    // The soft keyboard's Done changes the field and puts the keyboard away.
                    keyboardActions = KeyboardActions(onDone = {
                        submit(axis)
                        focus.clearFocus()
                    }),
                    modifier = Modifier.weight(1f)
                        // Enter from a hardware keyboard changes the field as it changes the browser's input, which
                        // keeps the focus and its typing; Escape stays the field's, as the browser skips its shortcuts
                        // while one is edited.
                        .onPreviewKeyEvent { event ->
                            val enter = event.key == Key.Enter || event.key == Key.NumPadEnter
                            if (enter && event.type == KeyEventType.KeyUp) submit(axis)
                            enter || event.key == Key.Escape
                        }
                        .onFocusChanged { state ->
                            if (state.isFocused) {
                                focused = axis
                                since = typed[axis]
                            } else if (focused == axis) {
                                // The input's change event: the focus left a field whose text changed since its last change.
                                focused = null
                                val change = TransformInspector.change(since, typed, axis)
                                if (change != null) onEdit(change) else typed = TransformInspector.follow(shown, typed, null)
                            }
                        }
                        .semantics { contentDescription = description },
                )
            }
        }
    }
}

/**
 * The browser's Add menu: the six primitives, each placed on the project's
 * bed as one undoable step, then the helper volumes for the selected object —
 * enabled as the core enables them.
 */
@Composable
private fun AddMenu(view: ProjectView, model: ProjectModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = view.ready && !model.busy) { Text(stringResource(R.string.project_add_menu)) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (action in ProjectEditing.addMenu(view)) {
                ActionMenuItem(action) {
                    open = false
                    model.perform(action.id)
                }
            }
        }
    }
}

/**
 * One plate of the plate bar (the browser's plate manager): the active one
 * marked, tapped to activate; its printing switch; and its own actions —
 * rename, move up or down, duplicate, delete — each on this plate.
 */
@Composable
private fun PlateRow(plate: ProjectPlateState, index: Int, view: ProjectView, model: ProjectModel, onRename: () -> Unit) {
    val enabled = view.ready && !model.busy
    var open by remember { mutableStateOf(false) }
    val activate = stringResource(R.string.project_activate_plate)
    val include = stringResource(R.string.project_set_plate_printable)
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled && !plate.active) { model.activatePlate(plate.id) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected = plate.active,
            onClick = { model.activatePlate(plate.id) },
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = "$activate: ${plate.name}" },
        )
        Text(plate.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        Checkbox(
            checked = plate.printable,
            onCheckedChange = { model.setPlatePrintable(plate.id, it) },
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = "$include: ${plate.name}" },
        )
        Box {
            val actions = stringResource(R.string.project_plate_actions, plate.name)
            TextButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.semantics { contentDescription = actions }) { Text("⋮") }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                fun choose(action: () -> Unit) {
                    open = false
                    action()
                }
                val count = view.plateList.size
                DropdownMenuItem(text = { Text(stringResource(R.string.project_rename_plate)) }, onClick = { choose(onRename) })
                DropdownMenuItem(text = { Text(stringResource(R.string.project_plate_move_up)) }, onClick = { choose { model.movePlate(plate.id, -1) } }, enabled = index > 0)
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.project_plate_move_down)) },
                    onClick = { choose { model.movePlate(plate.id, 1) } },
                    enabled = index < count - 1,
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.project_plate_duplicate)) },
                    onClick = { choose { model.duplicatePlate(plate.id) } },
                    enabled = count < ProjectWorkspace.MAX_PROJECT_PLATES,
                )
                DropdownMenuItem(text = { Text(stringResource(R.string.project_delete_plate)) }, onClick = { choose { model.deletePlate(plate.id) } }, enabled = count > 1)
            }
        }
    }
}

/**
 * One row of the plates-and-objects tree, as the browser's Objects panel
 * shows it: indented by level, opened and closed by its disclosure,
 * highlighted when its entity is selected. A tap selects it (Ctrl/Meta
 * toggles, Shift extends a range, from a hardware keyboard), its check box
 * toggles it, and a long-press — or a secondary click, the keyboard's menu
 * key or Shift+F10 — opens its menu: Rename for an object or part, then the
 * catalogue's actions in their sections (the scene's menu for the row's
 * kind), which act on the selection — without changing the selection, as the
 * browser's Objects panel does.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TreeRow(row: ProjectIntents.ObjectTreeRow, view: ProjectView, model: ProjectModel, onRename: (ProjectEditing.Choice.Rename) -> Unit) {
    val key = text(row.key)
    val label = text(row.label)
    var menu by remember { mutableStateOf(false) }
    var modifiers by remember { mutableStateOf(PointerKeyboardModifiers(0)) }
    val selectable = ProjectEditing.selectable(row)
    // A Settings or Layer ranges row opens the inspector's panel for its node instead of selecting.
    val opens = InspectorRows.opens(row)
    val choices = if (menu) ProjectEditing.rowMenu(row, view) else emptyList()
    val actions = stringResource(R.string.project_plate_actions, label)
    Box {
        Row(
            Modifier.fillMaxWidth()
                .background(if (row.selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                .pointerInput(Unit) {
                    // The keyboard's modifiers as the pointer goes down: what a click activates with. A secondary
                    // click (the mouse's right button) opens the row's menu, as the browser's `contextmenu` does.
                    awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            modifiers = event.keyboardModifiers
                            if (event.type == PointerEventType.Press && event.buttons.isSecondaryPressed) {
                                event.changes.forEach { it.consume() }
                                menu = true
                            }
                        }
                    }
                }
                // The keyboard's menu key, or Shift+F10, opens it too, as the browser's Objects panel lets them.
                .onKeyEvent { event ->
                    val opens = event.key == Key.Menu || (event.key == Key.F10 && event.isShiftPressed)
                    if (opens && event.type == KeyEventType.KeyUp && selectable) menu = true
                    opens
                }
                .combinedClickable(
                    enabled = selectable || opens != null,
                    onClick = {
                        if (opens != null) model.inspector.open(opens)
                        else model.selectRow(key, ProjectEditing.rowMode(modifiers.isShiftPressed, modifiers.isCtrlPressed || modifiers.isMetaPressed))
                    },
                    // As the browser's Objects panel: the menu opens without changing the selection.
                    // TalkBack offers it as the row's long-press action, named for the row.
                    onLongClickLabel = actions,
                    onLongClick = { menu = true },
                )
                .semantics { selected = row.selected }
                .padding(start = (16 * row.level.coerceIn(0L, 6L)).toInt().dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (row.expansion) {
                ProjectIntents.ObjectTreeRowExpansion.Leaf -> Spacer(Modifier.size(40.dp))
                else -> {
                    val open = row.expansion == ProjectIntents.ObjectTreeRowExpansion.Expanded
                    val description = stringResource(if (open) R.string.project_row_collapse else R.string.project_row_expand, label)
                    TextButton(onClick = { model.toggleRow(key) }, modifier = Modifier.size(40.dp).semantics { contentDescription = description }) {
                        Text(if (open) "▾" else "▸")
                    }
                }
            }
            if (selectable) {
                val description = stringResource(R.string.project_row_select, label)
                Checkbox(
                    checked = row.selected,
                    onCheckedChange = { model.selectRow(key, ProjectRowSelection.Toggle) },
                    modifier = Modifier.semantics { contentDescription = description },
                )
            }
            Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                Text(label, style = MaterialTheme.typography.bodyLarge)
                (row.description as? ProjectIntents.OptionalText.Value)?.let { Text(text(it.value), style = MaterialTheme.typography.bodySmall) }
                TreeIndicators(row)
            }
        }
        DropdownMenu(expanded = menu && choices.isNotEmpty(), onDismissRequest = { menu = false }) {
            // The Objects panel's own Rename first, then the catalogue's menu for the row in its sections.
            for (choice in choices) if (choice is ProjectEditing.Choice.Rename) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.project_rename)) },
                    onClick = {
                        menu = false
                        onRename(choice)
                    },
                    modifier = Modifier.pointerHoverIcon(PointerIcon.Hand),
                )
            }
            val actions = choices.filterIsInstance<ProjectEditing.Choice.Action>().map { it.state }
            val sections = remember(actions) { ActionPresentation.arrange(actions, ActionArrangement.CONTEXT) { it.id } }
            ActionSections(sections, enabled = { !model.busy && (it.enabled || model.toolActive(it.id)) }) { action ->
                menu = false
                model.perform(action.id)
            }
        }
    }
}

/** Renames an object, part or plate: the name trimmed and bounded as the browser takes it, a plate's checked as its plate manager checks it. */
@Composable
private fun RenameDialog(request: Renaming, model: ProjectModel, close: () -> Unit) {
    var name by remember(request) { mutableStateOf(request.name) }
    val problem = if (request is Renaming.Plate) ProjectNames.plateNameProblem(name) else null
    val blank = ProjectNames.trim(name).isEmpty()
    AlertDialog(
        onDismissRequest = close,
        title = { Text(stringResource(R.string.project_rename_title, request.name)) },
        text = {
            OutlinedTextField(
                name, { name = it },
                label = { Text(stringResource(R.string.project_rename_name)) },
                singleLine = true,
                isError = problem != null,
                supportingText = problem?.let { { Text(it) } },
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = {
                    close()
                    when (request) {
                        is Renaming.Entity -> model.rename(request.entity, name)
                        is Renaming.Plate -> model.renamePlate(request.id, name)
                    }
                },
                enabled = problem == null && !blank,
            ) { Text(stringResource(R.string.project_guard_save)) }
        },
        dismissButton = { TextButton(onClick = close) { Text(stringResource(R.string.device_cancel)) } },
    )
}

private const val MIME_3MF = "model/3mf"
