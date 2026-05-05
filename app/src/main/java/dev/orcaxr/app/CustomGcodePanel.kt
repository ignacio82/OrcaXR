package dev.orcaxr.app

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/**
 * A11 — author per-print-Z custom G-code ticks for the active plate.
 *
 * The MCP surface (`add_custom_gcode_tick`, `list_custom_gcode_ticks`,
 * `remove_custom_gcode_tick`, `clear_custom_gcode_ticks`) is the
 * canonical authoring path; this panel mirrors the same operations for
 * direct in-XR use. All four kinds libslic3r recognises are surfaced
 * (`CustomGCode.hpp:32-46`):
 *
 * - **Pause** — emits the printer profile's `pause_print_gcode` block
 *   (the magnet-insert workflow that motivated A11). [extra] is a short
 *   message shown to the operator at pause time.
 * - **Color change** — emits `M600` plus the new hex color so the LCD
 *   can preview the swap. [color] is `#RRGGBB`.
 * - **Tool change** — forces a `Tn` at this Z. [extruder] is 1-based.
 * - **Template** — pastes [extra] verbatim into the layer-change hook.
 *
 * Sort order is by ascending Z so the list mirrors the print sequence.
 */
object CustomGcodeAuthoring {

    /** Kinds the panel surfaces. Maps 1:1 onto [SlicerEngine.CustomGcodeKind]
     *  but keeps the user-facing strings + hint copy here so the panel
     *  doesn't drag the SlicerEngine import into the data layer. The
     *  `Custom` kind is intentionally left off the picker — `Template`
     *  covers the same authoring use case with friendlier copy. */
    enum class Kind(
        val displayName: String,
        val hint: String,
        val needsExtruder: Boolean,
        val needsColor: Boolean,
        val needsExtra: Boolean,
        val extraLabel: String,
    ) {
        PausePrint(
            displayName = "Pause",
            hint = "Emits the printer's pause_print_gcode at this Z.",
            needsExtruder = false,
            needsColor = false,
            needsExtra = true,
            extraLabel = "Operator note",
        ),
        ColorChange(
            displayName = "Color change",
            hint = "Emits M600 to swap filament. Color is the new spool's hex.",
            needsExtruder = true,
            needsColor = true,
            needsExtra = false,
            extraLabel = "",
        ),
        ToolChange(
            displayName = "Tool change",
            hint = "Forces a Tn switch at this Z. Extruder is 1-based.",
            needsExtruder = true,
            needsColor = false,
            needsExtra = false,
            extraLabel = "",
        ),
        Template(
            displayName = "Template",
            hint = "Pastes the snippet into the before_layer_change hook.",
            needsExtruder = false,
            needsColor = false,
            needsExtra = true,
            extraLabel = "G-code snippet",
        ),
    }

    /** Validation result used by both unit tests and the panel's Add
     *  button gating. `null` reason ⇒ valid. */
    data class Validation(val ok: Boolean, val reason: String?)

    /**
     * Validate a draft tick before emitting an [WorkspaceAction].
     *
     * - Z must be finite, > 0, and not exceed any printable ceiling
     *   the caller passes via [maxZmm] (null disables the upper bound).
     * - PausePrint / Template require [extra] to be non-blank — an
     *   empty pause message reads as a silent halt to the user and an
     *   empty template snippet emits nothing useful.
     * - ColorChange requires a `#RRGGBB` color.
     * - Extruder must be ≥ 1 when the kind needs it.
     */
    fun validate(
        kind: Kind,
        zMm: Float,
        extruder: Int,
        color: String,
        extra: String,
        maxZmm: Float? = null,
    ): Validation {
        if (!zMm.isFinite() || zMm <= 0f) {
            return Validation(false, "Z must be a positive number.")
        }
        if (maxZmm != null && zMm > maxZmm) {
            return Validation(false, "Z=$zMm mm exceeds the print height ($maxZmm mm).")
        }
        if (kind.needsExtra && extra.isBlank()) {
            return Validation(false, "${kind.extraLabel} is required for ${kind.displayName}.")
        }
        if (kind.needsColor) {
            if (!isValidHex(color)) {
                return Validation(false, "Color must be #RRGGBB.")
            }
        }
        if (kind.needsExtruder && extruder < 1) {
            return Validation(false, "Extruder must be ≥ 1 for ${kind.displayName}.")
        }
        return Validation(true, null)
    }

    /** Map the panel-facing [Kind] back onto the SlicerEngine enum the
     *  store + JNI consume. Kept on this side of the boundary so the
     *  panel composable stays free of SlicerEngine internals. */
    fun toEngineKind(k: Kind): SlicerEngine.CustomGcodeKind = when (k) {
        Kind.PausePrint -> SlicerEngine.CustomGcodeKind.PausePrint
        Kind.ColorChange -> SlicerEngine.CustomGcodeKind.ColorChange
        Kind.ToolChange -> SlicerEngine.CustomGcodeKind.ToolChange
        Kind.Template -> SlicerEngine.CustomGcodeKind.Template
    }

    /** Reverse mapping for rendering existing ticks back through the
     *  panel labels. The legacy `Custom` engine kind falls back to
     *  Template since it has the same shape on the wire. */
    fun fromEngineKind(k: SlicerEngine.CustomGcodeKind): Kind = when (k) {
        SlicerEngine.CustomGcodeKind.PausePrint -> Kind.PausePrint
        SlicerEngine.CustomGcodeKind.ColorChange -> Kind.ColorChange
        SlicerEngine.CustomGcodeKind.ToolChange -> Kind.ToolChange
        SlicerEngine.CustomGcodeKind.Template -> Kind.Template
        SlicerEngine.CustomGcodeKind.Custom -> Kind.Template
    }

    private fun isValidHex(s: String): Boolean {
        if (s.length != 7) return false
        if (s[0] != '#') return false
        for (i in 1..6) {
            val c = s[i]
            val ok = (c in '0'..'9') || (c in 'a'..'f') || (c in 'A'..'F')
            if (!ok) return false
        }
        return true
    }
}

/**
 * SpatialPanel for A11 — list / add / remove / clear custom-gcode
 * ticks on the active plate. Rendering is plain Compose so the panel
 * works in both flat-shell and the XR SpatialPanel host.
 *
 * The panel takes the plate id + ticks as arguments rather than reading
 * the store directly — that keeps the host's `customGcodeTicksByPlate`
 * StateFlow as the single source of truth and matches how every other
 * panel in this app is wired.
 */
@Composable
fun CustomGcodePanel(
    activePlateId: Int,
    activePlateLabel: String,
    ticks: List<SlicerEngine.CustomGcodeTick>,
    /** Optional upper bound for Z input — typically the parsed
     *  toolpath's printable ceiling. Null disables the upper-bound
     *  check; the validator falls back to "Z must be > 0". */
    maxZmm: Float? = null,
    onAdd: (SlicerEngine.CustomGcodeTick) -> Unit,
    onRemove: (index: Int) -> Unit,
    onClear: () -> Unit,
    onClose: () -> Unit,
) {
    var kind by remember { mutableStateOf(CustomGcodeAuthoring.Kind.PausePrint) }
    var zMm by remember { mutableFloatStateOf(5f) }
    var extruder by remember { mutableStateOf("1") }
    var color by remember { mutableStateOf("#FF8A00") }
    var extra by remember { mutableStateOf("Insert magnet") }

    val sliderMax = (maxZmm ?: 200f).coerceAtLeast(1f)

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
                        "Custom G-code per Z",
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.White,
                    )
                    Text(
                        "Plate: $activePlateLabel · ${ticks.size} tick" +
                            if (ticks.size == 1) "" else "s",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFB6BEC8),
                    )
                }
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleMedium)
                }
            }

            Text(
                "Ticks fire at the matching layer's before_layer_change hook. " +
                    "Pause uses the active printer profile's pause_print_gcode.",
                color = Color(0xFF8E97A2),
                style = MaterialTheme.typography.labelSmall,
            )

            // Kind picker.
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        "Kind",
                        color = Color.White,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        for (k in CustomGcodeAuthoring.Kind.values()) {
                            FilterChip(
                                selected = kind == k,
                                onClick = { kind = k },
                                label = { Text(k.displayName) },
                            )
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        kind.hint,
                        color = Color(0xFFB6BEC8),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            // Z slider + numeric.
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Z",
                            color = Color.White,
                            modifier = Modifier.weight(1f),
                        )
                        Text("%.2f mm".format(zMm), color = Color(0xFF7BC8FF))
                    }
                    Slider(
                        value = zMm.coerceIn(0f, sliderMax),
                        onValueChange = { zMm = it },
                        valueRange = 0f..sliderMax,
                        colors = SliderDefaults.colors(
                            thumbColor = Color(0xFF7BC8FF),
                            activeTrackColor = Color(0xFF7BC8FF),
                            inactiveTrackColor = Color(0xFF44505C),
                        ),
                    )
                    if (maxZmm != null) {
                        Text(
                            "Print ceiling: %.1f mm".format(maxZmm),
                            color = Color(0xFF8E97A2),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }

            // Per-kind body fields.
            if (kind.needsColor) {
                NumberOrTextField(
                    label = "Color (#RRGGBB)",
                    value = color,
                    onChange = { color = it },
                    keyboard = KeyboardType.Text,
                )
            }
            if (kind.needsExtruder) {
                NumberOrTextField(
                    label = "Extruder (1-based)",
                    value = extruder,
                    onChange = { extruder = it.filter(Char::isDigit).take(2) },
                    keyboard = KeyboardType.Number,
                )
            }
            if (kind.needsExtra) {
                NumberOrTextField(
                    label = kind.extraLabel,
                    value = extra,
                    onChange = { extra = it },
                    keyboard = KeyboardType.Text,
                    multiline = kind == CustomGcodeAuthoring.Kind.Template,
                )
            }

            // Validation feedback.
            val v = CustomGcodeAuthoring.validate(
                kind = kind,
                zMm = zMm,
                extruder = extruder.toIntOrNull() ?: 0,
                color = color,
                extra = extra,
                maxZmm = maxZmm,
            )
            if (v.reason != null) {
                Text(
                    v.reason,
                    color = Color(0xFFFFB347),
                    style = MaterialTheme.typography.labelSmall,
                )
            }

            Button(
                enabled = v.ok,
                onClick = {
                    onAdd(
                        SlicerEngine.CustomGcodeTick(
                            printZmm = zMm,
                            kind = CustomGcodeAuthoring.toEngineKind(kind),
                            extruder = if (kind.needsExtruder) extruder.toIntOrNull() ?: 0 else 0,
                            color = if (kind.needsColor) color else "",
                            extra = if (kind.needsExtra) extra else "",
                        ),
                    )
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF7BC8FF),
                    contentColor = Color.Black,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Add tick at %.2f mm".format(zMm), fontWeight = FontWeight.Bold)
            }

            // Existing ticks.
            if (ticks.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "On this plate",
                        color = Color.White,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onClear) {
                        Text("Clear all", color = Color(0xFFFF8A8E))
                    }
                }
                for ((i, t) in ticks.withIndex()) {
                    TickRow(
                        index = i,
                        tick = t,
                        onRemove = { onRemove(i) },
                    )
                }
            } else {
                Text(
                    "No ticks on this plate yet.",
                    color = Color(0xFF8E97A2),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun TickRow(
    index: Int,
    tick: SlicerEngine.CustomGcodeTick,
    onRemove: () -> Unit,
) {
    val label = CustomGcodeAuthoring.fromEngineKind(tick.kind).displayName
    Surface(
        color = Color(0xFF1B1F23),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "%.2f mm".format(tick.printZmm),
                color = Color(0xFF7BC8FF),
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.width(86.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(label, color = Color.White, style = MaterialTheme.typography.bodyMedium)
                val sub = tickSummaryLine(tick)
                if (sub.isNotBlank()) {
                    Text(
                        sub,
                        color = Color(0xFF8E97A2),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            TextButton(onClick = onRemove) {
                Text("Remove", color = Color(0xFFFF8A8E))
            }
        }
    }
}

/** Render the per-kind body (color / extruder / message) in one
 *  compact line beneath the row title. Pure function so the unit
 *  tests can pin the copy. */
internal fun tickSummaryLine(tick: SlicerEngine.CustomGcodeTick): String = when (tick.kind) {
    SlicerEngine.CustomGcodeKind.ColorChange ->
        if (tick.color.isNotBlank()) "→ ${tick.color}" + (if (tick.extruder > 0) " on T${tick.extruder - 1}" else "") else ""
    SlicerEngine.CustomGcodeKind.PausePrint ->
        if (tick.extra.isNotBlank()) tick.extra else "Pause"
    SlicerEngine.CustomGcodeKind.ToolChange ->
        if (tick.extruder > 0) "→ T${tick.extruder - 1}" else ""
    SlicerEngine.CustomGcodeKind.Template,
    SlicerEngine.CustomGcodeKind.Custom ->
        if (tick.extra.isNotBlank()) tick.extra.lineSequence().firstOrNull()?.take(60).orEmpty() else ""
}

@Composable
private fun NumberOrTextField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    keyboard: KeyboardType,
    multiline: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = !multiline,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Color.White,
            unfocusedTextColor = Color.White,
            cursorColor = Color(0xFF7BC8FF),
            focusedBorderColor = Color(0xFF7BC8FF),
            unfocusedBorderColor = Color.Gray,
            focusedLabelColor = Color(0xFF7BC8FF),
            unfocusedLabelColor = Color.Gray,
        ),
    )
}

/**
 * Layer-scrubber tick-mark overlay. Renders a thin strip beneath the
 * scrubber slider that draws one circular dot per tick at its relative
 * Z position. Tapping a dot calls [onSelectTick] so the user can jump
 * to the tick's layer or surface a remove affordance.
 *
 * Designed to be hosted directly inside [BottomLayerPreviewPanel];
 * stays a no-op when [ticks] is empty so the slot doesn't take any
 * height when nothing's authored.
 */
@Composable
fun CustomGcodeTickStrip(
    ticks: List<SlicerEngine.CustomGcodeTick>,
    layerZs: List<Float>,
    onSelectTick: (layerIndex: Int) -> Unit = {},
) {
    if (ticks.isEmpty() || layerZs.size < 2) return
    val zMin = layerZs.first()
    val zMax = layerZs.last()
    val span = (zMax - zMin).coerceAtLeast(0.001f)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(18.dp)
            .padding(horizontal = 4.dp)
            .background(Color(0xFF1B1F23), RoundedCornerShape(4.dp))
            .border(1.dp, Color(0xFF2A3038), RoundedCornerShape(4.dp)),
    ) {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val width = maxWidth
            for (t in ticks) {
                val frac = ((t.printZmm - zMin) / span).coerceIn(0f, 1f)
                val tint = colorForKind(t.kind)
                Box(
                    modifier = Modifier
                        .offset(x = (width.value * frac - 5f).dp, y = 4.dp)
                        .size(10.dp)
                        .background(tint, CircleShape)
                        .border(1.dp, Color(0xFF15181B), CircleShape)
                        .clickable {
                            // Snap to the closest layer in layerZs.
                            val target = nearestLayerIndex(layerZs, t.printZmm)
                            onSelectTick(target)
                        },
                )
            }
        }
    }
}

internal fun nearestLayerIndex(layerZs: List<Float>, z: Float): Int {
    if (layerZs.isEmpty()) return 0
    var best = 0
    var bestDist = Float.MAX_VALUE
    for ((i, lz) in layerZs.withIndex()) {
        val d = kotlin.math.abs(lz - z)
        if (d < bestDist) {
            bestDist = d
            best = i
        }
    }
    return best
}

private fun colorForKind(k: SlicerEngine.CustomGcodeKind): Color = when (k) {
    SlicerEngine.CustomGcodeKind.PausePrint -> Color(0xFFFFB347)
    SlicerEngine.CustomGcodeKind.ColorChange -> Color(0xFF7BC8FF)
    SlicerEngine.CustomGcodeKind.ToolChange -> Color(0xFFA0E37D)
    SlicerEngine.CustomGcodeKind.Template,
    SlicerEngine.CustomGcodeKind.Custom -> Color(0xFFB48EFE)
}
