package dev.orcaxr.nativeapp.project

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.DeviceTextStore
import dev.orcaxr.core.ProjectCalibration
import dev.orcaxr.nativeapp.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * State for the viewport session banner when a calibration is active.
 */
data class CalibrationSessionState(
    val open: Boolean = true,
    val workflowId: String = "",
    val workflowLabel: String = "",
    val heldProjectName: String? = null,
    val sliced: Boolean = false,
    val sendUnavailableReason: String? = null,
)

/**
 * Banner shown across the workspace when a calibration session is open,
 * letting the operator know the main project is held aside and providing
 * slice, export, send, discard, and keep actions.
 */
@Composable
fun CalibrationSessionBanner(
    state: CalibrationSessionState,
    onSlice: () -> Unit,
    onExport: () -> Unit,
    onSend: () -> Unit,
    onDiscard: () -> Unit,
    onKeep: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val heldText = if (state.heldProjectName != null) {
                stringResource(R.string.calib_session_held_named, state.heldProjectName)
            } else {
                stringResource(R.string.calib_session_held_unnamed)
            }
            Text(
                text = stringResource(R.string.calib_session_banner_text, heldText),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(onClick = onSlice) {
                    Text(stringResource(R.string.calib_slice_btn))
                }
                OutlinedButton(
                    onClick = onExport,
                    enabled = state.sliced,
                ) {
                    Text(stringResource(R.string.calib_export_gcode_btn))
                }
                OutlinedButton(
                    onClick = onSend,
                    enabled = state.sliced && state.sendUnavailableReason == null,
                ) {
                    Text(stringResource(R.string.calib_send_printer_btn))
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onDiscard) {
                    Text(stringResource(R.string.calib_discard_btn))
                }
                TextButton(onClick = onKeep) {
                    Text(stringResource(R.string.calib_keep_btn))
                }
            }
        }
    }
}

/**
 * Dialog for configuring calibration parameters and previewing compiled plan warnings/summary.
 */
@Composable
fun CalibrationParametersDialog(
    workflowId: String,
    conditionsJson: String,
    onDismiss: () -> Unit,
    onGenerate: (workflowId: String, parameters: Map<String, String>) -> Unit,
    onExportLineProgram: ((workflowId: String, parameters: Map<String, String>) -> Unit)? = null,
) {
    val definitionsJson = remember { ProjectCalibration.definitions() }
    val definition = remember(definitionsJson, workflowId) {
        try {
            val root = JSONObject(definitionsJson)
            val defs = root.getJSONArray("definitions")
            var found: JSONObject? = null
            for (i in 0 until defs.length()) {
                val item = defs.getJSONObject(i)
                if (item.getString("id") == workflowId) {
                    found = item
                    break
                }
            }
            found
        } catch (_: Exception) {
            null
        }
    }

    val params = remember(definition) {
        val map = mutableStateMapOf<String, String>()
        definition?.optJSONObject("parameters")?.let { p ->
            for (key in p.keys()) {
                val field = p.getJSONObject(key)
                map[key] = field.optString("default", "")
            }
        }
        map
    }

    var previewSummary by remember { mutableStateOf<String?>(null) }
    var previewIssues by remember { mutableStateOf<List<String>>(emptyList()) }
    var isValid by remember { mutableStateOf(true) }

    fun recomputePreview() {
        try {
            val req = JSONObject()
            req.put("workflowId", workflowId)
            val paramObj = JSONObject()
            for ((k, v) in params) {
                paramObj.put(k, v)
            }
            req.put("parameters", paramObj)
            if (conditionsJson.isNotBlank()) {
                req.put("conditions", JSONObject(conditionsJson))
            }
            val replyJson = ProjectCalibration.form(req.toString())
            val reply = JSONObject(replyJson)
            val form = reply.optJSONObject("form")
            previewSummary = if (form?.has("plan_summary") == true) form.getString("plan_summary") else null
            val issuesArray = form?.optJSONArray("issues")
            val issueList = mutableListOf<String>()
            if (issuesArray != null) {
                for (i in 0 until issuesArray.length()) {
                    val issue = issuesArray.getJSONObject(i)
                    issueList.add(issue.optString("message", ""))
                }
            }
            previewIssues = issueList
        } catch (e: Exception) {
            previewIssues = listOf(e.message ?: "Preview computation error")
            isValid = false
        }
    }

    remember(params.toMap()) {
        recomputePreview()
        true
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(definition?.optString("label") ?: stringResource(R.string.calib_dialog_title))
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                definition?.optString("description")?.let { desc ->
                    Text(desc, style = MaterialTheme.typography.bodyMedium)
                }

                // Render parameters
                definition?.optJSONObject("parameters")?.let { p ->
                    for (key in p.keys()) {
                        val field = p.getJSONObject(key)
                        val label = field.optString("label", key)
                        val unit = field.optString("unit", "")
                        val labelWithUnit = if (unit.isNotBlank()) "$label ($unit)" else label
                        OutlinedTextField(
                            value = params[key] ?: "",
                            onValueChange = { params[key] = it },
                            label = { Text(labelWithUnit) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                if (!previewSummary.isNullOrBlank()) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    ) {
                        Text(
                            text = previewSummary ?: "",
                            modifier = Modifier.padding(10.dp),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }

                if (previewIssues.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (issue in previewIssues) {
                            Text(
                                text = "• $issue",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (workflowId == "pressure-advance-line" && onExportLineProgram != null) {
                    OutlinedButton(
                        onClick = { onExportLineProgram(workflowId, params.toMap()) },
                        enabled = isValid,
                    ) {
                        Text(stringResource(R.string.calib_export_line_btn))
                    }
                }
                Button(
                    onClick = { onGenerate(workflowId, params.toMap()) },
                    enabled = isValid,
                ) {
                    Text(stringResource(R.string.calib_generate_btn))
                }
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    definition?.optJSONObject("parameters")?.let { p ->
                        for (key in p.keys()) {
                            val field = p.getJSONObject(key)
                            params[key] = field.optString("default", "")
                        }
                    }
                }) {
                    Text(stringResource(R.string.calib_reset_btn))
                }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.settings_cancel))
                }
            }
        },
    )
}

/**
 * Dialog displaying calibration instructions and interpretation steps.
 */
@Composable
fun CalibrationInstructionsDialog(
    planJson: String,
    onDismiss: () -> Unit,
) {
    val instructionsText = remember(planJson) {
        try {
            val replyJson = ProjectCalibration.instructions(planJson)
            val reply = JSONObject(replyJson)
            reply.optString("instructions", "No instructions available.")
        } catch (e: Exception) {
            "Unable to generate instructions: ${e.message}"
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.calib_instructions_title)) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            ) {
                Text(instructionsText, style = MaterialTheme.typography.bodyMedium)
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) {
                Text(stringResource(R.string.device_confirm))
            }
        },
    )
}

/**
 * Calibration history ledger dialog showing recorded results, applicability,
 * and options to save to preset, compare, re-run, or delete records.
 */
@Composable
fun CalibrationHistoryDialog(
    historyStore: DeviceTextStore,
    conditionsJson: String,
    onDismiss: () -> Unit,
    onRecordResult: () -> Unit,
    onCompare: (leftJson: String, rightJson: String) -> Unit,
    onRerun: (recordJson: String) -> Unit,
    onApply: (recordJson: String) -> Unit,
) {
    var rawText by remember { mutableStateOf(historyStore.read() ?: "[]") }
    val records = remember(rawText) {
        try {
            val verified = ProjectCalibration.historyImport(rawText)
            val reply = JSONObject(verified)
            val arr = reply.optJSONArray("records") ?: JSONArray()
            val list = mutableListOf<JSONObject>()
            for (i in 0 until arr.length()) {
                list.add(arr.getJSONObject(i))
            }
            list
        } catch (_: Exception) {
            emptyList()
        }
    }

    val selectedRecords = remember { mutableStateMapOf<Int, Boolean>() }

    fun deleteRecord(index: Int) {
        try {
            val nextArr = JSONArray()
            for (i in records.indices) {
                if (i != index) nextArr.put(records[i])
            }
            val nextText = nextArr.toString()
            historyStore.write(nextText)
            rawText = nextText
            selectedRecords.clear()
        } catch (_: Exception) {}
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.calib_view_history))
                TextButton(onClick = { rawText = historyStore.read() ?: "[]" }) {
                    Text(stringResource(R.string.calib_history_refresh))
                }
            }
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (records.isEmpty()) {
                    Text(
                        stringResource(R.string.calib_history_no_results),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f, fill = false),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(records.size) { index ->
                            val record = records[index]
                            val isSelected = selectedRecords[index] == true
                            val assessment = remember(record, conditionsJson) {
                                try {
                                    val replyJson = ProjectCalibration.historyAssess(record.toString(), conditionsJson)
                                    JSONObject(replyJson)
                                } catch (_: Exception) {
                                    null
                                }
                            }
                            val applicable = assessment?.optBoolean("applicable", false) ?: false

                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { selectedRecords[index] = !isSelected },
                                colors = CardDefaults.cardColors(
                                    containerColor = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
                                ),
                            ) {
                                Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            record.optString("method_id", "Workflow"),
                                            style = MaterialTheme.typography.titleSmall,
                                            fontWeight = FontWeight.SemiBold,
                                        )
                                        Text(
                                            if (applicable) stringResource(R.string.calib_history_applicable) else stringResource(R.string.calib_history_not_applicable),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = if (applicable) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                                        )
                                    }
                                    record.optString("operator").takeIf { it.isNotBlank() }?.let { op ->
                                        Text(stringResource(R.string.calib_history_operator, op), style = MaterialTheme.typography.bodySmall)
                                    }
                                    record.optString("recorded_at").takeIf { it.isNotBlank() }?.let { time ->
                                        Text(stringResource(R.string.calib_history_measured, time), style = MaterialTheme.typography.bodySmall)
                                    }

                                    // Action buttons for this record
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.End,
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        TextButton(onClick = { onApply(record.toString()) }) {
                                            Text(stringResource(R.string.calib_history_apply_btn))
                                        }
                                        TextButton(onClick = { onRerun(record.toString()) }) {
                                            Text(stringResource(R.string.calib_history_rerun_btn))
                                        }
                                        TextButton(onClick = { deleteRecord(index) }) {
                                            Text(stringResource(R.string.calib_history_delete_btn))
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val selectedIndices = selectedRecords.filter { it.value }.keys.toList()
                if (selectedIndices.size == 2) {
                    Button(onClick = {
                        onCompare(records[selectedIndices[0]].toString(), records[selectedIndices[1]].toString())
                    }) {
                        Text(stringResource(R.string.calib_history_compare_btn))
                    }
                }
                Button(onClick = onRecordResult) {
                    Text(stringResource(R.string.calib_history_record_btn))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.about_close))
            }
        },
    )
}

/**
 * Dialog to record a new calibration result.
 */
@Composable
fun CalibrationRecordResultDialog(
    onDismiss: () -> Unit,
    onSave: (methodId: String, operator: String, values: Map<String, String>) -> Unit,
) {
    var methodId by remember { mutableStateOf("flow-pass-1") }
    var operatorName by remember { mutableStateOf("") }
    val resultValues = remember { mutableStateMapOf<String, String>() }

    val methods = listOf(
        "flow-pass-1" to R.string.calib_flow_pass1,
        "flow-pass-2" to R.string.calib_flow_pass2,
        "flow-yolo" to R.string.calib_flow_yolo,
        "pressure-advance-tower" to R.string.calib_pressure_advance,
        "temperature-tower" to R.string.calib_temperature,
        "retraction-tower" to R.string.calib_retraction,
        "max-flowrate" to R.string.calib_max_flow,
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.calib_record_result)) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = operatorName,
                    onValueChange = { operatorName = it },
                    label = { Text("Operator Name") },
                    modifier = Modifier.fillMaxWidth(),
                )

                Text("Workflow", style = MaterialTheme.typography.labelMedium)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for ((id, resId) in methods) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { methodId = id }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = methodId == id, onCheckedChange = { methodId = id })
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(resId), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }

                OutlinedTextField(
                    value = resultValues["measured_value"] ?: "",
                    onValueChange = { resultValues["measured_value"] = it },
                    label = { Text("Measured Value / Modifier") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onSave(methodId, operatorName, resultValues.toMap())
                },
                enabled = operatorName.isNotBlank() && resultValues.isNotEmpty(),
            ) {
                Text(stringResource(R.string.calib_history_record_btn))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.settings_cancel))
            }
        },
    )
}

/**
 * Dialog comparing two calibration records side by side.
 */
@Composable
fun CalibrationCompareDialog(
    leftJson: String,
    rightJson: String,
    onDismiss: () -> Unit,
) {
    val comparison = remember(leftJson, rightJson) {
        try {
            val replyJson = ProjectCalibration.historyCompare(leftJson, rightJson)
            JSONObject(replyJson)
        } catch (e: Exception) {
            JSONObject().put("error", e.message)
        }
    }

    val sameValues = comparison.optBoolean("same_values", false)
    val caveats = comparison.optJSONArray("caveats") ?: JSONArray()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.calib_compare_results)) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (sameValues) {
                    Text(
                        stringResource(R.string.calib_history_both_same),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }

                if (caveats.length() > 0) {
                    Text("Comparison Notes:", style = MaterialTheme.typography.labelLarge)
                    for (i in 0 until caveats.length()) {
                        Text("• ${caveats.getString(i)}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) {
                Text(stringResource(R.string.device_confirm))
            }
        },
    )
}
