package dev.orcaxr.nativeapp.project

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.JsText
import dev.orcaxr.core.ModelToolStatus
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.SimplifyConfiguration
import dev.orcaxr.core.SplitConfirmation
import dev.orcaxr.core.SplitStrategy
import dev.orcaxr.nativeapp.R
import java.text.NumberFormat

/**
 * The browser's Simplify panel (web/src/ui/dom/SimplifyPanel.ts), in the
 * Project area's tools under the inspector, opened from its heading as the
 * browser's Tools card opens its Simplify section: decimate by triangle
 * count (remove a share) or by shape error (a quadric limit), Preview —
 * drawn in the Workspace, nothing installed —, then Apply, which installs
 * exactly what the preview shows, or Cancel. The choices lock while a
 * preview is shown, and the inactive mode's field is disabled rather than
 * hidden, as the browser's are.
 */
@Composable
fun SimplifyPanel(view: ProjectView, model: ProjectModel) {
    var open by rememberSaveable { mutableStateOf(false) }
    val title = stringResource(R.string.simplify_title)
    Column {
        Row(
            Modifier.fillMaxWidth().clickable(onClickLabel = title) { open = !open }.semantics { heading() }.padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Text(if (open) "▾" else "▸")
        }
        if (open) SimplifyControls(view, model)
    }
}

/** The Simplify panel's controls and status, while it is open. */
@Composable
private fun SimplifyControls(view: ProjectView, model: ProjectModel) {
    val preview = model.simplifyPreview
    val previewing = preview != null
    val requested = model.simplifyRequested
    // Held here while the operator edits, as the browser's panel holds its typed values; a new request resets them.
    var useCount by remember(requested) { mutableStateOf(requested.useCount) }
    var ratio by remember(requested) { mutableStateOf(JsText.number(requested.decimateRatio)) }
    var error by remember(requested) { mutableStateOf(JsText.number(requested.maxError)) }
    val selected = ProjectEditing.enabled(view, "simplify_preview")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.simplify_decimate_by), style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            for ((byCount, label) in listOf(true to R.string.simplify_by_count, false to R.string.simplify_by_error)) {
                Row(
                    Modifier.selectable(selected = useCount == byCount, enabled = !previewing, role = Role.RadioButton) { useCount = byCount },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = useCount == byCount, onClick = null, enabled = !previewing)
                    Text(stringResource(label))
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((value, label, enabled, set) in listOf(
                Field(ratio, R.string.simplify_remove, !previewing && useCount) { ratio = it },
                Field(error, R.string.simplify_max_error, !previewing && !useCount) { error = it },
            )) {
                val description = stringResource(label)
                OutlinedTextField(
                    value = value,
                    onValueChange = set,
                    label = { Text(description) },
                    singleLine = true,
                    enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.weight(1f).semantics { contentDescription = description },
                )
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    model.previewSimplify(
                        SimplifyConfiguration(
                            useCount,
                            SimplifyFields.value(ratio) ?: requested.decimateRatio,
                            SimplifyFields.value(error) ?: requested.maxError,
                        ),
                    )
                },
                enabled = selected && !previewing && !model.busy,
            ) { Text(stringResource(R.string.simplify_preview)) }
            OutlinedButton(onClick = model::applySimplify, enabled = previewing && !model.busy) { Text(stringResource(R.string.simplify_apply)) }
            OutlinedButton(onClick = model::cancelSimplify, enabled = previewing && !model.busy) { Text(stringResource(R.string.device_cancel)) }
        }
        Text(
            when {
                !selected && !previewing -> stringResource(R.string.simplify_select_model)
                preview == null -> stringResource(R.string.simplify_preview_hint)
                else -> ModelToolStatus.previewing(preview.parts.size, preview.beforeTriangles, preview.afterTriangles, preview.stoppedOnError)
            },
            Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private data class Field(val value: String, val label: Int, val enabled: Boolean, val set: (String) -> Unit)

/**
 * The browser's confirmation before Split to Objects (main.ts's
 * `onRequestSplitToObjectsConfirmation`): the object, how it splits — its
 * existing volumes promoted, or its triangles separated by connected body —
 * across all of its instances, replaced in one undoable edit. OK splits;
 * Cancel leaves the project as it is.
 */
@Composable
fun SplitDialog(confirmation: SplitConfirmation, model: ProjectModel) {
    val locale = LocalConfiguration.current.locales[0]
    val triangles = remember(confirmation, locale) { NumberFormat.getIntegerInstance(locale).format(confirmation.triangleCount) }
    AlertDialog(
        onDismissRequest = { model.answerSplit(false) },
        title = { Text(ModelToolStatus.splitQuestion(confirmation.objectName)) },
        text = {
            Text(
                ModelToolStatus.splitDetail(
                    confirmation.strategy == SplitStrategy.EXISTING_VOLUMES, confirmation.volumeCount, triangles,
                    confirmation.affectedInstanceIds.size,
                ),
                Modifier.verticalScroll(rememberScrollState()),
            )
        },
        confirmButton = { TextButton(onClick = { model.answerSplit(true) }) { Text(stringResource(android.R.string.ok)) } },
        dismissButton = { TextButton(onClick = { model.answerSplit(false) }) { Text(stringResource(R.string.device_cancel)) } },
    )
}

/**
 * The Simplify panel's number fields as the browser's `<input type=number>`
 * hands their values over (`Number(input.value)` on `change`): a valid
 * floating-point number is its value, anything the input would sanitize to
 * nothing is 0, and a value that is not finite leaves the setting as it was.
 */
object SimplifyFields {
    private val NUMBER = Regex("-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?")

    /** The setting [text] gives, or null to keep the one before. */
    fun value(text: String): Double? {
        if (!NUMBER.matches(text)) return 0.0
        return text.toDouble().takeIf { it.isFinite() }
    }
}
