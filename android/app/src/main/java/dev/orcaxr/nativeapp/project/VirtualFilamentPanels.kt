package dev.orcaxr.nativeapp.project

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import dev.orcaxr.core.VirtualFilamentChoice
import dev.orcaxr.core.VirtualFilamentForm
import dev.orcaxr.core.VirtualFilamentIssue
import dev.orcaxr.core.VirtualFilamentLibrary
import dev.orcaxr.core.VirtualFilamentLibraryResult
import dev.orcaxr.core.VirtualFilamentMode
import dev.orcaxr.core.VirtualFilamentOperation
import dev.orcaxr.core.VirtualFilamentRow
import dev.orcaxr.core.VirtualFilamentSearch
import dev.orcaxr.nativeapp.R

/** A recipe mode's name as the browser labels it (`modeLabel`). */
@Composable
private fun modeLabel(mode: VirtualFilamentMode): String = stringResource(
    when (mode) {
        VirtualFilamentMode.RATIO -> R.string.vf_mode_ratio
        VirtualFilamentMode.CYCLE -> R.string.vf_mode_cycle
        VirtualFilamentMode.MATCH -> R.string.vf_mode_match
        VirtualFilamentMode.GRADIENT -> R.string.vf_mode_gradient
    },
)

/**
 * The browser's virtual filament library (its sidebar section): the heading
 * and "Add virtual filament" (offered with two heads a recipe can select),
 * the library's status or the last operation's, why the library cannot be
 * shown, the physical components recipes reference (each head's material,
 * colour and availability) and the virtual library — one row per live
 * recipe with its badge, mode, availability, colour and recipe summary, and
 * Edit, Duplicate, Enable/Disable and Delete. Each edit is one undoable step
 * with the browser's label.
 */
@Composable
fun VirtualFilamentLibraryPanel(
    result: VirtualFilamentLibraryResult,
    status: VirtualFilamentDialogs.Status?,
    failure: VirtualFilamentDialogs.Failure?,
    busy: Boolean,
    onOpen: (VirtualFilamentOperation, VirtualFilamentRow?) -> Unit,
    onToggle: (VirtualFilamentRow) -> Unit,
    onDelete: (VirtualFilamentRow) -> Unit,
) {
    val library = (result as? VirtualFilamentLibraryResult.Shown)?.library
    val heading = stringResource(R.string.vf_heading)
    Column(
        Modifier.fillMaxWidth().semantics { contentDescription = heading },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(heading, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).semantics { heading() })
            val canAdd = library != null && VirtualFilamentDialogs.canAdd(library, busy)
            val needs = stringResource(R.string.vf_add_needs_two)
            OutlinedButton(
                onClick = { onOpen(VirtualFilamentOperation.ADD, null) },
                enabled = canAdd,
                modifier = Modifier.semantics { if (library != null && library.selectable.size < 2) stateDescription = needs },
            ) { Text(stringResource(R.string.vf_add)) }
        }
        Text(
            statusText(status) ?: library?.status ?: stringResource(R.string.vf_no_snapshot),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val error = (result as? VirtualFilamentLibraryResult.Unavailable)?.let { stringResource(R.string.vf_unavailable, it.message) }
            ?: failure?.let { failureText(it) }
        if (error != null) {
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth()
                    .border(1.dp, MaterialTheme.colorScheme.error, RoundedCornerShape(8.dp))
                    .padding(8.dp),
            )
        }
        if (library == null) return@Column
        Section(stringResource(R.string.vf_physical_title)) {
            Text(stringResource(R.string.vf_physical_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (library.physical.isEmpty()) Text(stringResource(R.string.vf_no_physical), style = MaterialTheme.typography.bodySmall)
            for (choice in library.physical) PhysicalRow(choice)
        }
        Section(stringResource(R.string.vf_library_title)) {
            if (library.rows.isEmpty()) Text(stringResource(R.string.vf_no_rows), style = MaterialTheme.typography.bodySmall)
            for (row in library.rows) MixedRow(row, busy, onOpen, onToggle, onDelete)
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
        content()
    }
}

@Composable
private fun PhysicalRow(choice: VirtualFilamentChoice) {
    val state = stringResource(
        when {
            !choice.enabled -> R.string.vf_state_disabled
            choice.compatible -> R.string.vf_state_available
            else -> R.string.vf_state_incompatible
        },
    )
    val details = choice.incompatibilityReason?.let { stringResource(R.string.vf_physical_details_reason, choice.material, choice.color, state, it) }
        ?: stringResource(R.string.vf_physical_details, choice.material, choice.color, state)
    val swatch = stringResource(R.string.vf_physical_swatch, choice.name, choice.color)
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        FilamentSwatch(choice.color, size = 28.dp, modifier = Modifier.semantics { contentDescription = swatch })
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.vf_physical_name, choice.toolId.toString(), choice.name), fontWeight = FontWeight.Bold)
            Text(details, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MixedRow(
    row: VirtualFilamentRow,
    busy: Boolean,
    onOpen: (VirtualFilamentOperation, VirtualFilamentRow?) -> Unit,
    onToggle: (VirtualFilamentRow) -> Unit,
    onDelete: (VirtualFilamentRow) -> Unit,
) {
    val badge = stringResource(R.string.vf_row_badge, row.name, row.displayColor)
    val availability = stringResource(if (row.enabled) R.string.vf_enabled else R.string.vf_state_disabled)
    val actions = stringResource(R.string.vf_actions_for, row.name)
    Column(
        Modifier.fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(9.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            FilamentSwatch(row.displayColor, size = 32.dp, modifier = Modifier.semantics { contentDescription = badge })
            Column(Modifier.weight(1f)) {
                Text(row.name, fontWeight = FontWeight.Bold)
                Text(
                    stringResource(R.string.vf_row_details, modeLabel(row.mode), availability, row.displayColor),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(row.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        FlowRow(
            Modifier.fillMaxWidth().semantics { contentDescription = actions },
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            OutlinedButton(onClick = { onOpen(VirtualFilamentOperation.EDIT, row) }, enabled = !busy) { Text(stringResource(R.string.vf_edit)) }
            OutlinedButton(onClick = { onOpen(VirtualFilamentOperation.DUPLICATE, row) }, enabled = !busy) { Text(stringResource(R.string.vf_duplicate)) }
            OutlinedButton(onClick = { onToggle(row) }, enabled = !busy) {
                Text(stringResource(if (row.enabled) R.string.vf_disable else R.string.vf_enable))
            }
            OutlinedButton(onClick = { onDelete(row) }, enabled = !busy) { Text(stringResource(R.string.vf_delete)) }
        }
    }
}

@Composable
private fun statusText(status: VirtualFilamentDialogs.Status?): String? = when (status) {
    null -> null
    is VirtualFilamentDialogs.Status.Accepted -> stringResource(
        when (status.operation) {
            VirtualFilamentOperation.ADD -> R.string.vf_add_accepted
            VirtualFilamentOperation.EDIT -> R.string.vf_edit_accepted
            VirtualFilamentOperation.DUPLICATE -> R.string.vf_duplicate_accepted
        },
        status.name,
    )
    is VirtualFilamentDialogs.Status.Toggling -> stringResource(if (status.enabling) R.string.vf_enabling else R.string.vf_disabling, status.name)
    is VirtualFilamentDialogs.Status.Toggled -> stringResource(if (status.enabled) R.string.vf_enable_accepted else R.string.vf_disable_accepted, status.name)
    is VirtualFilamentDialogs.Status.Deleted -> stringResource(R.string.vf_delete_accepted, status.name)
}

@Composable
private fun failureText(failure: VirtualFilamentDialogs.Failure): String = when (failure) {
    is VirtualFilamentDialogs.Failure.Recipe -> stringResource(R.string.vf_recipe_not_changed, failure.message)
    is VirtualFilamentDialogs.Failure.Toggle -> stringResource(R.string.vf_not_changed, failure.name, failure.message)
    is VirtualFilamentDialogs.Failure.Deletion -> stringResource(R.string.vf_not_deleted, failure.name, failure.message)
}

/**
 * The browser's author dialog: name, badge colour and the two surface
 * offsets; the authoring mode; that mode's fields — Ratio's heads, B percent
 * and triangle proportions with the triangle picker and the predicted mix,
 * Cycle's pattern with its quick tokens, Match's target, minimum and ranked
 * candidates from the pinned search, Gradient's heads, direction, sublayers
 * and vertical preview — then the located issues, the preview line, and
 * Cancel and Add, Apply changes or Create duplicate (only for a complete
 * draft, nothing pending, the project unchanged since the dialog opened).
 */
@Composable
fun VirtualFilamentAuthorDialog(
    dialog: VirtualFilamentDialogs.Author,
    revision: Any?,
    onType: (VirtualFilamentForm) -> Unit,
    onTriangle: (Double, Double) -> Unit,
    onSubmit: () -> Unit,
    onClose: () -> Unit,
) {
    val form = dialog.form
    val library = dialog.library
    val validation = dialog.validation
    val stale = VirtualFilamentDialogs.stale(dialog.revision, revision)
    val patternFocus = remember { FocusRequester() }
    var pattern by remember(dialog.operation, dialog.target?.id) { mutableStateOf(TextFieldValue(form.cyclePattern)) }
    if (pattern.text != form.cyclePattern) pattern = TextFieldValue(form.cyclePattern, TextRange(form.cyclePattern.length))
    AlertDialog(
        onDismissRequest = { if (!dialog.busy) onClose() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
        modifier = Modifier.widthIn(max = 760.dp).padding(16.dp),
        title = {
            Text(
                when (dialog.operation) {
                    VirtualFilamentOperation.ADD -> stringResource(R.string.vf_add)
                    VirtualFilamentOperation.EDIT -> stringResource(R.string.vf_title_edit, form.name)
                    VirtualFilamentOperation.DUPLICATE -> stringResource(R.string.vf_title_duplicate, form.name)
                },
            )
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.vf_dialog_description), style = MaterialTheme.typography.bodySmall)
                Field(stringResource(R.string.vf_name), form.name, "name", validation.issues) { onType(form.copy(name = it)) }
                BadgeField(form, validation.issues) { onType(form.copy(displayColor = it)) }
                Field(stringResource(R.string.vf_offset_a), form.offsetA, "component-a-surface-offset", validation.issues) { onType(form.copy(offsetA = it)) }
                Field(stringResource(R.string.vf_offset_b), form.offsetB, "component-b-surface-offset", validation.issues) { onType(form.copy(offsetB = it)) }
                Text(stringResource(R.string.vf_authoring_mode), fontWeight = FontWeight.Bold)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (mode in VirtualFilamentMode.entries) {
                        Choice(modeLabel(mode), form.mode == mode, enabled = !dialog.busy) { onType(form.copy(mode = mode)) }
                    }
                }
                Column(
                    Modifier.fillMaxWidth()
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    when (form.mode) {
                        VirtualFilamentMode.RATIO -> RatioPanel(dialog, onType, onTriangle)
                        VirtualFilamentMode.CYCLE -> CyclePanel(dialog, pattern, patternFocus, { value -> pattern = value; onType(form.copy(cyclePattern = value.text)) })
                        VirtualFilamentMode.MATCH -> MatchPanel(dialog, onType)
                        VirtualFilamentMode.GRADIENT -> GradientPanel(dialog, onType)
                    }
                }
                val issues = buildList {
                    if (stale) add(Issues.Line(stringResource(R.string.vf_stale), null))
                    dialog.error?.let { add(Issues.Line(stringResource(R.string.vf_recipe_not_changed, it), null)) }
                    for (issue in validation.issues) add(Issues.Line(issueText(issue), issue))
                }
                if (issues.isNotEmpty()) {
                    Column(
                        Modifier.fillMaxWidth()
                            .border(1.dp, MaterialTheme.colorScheme.error, RoundedCornerShape(8.dp))
                            .padding(9.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        for (line in issues) {
                            val located = line.issue?.takeIf { it.field == "cycle-pattern" && it.startOffset != null && it.endOffset != null }
                            Text(
                                line.text,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = if (located == null) Modifier else Modifier.clickable {
                                    pattern = pattern.copy(selection = TextRange(located.startOffset!!, located.endOffset!!))
                                    patternFocus.requestFocus()
                                },
                            )
                        }
                    }
                }
                val previewBorder = Filaments.argb(form.displayColor)?.let { Color(it) } ?: Color.Transparent
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.background(previewBorder).padding(start = 12.dp).heightIn(min = 44.dp))
                    Text(validation.preview, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 8.dp))
                }
            }
        },
        confirmButton = {
            Button(onClick = onSubmit, enabled = VirtualFilamentDialogs.canSubmit(dialog, revision)) {
                Text(
                    stringResource(
                        when (dialog.operation) {
                            VirtualFilamentOperation.ADD -> R.string.vf_submit_add
                            VirtualFilamentOperation.EDIT -> R.string.vf_submit_edit
                            VirtualFilamentOperation.DUPLICATE -> R.string.vf_submit_duplicate
                        },
                    ),
                )
            }
        },
        dismissButton = { TextButton(onClick = onClose, enabled = !dialog.busy) { Text(stringResource(R.string.device_cancel)) } },
    )
}

private object Issues {
    data class Line(val text: String, val issue: VirtualFilamentIssue?)
}

/** An issue's words; a located Cycle issue names its characters, as the browser's button does. */
@Composable
private fun issueText(issue: VirtualFilamentIssue): String {
    val start = issue.startOffset
    val end = issue.endOffset
    return if (issue.field == "cycle-pattern" && start != null && end != null) {
        stringResource(R.string.vf_issue_location, issue.message, (start + 1).toString(), maxOf(start + 1, end).toString())
    } else {
        issue.message
    }
}

@Composable
private fun Field(label: String, value: String, field: String, issues: List<VirtualFilamentIssue>, onChange: (String) -> Unit) {
    OutlinedTextField(
        value, onChange,
        label = { Text(label) },
        singleLine = true,
        isError = issues.any { it.field == field },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun BadgeField(form: VirtualFilamentForm, issues: List<VirtualFilamentIssue>, onChange: (String) -> Unit) {
    val choose = stringResource(R.string.vf_choose_badge)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            form.displayColor, onChange,
            label = { Text(stringResource(R.string.vf_badge_color)) },
            placeholder = { Text(stringResource(R.string.vf_hex_placeholder)) },
            singleLine = true,
            isError = issues.any { it.field == "display-color" },
            leadingIcon = { FilamentSwatch(form.displayColor) },
            modifier = Modifier.fillMaxWidth(),
        )
        // The badge picker: the palette's swatches, reported in upper case as the browser's picker reports its colour.
        FlowRow(
            Modifier.semantics { contentDescription = choose },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (swatch in Filaments.SWATCHES) {
                val upper = swatch.uppercase(java.util.Locale.ROOT)
                FilamentSwatch(swatch, size = 32.dp, modifier = Modifier.clickable { onChange(upper) }.semantics { contentDescription = upper })
            }
        }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, enabled: Boolean = true, onSelect: () -> Unit) {
    Row(
        Modifier.heightIn(min = 44.dp).selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect).padding(end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Text(label)
    }
}

/** A component picker: every head, those a recipe cannot newly take listed but not choosable (unless already chosen). */
@Composable
private fun HeadPicker(label: String, library: VirtualFilamentLibrary, selected: String?, error: Boolean, onChoose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val chosen = library.physical.lastOrNull { it.id == selected }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontWeight = FontWeight.Bold, color = if (error) MaterialTheme.colorScheme.error else Color.Unspecified)
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
                if (chosen != null) FilamentSwatch(chosen.color, size = 16.dp, modifier = Modifier.padding(end = 6.dp))
                Text(chosen?.let { choiceLabel(it) } ?: stringResource(R.string.vf_choose_head), modifier = Modifier.weight(1f))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for (choice in library.physical) {
                    val pickable = VirtualFilamentDialogs.selectableChoice(choice.enabled, choice.compatible, choice.id == selected)
                    DropdownMenuItem(
                        text = { Text(choiceLabel(choice)) },
                        leadingIcon = { FilamentSwatch(choice.color, size = 16.dp) },
                        enabled = pickable,
                        onClick = {
                            open = false
                            onChoose(choice.id)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun choiceLabel(choice: VirtualFilamentChoice): String {
    val base = stringResource(R.string.vf_choice_label, choice.toolId.toString(), choice.name, choice.material, choice.color)
    return when {
        choice.enabled && choice.compatible -> base
        choice.enabled -> stringResource(R.string.vf_choice_suffix, base, stringResource(R.string.vf_choice_incompatible))
        else -> stringResource(R.string.vf_choice_suffix, base, stringResource(R.string.vf_choice_disabled))
    }
}

private val LETTERS = listOf("A", "B", "C")

@Composable
private fun RatioPanel(dialog: VirtualFilamentDialogs.Author, onType: (VirtualFilamentForm) -> Unit, onTriangle: (Double, Double) -> Unit) {
    val form = dialog.form
    val issues = dialog.validation.issues
    Text(stringResource(R.string.vf_components), fontWeight = FontWeight.Bold)
    Row {
        for (count in listOf(2, 3)) {
            Choice(stringResource(R.string.vf_heads_count, count.toString()), form.ratioCount == count) {
                onType(VirtualFilamentDialogs.withCount(form, count))
            }
        }
    }
    for (index in 0 until form.ratioCount) {
        HeadPicker(
            stringResource(R.string.vf_component, LETTERS[index]),
            dialog.library,
            form.ratioId(index),
            issues.any { it.field == "ratio-component-$index" },
        ) { onType(form.withRatioId(index, it)) }
    }
    val parsed = form.ratioMixB.toIntOrNull()
    Text(stringResource(R.string.vf_component_b_percent), fontWeight = FontWeight.Bold)
    Slider(
        value = (parsed ?: 50).coerceIn(0, 100).toFloat(),
        onValueChange = { onType(form.copy(ratioMixB = it.toInt().toString())) },
        valueRange = 0f..100f,
        steps = 99,
    )
    Field(stringResource(R.string.vf_exact_percent), form.ratioMixB, "ratio-mix-b", issues) { onType(form.copy(ratioMixB = it)) }
    if (form.ratioCount == 3) {
        Text(stringResource(R.string.vf_triangle_proportions), fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (index in 0 until 3) {
                Box(Modifier.weight(1f)) {
                    Field(stringResource(R.string.vf_weight, LETTERS[index]), form.ratioTriangle[index], "ratio-weight-$index", issues) { value ->
                        onType(form.copy(ratioTriangle = form.ratioTriangle.toMutableList().also { it[index] = value }))
                    }
                }
            }
        }
        TrianglePicker(dialog, onTriangle)
        Text(stringResource(R.string.vf_triangle_note), style = MaterialTheme.typography.bodySmall)
    }
    val preview = dialog.validation.ratioPreview
    val background = preview?.let { Filaments.argb(it.color) }?.let { Color(it) } ?: Color(0xff555555)
    val words = preview?.text ?: stringResource(R.string.vf_ratio_incomplete)
    Box(
        Modifier.fillMaxWidth().heightIn(min = 58.dp)
            .background(background, RoundedCornerShape(9.dp))
            .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(9.dp))
            .padding(9.dp)
            .semantics { contentDescription = words },
        contentAlignment = Alignment.Center,
    ) { Text(words, color = Color.White, style = MaterialTheme.typography.bodySmall) }
}

/** The browser's Ratio triangle: corners A, B, C in the components' colours, the marker where the proportions put it. */
@Composable
private fun TrianglePicker(dialog: VirtualFilamentDialogs.Author, onTriangle: (Double, Double) -> Unit) {
    val marker = dialog.validation.triangle
    val colors = (0 until 3).map { index ->
        dialog.library.physical.lastOrNull { it.id == dialog.form.ratioId(index) }?.color?.let(Filaments::argb)?.let { Color(it) } ?: Color(0xff777777)
    }
    val label = stringResource(R.string.vf_triangle_label)
    val outline = MaterialTheme.colorScheme.outline
    val markerColor = MaterialTheme.colorScheme.tertiary
    Canvas(
        Modifier.fillMaxWidth().widthIn(max = 360.dp).aspectRatio(240f / 216f)
            .semantics {
                contentDescription = label
                marker?.let { stateDescription = it.valueText }
            }
            .pointerInput(dialog.library.json) {
                detectTapGestures { offset ->
                    VirtualFilamentDialogs.trianglePoint(offset.x, offset.y, size.width.toFloat(), size.height.toFloat())?.let { (x, y) -> onTriangle(x, y) }
                }
            }
            .pointerInput(dialog.library.json) {
                detectDragGestures { change, _ ->
                    val position = change.position
                    VirtualFilamentDialogs.trianglePoint(position.x, position.y, size.width.toFloat(), size.height.toFloat())?.let { (x, y) -> onTriangle(x, y) }
                }
            },
    ) {
        val scaleX = size.width / 240f
        val scaleY = size.height / 216f
        val corners = listOf(Offset(120f * scaleX, 18f * scaleY), Offset(18f * scaleX, 198f * scaleY), Offset(222f * scaleX, 198f * scaleY))
        val path = Path().apply {
            moveTo(corners[0].x, corners[0].y)
            lineTo(corners[1].x, corners[1].y)
            lineTo(corners[2].x, corners[2].y)
            close()
        }
        drawPath(path, outline, style = Stroke(width = 2.dp.toPx()))
        corners.forEachIndexed { index, corner -> drawCircle(colors[index], radius = 10.dp.toPx(), center = corner) }
        marker?.let { drawCircle(markerColor, radius = 8.dp.toPx(), center = Offset(it.x.toFloat() * scaleX, it.y.toFloat() * scaleY)) }
    }
}

@Composable
private fun CyclePanel(
    dialog: VirtualFilamentDialogs.Author,
    pattern: TextFieldValue,
    focus: FocusRequester,
    onPattern: (TextFieldValue) -> Unit,
) {
    val issues = dialog.validation.issues
    OutlinedTextField(
        pattern, onPattern,
        label = { Text(stringResource(R.string.vf_cycle_pattern)) },
        minLines = 3,
        isError = issues.any { it.field == "cycle-pattern" },
        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        modifier = Modifier.fillMaxWidth().focusRequester(focus),
    )
    Text(stringResource(R.string.vf_cycle_help), style = MaterialTheme.typography.bodySmall)
    val group = stringResource(R.string.vf_insert_token_group)
    FlowRow(
        Modifier.semantics { contentDescription = group },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (choice in dialog.library.physical) {
            OutlinedButton(
                onClick = {
                    val text = VirtualFilamentDialogs.withToken(pattern.text, choice.toolId)
                    onPattern(TextFieldValue(text, TextRange(text.length)))
                },
                enabled = choice.enabled && choice.compatible && !dialog.busy,
            ) { Text(stringResource(R.string.vf_insert, choice.toolId.toString())) }
        }
        OutlinedButton(onClick = {
            val text = VirtualFilamentDialogs.withGroup(pattern.text)
            onPattern(TextFieldValue(text, TextRange(text.length)))
        }) { Text(stringResource(R.string.vf_new_group)) }
    }
}

@Composable
private fun MatchPanel(dialog: VirtualFilamentDialogs.Author, onType: (VirtualFilamentForm) -> Unit) {
    val form = dialog.form
    val issues = dialog.validation.issues
    Text(
        stringResource(R.string.vf_coverage),
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.tertiary, RoundedCornerShape(8.dp))
            .padding(8.dp),
    )
    OutlinedTextField(
        form.matchTarget, { onType(form.copy(matchTarget = it)) },
        label = { Text(stringResource(R.string.vf_target)) },
        placeholder = { Text(stringResource(R.string.vf_hex_placeholder)) },
        singleLine = true,
        isError = issues.any { it.field == "match-target" },
        leadingIcon = { FilamentSwatch(form.matchTarget) },
        modifier = Modifier.fillMaxWidth(),
    )
    Field(stringResource(R.string.vf_minimum), form.matchMinimum, "match-minimum", issues) { onType(form.copy(matchMinimum = it)) }
    Text(stringResource(R.string.vf_ranked), fontWeight = FontWeight.Bold)
    val pending = dialog.search?.state == VirtualFilamentSearch.Pending
    if (pending) Text(stringResource(R.string.vf_searching), style = MaterialTheme.typography.bodySmall)
    val ranked = dialog.validation.ranking?.ranked.orEmpty()
    if (ranked.isEmpty() && !pending) {
        Text(
            stringResource(if (dialog.search?.state is VirtualFilamentSearch.Failed) R.string.vf_match_failed else R.string.vf_match_empty),
            style = MaterialTheme.typography.bodySmall,
        )
    }
    for (candidate in ranked) {
        val selected = form.matchSelected == candidate.candidateId
        val predicted = stringResource(R.string.vf_candidate_swatch, candidate.previewColor)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
                .selectable(selected, role = Role.RadioButton) { onType(form.copy(matchSelected = candidate.candidateId)) }
                .padding(7.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected, onClick = null)
            FilamentSwatch(candidate.previewColor, size = 34.dp, modifier = Modifier.semantics { contentDescription = predicted })
            Column(Modifier.weight(1f)) {
                Text(candidate.title, fontWeight = FontWeight.Bold)
                Text(candidate.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun GradientPanel(dialog: VirtualFilamentDialogs.Author, onType: (VirtualFilamentForm) -> Unit) {
    val form = dialog.form
    val issues = dialog.validation.issues
    for (index in 0 until 2) {
        HeadPicker(
            stringResource(R.string.vf_component, LETTERS[index]),
            dialog.library,
            form.gradientIds.getOrNull(index),
            issues.any { it.field == "gradient-component-$index" },
        ) { id -> onType(form.copy(gradientIds = form.gradientIds.toMutableList().also { it[index] = id })) }
    }
    Text(stringResource(R.string.vf_direction), fontWeight = FontWeight.Bold)
    Column {
        Choice(stringResource(R.string.vf_direction_a_to_b), form.gradientAToB) { onType(form.copy(gradientAToB = true)) }
        Choice(stringResource(R.string.vf_direction_b_to_a), !form.gradientAToB) { onType(form.copy(gradientAToB = false)) }
    }
    Field(stringResource(R.string.vf_sublayers), form.gradientSublayers, "gradient-sublayers", issues) { onType(form.copy(gradientSublayers = it)) }
    val preview = dialog.validation.gradientPreview
    val words = preview?.text ?: stringResource(R.string.vf_gradient_incomplete)
    val top = preview?.color?.let(Filaments::argb)?.let { Color(it) }
    val bottom = preview?.bottom?.let(Filaments::argb)?.let { Color(it) }
    Box(
        Modifier.fillMaxWidth().heightIn(min = 96.dp)
            .background(
                if (top != null && bottom != null) Brush.verticalGradient(listOf(top, bottom)) else Brush.verticalGradient(listOf(Color(0xff555555), Color(0xff555555))),
                RoundedCornerShape(9.dp),
            )
            .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(9.dp))
            .padding(9.dp)
            .semantics { contentDescription = words },
        contentAlignment = Alignment.Center,
    ) { Text(words, color = Color.White, style = MaterialTheme.typography.bodySmall) }
}

/**
 * The browser's delete dialog: "Delete <name>?", what the request does, the
 * recipe's canonical references (or that none were reported), and Cancel
 * and "Delete virtual filament" (not while the project changed since it
 * opened).
 */
@Composable
fun VirtualFilamentDeleteDialog(dialog: VirtualFilamentDialogs.Delete, revision: Any?, onConfirm: () -> Unit, onClose: () -> Unit) {
    val stale = VirtualFilamentDialogs.stale(dialog.revision, revision)
    AlertDialog(
        onDismissRequest = { if (!dialog.busy) onClose() },
        title = { Text(stringResource(R.string.vf_delete_title, dialog.row.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.vf_delete_description), style = MaterialTheme.typography.bodySmall)
                Column(
                    Modifier.fillMaxWidth()
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
                        .padding(12.dp),
                ) {
                    val labels = dialog.row.dependencyLabels
                    Text(
                        stringResource(if (labels.isNotEmpty()) R.string.vf_dependency_review else R.string.vf_no_dependencies),
                        fontWeight = FontWeight.Bold,
                    )
                    for (label in labels) Text("• $label", style = MaterialTheme.typography.bodySmall)
                }
                val error = dialog.error?.let { stringResource(R.string.vf_not_deleted, dialog.row.name, it) }
                    ?: if (stale) stringResource(R.string.vf_stale) else null
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            Button(onClick = onConfirm, enabled = !dialog.busy && !stale) { Text(stringResource(R.string.vf_delete_confirm)) }
        },
        dismissButton = { TextButton(onClick = onClose, enabled = !dialog.busy) { Text(stringResource(R.string.device_cancel)) } },
    )
}
