package dev.orcaxr.nativeapp.project

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.LayerRangeCheck
import dev.orcaxr.core.LayerRangeEditors
import dev.orcaxr.core.LayerRangeEntry
import dev.orcaxr.core.LayerRangeMerge
import dev.orcaxr.core.SettingsPanelControl
import dev.orcaxr.core.SettingsPanelMode
import dev.orcaxr.core.SettingsPanelRow
import dev.orcaxr.nativeapp.R

/** The width from which a setting's name and control share a line, as the browser's sidebar grid does. */
const val SETTINGS_SIDE_BY_SIDE_DP = 300

/**
 * The inspector's open panel under the tree — a node's settings or an
 * object's height ranges — as lazy items, so a long list of settings scrolls
 * with the area. [wide] puts a setting's name beside its control.
 */
fun LazyListScope.inspectorPanel(inspector: InspectorModel, wide: Boolean) {
    when (inspector.panel) {
        is InspectorPanel.Settings -> inspector.settingsShell?.let { settingsItems(it, inspector, wide) }
        is InspectorPanel.HeightRanges -> inspector.rangesShell?.let { rangesItems(it, inspector) }
        null -> Unit
    }
}

// ---- The scoped settings panel (ScopedSettingsPanel + GeneratedSettingsPanel) ----

private fun LazyListScope.settingsItems(shell: SettingsShell, inspector: InspectorModel, wide: Boolean) {
    item(key = "settings:head") { SettingsHead(shell, inspector) }
    val view = shell.view
    if (view != null && view.shown == 0) {
        item(key = "settings:none") {
            Text(stringResource(R.string.settings_no_match), Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
        }
    }
    view?.sections?.forEach { section ->
        item(key = "settings:section:" + section.id) {
            Column(Modifier.padding(top = 8.dp)) {
                Text(section.label, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                HorizontalDivider(Modifier.padding(top = 4.dp))
            }
        }
        for (row in section.rows) {
            item(key = "settings:row:" + row.fieldId) {
                SettingsRow(row, shell.interactive, wide, inspector)
            }
        }
    }
    item(key = "settings:foot") { SettingsFoot(shell, inspector) }
}

/** The panel's head: its node, the picker of every node, what the scope does, the conflict, the detail level and the search. */
@Composable
private fun SettingsHead(shell: SettingsShell, inspector: InspectorModel) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(shell.target?.heading.orEmpty(), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = inspector::dismiss) { Text(stringResource(R.string.inspector_close)) }
        }
        Text(stringResource(R.string.settings_for), style = MaterialTheme.typography.labelMedium)
        TargetPicker(shell, inspector)
        shell.target?.let { Text(it.summary, style = MaterialTheme.typography.bodySmall) }
        if (shell.loading || shell.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        shell.error?.let { error ->
            Text(
                stringResource(errorPrefix(error.kind), error.message),
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
            )
        }
        if (shell.conflict) {
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive },
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.settings_conflict))
                    OutlinedButton(onClick = inspector::discardAndReload, enabled = !shell.loading && !shell.busy) {
                        Text(stringResource(R.string.settings_discard_reload))
                    }
                }
            }
        }
        Text(stringResource(R.string.settings_detail_level), style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (mode in SettingsPanelMode.entries) {
                val label = stringResource(modeLabel(mode))
                Row(
                    Modifier.selectable(selected = shell.mode == mode, enabled = shell.interactive, role = Role.RadioButton) { inspector.chooseMode(mode) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = shell.mode == mode, onClick = null, enabled = shell.interactive)
                    Text(label, Modifier.padding(end = 8.dp))
                }
            }
        }
        var search by remember(shell.targetId) { mutableStateOf(shell.search) }
        val searchLabel = stringResource(R.string.settings_search)
        OutlinedTextField(
            value = search,
            onValueChange = {
                search = it
                inspector.search(it)
            },
            label = { Text(searchLabel) },
            placeholder = { Text(stringResource(R.string.settings_search_hint)) },
            singleLine = true,
            enabled = shell.interactive,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = searchLabel },
        )
        shell.view?.let { Text(it.summary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
    }
}

/** "Settings for": every node of the project, as the browser's picker lists them. */
@Composable
private fun TargetPicker(shell: SettingsShell, inspector: InspectorModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = shell.targets.isNotEmpty() && !shell.busy, modifier = Modifier.fillMaxWidth()) {
            Text(shell.target?.text ?: shell.targetId, Modifier.weight(1f))
            Text("▾")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (target in shell.targets) {
                DropdownMenuItem(
                    text = { Text(target.text) },
                    onClick = {
                        open = false
                        inspector.chooseTarget(target.id)
                    },
                    modifier = Modifier.semantics { selected = target.id == shell.targetId },
                )
            }
        }
    }
}

/** The panel's foot: what the last operation said, then Cancel and Apply. */
@Composable
private fun SettingsFoot(shell: SettingsShell, inspector: InspectorModel) {
    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        shell.note?.let { Text(noteText(it), style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            OutlinedButton(onClick = inspector::cancel, enabled = shell.canCancel) { Text(stringResource(R.string.settings_cancel)) }
            Button(onClick = inspector::apply, enabled = shell.canApply) { Text(stringResource(R.string.settings_apply)) }
        }
    }
}

private fun modeLabel(mode: SettingsPanelMode) = when (mode) {
    SettingsPanelMode.SIMPLE -> R.string.settings_mode_simple
    SettingsPanelMode.ADVANCED -> R.string.settings_mode_advanced
    SettingsPanelMode.DEVELOP -> R.string.settings_mode_develop
}

private fun errorPrefix(kind: SettingsErrorKind) = when (kind) {
    SettingsErrorKind.FixHighlighted -> R.string.settings_error_fix
    SettingsErrorKind.NotValidated -> R.string.settings_error_validate
    SettingsErrorKind.NotApplied -> R.string.settings_error_not_applied
    SettingsErrorKind.DefaultResetFailed -> R.string.settings_error_default
    SettingsErrorKind.LoadFailed -> R.string.settings_error_load
}

@Composable
private fun noteText(note: SettingsNote): String = when (note) {
    SettingsNote.DraftPending -> stringResource(R.string.settings_draft_pending)
    is SettingsNote.Applying -> stringResource(if (note.changes == 1) R.string.settings_applying_one else R.string.settings_applying_other, note.changes.toString())
    is SettingsNote.Applied -> stringResource(if (note.changes == 1) R.string.settings_applied_one else R.string.settings_applied_other, note.changes.toString())
    SettingsNote.NothingToApply -> stringResource(R.string.settings_nothing_to_apply)
    SettingsNote.Cancelled -> stringResource(R.string.settings_cancelled)
    SettingsNote.ConflictKept -> stringResource(R.string.settings_conflict_kept)
    SettingsNote.Refreshed -> stringResource(R.string.settings_refreshed)
    SettingsNote.Reloaded -> stringResource(R.string.settings_reloaded)
    SettingsNote.KeptForReview -> stringResource(R.string.settings_kept_for_review)
}

/**
 * One setting as the browser's generated panel draws it: its name and key,
 * its control holding the value (the inherited or default one until the node
 * holds its own) with its unit, its badges, "Use inherited" and "Use
 * default", why it is unavailable or structured, and its issues.
 */
@Composable
private fun SettingsRow(row: SettingsPanelRow, interactive: Boolean, wide: Boolean, inspector: InspectorModel) {
    val enabled = interactive && row.draftable
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val name: @Composable (Modifier) -> Unit = { modifier ->
            Column(modifier.semantics(mergeDescendants = true) { row.tooltip?.let { contentDescription = "${row.label}. $it" } }) {
                Text(row.label, style = MaterialTheme.typography.bodyMedium)
                Text(row.key, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        val control: @Composable (Modifier) -> Unit = { modifier ->
            Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SettingControl(row, enabled, Modifier.weight(1f), inspector)
                row.unit?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        if (wide) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                name(Modifier.weight(1f))
                control(Modifier.weight(1f))
            }
        } else {
            name(Modifier)
            control(Modifier.fillMaxWidth())
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            Badge(row.originLabel)
            if (row.draftChanged) Badge(stringResource(R.string.settings_draft_changed))
            when (row.availability) {
                "structured-editor" -> Badge(stringResource(R.string.settings_structured_editor))
                "unavailable" -> Badge(stringResource(R.string.settings_unavailable))
            }
            if (row.dependencyController != null) Badge(stringResource(R.string.settings_not_applicable))
            if (row.inherit) {
                TextButton(onClick = { inspector.useInherited(row.fieldId) }, enabled = interactive && row.dependencyEnabled) {
                    Text(stringResource(R.string.settings_use_inherited))
                }
            }
            if (row.useDefault) {
                TextButton(onClick = { inspector.useDefault(row.fieldId) }, enabled = interactive && row.dependencyEnabled) {
                    Text(stringResource(R.string.settings_use_default))
                }
            }
        }
        row.unavailableMessage?.let { Text(it, color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall) }
        if (row.structuredEditor != null) Text(stringResource(R.string.settings_structured_note), color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodySmall)
        if (row.dependencyController != null) Text(stringResource(R.string.settings_dependency_note), style = MaterialTheme.typography.bodySmall)
        for (issue in row.issues) Text(issue.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Badge(text: String) {
    Surface(shape = MaterialTheme.shapes.extraLarge, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Text(text, Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * The control of one setting: a check box for a switch, a list for a
 * choice (with "Not set" for a nullable one), a text area or a field for the
 * rest (numbers with the browser's numeric or decimal keyboard), disabled text
 * for one the panel cannot edit, and the structured editor's note for the
 * Full Spectrum recipes. A field keeps what is typed while it holds the focus;
 * each change drafts it, as the browser's `input` event does.
 */
@Composable
private fun SettingControl(row: SettingsPanelRow, enabled: Boolean, modifier: Modifier, inspector: InspectorModel) {
    when (val control = row.control) {
        is SettingsPanelControl.Structured -> Text(control.value, modifier, style = MaterialTheme.typography.bodySmall)
        is SettingsPanelControl.Checkbox -> Box(modifier) {
            Checkbox(
                checked = control.checked,
                onCheckedChange = { inspector.draft(row.fieldId, if (it) "1" else "0") },
                enabled = enabled,
                modifier = Modifier.semantics { contentDescription = row.label },
            )
        }
        is SettingsPanelControl.Select -> {
            var open by remember { mutableStateOf(false) }
            val notSet = stringResource(R.string.settings_not_set)
            val shown = when (control.value) {
                control.nil -> notSet
                else -> control.choices.firstOrNull { it.value == control.value }?.label ?: control.value
            }
            Box(modifier) {
                OutlinedButton(
                    onClick = { open = true },
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "${row.label}: $shown" },
                ) {
                    Text(shown, Modifier.weight(1f))
                    Text("▾")
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    control.nil?.let { nil ->
                        DropdownMenuItem(text = { Text(notSet) }, onClick = {
                            open = false
                            inspector.draft(row.fieldId, nil)
                        })
                    }
                    for (choice in control.choices) {
                        DropdownMenuItem(
                            text = { Text(choice.label) },
                            onClick = {
                                open = false
                                inspector.draft(row.fieldId, choice.value)
                            },
                            modifier = Modifier.semantics { selected = choice.value == control.value },
                        )
                    }
                }
            }
        }
        is SettingsPanelControl.Locked -> OutlinedTextField(
            value = control.value,
            onValueChange = {},
            enabled = false,
            singleLine = true,
            modifier = modifier.semantics { contentDescription = row.label },
        )
        is SettingsPanelControl.Textarea -> TypedField(row, control.value, enabled, modifier, KeyboardType.Text, inspector, lines = control.rows)
        is SettingsPanelControl.Text -> TypedField(
            row, control.value, enabled, modifier,
            when (control.inputMode) {
                "numeric" -> KeyboardType.Number
                "decimal" -> KeyboardType.Decimal
                else -> KeyboardType.Text
            },
            inspector,
        )
    }
}

/** A typed setting: what is typed stays while the field holds the focus; elsewhere it follows the core's value. */
@Composable
private fun TypedField(row: SettingsPanelRow, value: String, enabled: Boolean, modifier: Modifier, keyboard: KeyboardType, inspector: InspectorModel, lines: Int = 1) {
    var typed by remember(row.fieldId) { mutableStateOf(value) }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(value) { if (!focused) typed = value }
    val focus = LocalFocusManager.current
    OutlinedTextField(
        value = typed,
        onValueChange = { next ->
            typed = next
            inspector.draft(row.fieldId, next)
        },
        enabled = enabled,
        singleLine = lines == 1,
        minLines = lines,
        isError = row.issues.isNotEmpty(),
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = if (lines == 1) ImeAction.Done else ImeAction.Default),
        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
        modifier = modifier
            .onFocusChanged {
                focused = it.isFocused
                if (!it.isFocused) typed = value
            }
            .semantics { contentDescription = row.label },
    )
}

// ---- The semantic editor's height ranges (SemanticObjectEditor) ----

private fun LazyListScope.rangesItems(shell: RangesShell, inspector: InspectorModel) {
    item(key = "ranges:head") { RangesHead(shell, inspector) }
    val projection = shell.projection ?: return
    if (projection.ranges.isEmpty()) {
        item(key = "ranges:none") { Text(stringResource(R.string.ranges_none), style = MaterialTheme.typography.bodySmall) }
    }
    for (range in projection.ranges) {
        item(key = "ranges:range:" + range.id) {
            val chosen = range.id == projection.selected?.id
            Text(
                range.label,
                Modifier.fillMaxWidth()
                    .selectable(selected = chosen, enabled = !shell.pending) { inspector.selectRange(range.id) }
                    .padding(vertical = 8.dp),
                style = if (chosen) MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.primary) else MaterialTheme.typography.bodyLarge,
            )
        }
    }
    item(key = "ranges:add") { AddRange(shell, inspector) }
    val selected = projection.selectedRange
    val selection = projection.selected
    if (selected == null || selection == null) {
        item(key = "ranges:hint") { Text(stringResource(R.string.ranges_select_hint), style = MaterialTheme.typography.bodySmall) }
        return
    }
    item(key = "ranges:selected:" + selected.id) { SelectedRange(shell, selected, selection.mergePrevious, selection.mergeNext, inspector) }
}

@Composable
private fun RangesHead(shell: RangesShell, inspector: InspectorModel) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.ranges_heading), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = inspector::dismiss) { Text(stringResource(R.string.inspector_close)) }
        }
        shell.projection?.let { Text(it.objectName, style = MaterialTheme.typography.bodySmall) }
        if (shell.pending) LinearProgressIndicator(Modifier.fillMaxWidth())
        val status = shell.status
        Text(
            when (status) {
                RangeStatus.Idle -> stringResource(R.string.ranges_idle)
                is RangeStatus.Pending -> status.text
                is RangeStatus.Done -> status.text
                is RangeStatus.Rejected -> stringResource(R.string.ranges_rejected, status.reason)
            },
            color = if (status is RangeStatus.Rejected) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.semantics { liveRegion = if (status is RangeStatus.Rejected) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        )
    }
}

/** A Z field of a range form, in millimetres. */
@Composable
private fun HeightField(value: String, label: String, enabled: Boolean, invalid: Boolean, modifier: Modifier = Modifier, onValue: (String) -> Unit) {
    val focus = LocalFocusManager.current
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        isError = invalid,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
        modifier = modifier.fillMaxWidth().semantics { contentDescription = label },
    )
}

/** A form of one or two Z fields, its check's words and its button. */
@Composable
private fun RangeFormCard(content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(vertical = 4.dp), colors = CardDefaults.outlinedCardColors(), border = CardDefaults.outlinedCardBorder()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
    }
}

/** "Add range": its bounds checked against the object's ranges before anything is sent. */
@Composable
private fun AddRange(shell: RangesShell, inspector: InspectorModel) {
    val ranges = shell.projection?.ranges.orEmpty()
    val form = shell.add
    val check = remember(form, ranges) { LayerRangeEditors.bounds(form.first, form.second, ranges) }
    val message = RangeForms.boundsMessage(check, form, editing = false)
    val minLabel = stringResource(R.string.ranges_min)
    val maxLabel = stringResource(R.string.ranges_max)
    RangeFormCard {
        Text(stringResource(R.string.ranges_add), style = MaterialTheme.typography.titleSmall)
        HeightField(form.first, minLabel, !shell.pending, form.touched && check is LayerRangeCheck.Invalid) { inspector.typeAdd(form.copy(first = it)) }
        HeightField(form.second, maxLabel, !shell.pending, form.touched && check is LayerRangeCheck.Invalid) { inspector.typeAdd(form.copy(second = it)) }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Button(
            onClick = { (check as? LayerRangeCheck.Valid)?.values?.let { inspector.addRange(it[0], it[1]) } },
            enabled = !shell.pending && check is LayerRangeCheck.Valid,
        ) { Text(stringResource(R.string.ranges_add)) }
    }
}

/** The selected range: its settings, its bounds, a split, the merges the command allows, and Delete. */
@Composable
private fun SelectedRange(shell: RangesShell, selected: LayerRangeEntry, previous: LayerRangeMerge, next: LayerRangeMerge, inspector: InspectorModel) {
    val ranges = shell.projection?.ranges.orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.ranges_selected, selected.label), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            TextButton(onClick = { inspector.open(InspectorPanel.Settings("layerRange:" + selected.id)) }, enabled = !shell.pending) {
                Text(stringResource(R.string.ranges_settings))
            }
        }
        // Edit boundaries.
        val edit = shell.edit
        val editCheck = remember(edit, ranges, selected.id) { LayerRangeEditors.bounds(edit.first, edit.second, ranges, selected.id) }
        val editMessage = RangeForms.boundsMessage(editCheck, edit, editing = true)
        RangeFormCard {
            Text(stringResource(R.string.ranges_edit_heading), style = MaterialTheme.typography.titleSmall)
            val invalid = edit.touched && editCheck is LayerRangeCheck.Invalid
            HeightField(edit.first, stringResource(R.string.ranges_min), !shell.pending, invalid) { inspector.typeEdit(edit.copy(first = it)) }
            HeightField(edit.second, stringResource(R.string.ranges_max), !shell.pending, invalid) { inspector.typeEdit(edit.copy(second = it)) }
            editMessage?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(
                onClick = {
                    (editCheck as? LayerRangeCheck.Valid)?.values?.let { inspector.editRange(selected.id, selected.minZMm, selected.maxZMm, it[0], it[1]) }
                },
                enabled = !shell.pending && editCheck is LayerRangeCheck.Valid,
            ) { Text(stringResource(R.string.ranges_apply_bounds)) }
        }
        // Split range.
        val split = shell.split
        val splitCheck = remember(split, selected) { LayerRangeEditors.split(split.first, selected) }
        val splitMessage = RangeForms.splitMessage(splitCheck, split)
        RangeFormCard {
            Text(stringResource(R.string.ranges_split), style = MaterialTheme.typography.titleSmall)
            HeightField(split.first, stringResource(R.string.ranges_split_at), !shell.pending, split.touched && splitCheck is LayerRangeCheck.Invalid) {
                inspector.typeSplit(split.copy(first = it))
            }
            splitMessage?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Button(
                onClick = { (splitCheck as? LayerRangeCheck.Valid)?.values?.let { inspector.splitRange(selected.id, it[0]) } },
                enabled = !shell.pending && splitCheck is LayerRangeCheck.Valid,
            ) { Text(stringResource(R.string.ranges_split_button)) }
        }
        // Merge range.
        RangeFormCard {
            Text(stringResource(R.string.ranges_merge), style = MaterialTheme.typography.titleSmall)
            for ((decision, previousSide) in listOf(previous to true, next to false)) {
                val (other, reason) = RangeForms.merge(decision)
                OutlinedButton(
                    onClick = { other?.let { inspector.mergeRange(selected.id, it, previousSide) } },
                    enabled = !shell.pending && other != null,
                ) { Text(stringResource(if (previousSide) R.string.ranges_merge_previous else R.string.ranges_merge_next)) }
                reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        OutlinedButton(
            onClick = { inspector.deleteRange(selected.id) },
            enabled = !shell.pending,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
        ) { Text(stringResource(R.string.ranges_delete), color = MaterialTheme.colorScheme.error) }
    }
}

/** Whether the inspector's panel lays a setting's name beside its control in a column [widthDp] wide. */
fun settingsSideBySide(widthDp: Int): Boolean = widthDp >= SETTINGS_SIDE_BY_SIDE_DP
