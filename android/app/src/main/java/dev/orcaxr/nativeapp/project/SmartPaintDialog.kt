package dev.orcaxr.nativeapp.project

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.nativeapp.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * State for an ongoing Smart Paint dialog session.
 */
data class SmartPaintSessionState(
    val volumeId: String,
    val channel: PaintChannel = PaintChannel.COLOR,
    val includeImage: Boolean = false,
    val consentGeometry: Boolean = true,
    val consentImage: Boolean = true,
    val prompt: String = "",
    val referenceImageUri: Uri? = null,
    val proposalJson: String? = null,
    val projection: SmartPaintProjectionData? = null,
    val requesting: Boolean = false,
    val error: String? = null,
)

/**
 * Data structures for parsed Smart Paint projected regions.
 */
data class SmartPaintRegionData(
    val id: String,
    val label: String,
    val confidence: Double,
    val triangleIndices: List<Int>,
    val coverage: Double,
)

data class SmartPaintProjectionData(
    val volumeId: String,
    val topologyRevision: Long,
    val triangleCount: Int,
    val regions: List<SmartPaintRegionData>,
    val coverage: Double,
    val unassignedTriangleCount: Int,
    val confidence: Double,
)

private class SimpleJson(val src: String) {
    var pos = 0
    fun skipWs() { while (pos < src.length && src[pos].isWhitespace()) pos++ }
    fun parseValue(): Any? {
        skipWs()
        if (pos >= src.length) return null
        return when (src[pos]) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> parseString()
            't' -> { pos += 4; true }
            'f' -> { pos += 5; false }
            'n' -> { pos += 4; null }
            else -> parseNumber()
        }
    }
    fun parseObject(): Map<String, Any?> {
        pos++
        val map = mutableMapOf<String, Any?>()
        skipWs()
        if (pos < src.length && src[pos] == '}') { pos++; return map }
        while (pos < src.length) {
            val key = parseString()
            skipWs()
            if (pos < src.length && src[pos] == ':') pos++
            val v = parseValue()
            map[key] = v
            skipWs()
            if (pos < src.length && src[pos] == ',') { pos++; skipWs(); continue }
            if (pos < src.length && src[pos] == '}') { pos++; break }
        }
        return map
    }
    fun parseArray(): List<Any?> {
        pos++
        val list = mutableListOf<Any?>()
        skipWs()
        if (pos < src.length && src[pos] == ']') { pos++; return list }
        while (pos < src.length) {
            val v = parseValue()
            list.add(v)
            skipWs()
            if (pos < src.length && src[pos] == ',') { pos++; skipWs(); continue }
            if (pos < src.length && src[pos] == ']') { pos++; break }
        }
        return list
    }
    fun parseString(): String {
        skipWs()
        if (pos >= src.length || src[pos] != '"') return ""
        pos++
        val sb = StringBuilder()
        while (pos < src.length && src[pos] != '"') {
            if (src[pos] == '\\' && pos + 1 < src.length) {
                pos++
                when (src[pos]) {
                    '"' -> sb.append('"')
                    '\\' -> sb.append('\\')
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    else -> sb.append(src[pos])
                }
            } else {
                sb.append(src[pos])
            }
            pos++
        }
        if (pos < src.length && src[pos] == '"') pos++
        return sb.toString()
    }
    fun parseNumber(): Double {
        skipWs()
        val start = pos
        while (pos < src.length && (src[pos].isDigit() || src[pos] == '-' || src[pos] == '.' || src[pos] == 'e' || src[pos] == 'E' || src[pos] == '+')) pos++
        return src.substring(start, pos).toDoubleOrNull() ?: 0.0
    }
}

/**
 * Parses the canonical JSON returned by `smartPaintProject`.
 */
@Suppress("UNCHECKED_CAST")
fun parseSmartPaintProjection(jsonStr: String): SmartPaintProjectionData {
    val obj = (SimpleJson(jsonStr).parseValue() as? Map<String, Any?>) ?: emptyMap()
    val regionsArray = (obj["regions"] as? List<Map<String, Any?>>) ?: emptyList()
    val regions = regionsArray.map { r ->
        val triList = (r["triangleIndices"] as? List<*>) ?: emptyList<Any>()
        val tris = triList.mapNotNull { (it as? Number)?.toInt() }
        SmartPaintRegionData(
            id = (r["id"] as? String).orEmpty(),
            label = (r["label"] as? String).orEmpty(),
            confidence = (r["confidence"] as? Number)?.toDouble() ?: 1.0,
            triangleIndices = tris,
            coverage = (r["coverage"] as? Number)?.toDouble() ?: 0.0,
        )
    }
    return SmartPaintProjectionData(
        volumeId = (obj["volumeId"] as? String).orEmpty(),
        topologyRevision = (obj["topologyRevision"] as? Number)?.toLong() ?: 0L,
        triangleCount = (obj["triangleCount"] as? Number)?.toInt() ?: 0,
        regions = regions,
        coverage = (obj["coverage"] as? Number)?.toDouble() ?: 0.0,
        unassignedTriangleCount = (obj["unassignedTriangleCount"] as? Number)?.toInt() ?: 0,
        confidence = (obj["confidence"] as? Number)?.toDouble() ?: 1.0,
    )
}

/**
 * Smart Paint configuration, consent, proposal review and commit dialog.
 */
@Composable
fun SmartPaintDialog(
    session: SmartPaintSessionState,
    onDismiss: () -> Unit,
    onPropose: (prompt: String, imageUri: Uri?) -> Unit,
    onApply: (assignments: Map<String, String>) -> Unit,
) {
    var consentGeometry by remember { mutableStateOf(session.consentGeometry) }
    var consentImage by remember { mutableStateOf(session.consentImage) }
    var prompt by remember { mutableStateOf(session.prompt) }
    var selectedImageUri by remember { mutableStateOf<Uri?>(session.referenceImageUri) }

    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null) {
            selectedImageUri = uri
        }
    }

    // regionId -> filament ID (or state)
    var assignments by remember(session.projection) {
        val initial = mutableMapOf<String, String>()
        session.projection?.regions?.forEachIndexed { index, region ->
            // Default first region to first filament/state
            if (index == 0) {
                initial[region.id] = if (session.channel == PaintChannel.COLOR) "1" else "enforce"
            }
        }
        mutableStateOf<Map<String, String>>(initial)
    }

    val canPropose = consentGeometry &&
            (!session.includeImage || (consentImage && selectedImageUri != null)) &&
            prompt.isNotBlank() &&
            !session.requesting

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    if (session.includeImage) R.string.action_tool_smart_paint_image
                    else R.string.action_tool_smart_paint
                ),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Consent card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    ),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Column(
                        modifier = Modifier.padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            stringResource(R.string.smart_paint_what_may_be_sent),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                        )

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { consentGeometry = !consentGeometry },
                        ) {
                            Checkbox(
                                checked = consentGeometry,
                                onCheckedChange = { consentGeometry = it },
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                stringResource(R.string.smart_paint_consent_geometry),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }

                        if (session.includeImage) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { consentImage = !consentImage },
                            ) {
                                Checkbox(
                                    checked = consentImage,
                                    onCheckedChange = { consentImage = it },
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    stringResource(R.string.smart_paint_consent_image),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                OutlinedButton(
                                    onClick = { imagePicker.launch("image/*") },
                                ) {
                                    Text(stringResource(R.string.smart_paint_attach_image))
                                }
                                if (selectedImageUri != null) {
                                    Text(
                                        stringResource(R.string.smart_paint_image_attached),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                    }
                }

                // Prompt field
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = { Text(stringResource(R.string.smart_paint_describe_prompt)) },
                    placeholder = { Text(stringResource(R.string.smart_paint_example_prompt)) },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                    enabled = !session.requesting,
                )

                // Propose button
                Button(
                    onClick = { onPropose(prompt, selectedImageUri) },
                    enabled = canPropose,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.smart_paint_propose))
                }

                // Status or waiting
                if (session.requesting) {
                    Text(
                        stringResource(R.string.smart_paint_waiting),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }

                if (session.error != null) {
                    Text(
                        session.error,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                // Projected regions list
                val proj = session.projection
                if (proj != null && proj.regions.isNotEmpty()) {
                    Text(
                        stringResource(R.string.smart_paint_region_count, proj.regions.size),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )

                    LazyColumn(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(proj.regions) { region ->
                            RegionAssignmentCard(
                                region = region,
                                channel = session.channel,
                                currentAssignment = assignments[region.id],
                                onAssign = { dest ->
                                    assignments = if (dest != null) {
                                        assignments + (region.id to dest)
                                    } else {
                                        assignments - region.id
                                    }
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onApply(assignments) },
                enabled = session.projection != null && assignments.isNotEmpty() && !session.requesting,
            ) {
                Text(stringResource(R.string.smart_paint_apply))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.smart_paint_cancel))
            }
        },
    )
}

@Composable
private fun RegionAssignmentCard(
    region: SmartPaintRegionData,
    channel: PaintChannel,
    currentAssignment: String?,
    onAssign: (String?) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    val options = when (channel) {
        PaintChannel.COLOR -> (1..8).map { "$it" to "Filament $it" }
        PaintChannel.SUPPORT -> listOf("enforce" to "Enforce Support", "block" to "Block Support")
        PaintChannel.SEAM -> listOf("prefer" to "Prefer Seam", "avoid" to "Avoid Seam")
        PaintChannel.FUZZY_SKIN -> listOf("true" to "Fuzzy Skin")
    }

    val currentLabel = options.firstOrNull { it.first == currentAssignment }?.second
        ?: stringResource(R.string.smart_paint_leave_unpainted)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)
        ),
        shape = RoundedCornerShape(6.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    region.label,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    stringResource(R.string.smart_paint_coverage, region.coverage * 100.0) +
                            " • " + stringResource(R.string.smart_paint_confidence, region.confidence * 100.0),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Box {
                OutlinedButton(onClick = { expanded = true }) {
                    Text(currentLabel, style = MaterialTheme.typography.bodySmall)
                }

                DropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.smart_paint_leave_unpainted)) },
                        onClick = {
                            onAssign(null)
                            expanded = false
                        },
                    )
                    options.forEach { (value, label) ->
                        DropdownMenuItem(
                            text = { Text(label) },
                            onClick = {
                                onAssign(value)
                                expanded = false
                            },
                        )
                    }
                }
            }
        }
    }
}
