package dev.orcaxr.nativeapp.send

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import dev.orcaxr.core.ProjectIntents

/**
 * The browser's `PrintSubmissionDialog`: the printer and its state, the plate,
 * the file and its size, the filaments, the mapping problems (blocking) and
 * mismatches (warnings), the "Before printing" options — unavailable ones
 * disabled with the printer's reason — the exact-name choice, and "Upload and
 * start print", "Upload only" and "Cancel". Back, like the browser's Escape,
 * cancels; nothing is sent unless a button says so.
 */
@Composable
fun SendDialog(view: SendDialogView, onDecide: (ProjectIntents.PrintWorkflowDecision) -> Unit) {
    var overwrite by remember(view) { mutableStateOf(false) }
    var chosen by remember(view) { mutableStateOf(view.options.filter { it.checked }.map { it.id }.toSet()) }
    AlertDialog(
        onDismissRequest = { onDecide(view.decide(ProjectIntents.PrintWorkflowDecisionChoice.Cancel)) },
        title = { Text(view.title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((label, value) in view.facts(overwrite)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(label, Modifier.width(76.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                for (message in view.blockers) Notice(message, blocking = true)
                for (message in view.warnings) Notice(message, blocking = false)
                // The browser's disabled start button says why on hover; a touch screen shows it.
                view.startRefusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                view.optionsHeading?.let { heading ->
                    Text(heading, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    for (option in view.options) {
                        Choice(
                            checked = option.available && option.id in chosen,
                            enabled = option.available,
                            label = option.label,
                            detail = option.text,
                        ) { on -> chosen = if (on) chosen + option.id else chosen - option.id }
                    }
                }
                view.overwriteLabel?.let { label ->
                    Choice(checked = overwrite && view.overwriteAllowed, enabled = view.overwriteAllowed, label = label, detail = null) { overwrite = it }
                }
            }
        },
        // Each button a separate item, so a narrow window wraps them rather than squeezing them.
        confirmButton = {
            TextButton(
                onClick = { onDecide(view.decide(ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint, overwrite, chosen)) },
                enabled = view.startEnabled,
            ) { Text(view.startLabel) }
            view.uploadLabel?.let { label ->
                TextButton(onClick = { onDecide(view.decide(ProjectIntents.PrintWorkflowDecisionChoice.Upload, overwrite, chosen)) }) { Text(label) }
            }
        },
        dismissButton = {
            TextButton(onClick = { onDecide(view.decide(ProjectIntents.PrintWorkflowDecisionChoice.Cancel)) }) { Text(view.cancelLabel) }
        },
        // As the browser's overlay: only its buttons or Back (its Escape) answer it, never a stray touch beside it.
        properties = DialogProperties(dismissOnClickOutside = false),
    )
}

/** A blocking problem or a warning, as the browser's dialog tints them. */
@Composable
private fun Notice(message: String, blocking: Boolean) {
    val tone = if (blocking) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (blocking) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.tertiaryContainer,
        ),
        border = BorderStroke(1.dp, tone),
    ) {
        Text(message, Modifier.padding(10.dp), style = MaterialTheme.typography.bodyMedium)
    }
}

/** A labelled checkbox the whole row toggles, so its name is what accessibility services read. */
@Composable
private fun Choice(checked: Boolean, enabled: Boolean, label: String, detail: String?, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Column(Modifier.weight(1f).padding(top = 12.dp)) {
            val color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
            Text(label, style = MaterialTheme.typography.bodyMedium, color = color)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
