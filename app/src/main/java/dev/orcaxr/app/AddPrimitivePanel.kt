package dev.orcaxr.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * D12 — primitive-shape authoring panel.
 *
 * Mirrors the `add_primitive` MCP tool's surface 1:1 so the LLM-driven
 * path and the in-XR path stay equivalent: pick a [PrimitiveKind],
 * tweak its params, choose whether the result becomes a fresh
 * PlacedModel ("object" mode) or a sub-volume of an existing model
 * ("part" / "negative" / "modifier" / "enforcer" / "blocker"), then
 * tap Add.
 *
 * The mode → [ModelVolumeType] mapping is identical to
 * `PrimitiveTools.parseMode` — kept here as a private resolver so the
 * panel doesn't have to import the MCP package.
 */
object PrimitivePanelData {

    /** What the panel emits when the user taps Add. The host runs the
     *  same dispatch the MCP tool runs: build the STL via
     *  [SlicerEngine.buildPrimitiveStl] and emit either
     *  [dev.orcaxr.app.mcp.WorkspaceAction.LoadModelFromPath] or
     *  [dev.orcaxr.app.mcp.WorkspaceAction.AddVolumeToModel]. */
    data class AddRequest(
        val kind: PrimitiveKind,
        val params: FloatArray,
        val mode: Mode,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is AddRequest) return false
            if (kind != other.kind) return false
            if (mode != other.mode) return false
            if (!params.contentEquals(other.params)) return false
            return true
        }
        override fun hashCode(): Int {
            var r = kind.hashCode()
            r = 31 * r + mode.hashCode()
            r = 31 * r + params.contentHashCode()
            return r
        }
    }

    sealed interface Mode {
        data object AsObject : Mode
        data class AsVolume(val type: ModelVolumeType, val targetModelId: String) : Mode
    }

    /** Picker rows in the "Mode" filter chip strip. The MODEL_PART
     *  variant is folded under "Part" — same wire shape but the user-
     *  facing label is the friendlier word. */
    enum class ModeKind(
        val displayName: String,
        val volumeType: ModelVolumeType?,
        val description: String,
    ) {
        AsObject(
            displayName = "New object",
            volumeType = null,
            description = "Drop a fresh model on the bed.",
        ),
        Part(
            displayName = "Part",
            volumeType = ModelVolumeType.MODEL_PART,
            description = "Solid additive sub-volume on the selected model.",
        ),
        Negative(
            displayName = "Negative",
            volumeType = ModelVolumeType.NEGATIVE_VOLUME,
            description = "Boolean-subtracts geometry (e.g. a magnet pocket).",
        ),
        Modifier(
            displayName = "Modifier",
            volumeType = ModelVolumeType.PARAMETER_MODIFIER,
            description = "Apply per-region print settings (D16 overrides).",
        ),
        Enforcer(
            displayName = "Enforcer",
            volumeType = ModelVolumeType.SUPPORT_ENFORCER,
            description = "Force supports inside this region.",
        ),
        Blocker(
            displayName = "Blocker",
            volumeType = ModelVolumeType.SUPPORT_BLOCKER,
            description = "Block supports inside this region.",
        ),
    }

    /** Per-param slider range, picked to cover the realistic authoring
     *  envelope without spanning a useless decade. Stays inside the
     *  printable bed for a typical 256 mm cube without forcing the
     *  user to hand-type a value. */
    fun rangeFor(name: String): ClosedFloatingPointRange<Float> = when {
        name.contains("facet_angle") -> 1f..18f
        name.endsWith("radius_mm") -> 0.5f..120f
        name.contains("thickness") -> 0.1f..30f
        name.contains("height") -> 0.5f..200f
        name.endsWith("_mm") -> 0.5f..256f
        else -> 0.1f..200f
    }

    /** Steps for the slider — discretizes the range so the user gets
     *  predictable values without a numeric keyboard. */
    fun stepsFor(name: String): Int = when {
        name.contains("facet_angle") -> 16
        else -> 0
    }
}

@Composable
fun AddPrimitivePanel(
    /** Existing models on the bed — feeds the "Target" dropdown when
     *  the user picks a volume mode. Empty = the volume modes
     *  auto-disable. */
    placedModels: List<PlacedModel>,
    /** Selected model id (if any) — used as the default target when
     *  the user switches to a volume mode. Null = no preselect. */
    selectedModelId: String?,
    onAdd: (PrimitivePanelData.AddRequest) -> Unit,
    onClose: () -> Unit,
) {
    var kind by remember { mutableStateOf(PrimitiveKind.CUBE) }
    var modeKind by remember { mutableStateOf(PrimitivePanelData.ModeKind.AsObject) }
    var targetId by remember(selectedModelId) { mutableStateOf(selectedModelId) }

    // Per-kind param overrides. Reset to defaults whenever `kind`
    // changes so a slider value from CYLINDER doesn't bleed into
    // SPHERE's params. Stored as a list so Compose tracks edits per
    // index without rebuilding the whole map on every change.
    val paramValues = remember(kind) {
        androidx.compose.runtime.mutableStateListOf<Float>().also { list ->
            for (v in kind.defaults) list += v
        }
    }

    // Default the target to the first available model when the user
    // switches to a volume mode and nothing's preselected.
    val targetCandidates = placedModels
    if (modeKind != PrimitivePanelData.ModeKind.AsObject &&
        targetId == null && targetCandidates.isNotEmpty()
    ) {
        targetId = targetCandidates.first().id
    }

    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Add primitive",
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.White,
                    )
                    Text(
                        "Drop a stock cube / cylinder / sphere / cone / torus / disc / slab " +
                            "on the bed, or attach it as a sub-volume.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFB6BEC8),
                    )
                }
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleMedium)
                }
            }

            // Kind picker — chips so every option stays visible at a
            // glance instead of hiding behind a dropdown.
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        "Shape",
                        color = Color.White,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    androidx.compose.foundation.layout.FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        for (k in PrimitiveKind.values()) {
                            FilterChip(
                                selected = kind == k,
                                onClick = {
                                    if (kind != k) {
                                        kind = k
                                        // remember(kind) on paramValues
                                        // resets the list on next compose.
                                    }
                                },
                                label = { Text(k.displayName) },
                            )
                        }
                    }
                }
            }

            // Per-param sliders.
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        "Parameters",
                        color = Color.White,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    for ((i, name) in kind.paramNames.withIndex()) {
                        val current = paramValues.getOrNull(i) ?: kind.defaults[i]
                        val range = PrimitivePanelData.rangeFor(name)
                        val steps = PrimitivePanelData.stepsFor(name)
                        Spacer(Modifier.height(4.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                paramLabel(name),
                                color = Color.White,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                paramValueLabel(name, current),
                                color = Color(0xFF7BC8FF),
                            )
                        }
                        Slider(
                            value = current.coerceIn(range.start, range.endInclusive),
                            onValueChange = { v ->
                                if (i < paramValues.size) paramValues[i] = v
                            },
                            valueRange = range,
                            steps = steps,
                            colors = SliderDefaults.colors(
                                thumbColor = Color(0xFF7BC8FF),
                                activeTrackColor = Color(0xFF7BC8FF),
                                inactiveTrackColor = Color(0xFF44505C),
                            ),
                        )
                    }
                }
            }

            // Mode picker.
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        "Add as",
                        color = Color.White,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    androidx.compose.foundation.layout.FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        for (m in PrimitivePanelData.ModeKind.values()) {
                            val volumeAvailable =
                                m == PrimitivePanelData.ModeKind.AsObject ||
                                    placedModels.isNotEmpty()
                            FilterChip(
                                selected = modeKind == m,
                                onClick = { if (volumeAvailable) modeKind = m },
                                enabled = volumeAvailable,
                                label = { Text(m.displayName) },
                            )
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        modeKind.description,
                        color = Color(0xFFB6BEC8),
                        style = MaterialTheme.typography.bodySmall,
                    )

                    if (modeKind != PrimitivePanelData.ModeKind.AsObject) {
                        Spacer(Modifier.height(8.dp))
                        TargetDropdown(
                            placedModels = targetCandidates,
                            selectedId = targetId,
                            onSelect = { targetId = it },
                        )
                    }
                }
            }

            val canAdd = when (modeKind) {
                PrimitivePanelData.ModeKind.AsObject -> true
                else -> targetId != null && targetCandidates.any { it.id == targetId }
            }

            Button(
                enabled = canAdd,
                onClick = {
                    val params = FloatArray(kind.defaults.size) { idx ->
                        paramValues.getOrNull(idx) ?: kind.defaults[idx]
                    }
                    val resolvedMode = when (modeKind) {
                        PrimitivePanelData.ModeKind.AsObject ->
                            PrimitivePanelData.Mode.AsObject
                        else -> {
                            val vt = modeKind.volumeType ?: ModelVolumeType.MODEL_PART
                            val tid = targetId ?: return@Button
                            PrimitivePanelData.Mode.AsVolume(vt, tid)
                        }
                    }
                    onAdd(
                        PrimitivePanelData.AddRequest(
                            kind = kind,
                            params = params,
                            mode = resolvedMode,
                        ),
                    )
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF7BC8FF),
                    contentColor = Color.Black,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "Add ${kind.displayName.lowercase()}",
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

@Composable
private fun TargetDropdown(
    placedModels: List<PlacedModel>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = placedModels.firstOrNull { it.id == selectedId }?.label
        ?: "Select model"
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            "Target model",
            color = Color.White,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(4.dp))
        OutlinedButton(
            onClick = { expanded = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(selectedLabel, color = Color(0xFF7BC8FF))
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for (m in placedModels) {
                DropdownMenuItem(
                    text = { Text(m.label) },
                    onClick = {
                        onSelect(m.id)
                        expanded = false
                    },
                )
            }
        }
    }
}

internal fun paramLabel(name: String): String = when (name) {
    "x_mm" -> "Length (X)"
    "y_mm" -> "Width (Y)"
    "z_mm" -> "Height (Z)"
    "radius_mm" -> "Radius"
    "height_mm" -> "Height"
    "facet_angle_deg" -> "Facet angle"
    "major_radius_mm" -> "Major radius"
    "minor_radius_mm" -> "Minor radius"
    "thickness_mm" -> "Thickness"
    else -> name
}

internal fun paramValueLabel(name: String, value: Float): String = when {
    name.contains("facet_angle") -> "%.0f°".format(value)
    else -> "%.1f mm".format(value)
}
