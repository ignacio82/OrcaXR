package dev.orcaxr.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.io.File

/**
 * Bed-fit summary the project panel can show alongside the loaded
 * model. [BedFit.Warn] flags any axis that overflows the bed and
 * carries the formatted size string ("48.3 × 92.1 × 23.0 mm").
 */
sealed interface BedFit {
    val sizeText: String

    data class Ok(override val sizeText: String) : BedFit
    data class Warn(override val sizeText: String, val reason: String) : BedFit
}

@Composable
fun LeftProjectPanel(
    sliceState: SliceUiState,
    bedFit: BedFit?,
    printers: List<PrinterConfig>,
    selectedPrinterId: String?,
    onSelectPrinter: (String?) -> Unit,
    onOpenDevices: () -> Unit,
    onPickStl: () -> Unit,
    onClearModel: () -> Unit,
    /** True between the moment the user picks a file and when the
     *  preview GLB is ready. Drives the model-row spinner so big
     *  3MFs (1M+ triangle dragons take ~10s through the colored-GLB
     *  writer) don't look frozen. */
    isLoadingModel: Boolean = false,
    /** Optional label shown next to the spinner — usually the file
     *  name being loaded. Falls back to "Loading…" when null. */
    loadingLabel: String? = null,
    /** Project filaments — one entry per project slot (length ==
     *  [slotCount]). Each carries the model's authored color (from a
     *  loaded 3MF or the slot default), an optional [FilamentEntry.physicalSlot]
     *  remap pointing at a physical printer slot, and an optional
     *  [FilamentEntry.virtualSlot] remap pointing at a virtual mixed
     *  pair. Painted facets at project filament index N print from
     *  physicalSlot if set, else virtualSlot if set, else identity
     *  (T_N). Caller materializes a default entry per slot so the UI
     *  is fully data-driven. */
    filaments: List<FilamentEntry>,
    slotCount: Int,
    /** Generic palette shown to the user when manually editing a model
     *  color (when no printer-loaded swatch is what they want). */
    paletteSuggestions: List<String>,
    /** Spools currently loaded in the active printer, surfaced via
     *  Moonraker's `print_task_config`. Drives the read-only "Printer
     *  filaments" section AND the picker's printer-slot targets in the
     *  Model colors section. Empty list when the printer didn't expose
     *  the data — the section falls back to [paletteSuggestions]
     *  defaults so the user can still see slot positions. */
    printerLoadedSlots: List<FilamentSlot> = emptyList(),
    /** Edit a model color's swatch (pure cosmetic — does NOT touch the
     *  mapping target). Used by the manual hex / common-color path
     *  inside the Model colors section. */
    onChangeFilamentColor: (slotIndex: Int, hex: String) -> Unit,
    /** Map the project filament at [slotIndex] to print from physical
     *  printer slot [physicalSlot] (0-based). Sets
     *  [FilamentEntry.physicalSlot] and clears
     *  [FilamentEntry.virtualSlot]; does NOT touch the swatch color
     *  (model colors stay readable in the row, the destination is the
     *  separate "→ prints from" indicator). */
    onMapToPhysicalSlot: (slotIndex: Int, physicalSlot: Int) -> Unit,
    /** Map the project filament at [slotIndex] to print from virtual
     *  mixed-filament [virtualSlot] (1-based row in
     *  [virtualRows]). Mutually exclusive with
     *  [onMapToPhysicalSlot]; clears physicalSlot. */
    onMapToVirtualSlot: (slotIndex: Int, virtualSlot: Int) -> Unit,
    /** Reset the project filament at [slotIndex] to identity mapping
     *  (T_slotIndex). Clears both [FilamentEntry.physicalSlot] and
     *  [FilamentEntry.virtualSlot]. */
    onClearMapping: (slotIndex: Int) -> Unit,
    /** Edit the material type for project filament [slotIndex]. */
    onChangeFilamentType: (slotIndex: Int, type: String) -> Unit,
    /** Refresh the printer-loaded-filaments cache from Moonraker.
     *  Null when no printer is selected. */
    onDetectFilaments: (() -> Unit)? = null,
    /** Phase I.1 — copy the printer's loaded slot colors + filament
     *  types into the project palette in one action. Clobbers user
     *  edits intentionally; null when no printer is selected or no
     *  slot data has been detected yet. */
    onSyncFromPrinter: (() -> Unit)? = null,
    /** FullSpectrum mixed-filament rows for the active printer. Used
     *  both for displaying / editing the Virtual colors section and
     *  for resolving the V_K mapping targets in the Model colors
     *  section. Empty list = the section shows "+ New mix" only. */
    virtualRows: List<MixedFilamentEntry> = emptyList(),
    /** Persist a single virtual row update (component swap, ratio
     *  edit, bias change, enable toggle). */
    onUpdateVirtualRow: (MixedFilamentEntry) -> Unit = {},
    /** Append a new virtual mix to the active printer's list. Caller
     *  is expected to seed it with sensible defaults (the panel does
     *  this when the user taps "+ New mix"). */
    onAddVirtualRow: (MixedFilamentEntry) -> Unit = {},
    /** Tombstone a virtual row (sets `deleted = true`). Caller should
     *  also clear any project filament whose [FilamentEntry.virtualSlot]
     *  pointed at this row to avoid a stale mapping. */
    onRemoveVirtualRow: (MixedFilamentEntry) -> Unit = {},
    /** Pre-flight outcome of the (bed × filament) compatibility rules
     *  (Phase E port of Snapmaker fork's filament_hot_bed_nozzles.json).
     *  [FilamentRules.Result.Ok] hides the banner; Warning shows an
     *  amber banner; Forbidden shows a red banner and the caller is
     *  expected to pass the same state into [BottomRightSummaryPanel]
     *  to disable the Slice button. */
    filamentRuleResult: FilamentRules.Result = FilamentRules.Result.Ok,
    /** Phase H.2 top-cover hint from the active profile's
     *  `requires_top_cover` array. Renders as an amber "Top cover
     *  recommended" banner alongside the FilamentRules warnings.
     *  [TopCoverRule.Result.Ok] hides the banner. */
    topCoverHint: TopCoverRule.Result = TopCoverRule.Result.Ok,
    /** Phase G: every model the user has plated on the bed, in load
     *  order. Empty list = the empty state (the single-model "Load
     *  model…" row keeps showing). 1 entry = single-model legacy UX
     *  (top row + Add another / Auto-arrange visible only when ≥2
     *  exist makes the panel quiet). 2+ entries = the multi-model UX
     *  with per-row select / delete + the auto-arrange affordance. */
    placedModels: List<PlacedModel> = emptyList(),
    /** Id of the currently-selected model (the one the rotate / scale
     *  / grab tools target). Highlighted in the list. */
    selectedPlacedModelId: String? = null,
    onSelectPlacedModel: (id: String) -> Unit = {},
    onDeletePlacedModel: (id: String) -> Unit = {},
    /** Open the file picker in "add another" mode — picks append to
     *  the list rather than replacing it. */
    onAddPlacedModel: () -> Unit = {},
    /** Re-arrange the plated models left-to-right with 5 mm gaps
     *  centered on bed origin. */
    onAutoArrangePlacedModels: () -> Unit = {},
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF15181B))
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("Project", style = MaterialTheme.typography.titleLarge, color = Color.White)

        val sourceLabel = when (sliceState) {
            is SliceUiState.Done -> sliceState.sourceLabel
            is SliceUiState.Slicing -> sliceState.sourceLabel
            else -> "No Model Loaded"
        }

        // Model List / Picker. Clicking the row opens the picker; the ✕
        // button on the right (only when a model is loaded) returns to
        // the empty state. The clear control sits inside the same
        // Surface as a secondary IconButton to keep the project panel
        // visually compact.
        val hasModel = sliceState !is SliceUiState.Idle
        Surface(
            color = Color(0xFF1B1F23),
            shape = RoundedCornerShape(8.dp),
        ) {
            Row(
                modifier = Modifier
                    .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
                    .fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(enabled = !isLoadingModel) { onPickStl() }
                        .padding(vertical = 8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (isLoadingModel) {
                            CircularProgressIndicator(
                                color = Color(0xFF7BC8FF),
                                strokeWidth = 2.dp,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                loadingLabel ?: "Loading…",
                                color = Color(0xFF7BC8FF),
                                fontWeight = FontWeight.Bold,
                                maxLines = 1,
                            )
                            Spacer(modifier = Modifier.weight(1f))
                            Text(
                                "Reading…",
                                color = Color.Gray,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        } else {
                            Text(sourceLabel, color = Color(0xFF7BC8FF), fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.weight(1f))
                            Text("Load model...", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                if (hasModel) {
                    IconButton(onClick = onClearModel) {
                        Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleSmall)
                    }
                }
            }
        }

        // Phase G: per-model rows + Add another / Auto-arrange. The
        // single-model UX stays unchanged (no list shown when 0 or 1
        // model is plated — keeps the panel quiet for the common
        // case). The list appears the moment the user plates a 2nd
        // model; the "+ Add another" button appears even at 1 model
        // so the user can discover it without having to open a menu.
        PlacedModelsSection(
            models = placedModels,
            selectedId = selectedPlacedModelId,
            onSelect = onSelectPlacedModel,
            onDelete = onDeletePlacedModel,
            onAdd = onAddPlacedModel,
            onAutoArrange = onAutoArrangePlacedModels,
        )

        // Bed-fit indicator. Only visible once a model is loaded so the
        // panel stays calm in the empty state.
        if (bedFit != null) {
            val isWarn = bedFit is BedFit.Warn
            Surface(
                color = if (isWarn) Color(0xFF3A1E1E) else Color(0xFF1B1F23),
                shape = RoundedCornerShape(8.dp),
            ) {
                Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (isWarn) "⚠" else "✓",
                            color = if (isWarn) Color(0xFFFF9F4A) else Color(0xFF7BC8FF),
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(end = 8.dp),
                        )
                        Text(
                            if (isWarn) "Model exceeds build plate" else "Fits on build plate",
                            color = Color.White,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    Text(
                        bedFit.sizeText,
                        color = Color.LightGray,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (bedFit is BedFit.Warn) {
                        Text(
                            bedFit.reason,
                            color = Color(0xFFFF9F4A),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }
        }

        // Filament-vs-bed compatibility banner (Phase E). Renders only
        // when the rules raise a Warning or Forbidden — Ok stays silent
        // so the panel doesn't grow a "✓ supported" row that's noise on
        // the common PLA-on-PEI case.
        FilamentRulesBanner(filamentRuleResult)

        // Phase H.2 top-cover hint banner. Same amber Warning shape as
        // FilamentRulesBanner — non-blocking, surfaces above the
        // Filament list so a user with PA-CF loaded sees it before
        // they decide whether to slice without the cover installed.
        TopCoverHintBanner(topCoverHint)

        Spacer(modifier = Modifier.height(8.dp))
        Text("Printer", style = MaterialTheme.typography.titleMedium, color = Color.White)
        if (printers.isEmpty()) {
            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth().clickable { onOpenDevices() },
            ) {
                Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
                    Text("No printer configured", color = Color.White)
                    Text(
                        "Tap to add — Device tab",
                        color = Color(0xFF7BC8FF),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        } else {
            PrinterDropdown(
                printers = printers,
                selectedPrinterId = selectedPrinterId,
                onSelect = onSelectPrinter,
                onOpenDevices = onOpenDevices,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))
        ColorMappingPanel(
            slotCount = slotCount,
            printerLoadedSlots = printerLoadedSlots,
            paletteSuggestions = paletteSuggestions,
            projectFilaments = filaments,
            virtualRows = virtualRows,
            onDetectFilaments = onDetectFilaments,
            onSyncFromPrinter = onSyncFromPrinter,
            onChangeProjectFilamentColor = onChangeFilamentColor,
            onChangeProjectFilamentType = onChangeFilamentType,
            onMapToPhysicalSlot = onMapToPhysicalSlot,
            onMapToVirtualSlot = onMapToVirtualSlot,
            onClearMapping = onClearMapping,
            onUpdateVirtualRow = onUpdateVirtualRow,
            onAddVirtualRow = onAddVirtualRow,
            onRemoveVirtualRow = onRemoveVirtualRow,
        )
    }
}

/**
 * Compose surface for [FilamentRules.Result]. Hides on [FilamentRules.Result.Ok];
 * renders an amber banner for Warning, a red banner for Forbidden. Mirrors the
 * existing bed-fit warning's shape (Surface + rounded 8dp + colored icon +
 * bold heading + reason) so the two banners read as one stack of pre-flight
 * checks rather than two competing styles.
 */
@Composable
private fun FilamentRulesBanner(result: FilamentRules.Result) {
    val (bg, icon, iconTint, heading, body) = when (result) {
        is FilamentRules.Result.Ok -> return
        is FilamentRules.Result.Warning -> FilamentRulesBannerSpec(
            bg = Color(0xFF3A1E1E),
            icon = "⚠",
            iconTint = Color(0xFFFF9F4A),
            heading = "Filament: caution",
            body = result.message,
        )
        is FilamentRules.Result.Forbidden -> FilamentRulesBannerSpec(
            bg = Color(0xFF44181A),
            icon = "✕",
            iconTint = Color(0xFFFF5A5F),
            heading = "Filament: not supported",
            body = result.message,
        )
    }
    Surface(color = bg, shape = RoundedCornerShape(8.dp)) {
        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    icon,
                    color = iconTint,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(end = 8.dp),
                )
                Text(
                    heading,
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            Text(
                body,
                color = Color.LightGray,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

private data class FilamentRulesBannerSpec(
    val bg: Color,
    val icon: String,
    val iconTint: Color,
    val heading: String,
    val body: String,
)

/**
 * Compose surface for [TopCoverRule.Result] (Phase H.2). Mirrors
 * [FilamentRulesBanner]'s amber Warning shape so the two banners
 * stack visually as one set of pre-flight hints. Hides on
 * [TopCoverRule.Result.Ok].
 */
@Composable
private fun TopCoverHintBanner(result: TopCoverRule.Result) {
    val w = result as? TopCoverRule.Result.Warning ?: return
    Surface(color = Color(0xFF3A1E1E), shape = RoundedCornerShape(8.dp)) {
        Column(modifier = Modifier.padding(12.dp).fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "⚠",
                    color = Color(0xFFFF9F4A),
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(end = 8.dp),
                )
                Text(
                    "Top cover recommended",
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            Text(
                w.message,
                color = Color.LightGray,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/**
 * Phase G multi-model UI section. Renders nothing when the list is
 * empty (the empty-state model picker row above is the only
 * affordance the user sees). At 1 model it shows just the
 * "+ Add another" button so the discovery affordance is present
 * without cluttering the panel. At ≥2 models it shows the full
 * list (selectable, deletable) plus Add and Auto-arrange.
 */
@Composable
private fun PlacedModelsSection(
    models: List<PlacedModel>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    onDelete: (String) -> Unit,
    onAdd: () -> Unit,
    onAutoArrange: () -> Unit,
) {
    if (models.isEmpty()) return
    val atCapacity = models.size >= MAX_PLACED_MODELS
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (models.size >= 2) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "Plated models (${models.size}/$MAX_PLACED_MODELS)",
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White,
                )
                TextButton(onClick = onAutoArrange) {
                    Text("Auto-arrange", color = Color(0xFF7BC8FF))
                }
            }
            for (m in models) {
                val isSelected = m.id == selectedId
                Surface(
                    color = if (isSelected) Color(0xFF24323D) else Color(0xFF1B1F23),
                    shape = RoundedCornerShape(8.dp),
                    border = if (isSelected) BorderStroke(1.dp, Color(0xFF7BC8FF)) else null,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(m.id) },
                ) {
                    Row(
                        modifier = Modifier
                            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
                            .fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f).padding(vertical = 4.dp)) {
                            Text(
                                m.label,
                                color = Color.White,
                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                maxLines = 1,
                            )
                            val rot = if (m.rotZDeg == 0) "" else " · rot ${m.rotZDeg}°"
                            val scl = if (m.scalePct == 100) "" else " · ${m.scalePct}%"
                            val pos = "x=%.0f y=%.0f mm".format(m.translateXmm, m.translateYmm)
                            Text(
                                "$pos$rot$scl",
                                color = Color.LightGray,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                        IconButton(onClick = { onDelete(m.id) }) {
                            Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleSmall)
                        }
                    }
                }
            }
        }
        // Always-visible "+ Add another" affordance. Disabled at the
        // SceneCore-budget cap (16) — the toast surface in
        // MainActivity.onFileSelected handles the secondary "you
        // tried again" message; the disabled state communicates the
        // limit at first sight.
        OutlinedButton(
            onClick = onAdd,
            enabled = !atCapacity,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            Text(
                if (atCapacity) "Plate full ($MAX_PLACED_MODELS / $MAX_PLACED_MODELS)"
                else "+ Add another model",
                color = if (atCapacity) Color.Gray else Color(0xFF7BC8FF),
            )
        }
    }
}

// ============================================================================
// ColorMappingPanel — three-section model for printer / virtual / model colors.
//
// The previous design conflated "what's loaded in printer slot N" with "what
// color does project filament N print as": a single FilamentRow per slot, the
// 3MF embedded palette overwriting the slot palette, and a picker that quietly
// offered both "set the visual color" and "rewire which physical spool prints
// here" using nearly-identical-looking swatches. Net effect: users picked
// printer-yellow for a model purple, the swatch updated, but `filament_map`
// stayed at identity → prints came out using whatever was in the matching
// physical slot regardless of intent.
//
// The new layout makes the three concepts spatially distinct:
//
//   ▸ Printer filaments — read-only, sourced from Moonraker (with
//     palette-default fallback). One row per physical slot. This row never
//     changes from a model load — it reflects physical reality.
//   ▸ Virtual colors — FullSpectrum mixed pairs the user can define and
//     remap onto. Each row reads as an equation: [T_a] + [T_b] = [V_K], with
//     an Advanced expand for ratio + bias. Replaces the standalone
//     MixedColorsPanel; defining is one-tap from this panel without leaving
//     the mapping flow.
//   ▸ Model colors — one row per project filament (matches the loaded 3MF's
//     authored palette, or slot defaults when no model is loaded). Each row
//     carries the model color on the LEFT and an explicit "→ prints from"
//     picker on the RIGHT pointing at a printer slot or a virtual mix.
//
// The "→" arrow is the load-bearing UX element: it visually disambiguates
// "what color the model wants" from "what spool we're going to use." Tapping
// it opens a single picker that shows printer + virtual targets together, so
// "Default (T_N)", T1..T_n, and V1..V_K are all one tap away with no chance
// of picking a cosmetic-only swatch by accident.
//
// All inline expansion (no AlertDialog) — gotcha #1 in GEMINI.md, alpha12's
// SpatialPanel doesn't paint Window-level overlays.
// ============================================================================

/**
 * The three-section filament UI: printer slots (read-only), virtual mixes
 * (definable inline), and model colors (with explicit mapping picker).
 *
 * State held internally:
 *  - which model row's picker / color editor is open (mutually exclusive),
 *  - which virtual row has Advanced expanded,
 *  - which virtual row has a component swap picker open.
 *
 * This is a private composable; [LeftProjectPanel] is the public entry point.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ColorMappingPanel(
    slotCount: Int,
    printerLoadedSlots: List<FilamentSlot>,
    paletteSuggestions: List<String>,
    projectFilaments: List<FilamentEntry>,
    virtualRows: List<MixedFilamentEntry>,
    onDetectFilaments: (() -> Unit)?,
    onSyncFromPrinter: (() -> Unit)?,
    onChangeProjectFilamentColor: (slotIndex: Int, hex: String) -> Unit,
    onChangeProjectFilamentType: (slotIndex: Int, type: String) -> Unit,
    onMapToPhysicalSlot: (slotIndex: Int, physicalSlot: Int) -> Unit,
    onMapToVirtualSlot: (slotIndex: Int, virtualSlot: Int) -> Unit,
    onClearMapping: (slotIndex: Int) -> Unit,
    onUpdateVirtualRow: (MixedFilamentEntry) -> Unit,
    onAddVirtualRow: (MixedFilamentEntry) -> Unit,
    onRemoveVirtualRow: (MixedFilamentEntry) -> Unit,
) {
    if (slotCount == 0) {
        Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(8.dp)) {
            Text(
                "Select a printer to manage filaments",
                color = Color.Gray,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(12.dp),
            )
        }
        return
    }

    // Effective per-slot palette for the printer section. Moonraker-sourced
    // colors (when detected) win per-slot; everything else falls back to the
    // shared palette suggestions so the section always has something to show.
    val printerPalette: List<EffectivePrinterSlot> =
        remember(slotCount, printerLoadedSlots, paletteSuggestions) {
            val byIndex = printerLoadedSlots.associateBy { it.slotIndex }
            (0 until slotCount).map { i ->
                val real = byIndex[i]
                EffectivePrinterSlot(
                    slotIndex = i,
                    colorHex = real?.colorHex
                        ?: paletteSuggestions.getOrNull(i)
                        ?: paletteSuggestions.getOrNull(i % paletteSuggestions.size.coerceAtLeast(1))
                        ?: "#FFFFFF",
                    material = real?.material ?: "—",
                    isDetected = real != null,
                )
            }
        }

    // Single-source-of-truth for which model row's picker is currently open.
    // Tapping a different row closes the previous one — keeps panel height
    // bounded so the user isn't scrolling past 4 stacked pickers.
    var openModelRow: ModelRowEdit? by remember { mutableStateOf(null) }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PrinterFilamentsSection(
            slots = printerPalette,
            onDetectFilaments = onDetectFilaments,
            onSyncFromPrinter = onSyncFromPrinter,
        )

        VirtualColorsSection(
            virtualRows = virtualRows,
            slotCount = slotCount,
            printerPalette = printerPalette,
            onUpdate = onUpdateVirtualRow,
            onAdd = onAddVirtualRow,
            onRemove = onRemoveVirtualRow,
        )

        ModelColorsSection(
            projectFilaments = projectFilaments,
            slotCount = slotCount,
            printerPalette = printerPalette,
            virtualRows = virtualRows,
            paletteSuggestions = paletteSuggestions,
            openEdit = openModelRow,
            onOpenEdit = { openModelRow = it },
            onChangeColor = onChangeProjectFilamentColor,
            onChangeType = onChangeProjectFilamentType,
            onMapToPhysical = onMapToPhysicalSlot,
            onMapToVirtual = onMapToVirtualSlot,
            onClearMapping = onClearMapping,
        )

        // Preview palette — what each project slot will *actually* print
        // as, after physical / virtual remaps and the underlying mix
        // resolution. Routes through PreviewPalette.resolveAsWillPrintPalette,
        // the same function the colored-GLB writer consumes, so this row
        // is a faithful preview of the in-XR model render. Hidden behind
        // an accordion so the panel doesn't grow by default.
        PreviewPaletteAccordion(
            filaments = projectFilaments,
            printerLoadedSlots = printerLoadedSlots,
            paletteSuggestions = paletteSuggestions,
            virtualRows = virtualRows,
            slotCount = slotCount,
        )
    }
}

@Composable
private fun PreviewPaletteAccordion(
    filaments: List<FilamentEntry>,
    printerLoadedSlots: List<FilamentSlot>,
    paletteSuggestions: List<String>,
    virtualRows: List<MixedFilamentEntry>,
    slotCount: Int,
) {
    var expanded by remember { mutableStateOf(false) }
    val resolved = remember(filaments, printerLoadedSlots, paletteSuggestions, virtualRows, slotCount) {
        resolveAsWillPrintPalette(
            filaments = filaments,
            printerLoadedSlots = printerLoadedSlots,
            paletteSuggestions = paletteSuggestions,
            virtualRows = virtualRows,
            slotCount = slotCount,
        )
    }
    Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(8.dp)) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    "Preview palette",
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    if (expanded) "▾" else "▸",
                    color = Color.LightGray,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (expanded) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "What each project slot prints as after remaps + mixes.",
                    color = Color.Gray,
                    style = MaterialTheme.typography.labelSmall,
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    for ((idx, hex) in resolved.withIndex()) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            SwatchBox(hex, size = 24.dp)
                            Text(
                                "F${idx + 1}",
                                color = Color.LightGray,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * One physical printer slot resolved for the panel — Moonraker-detected
 * (real loadout) or palette-default (fallback). The boolean lets the UI
 * distinguish the two with a small "—" hint instead of pretending the
 * default-palette swatch is loaded reality.
 */
private data class EffectivePrinterSlot(
    val slotIndex: Int,
    val colorHex: String,
    val material: String,
    val isDetected: Boolean,
)

/**
 * What's currently expanded inside the Model colors section. Mutually
 * exclusive — only one row at a time gets to take vertical real estate.
 */
private sealed interface ModelRowEdit {
    val slotIndex: Int

    /** "→ prints from" picker is open: choose a printer or virtual target. */
    data class Mapping(override val slotIndex: Int) : ModelRowEdit

    /** Manual color editor open: hex field + common colors palette. */
    data class Color(override val slotIndex: Int) : ModelRowEdit

    /** Material type picker open. */
    data class Material(override val slotIndex: Int) : ModelRowEdit
}

/**
 * Section 1 of [ColorMappingPanel] — read-only physical printer loadout.
 * Sourced from Moonraker's `print_task_config`; falls back to the shared
 * palette suggestions per-slot when a slot wasn't detected, and a small "—"
 * indicator next to the material differentiates the fallback from real
 * loadout. Detect / Sync buttons mirror the previous behavior.
 */
@Composable
private fun PrinterFilamentsSection(
    slots: List<EffectivePrinterSlot>,
    onDetectFilaments: (() -> Unit)?,
    onSyncFromPrinter: (() -> Unit)?,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Printer filaments", style = MaterialTheme.typography.titleMedium, color = Color.White)
            Row {
                if (onSyncFromPrinter != null) {
                    TextButton(onClick = onSyncFromPrinter) {
                        Text("Sync", color = Color(0xFF7BC8FF))
                    }
                }
                if (onDetectFilaments != null) {
                    TextButton(onClick = onDetectFilaments) {
                        Text("Detect", color = Color(0xFFB6E4B6))
                    }
                }
            }
        }
        for (slot in slots) {
            Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(8.dp)) {
                Row(
                    modifier = Modifier
                        .padding(horizontal = 10.dp, vertical = 8.dp)
                        .fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SwatchBox(slot.colorHex, size = 36.dp)
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            "T${slot.slotIndex + 1}",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            if (slot.isDetected) slot.material else "${slot.material}  ·  not detected",
                            color = if (slot.isDetected) Color.LightGray else Color.Gray,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    Text(
                        slot.colorHex.uppercase(),
                        color = Color.Gray,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}

/**
 * Section 2 of [ColorMappingPanel] — FullSpectrum virtual mixes. Each row
 * reads as an equation [T_a] + [T_b] = [V_K], with an inline component-swap
 * picker (tap a component swatch → choose another physical slot) and an
 * Advanced expand panel for ratio + bias. "+ New mix" appends a row and
 * auto-expands its Advanced editor.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VirtualColorsSection(
    virtualRows: List<MixedFilamentEntry>,
    slotCount: Int,
    printerPalette: List<EffectivePrinterSlot>,
    onUpdate: (MixedFilamentEntry) -> Unit,
    onAdd: (MixedFilamentEntry) -> Unit,
    onRemove: (MixedFilamentEntry) -> Unit,
) {
    val visible = virtualRows.filter { !it.deleted }
    var advancedOpenRowId: String? by remember { mutableStateOf(null) }
    var swapOpenRowId: String? by remember { mutableStateOf(null) }
    var swapOpenSide: ComponentSide? by remember { mutableStateOf(null) }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Virtual colors", style = MaterialTheme.typography.titleMedium, color = Color.White)
        if (slotCount < 2) {
            Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(8.dp)) {
                Text(
                    "Mixed colors require at least 2 physical filaments.",
                    color = Color.Gray,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(12.dp),
                )
            }
            return
        }

        for ((idx, row) in visible.withIndex()) {
            VirtualRowEquation(
                row = row,
                rowNumber = idx + 1,
                printerPalette = printerPalette,
                advancedOpen = advancedOpenRowId == row.id,
                swapOpenSide = if (swapOpenRowId == row.id) swapOpenSide else null,
                onTapComponent = { side ->
                    val same = swapOpenRowId == row.id && swapOpenSide == side
                    swapOpenRowId = if (same) null else row.id
                    swapOpenSide = if (same) null else side
                },
                onPickComponent = { side, slotIndex ->
                    val updated = when (side) {
                        ComponentSide.A -> row.copy(componentA = slotIndex + 1)
                        ComponentSide.B -> row.copy(componentB = slotIndex + 1)
                    }
                    onUpdate(updated)
                    swapOpenRowId = null
                    swapOpenSide = null
                },
                onToggleAdvanced = {
                    val same = advancedOpenRowId == row.id
                    advancedOpenRowId = if (same) null else row.id
                    // Closing the swap picker if the user opens advanced
                    // keeps vertical density bounded.
                    if (!same) {
                        swapOpenRowId = null
                        swapOpenSide = null
                    }
                },
                onUpdate = onUpdate,
                onRemove = {
                    onRemove(row)
                    if (advancedOpenRowId == row.id) advancedOpenRowId = null
                    if (swapOpenRowId == row.id) {
                        swapOpenRowId = null
                        swapOpenSide = null
                    }
                },
            )
        }

        // "+ New mix" — picks the first unused unordered (a,b) pair and
        // immediately opens its Advanced editor so the user lands in
        // edit mode. Falls back to (T1, T2) when every pair is taken.
        OutlinedButton(
            onClick = {
                val taken = visible.map { unorderedKey(it.componentA, it.componentB) }.toSet()
                val pair = firstUnusedPair(slotCount, taken) ?: (1 to 2)
                val newId = "user_${System.currentTimeMillis().toString(36)}"
                val newRow = MixedFilamentEntry(
                    id = newId,
                    componentA = pair.first,
                    componentB = pair.second,
                )
                onAdd(newRow)
                advancedOpenRowId = newId
            },
            enabled = visible.size < slotCount * (slotCount - 1) / 2,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            Text("+ New mix", color = Color(0xFF7BC8FF))
        }
    }
}

private enum class ComponentSide { A, B }

/**
 * One virtual-mix row rendered as `V_K  [T_a]+[T_b] = [preview]  ⌄  🗑`.
 * Tapping a component swatch opens an inline picker for swapping it.
 * Tapping the chevron toggles the Advanced editor (ratio + bias).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VirtualRowEquation(
    row: MixedFilamentEntry,
    rowNumber: Int,
    printerPalette: List<EffectivePrinterSlot>,
    advancedOpen: Boolean,
    swapOpenSide: ComponentSide?,
    onTapComponent: (ComponentSide) -> Unit,
    onPickComponent: (ComponentSide, slotIndex: Int) -> Unit,
    onToggleAdvanced: () -> Unit,
    onUpdate: (MixedFilamentEntry) -> Unit,
    onRemove: () -> Unit,
) {
    val colorA = printerPalette.getOrNull(row.componentA - 1)?.colorHex ?: "#FFFFFF"
    val colorB = printerPalette.getOrNull(row.componentB - 1)?.colorHex ?: "#FFFFFF"
    val preview = blendMixedColor(colorA, colorB, row.ratioA, row.ratioB)

    Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(8.dp)) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "V$rowNumber",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.width(28.dp),
                )
                ComponentSwatchTap(
                    colorHex = colorA,
                    label = "T${row.componentA}",
                    selected = swapOpenSide == ComponentSide.A,
                    onTap = { onTapComponent(ComponentSide.A) },
                )
                Text("+", color = Color.LightGray, style = MaterialTheme.typography.titleMedium)
                ComponentSwatchTap(
                    colorHex = colorB,
                    label = "T${row.componentB}",
                    selected = swapOpenSide == ComponentSide.B,
                    onTap = { onTapComponent(ComponentSide.B) },
                )
                Text("=", color = Color.LightGray, style = MaterialTheme.typography.titleMedium)
                SwatchBox(preview, size = 32.dp, accent = true)
                Spacer(modifier = Modifier.weight(1f))
                TextButton(onClick = onToggleAdvanced) {
                    Text(
                        if (advancedOpen) "Advanced ▴" else "Advanced ▾",
                        color = Color(0xFF7BC8FF),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                IconButton(onClick = onRemove) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleSmall)
                }
            }
            if (swapOpenSide != null) {
                Spacer(modifier = Modifier.height(6.dp))
                PhysicalSlotChooserRow(
                    slots = printerPalette,
                    excludeSlotIndex = if (swapOpenSide == ComponentSide.A) row.componentB - 1
                                       else row.componentA - 1,
                    onPick = { slotIdx -> onPickComponent(swapOpenSide, slotIdx) },
                )
            }
            if (advancedOpen) {
                Spacer(modifier = Modifier.height(8.dp))
                MixedAdvancedEditor(row = row, onUpdate = onUpdate)
            }
        }
    }
}

/**
 * A tap-to-swap component swatch inside a virtual-mix equation row. Outline
 * brightens when the swap picker is currently open against this swatch.
 */
@Composable
private fun ComponentSwatchTap(
    colorHex: String,
    label: String,
    selected: Boolean,
    onTap: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .clickable(onClick = onTap)
            .padding(2.dp),
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(parseHexColorOrDefault(colorHex))
                .border(
                    1.dp,
                    if (selected) Color(0xFF7BC8FF) else Color(0xFF2C3138),
                    RoundedCornerShape(6.dp),
                ),
        )
        Text(label, color = Color.Gray, style = MaterialTheme.typography.labelSmall)
    }
}

/**
 * Inline row of physical-slot swatches used by virtual-mix component swap and
 * by model-color physical-target mapping. Excludes the partner slot when
 * called from a virtual row to prevent picking T_a + T_a (a degenerate
 * "mix" that just prints solid).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PhysicalSlotChooserRow(
    slots: List<EffectivePrinterSlot>,
    excludeSlotIndex: Int? = null,
    onPick: (slotIndex: Int) -> Unit,
) {
    Surface(color = Color(0xFF15181B), shape = RoundedCornerShape(6.dp)) {
        FlowRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (slot in slots) {
                if (slot.slotIndex == excludeSlotIndex) continue
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { onPick(slot.slotIndex) }
                        .padding(2.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(parseHexColorOrDefault(slot.colorHex))
                            .border(1.dp, Color(0xFF2C3138), RoundedCornerShape(6.dp)),
                    )
                    Text(
                        "T${slot.slotIndex + 1}",
                        color = Color.Gray,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}

/**
 * Advanced editor for one virtual-mix row: layer cadence steppers + bias
 * slider + enable toggle. Hidden behind the row's chevron so the row stays
 * glanceable in the common case.
 */
@Composable
private fun MixedAdvancedEditor(
    row: MixedFilamentEntry,
    onUpdate: (MixedFilamentEntry) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        HorizontalDivider(color = Color(0xFF2C3138))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = row.enabled,
                onCheckedChange = { onUpdate(row.copy(enabled = it)) },
            )
            Text(
                if (row.enabled) "Enabled" else "Disabled",
                color = Color.LightGray,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text(
            "Layer cadence: ${row.ratioA}:${row.ratioB}",
            color = Color.LightGray,
            style = MaterialTheme.typography.labelSmall,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            RatioStepper(
                label = "T${row.componentA}",
                value = row.ratioA,
                onChange = { onUpdate(row.copy(ratioA = it)) },
            )
            RatioStepper(
                label = "T${row.componentB}",
                value = row.ratioB,
                onChange = { onUpdate(row.copy(ratioB = it)) },
            )
        }
        Text(
            "Bias: ${row.biasPercent}%  (negative = more T${row.componentA}, " +
                "positive = more T${row.componentB})",
            color = Color.LightGray,
            style = MaterialTheme.typography.labelSmall,
        )
        Slider(
            value = row.biasPercent.toFloat(),
            onValueChange = { onUpdate(row.copy(biasPercent = it.toInt())) },
            valueRange = -100f..100f,
            steps = 39,
        )
    }
}

/**
 * One layer-cadence stepper (used for ratioA and ratioB inside [MixedAdvancedEditor]).
 */
@Composable
private fun RatioStepper(label: String, value: Int, onChange: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            color = Color.LightGray,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(end = 6.dp),
        )
        IconButton(
            onClick = { onChange((value - 1).coerceAtLeast(1)) },
            enabled = value > 1,
        ) { Text("−", color = Color.White) }
        Text(value.toString(), color = Color.White, style = MaterialTheme.typography.titleMedium)
        IconButton(
            onClick = { onChange((value + 1).coerceAtMost(8)) },
            enabled = value < 8,
        ) { Text("+", color = Color.White) }
    }
}

/**
 * Section 3 of [ColorMappingPanel] — model colors with explicit "→ prints
 * from" mapping. Each row shows the model's authored color on the LEFT
 * (read-only display by default — tappable to edit), the project filament
 * index, and a tappable mapping target on the RIGHT. The target is the
 * load-bearing UX element — visually disambiguating "what color the model
 * wants" from "which spool we'll use to print it."
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ModelColorsSection(
    projectFilaments: List<FilamentEntry>,
    slotCount: Int,
    printerPalette: List<EffectivePrinterSlot>,
    virtualRows: List<MixedFilamentEntry>,
    paletteSuggestions: List<String>,
    openEdit: ModelRowEdit?,
    onOpenEdit: (ModelRowEdit?) -> Unit,
    onChangeColor: (slotIndex: Int, hex: String) -> Unit,
    onChangeType: (slotIndex: Int, type: String) -> Unit,
    onMapToPhysical: (slotIndex: Int, physicalSlot: Int) -> Unit,
    onMapToVirtual: (slotIndex: Int, virtualSlot: Int) -> Unit,
    onClearMapping: (slotIndex: Int) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Model colors", style = MaterialTheme.typography.titleMedium, color = Color.White)
        Text(
            "Each project filament prints from the slot you point it at. " +
                "Default = T_N (the matching physical slot).",
            color = Color.Gray,
            style = MaterialTheme.typography.labelSmall,
        )
        for (slot in 0 until slotCount) {
            val entry = projectFilaments.getOrNull(slot) ?: FilamentEntry(
                id = "slot_$slot",
                color = "#FFFFFF",
                slotIndex = slot,
            )
            ModelColorRow(
                entry = entry,
                slotIndex = slot,
                printerPalette = printerPalette,
                virtualRows = virtualRows,
                paletteSuggestions = paletteSuggestions,
                openEdit = openEdit,
                onOpenEdit = onOpenEdit,
                onChangeColor = onChangeColor,
                onChangeType = onChangeType,
                onMapToPhysical = onMapToPhysical,
                onMapToVirtual = onMapToVirtual,
                onClearMapping = onClearMapping,
            )
        }
    }
}

/**
 * One model-color row. Layout:
 *
 *   [color] T_N · type            →   [target]
 *
 * - Tapping the LEFT cluster (color + label + material) opens that row's
 *   color/material editor (cosmetic — does not change the mapping).
 * - Tapping the RIGHT [target] opens the mapping picker (printer + virtual
 *   targets, plus a Default reset).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ModelColorRow(
    entry: FilamentEntry,
    slotIndex: Int,
    printerPalette: List<EffectivePrinterSlot>,
    virtualRows: List<MixedFilamentEntry>,
    paletteSuggestions: List<String>,
    openEdit: ModelRowEdit?,
    onOpenEdit: (ModelRowEdit?) -> Unit,
    onChangeColor: (slotIndex: Int, hex: String) -> Unit,
    onChangeType: (slotIndex: Int, type: String) -> Unit,
    onMapToPhysical: (slotIndex: Int, physicalSlot: Int) -> Unit,
    onMapToVirtual: (slotIndex: Int, virtualSlot: Int) -> Unit,
    onClearMapping: (slotIndex: Int) -> Unit,
) {
    val colorOpen = openEdit == ModelRowEdit.Color(slotIndex)
    val mappingOpen = openEdit == ModelRowEdit.Mapping(slotIndex)
    val materialOpen = openEdit == ModelRowEdit.Material(slotIndex)

    val target = resolveMappingTarget(entry, slotIndex, printerPalette, virtualRows)

    Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(8.dp)) {
        Column {
            Row(
                modifier = Modifier
                    .padding(horizontal = 10.dp, vertical = 8.dp)
                    .fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .clickable {
                            onOpenEdit(if (colorOpen) null else ModelRowEdit.Color(slotIndex))
                        }
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SwatchBox(
                            entry.color,
                            size = 36.dp,
                            highlight = colorOpen,
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Column {
                            Text(
                                "Filament ${slotIndex + 1}",
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                entry.color.uppercase(),
                                color = Color.LightGray,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
                Spacer(modifier = Modifier.weight(1f))
                Text("→", color = Color.LightGray, style = MaterialTheme.typography.titleMedium)
                MappingTargetButton(
                    target = target,
                    selected = mappingOpen,
                    onTap = {
                        onOpenEdit(if (mappingOpen) null else ModelRowEdit.Mapping(slotIndex))
                    },
                )
            }

            // Material chip on its own row so the long row above stays
            // readable. Tapping it expands the type picker.
            Row(
                modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "Material",
                    color = Color.Gray,
                    style = MaterialTheme.typography.labelSmall,
                )
                Surface(
                    color = Color(0xFF15181B),
                    shape = RoundedCornerShape(6.dp),
                    modifier = Modifier.clickable {
                        onOpenEdit(if (materialOpen) null else ModelRowEdit.Material(slotIndex))
                    },
                ) {
                    Text(
                        entry.filamentType,
                        color = Color.White,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }

            if (mappingOpen) {
                MappingTargetEditor(
                    entry = entry,
                    slotIndex = slotIndex,
                    printerPalette = printerPalette,
                    virtualRows = virtualRows,
                    onMapToPhysical = { physical ->
                        onMapToPhysical(slotIndex, physical)
                        onOpenEdit(null)
                    },
                    onMapToVirtual = { virtual ->
                        onMapToVirtual(slotIndex, virtual)
                        onOpenEdit(null)
                    },
                    onClearMapping = {
                        onClearMapping(slotIndex)
                        onOpenEdit(null)
                    },
                    onCancel = { onOpenEdit(null) },
                )
            }
            if (colorOpen) {
                ColorOnlyEditor(
                    initialHex = entry.color,
                    paletteSuggestions = paletteSuggestions,
                    onPick = { hex ->
                        onChangeColor(slotIndex, hex)
                        onOpenEdit(null)
                    },
                    onCancel = { onOpenEdit(null) },
                )
            }
            if (materialOpen) {
                MaterialChooser(
                    selected = entry.filamentType,
                    onPick = { t ->
                        onChangeType(slotIndex, t)
                        onOpenEdit(null)
                    },
                    onCancel = { onOpenEdit(null) },
                )
            }
        }
    }
}

/**
 * The right-side mapping target chip. Renders the destination as a swatch +
 * label so the user reads the row at a glance ("→ T2 (Yellow PLA)" or "→ V1
 * mix"). Tapping toggles the inline picker below.
 */
@Composable
private fun MappingTargetButton(
    target: ResolvedMappingTarget,
    selected: Boolean,
    onTap: () -> Unit,
) {
    Surface(
        color = if (selected) Color(0xFF24323D) else Color(0xFF15181B),
        shape = RoundedCornerShape(6.dp),
        border = if (selected) BorderStroke(1.dp, Color(0xFF7BC8FF)) else null,
        modifier = Modifier.clickable(onClick = onTap),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            SwatchBox(target.colorHex, size = 24.dp, accent = target.isVirtual)
            Column {
                Text(
                    target.primaryLabel,
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
                if (target.secondaryLabel != null) {
                    Text(
                        target.secondaryLabel,
                        color = Color.LightGray,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}

/**
 * Picker shown when the user taps the right-side mapping target chip.
 * Offers Default, every printer slot, and every enabled virtual mix in
 * a single panel so the user makes the choice in one tap.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MappingTargetEditor(
    entry: FilamentEntry,
    slotIndex: Int,
    printerPalette: List<EffectivePrinterSlot>,
    virtualRows: List<MixedFilamentEntry>,
    onMapToPhysical: (physicalSlot: Int) -> Unit,
    onMapToVirtual: (virtualSlot: Int) -> Unit,
    onClearMapping: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "Print this filament from…",
            color = Color.LightGray,
            style = MaterialTheme.typography.labelSmall,
        )
        // Default option (identity: filament N → T_N). Bigger tap target
        // because it's the safe fallback the user will reach for first.
        Surface(
            color = if (entry.physicalSlot == null && entry.virtualSlot == null)
                Color(0xFF24323D) else Color(0xFF15181B),
            shape = RoundedCornerShape(6.dp),
            border = if (entry.physicalSlot == null && entry.virtualSlot == null)
                BorderStroke(1.dp, Color(0xFF7BC8FF)) else null,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onClearMapping),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val def = printerPalette.getOrNull(slotIndex)
                SwatchBox(def?.colorHex ?: "#FFFFFF", size = 28.dp)
                Column {
                    Text(
                        "Default — T${slotIndex + 1}",
                        color = Color.White,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "Identity mapping (project filament ${slotIndex + 1} prints on T${slotIndex + 1})",
                        color = Color.Gray,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }

        Text("Printer slots", color = Color.LightGray, style = MaterialTheme.typography.labelSmall)
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (slot in printerPalette) {
                val isSelected = entry.physicalSlot == slot.slotIndex
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { onMapToPhysical(slot.slotIndex) }
                        .padding(2.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(parseHexColorOrDefault(slot.colorHex))
                            .border(
                                if (isSelected) 2.dp else 1.dp,
                                if (isSelected) Color(0xFF7BC8FF) else Color(0xFF2C3138),
                                RoundedCornerShape(6.dp),
                            ),
                    )
                    Text(
                        "T${slot.slotIndex + 1}",
                        color = if (isSelected) Color(0xFF7BC8FF) else Color.Gray,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }

        val visibleVirtual = virtualRows.filter { !it.deleted && it.enabled }
        if (visibleVirtual.isNotEmpty()) {
            Text("Virtual mixes", color = Color.LightGray, style = MaterialTheme.typography.labelSmall)
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for ((idx, row) in visibleVirtual.withIndex()) {
                    val virtualSlot = idx + 1
                    val isSelected = entry.virtualSlot == virtualSlot
                    val a = printerPalette.getOrNull(row.componentA - 1)?.colorHex ?: "#FFFFFF"
                    val b = printerPalette.getOrNull(row.componentB - 1)?.colorHex ?: "#FFFFFF"
                    val preview = blendMixedColor(a, b, row.ratioA, row.ratioB)
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable { onMapToVirtual(virtualSlot) }
                            .padding(2.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .background(parseHexColorOrDefault(preview))
                                .border(
                                    if (isSelected) 2.dp else 1.dp,
                                    if (isSelected) Color(0xFF7BC8FF) else Color(0xFF7BC8FF).copy(alpha = 0.4f),
                                    RoundedCornerShape(6.dp),
                                ),
                        )
                        Text(
                            "V$virtualSlot",
                            color = if (isSelected) Color(0xFF7BC8FF) else Color.Gray,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        )
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = onCancel) {
                Text("Close", color = Color.Gray)
            }
        }
    }
}

/**
 * Cosmetic-only color editor for a model row. Manual hex + common-color
 * palette, no printer-slot or virtual-slot swatches (those live in
 * [MappingTargetEditor]). Saving here updates the row's swatch but does
 * NOT touch the mapping target — the model's authored color is editable
 * (the user might want to recolor a 3MF locally) without losing their
 * mapping setup.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ColorOnlyEditor(
    initialHex: String,
    paletteSuggestions: List<String>,
    onPick: (String) -> Unit,
    onCancel: () -> Unit,
) {
    var hex by remember(initialHex) {
        mutableStateOf(initialHex.removePrefix("#").uppercase().take(6))
    }
    val effective = "#" + hex.padStart(6, '0').take(6)
    Column(
        modifier = Modifier
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(36.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(parseHexColorOrDefault(effective))
                .border(1.dp, Color(0xFF2C3138), RoundedCornerShape(6.dp)),
        )
        Text(
            "Common colors",
            color = Color.LightGray,
            style = MaterialTheme.typography.labelSmall,
        )
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (preset in paletteSuggestions) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(parseHexColorOrDefault(preset))
                        .border(1.dp, Color(0xFF2C3138), RoundedCornerShape(6.dp))
                        .clickable { onPick(preset) },
                )
            }
        }
        TextField(
            value = hex,
            onValueChange = { input ->
                hex = input.uppercase().filter { it.isDigit() || it in 'A'..'F' }.take(6)
            },
            singleLine = true,
            label = { Text("Hex (RRGGBB)") },
            placeholder = { Text("FF6B00") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
            colors = TextFieldDefaults.colors(
                unfocusedContainerColor = Color(0xFF15181B),
                focusedContainerColor = Color(0xFF15181B),
                unfocusedTextColor = Color.White,
                focusedTextColor = Color.White,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
        ) {
            TextButton(onClick = onCancel) { Text("Cancel", color = Color.Gray) }
            TextButton(
                enabled = hex.length == 6,
                onClick = { onPick(effective) },
            ) { Text("Save", color = Color(0xFF7BC8FF)) }
        }
    }
}

/**
 * Material picker shown when the user taps a model row's material chip.
 * Pure single-tap selection — no save button.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MaterialChooser(
    selected: String,
    onPick: (String) -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Material", color = Color.LightGray, style = MaterialTheme.typography.labelSmall)
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (t in FILAMENT_TYPES) {
                val isSelected = t == selected
                Surface(
                    color = if (isSelected) Color(0xFF24323D) else Color(0xFF15181B),
                    shape = RoundedCornerShape(6.dp),
                    border = if (isSelected) BorderStroke(1.dp, Color(0xFF7BC8FF)) else null,
                    modifier = Modifier.clickable { onPick(t) },
                ) {
                    Text(
                        t,
                        color = Color.White,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel) { Text("Close", color = Color.Gray) }
        }
    }
}

/**
 * A flat color swatch used in many places. [highlight] paints a brighter
 * outline (matches the row-edit-open visual). [accent] uses the cyan
 * outline that virtual swatches share, signaling "this isn't a single
 * physical color."
 */
@Composable
private fun SwatchBox(
    colorHex: String,
    size: androidx.compose.ui.unit.Dp = 32.dp,
    highlight: Boolean = false,
    accent: Boolean = false,
) {
    val border = when {
        highlight -> Color(0xFF7BC8FF)
        accent -> Color(0xFF7BC8FF).copy(alpha = 0.6f)
        else -> Color(0xFF2C3138)
    }
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(6.dp))
            .background(parseHexColorOrDefault(colorHex))
            .border(if (highlight || accent) 1.5.dp else 1.dp, border, RoundedCornerShape(6.dp)),
    )
}

/**
 * Resolved snapshot of a model row's mapping target. Carries everything the
 * row needs to render the right-side chip without re-running the resolution
 * logic at multiple call sites.
 */
private data class ResolvedMappingTarget(
    val colorHex: String,
    val primaryLabel: String,
    val secondaryLabel: String?,
    val isVirtual: Boolean,
)

private fun resolveMappingTarget(
    entry: FilamentEntry,
    slotIndex: Int,
    printerPalette: List<EffectivePrinterSlot>,
    virtualRows: List<MixedFilamentEntry>,
): ResolvedMappingTarget {
    val virtualSlot = entry.virtualSlot
    val physicalSlot = entry.physicalSlot
    return when {
        virtualSlot != null -> {
            val visible = virtualRows.filter { !it.deleted && it.enabled }
            val row = visible.getOrNull(virtualSlot - 1)
            if (row != null) {
                val a = printerPalette.getOrNull(row.componentA - 1)?.colorHex ?: "#FFFFFF"
                val b = printerPalette.getOrNull(row.componentB - 1)?.colorHex ?: "#FFFFFF"
                ResolvedMappingTarget(
                    colorHex = blendMixedColor(a, b, row.ratioA, row.ratioB),
                    primaryLabel = "V$virtualSlot",
                    secondaryLabel = "T${row.componentA}+T${row.componentB}",
                    isVirtual = true,
                )
            } else {
                // Virtual row was removed under the selection — surface the
                // dangling state honestly instead of pretending it printed.
                ResolvedMappingTarget(
                    colorHex = "#888888",
                    primaryLabel = "V$virtualSlot",
                    secondaryLabel = "missing",
                    isVirtual = true,
                )
            }
        }
        physicalSlot != null -> {
            val slot = printerPalette.getOrNull(physicalSlot)
            ResolvedMappingTarget(
                colorHex = slot?.colorHex ?: "#FFFFFF",
                primaryLabel = "T${physicalSlot + 1}",
                secondaryLabel = slot?.material?.takeUnless { it == "—" },
                isVirtual = false,
            )
        }
        else -> {
            val def = printerPalette.getOrNull(slotIndex)
            ResolvedMappingTarget(
                colorHex = def?.colorHex ?: "#FFFFFF",
                primaryLabel = "T${slotIndex + 1}",
                secondaryLabel = "default",
                isVirtual = false,
            )
        }
    }
}

private fun unorderedKey(a: Int, b: Int): Long {
    val lo = minOf(a, b).toLong()
    val hi = maxOf(a, b).toLong()
    return (lo shl 32) or hi
}

private fun firstUnusedPair(physicalCount: Int, taken: Set<Long>): Pair<Int, Int>? {
    for (a in 1..physicalCount) {
        for (b in (a + 1)..physicalCount) {
            if (unorderedKey(a, b) !in taken) return a to b
        }
    }
    return null
}


/**
 * Format seconds since slice start as `m:ss` (or `h:mm:ss` past 1 h).
 * The progress UI shows this next to the percent so the user has a
 * second-by-second sign of life even when libslic3r doesn't fire any
 * percent updates (e.g. mid-MMU-segmentation).
 */
private fun formatElapsedSeconds(totalSec: Long): String {
    val s = totalSec.coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec)
    else "%d:%02d".format(m, sec)
}

private fun parseHexColorOrDefault(hex: String): Color {
    val cleaned = hex.removePrefix("#").trim()
    if (cleaned.length != 6) return Color.LightGray
    return runCatching {
        val r = cleaned.substring(0, 2).toInt(16)
        val g = cleaned.substring(2, 4).toInt(16)
        val b = cleaned.substring(4, 6).toInt(16)
        Color(r, g, b)
    }.getOrDefault(Color.LightGray)
}

@Composable
fun RightSettingsPanel(
    allProfiles: List<SlicerProfile>,
    selectedProfile: SlicerProfile,
    onProfileSelect: (SlicerProfile) -> Unit,
    onSaveAsProfile: (String) -> Unit,
    onDeleteProfile: (String) -> Unit,
    layerHeightOverride: String,
    onLayerHeightChange: (String) -> Unit,
    /** User-typed Speed / Support tab edits, sparse map keyed by libslic3r
     *  config key. Empty = no overrides; the Tab composables fall back
     *  to the active profile's defaults via [SlicerProfile.config]. */
    printSettingsOverrides: Map<String, String> = emptyMap(),
    /** Called when the user edits a Speed / Support field. Empty value =
     *  delete the override (i.e. revert to profile default for that key);
     *  non-empty = upsert the override. */
    onPrintSettingChange: (key: String, value: String) -> Unit = { _, _ -> },
) {
    var selectedTab by remember { mutableStateOf(0) }
    val tabs = listOf("Quality", "Strength", "Speed", "Support", "Others")
    var showSaveDialog by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF15181B))
            .padding(16.dp)
    ) {
        Text("Print Settings", style = MaterialTheme.typography.titleLarge, color = Color.White)
        Spacer(modifier = Modifier.height(16.dp))

        // Profile selector — proper dropdown so users see the catalog
        // at a glance instead of cycling blind through it. Built-in
        // entries can't be deleted; user-saved entries can.
        ProfileDropdown(
            allProfiles = allProfiles,
            selectedProfile = selectedProfile,
            onProfileSelect = onProfileSelect,
            onDeleteProfile = onDeleteProfile,
        )

        Spacer(modifier = Modifier.height(8.dp))
        TextButton(
            onClick = { showSaveDialog = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Save current settings as profile…", color = Color(0xFF7BC8FF))
        }

        if (showSaveDialog) {
            SaveProfileDialog(
                suggestedName = selectedProfile.displayName,
                onConfirm = { name ->
                    onSaveAsProfile(name)
                    showSaveDialog = false
                },
                onDismiss = { showSaveDialog = false },
            )
        }
        
        Spacer(modifier = Modifier.height(16.dp))

        // Tabs
        PrimaryScrollableTabRow(
            selectedTabIndex = selectedTab,
            containerColor = Color.Transparent,
            contentColor = Color(0xFF7BC8FF),
            edgePadding = 0.dp
        ) {
            tabs.forEachIndexed { index, title ->
                Tab(
                    selected = selectedTab == index,
                    onClick = { selectedTab = index },
                    text = { Text(title, color = if (selectedTab == index) Color(0xFF7BC8FF) else Color.Gray) }
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Tab content scrolls independently of the title / profile picker
        // / tab bar above. Without this the Strength/Support tabs
        // overflow the panel height and the lower controls fall off-
        // screen with no way to reach them. fillMaxWidth keeps each row
        // full-bleed; weight(1f) gives the scroll area whatever vertical
        // space remains so the user always sees as much as fits.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState()),
        ) {
            when (selectedTab) {
                0 -> QualityTab(selectedProfile, layerHeightOverride, onLayerHeightChange)
                1 -> StrengthTab(selectedProfile)
                2 -> SpeedTab(selectedProfile, printSettingsOverrides, onPrintSettingChange)
                3 -> SupportTab(selectedProfile, printSettingsOverrides, onPrintSettingChange)
                4 -> OthersTab(selectedProfile)
            }
        }
    }
}

@Composable
private fun QualityTab(
    profile: SlicerProfile,
    layerHeightOverride: String,
    onLayerHeightChange: (String) -> Unit,
) {
    Text("Layer Height", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))

    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Layer height", color = Color.LightGray, style = MaterialTheme.typography.bodyMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = layerHeightOverride,
                onValueChange = onLayerHeightChange,
                placeholder = { Text(profile.config["layer_height"] ?: "0.20", color = Color.Gray) },
                modifier = Modifier.width(100.dp),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = Color(0xFF1B1F23),
                    focusedContainerColor = Color(0xFF1B1F23),
                    unfocusedTextColor = Color.White,
                    focusedTextColor = Color.White,
                ),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text("mm", color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(24.dp))
        }
    }

    SettingRow(
        "First layer height",
        profile.config["initial_layer_print_height"] ?: profile.config["first_layer_height"] ?: "—",
        "mm",
    )

    Spacer(modifier = Modifier.height(16.dp))
    Text("Walls", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))
    SettingRow("Wall loops", profile.config["wall_loops"] ?: "—", "")
}

@Composable
private fun StrengthTab(profile: SlicerProfile) {
    Text("Infill", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))
    SettingRow("Density", profile.config["sparse_infill_density"] ?: "—", "")

    Spacer(modifier = Modifier.height(16.dp))
    Text("Shells", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))
    SettingRow("Top layers", profile.config["top_shell_layers"] ?: "—", "")
    SettingRow("Bottom layers", profile.config["bottom_shell_layers"] ?: "—", "")
    SettingRow("Wall loops", profile.config["wall_loops"] ?: "—", "")
}

@Composable
private fun OthersTab(profile: SlicerProfile) {
    Text("Temperatures", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))
    SettingRow("Nozzle", profile.config["nozzle_temperature"] ?: "—", "°C")
    SettingRow("Nozzle (1st layer)", profile.config["nozzle_temperature_initial_layer"] ?: "—", "°C")
    SettingRow("Bed", profile.config["hot_plate_temp"] ?: "—", "°C")

    Spacer(modifier = Modifier.height(16.dp))
    Text("Cooling", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))
    SettingRow("Fan max", profile.config["fan_max_speed"] ?: "—", "%")
}

/**
 * Speed-tab editor. Every field is a coFloat single value in libslic3r —
 * no per-extruder vector treatment needed. Empty TextField shows the
 * profile default; typing replaces it.
 */
@Composable
private fun SpeedTab(
    profile: SlicerProfile,
    overrides: Map<String, String>,
    onChange: (String, String) -> Unit,
) {
    Text("Print speeds", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))

    SettingNumericEditor(
        label = "Initial layer",
        key = "initial_layer_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
    SettingNumericEditor(
        label = "Outer wall",
        key = "outer_wall_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
    SettingNumericEditor(
        label = "Inner wall",
        key = "inner_wall_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
    SettingNumericEditor(
        label = "Sparse infill",
        key = "sparse_infill_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
    SettingNumericEditor(
        label = "Solid infill",
        key = "internal_solid_infill_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
    SettingNumericEditor(
        label = "Support",
        key = "support_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
    SettingNumericEditor(
        label = "Travel",
        key = "travel_speed",
        unit = "mm/s",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
    )
}

/**
 * Support-tab editor. enable_support is a Switch; support_type is a
 * segmented chooser over libslic3r's four-element SupportType enum
 * (PrintConfig.cpp:`add("support_type"…)` — string tokens
 * normal(auto) / tree(auto) / normal(manual) / tree(manual)). Threshold
 * angle and interface layers are integers; top z distance is a float.
 *
 * The "Paint Supports" button in the plan §3 is intentionally NOT shipped
 * here — it depends on the §5 Support paint pipeline (`PaintMode.Support`),
 * which doesn't exist yet. Adding the button now would be exactly the
 * "dead chrome" the plan §0 warns against.
 */
@Composable
private fun SupportTab(
    profile: SlicerProfile,
    overrides: Map<String, String>,
    onChange: (String, String) -> Unit,
) {
    Text("Support", style = MaterialTheme.typography.titleMedium, color = Color.White)
    Spacer(modifier = Modifier.height(8.dp))

    val enableValue = overrides["enable_support"] ?: profile.config["enable_support"] ?: "0"
    val isEnabled = enableValue.trim() in listOf("1", "true", "True")
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Enable supports", color = Color.LightGray, style = MaterialTheme.typography.bodyMedium)
        Switch(
            checked = isEnabled,
            onCheckedChange = { onChange("enable_support", if (it) "1" else "0") },
        )
    }

    Spacer(modifier = Modifier.height(8.dp))
    Text("Style", color = Color.LightGray, style = MaterialTheme.typography.bodyMedium)
    val supportType = overrides["support_type"] ?: profile.config["support_type"] ?: "normal(auto)"
    val supportTypes = listOf(
        "normal(auto)" to "Normal · auto",
        "tree(auto)" to "Tree · auto",
        "normal(manual)" to "Normal · manual",
        "tree(manual)" to "Tree · manual",
    )
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 4.dp)) {
        for ((value, label) in supportTypes) {
            val selected = supportType == value
            Surface(
                color = if (selected) Color(0xFF24323D) else Color(0xFF1B1F23),
                shape = RoundedCornerShape(8.dp),
                border = if (selected) BorderStroke(1.dp, Color(0xFF7BC8FF)) else null,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = isEnabled) { onChange("support_type", value) },
            ) {
                Text(
                    label,
                    color = if (isEnabled) (if (selected) Color.White else Color.LightGray) else Color.Gray,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
    }

    Spacer(modifier = Modifier.height(12.dp))
    SettingNumericEditor(
        label = "Threshold angle",
        key = "support_threshold_angle",
        unit = "°",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
        enabled = isEnabled,
    )
    SettingNumericEditor(
        label = "Top Z distance",
        key = "support_top_z_distance",
        unit = "mm",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
        enabled = isEnabled,
    )
    SettingNumericEditor(
        label = "Interface top layers",
        key = "support_interface_top_layers",
        unit = "",
        profile = profile,
        overrides = overrides,
        onChange = onChange,
        enabled = isEnabled,
    )
}

/**
 * One labelled numeric TextField backed by a sparse override map.
 * Empty input deletes the override (revert to profile default). Used by
 * SpeedTab and SupportTab — same pattern as QualityTab's layer-height
 * editor.
 */
@Composable
private fun SettingNumericEditor(
    label: String,
    key: String,
    unit: String,
    profile: SlicerProfile,
    overrides: Map<String, String>,
    onChange: (String, String) -> Unit,
    enabled: Boolean = true,
) {
    val current = overrides[key] ?: ""
    val placeholder = profile.config[key] ?: "—"
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = if (enabled) Color.LightGray else Color.Gray, style = MaterialTheme.typography.bodyMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = current,
                onValueChange = { onChange(key, it) },
                placeholder = { Text(placeholder, color = Color.Gray) },
                enabled = enabled,
                modifier = Modifier.width(100.dp),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = Color(0xFF1B1F23),
                    focusedContainerColor = Color(0xFF1B1F23),
                    unfocusedTextColor = Color.White,
                    focusedTextColor = Color.White,
                    disabledContainerColor = Color(0xFF15181B),
                    disabledTextColor = Color.Gray,
                ),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(unit, color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(40.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PrinterDropdown(
    printers: List<PrinterConfig>,
    selectedPrinterId: String?,
    onSelect: (String?) -> Unit,
    onOpenDevices: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = printers.firstOrNull { it.id == selectedPrinterId } ?: printers.first()
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = Modifier.fillMaxWidth(),
    ) {
        TextField(
            value = selected.name,
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            colors = TextFieldDefaults.colors(
                unfocusedContainerColor = Color(0xFF1B1F23),
                focusedContainerColor = Color(0xFF1B1F23),
                unfocusedTextColor = Color.White,
                focusedTextColor = Color.White,
            ),
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, true)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            containerColor = Color(0xFF1B1F23),
        ) {
            for (p in printers) {
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(p.name, color = Color.White, fontWeight = FontWeight.Bold)
                            Text(
                                "${p.host}:${p.port}",
                                color = Color.Gray,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    },
                    onClick = {
                        onSelect(p.id)
                        expanded = false
                    },
                )
            }
            HorizontalDivider(color = Color(0xFF2A2F35))
            DropdownMenuItem(
                text = { Text("Manage printers…", color = Color(0xFF7BC8FF)) },
                onClick = {
                    expanded = false
                    onOpenDevices()
                },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProfileDropdown(
    allProfiles: List<SlicerProfile>,
    selectedProfile: SlicerProfile,
    onProfileSelect: (SlicerProfile) -> Unit,
    onDeleteProfile: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val builtinIds = remember { Profiles.all.map { it.id }.toSet() }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text("Profile", color = Color.Gray, modifier = Modifier.width(60.dp))
        ExposedDropdownMenuBox(
            expanded = expanded,
            onExpandedChange = { expanded = it },
            modifier = Modifier.fillMaxWidth(),
        ) {
            TextField(
                value = selectedProfile.displayName,
                onValueChange = {},
                readOnly = true,
                singleLine = true,
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = Color(0xFF1B1F23),
                    focusedContainerColor = Color(0xFF1B1F23),
                    unfocusedTextColor = Color.White,
                    focusedTextColor = Color.White,
                ),
                modifier = Modifier
                    .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, true)
                    .fillMaxWidth(),
            )
            ExposedDropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                containerColor = Color(0xFF1B1F23),
            ) {
                for (p in allProfiles) {
                    val isUserProfile = p.id !in builtinIds
                    DropdownMenuItem(
                        text = {
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (isUserProfile) {
                                        Text(
                                            "★ ",
                                            color = Color(0xFFFF9F4A),
                                            style = MaterialTheme.typography.bodyMedium,
                                        )
                                    }
                                    Text(p.displayName, color = Color.White, fontWeight = FontWeight.Bold)
                                }
                                Text(
                                    p.description,
                                    color = Color.Gray,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        },
                        // Built-ins have no trailing action; user
                        // profiles get an inline ✕ that deletes them.
                        // We swallow the click on the trailing button
                        // so it doesn't also fire the onClick (which
                        // would select then delete in the same gesture).
                        trailingIcon = if (isUserProfile) {
                            {
                                IconButton(onClick = { onDeleteProfile(p.id) }) {
                                    Text("✕", color = Color.Gray)
                                }
                            }
                        } else null,
                        onClick = {
                            onProfileSelect(p)
                            expanded = false
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SaveProfileDialog(
    suggestedName: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf("$suggestedName (custom)") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name) },
                enabled = name.isNotBlank(),
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Save profile") },
        text = {
            Column {
                Text(
                    "Capture the current profile and any layer-height " +
                        "override as a reusable named profile.",
                    color = Color.LightGray,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
                TextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    label = { Text("Profile name") },
                )
            }
        },
    )
}

@Composable
fun SettingRow(label: String, value: String, unit: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, color = Color.LightGray, style = MaterialTheme.typography.bodyMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Surface(color = Color(0xFF1B1F23), shape = RoundedCornerShape(4.dp), modifier = Modifier.width(60.dp)) {
                Text(value, color = Color.White, modifier = Modifier.padding(4.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End)
            }
            if (unit.isNotEmpty()) {
                Spacer(modifier = Modifier.width(8.dp))
                Text(unit, color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(24.dp))
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun BottomLayerPreviewPanel(
    parsed: ParsedToolpath?,
    currentLayer: Int,
    maxLayers: Int,
    onLayerChange: (Int) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF15181B))
            .padding(16.dp)
    ) {
        Text("Layer Preview", style = MaterialTheme.typography.titleMedium, color = Color.White)
        Spacer(modifier = Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text("Layer: ${currentLayer + 1} / $maxLayers", color = Color.LightGray)
        }
        // Slider valueRange/steps must stay valid even when no slice has
        // happened yet (maxLayers can be 0 or 1). Coerce both ends to a
        // safe range so dragging never throws IllegalArgumentException.
        val sliderMax = (maxLayers - 1).coerceAtLeast(0)
        Slider(
            enabled = maxLayers > 1,
            value = currentLayer.coerceIn(0, sliderMax).toFloat(),
            onValueChange = { onLayerChange(it.toInt()) },
            valueRange = 0f..sliderMax.toFloat().coerceAtLeast(1f),
            steps = (sliderMax - 1).coerceAtLeast(0),
        )

        // Legend reflects the roles actually present in the parsed
        // toolpath, colored from the same RoleColors table the GLB
        // builder uses. Skip Unknown — it's the catch-all for segments
        // libslic3r didn't tag and tells the user nothing useful.
        val rolesInOrder: List<ExtrusionRole> = parsed
            ?.segments
            ?.asSequence()
            ?.map { it.role }
            ?.filter { it != ExtrusionRole.Unknown }
            ?.distinct()
            ?.toList()
            .orEmpty()

        if (rolesInOrder.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (role in rolesInOrder) {
                    val rgb = RoleColors.colorFor(role)
                    LegendItem(Color(rgb.r, rgb.g, rgb.b, 1f), role.tag)
                }
            }
        }
    }
}

@Composable
fun LegendItem(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(modifier = Modifier.size(12.dp).background(color, RoundedCornerShape(2.dp)))
        Text(label, color = Color.LightGray, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun BottomRightSummaryPanel(
    sliceState: SliceUiState,
    sliceTarget: String,
    activePrinterName: String?,
    canSaveModel: Boolean,
    onSliceClick: () -> Unit,
    onSaveGcode: () -> Unit,
    onSaveModelStl: () -> Unit,
    onSaveProject3mf: () -> Unit,
    onSendAndPrint: () -> Unit,
    /** Phase E (filament-vs-bed compatibility): blocks slicing on
     *  [FilamentRules.Result.Forbidden]. Warning and Ok both leave the
     *  Slice button enabled — the caller surfaces the warning state in
     *  the LeftProjectPanel banner instead. */
    filamentRuleResult: FilamentRules.Result = FilamentRules.Result.Ok,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF15181B))
            .padding(16.dp),
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        Text("Slicing Summary", style = MaterialTheme.typography.titleMedium, color = Color.White)

        val isSlicing = sliceState is SliceUiState.Slicing
        val isForbidden = filamentRuleResult is FilamentRules.Result.Forbidden

        Button(
            onClick = onSliceClick,
            enabled = !isSlicing && !isForbidden,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = Color(0xFF00BFA5),
                disabledContainerColor = Color(0xFF2A2F33),
            ),
        ) {
            if (isForbidden && !isSlicing) {
                // Compact in-button hint so the user understands WHY the
                // button is grey without having to track up to the
                // LeftProjectPanel banner. The banner carries the full
                // explanation; this is just the affordance.
                Text(
                    "Filament not supported",
                    color = Color(0xFFFF8A8E),
                    fontWeight = FontWeight.Bold,
                )
            } else if (isSlicing) {
                val s = sliceState as SliceUiState.Slicing
                // Tick once a second so the elapsed counter advances
                // visually even when libslic3r isn't firing percent
                // updates (e.g. during the long MMU segmentation
                // phase between 5% "Slicing mesh" and 15% "Generating
                // walls" — silent on the libslic3r side, can be
                // many minutes on serial-TBB Android).
                var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
                LaunchedEffect(s.startedAtMs) {
                    while (true) {
                        nowMs = System.currentTimeMillis()
                        kotlinx.coroutines.delay(1_000)
                    }
                }
                val elapsed = formatElapsedSeconds((nowMs - s.startedAtMs) / 1000)
                val label = if (s.percent in 0..100) {
                    "Slicing… ${s.percent}% · $elapsed"
                } else {
                    "Slicing… $elapsed"
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Text(label, color = Color.White, fontWeight = FontWeight.Bold)
                }
            } else {
                // Show what we're about to slice. Reads as a clear
                // affirmative action ("Slice <name>") instead of an
                // ambiguous "Slice Now" that doesn't tell the user
                // whether the loaded model or the demo cube goes through.
                Text("Slice $sliceTarget", color = Color.White, fontWeight = FontWeight.Bold)
            }
        }
        if (isSlicing) {
            val s = sliceState as SliceUiState.Slicing
            // Always show a progress bar — indeterminate when no
            // percent has come in yet, determinate once libslic3r
            // reports one. Indeterminate at least tells the user the
            // bar exists and is alive.
            Spacer(modifier = Modifier.height(6.dp))
            if (s.percent in 0..100) {
                LinearProgressIndicator(
                    progress = { s.percent / 100f },
                    modifier = Modifier.fillMaxWidth(),
                    color = Color(0xFF00BFA5),
                    trackColor = Color(0xFF2A2F33),
                )
            } else {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth(),
                    color = Color(0xFF00BFA5),
                    trackColor = Color(0xFF2A2F33),
                )
            }
            if (s.message.isNotBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    s.message,
                    color = Color(0xFFB6BEC8),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (sliceState is SliceUiState.Done) {
                val stats = sliceState.parsed?.stats
                SummaryRow("Estimated Time", stats?.estimatedPrintTime ?: "Unknown")

                val weight = stats?.filamentWeightG?.let { "%.1f g".format(it) } ?: "Unknown"
                val length = stats?.totalExtrusionLengthMm?.let { "%.2f m".format(it / 1000.0) } ?: "Unknown"
                SummaryRow("Filament Usage", "$length   $weight")

                val result = sliceState.result as? SliceResult.Success
                SummaryRow("G-Code Size", result?.sizeBytes?.let { "${it / 1024} KB" } ?: "Unknown")

                if (result != null) {
                    Spacer(modifier = Modifier.height(4.dp))
                    if (activePrinterName != null) {
                        Button(
                            onClick = onSendAndPrint,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color(0xFF7BC8FF),
                                contentColor = Color(0xFF002D45),
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                "Send to $activePrinterName & print",
                                fontWeight = FontWeight.Bold,
                            )
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                    }
                    OutlinedButton(
                        onClick = onSaveGcode,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Save G-code to Downloads") }
                }
            } else {
                SummaryRow("Estimated Time", "--")
                SummaryRow("Filament Usage", "--")
                SummaryRow("G-Code Size", "--")
            }

            // Model export — always available once a model is loaded,
            // independent of slice state. Useful for stashing a
            // prepared mesh between sessions or sharing with desktop
            // OrcaSlicer. STL drops the transformed mesh; 3MF wraps
            // the original mesh + the active slicer config so a
            // re-open lands at the same settings.
            if (canSaveModel) {
                Spacer(modifier = Modifier.height(4.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    OutlinedButton(
                        onClick = onSaveModelStl,
                        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp),
                        modifier = Modifier.weight(1f),
                    ) { Text("Save .stl", maxLines = 1) }
                    OutlinedButton(
                        onClick = onSaveProject3mf,
                        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp),
                        modifier = Modifier.weight(1f),
                    ) { Text("Save .3mf", maxLines = 1) }
                }
            }
        }
    }
}

@Composable
fun SummaryRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Color.Gray, style = MaterialTheme.typography.bodyMedium)
        Text(value, color = Color.White, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
    }
}

/** What the user is doing with the workspace right now. */
enum class WorkspaceMode { Prepare, Preview }

@Composable
fun TopNavigationPill(
    mode: WorkspaceMode,
    onModeChange: (WorkspaceMode) -> Unit,
    previewEnabled: Boolean,
    onResetWorkspace: () -> Unit,
    devicesShown: Boolean,
    onToggleDevices: () -> Unit,
    modelRotZDeg: Int,
    rotateEnabled: Boolean,
    onRotateModel: () -> Unit,
    modelScalePct: Int,
    scaleEnabled: Boolean,
    onScaleModel: () -> Unit,
    /** Phase J paint controls. */
    paintBrush: PaintBrush = PaintBrush(),
    paintEnabled: Boolean = false,
    onTogglePaint: () -> Unit = {},
    onPaintSlotChange: (Int) -> Unit = {},
    onPaintRadiusChange: (Float) -> Unit = {},
    paintMaxSlots: Int = 4,
    /**
     * Resolved "as will print" colors for paint slots 1..[paintMaxSlots]
     * (size = paintMaxSlots). The Paint mode swatch row uses these so
     * the user picks a color visually instead of cycling a "Slot N"
     * counter. Empty list → falls back to filament_id-only labels (the
     * old behavior).
     */
    paintPalette: List<String> = emptyList(),
) {
    Surface(
        color = Color(0xFF1B1F23).copy(alpha = 0.9f),
        shape = RoundedCornerShape(32.dp),
        modifier = Modifier.padding(8.dp)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Top Row: App Modes
            Row(
                horizontalArrangement = Arrangement.spacedBy(24.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                NavAction(
                    label = "Prepare",
                    icon = androidx.compose.material.icons.Icons.Default.Build,
                    isSelected = mode == WorkspaceMode.Prepare,
                    onClick = { onModeChange(WorkspaceMode.Prepare) },
                )
                NavAction(
                    label = "Preview",
                    icon = androidx.compose.material.icons.Icons.Default.Visibility,
                    isSelected = mode == WorkspaceMode.Preview,
                    enabled = previewEnabled,
                    onClick = { if (previewEnabled) onModeChange(WorkspaceMode.Preview) },
                )
                NavAction(
                    label = "Device",
                    icon = androidx.compose.material.icons.Icons.Default.SettingsInputComponent,
                    isSelected = devicesShown,
                    enabled = true,
                    onClick = onToggleDevices,
                )
            }

            Divider(color = Color.Gray.copy(alpha = 0.3f), thickness = 1.dp, modifier = Modifier.width(600.dp))

            // Bottom Row: Transform Tools. "Move" is the implicit default
            // mode (laser-grab via the model-grab handle); render it as a
            // status chip so it's visually distinct from the actionable
            // Rotate / Scale / Paint / Reset buttons.
            Row(
                horizontalArrangement = Arrangement.spacedBy(24.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                NavStatusChip(
                    label = "Move",
                    icon = androidx.compose.material.icons.Icons.Default.OpenWith,
                    active = paintBrush.mode == PaintMode.Off,
                )
                NavAction(
                    label = if (modelRotZDeg == 0) "Rotate" else "Rotate ${modelRotZDeg}°",
                    icon = androidx.compose.material.icons.Icons.Default.Refresh,
                    isSelected = modelRotZDeg != 0,
                    enabled = rotateEnabled,
                    onClick = onRotateModel,
                )
                NavAction(
                    label = if (modelScalePct == 100) "Scale" else "Scale ${modelScalePct}%",
                    icon = androidx.compose.material.icons.Icons.Default.AspectRatio,
                    isSelected = modelScalePct != 100,
                    enabled = scaleEnabled,
                    onClick = onScaleModel,
                )
                NavAction(
                    label = if (paintBrush.mode == PaintMode.Off) "Paint"
                        else "Paint S${paintBrush.activeSlot}",
                    icon = androidx.compose.material.icons.Icons.Default.Brush,
                    isSelected = paintBrush.mode != PaintMode.Off,
                    enabled = paintEnabled,
                    onClick = onTogglePaint,
                )
                NavAction(
                    label = "Reset",
                    icon = androidx.compose.material.icons.Icons.Default.RestartAlt,
                    isSelected = false,
                    enabled = true,
                    onClick = onResetWorkspace
                )
            }

            if (paintBrush.mode != PaintMode.Off) {
                Divider(color = Color.Gray.copy(alpha = 0.3f), thickness = 1.dp, modifier = Modifier.width(600.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // One readable swatch per project filament 1..N + an
                    // eraser. Each swatch shows its resolved "as will
                    // print" color so the user picks a paint slot
                    // visually — what was previously a tiny "Slot 1"
                    // text label is now a 36 dp tappable color tile.
                    // The active slot gets a blue ring and a bold
                    // "T_N" caption; the rest stay subtle. The eraser
                    // is rendered as a transparent X tile at the end.
                    for (slot in 1..paintMaxSlots) {
                        val colorHex = paintPalette.getOrNull(slot - 1) ?: "#FFFFFF"
                        val isActive = paintBrush.activeSlot == slot
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { onPaintSlotChange(slot) }
                                .padding(horizontal = 4.dp, vertical = 6.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(36.dp)
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(parseHexColorOrDefault(colorHex))
                                    .border(
                                        width = if (isActive) 2.5.dp else 1.dp,
                                        color = if (isActive) Color(0xFF7BC8FF) else Color(0xFF2C3138),
                                        shape = RoundedCornerShape(6.dp),
                                    ),
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "T$slot",
                                color = if (isActive) Color(0xFF7BC8FF) else Color.Gray,
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                            )
                        }
                    }
                    // Eraser — slot 0 — clears paint on the touched
                    // triangle. Always available regardless of palette.
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onPaintSlotChange(0) }
                            .padding(horizontal = 4.dp, vertical = 6.dp),
                    ) {
                        val isActive = paintBrush.activeSlot == 0
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .background(Color(0xFF1B1F23))
                                .border(
                                    width = if (isActive) 2.5.dp else 1.dp,
                                    color = if (isActive) Color(0xFF7BC8FF) else Color(0xFF2C3138),
                                    shape = RoundedCornerShape(6.dp),
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "✕",
                                color = if (isActive) Color(0xFF7BC8FF) else Color.LightGray,
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Erase",
                            color = if (isActive) Color(0xFF7BC8FF) else Color.Gray,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    NavAction(
                        label = "Brush ${paintBrush.radiusMm.toInt()}mm",
                        icon = androidx.compose.material.icons.Icons.Default.Adjust,
                        isSelected = false,
                        enabled = true,
                        onClick = {
                            val presets = BRUSH_RADIUS_PRESETS_MM
                            val idx = presets.indexOfFirst {
                                kotlin.math.abs(it - paintBrush.radiusMm) < 0.01f
                            }
                            val next = presets[(idx + 1).coerceAtLeast(0) % presets.size]
                            onPaintRadiusChange(next)
                        },
                    )
                }
            }
        }
    }
}

/**
 * Non-interactive sibling of [NavAction]. Used for status indicators on the
 * top pill that read like "we are in this mode" rather than "tap to change."
 * Visually distinct from buttons: dimmer tint, no clip / clickable, the icon
 * sits without a hover frame so users don't waste a laser-pinch on it.
 */
@Composable
fun NavStatusChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    active: Boolean,
) {
    val tint = if (active) Color(0xFF7BC8FF) else Color.Gray
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = tint,
            modifier = Modifier.size(28.dp),
        )
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = label,
            color = tint,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
fun NavAction(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    isSelected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit = {},
) {
    val tintColor = when {
        isSelected -> Color(0xFF00FFC2) // Teal accent from mock-up
        enabled -> Color.White
        else -> Color.Gray
    }
    val backgroundColor = if (isSelected) Color(0xFF00FFC2).copy(alpha = 0.15f) else Color.Transparent

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(backgroundColor)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = tintColor,
            modifier = Modifier.size(28.dp)
        )
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = label,
            color = if (enabled) Color.White else Color.Gray,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
            softWrap = false
        )
    }
}

/**
 * Floating radial menu of bed actions. Positions four buttons around an
 * outer ring; each carries a hoisted [onClick] so the call site (currently
 * `MainActivity.XrShell`) can wire them against `placedModels` state. Group /
 * multi-select was dropped per `docs/XR_UI_UX_IMPLEMENTATION_PLAN.md` §1 —
 * no group concept exists yet, and a button that does nothing is worse than
 * no button. Disabled state mirrors what the host scene supports right now
 * (Duplicate / Delete need a selection; Arrange needs ≥2 plated models).
 */
@Composable
fun RadialMenuPanel(
    onAdd: () -> Unit,
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
    onArrange: () -> Unit,
    duplicateEnabled: Boolean = true,
    deleteEnabled: Boolean = true,
    arrangeEnabled: Boolean = true,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        contentAlignment = Alignment.Center
    ) {
        // Outer ring — purely decorative scaffolding for the four action
        // buttons. No central core button: previously the
        // `Architecture`-icon Surface was visually a button (border + filled
        // disc) without any action attached. Per §1 of the plan we remove
        // it rather than ship a control that ignores clicks.
        Surface(
            color = Color(0xFF15181B).copy(alpha = 0.6f),
            shape = CircleShape,
            border = BorderStroke(2.dp, Color(0xFF00FFC2).copy(alpha = 0.3f)),
            modifier = Modifier.fillMaxSize()
        ) {}

        val actions = listOf(
            RadialAction(
                label = "Add",
                icon = androidx.compose.material.icons.Icons.Default.AddCircleOutline,
                angleDeg = 270f,
                enabled = true,
                onClick = onAdd,
            ),
            RadialAction(
                label = "Duplicate",
                icon = androidx.compose.material.icons.Icons.Default.ContentCopy,
                angleDeg = 342f,
                enabled = duplicateEnabled,
                onClick = onDuplicate,
            ),
            RadialAction(
                label = "Delete",
                icon = androidx.compose.material.icons.Icons.Default.DeleteOutline,
                angleDeg = 54f,
                enabled = deleteEnabled,
                onClick = onDelete,
            ),
            RadialAction(
                label = "Arrange",
                icon = androidx.compose.material.icons.Icons.Default.GridView,
                angleDeg = 126f,
                enabled = arrangeEnabled,
                onClick = onArrange,
            ),
        )

        val radiusPx = 70f

        actions.forEach { action ->
            val angleRad = Math.toRadians(action.angleDeg.toDouble())
            val xOffset = (Math.cos(angleRad) * radiusPx).dp
            val yOffset = (Math.sin(angleRad) * radiusPx).dp

            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.offset(x = xOffset, y = yOffset)
            ) {
                Surface(
                    color = Color(0xFF1B1F23),
                    shape = CircleShape,
                    modifier = Modifier.size(40.dp),
                    shadowElevation = 4.dp
                ) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier.clickable(
                            enabled = action.enabled,
                            onClick = action.onClick,
                        ),
                    ) {
                        Icon(
                            imageVector = action.icon,
                            contentDescription = action.label,
                            tint = if (action.enabled) Color.White else Color.Gray,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
                Text(
                    text = action.label,
                    color = if (action.enabled) Color.White else Color.Gray,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }
    }
}

private data class RadialAction(
    val label: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val angleDeg: Float,
    val enabled: Boolean,
    val onClick: () -> Unit,
)


/**
 * Folder navigation entry. We surface a couple of obvious shortcuts at
 * the top of the panel so users don't have to climb out of /storage to
 * reach Downloads on every launch.
 */
private data class Shortcut(val label: String, val path: File)

private fun standardShortcuts(): List<Shortcut> {
    val ext = Environment.getExternalStorageDirectory()
    return listOfNotNull(
        Shortcut("Downloads", File(ext, Environment.DIRECTORY_DOWNLOADS)),
        Shortcut("Documents", File(ext, Environment.DIRECTORY_DOCUMENTS)),
        Shortcut("Quick Share", File(ext, "QuickShare")),
        Shortcut("Internal storage", ext),
    ).filter { it.path.exists() }
}

/**
 * Whether [MANAGE_EXTERNAL_STORAGE] is granted at runtime. We need it
 * because Android 11+ scoped storage hides everything outside our own
 * app dir from the plain File API, which is why the previous
 * `listFiles(Downloads)` returned null/empty for the user.
 */
private fun hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

/**
 * Mesh container formats we'll show in the in-XR file picker. Slicing
 * dispatches by extension on the libslic3r side via
 * `Model::read_from_file` (STL/3MF/AMF/OBJ/STEP); preview uses
 * `SlicerEngine.convertToStl` for non-STL inputs to derive a single
 * binary STL the existing in-app `StlReader` can handle.
 *
 * STEP support exists in libslic3r but goes through a separate
 * (heavier) loader; deferred until we actually have a STEP test
 * fixture.
 */
private val MESH_EXTENSIONS = setOf("stl", "3mf", "amf", "obj")

@Composable
fun FilePickerPanel(
    onFileSelected: (File) -> Unit,
    onClose: () -> Unit,
) {
    val ctx = LocalContext.current
    var permissionGranted by remember { mutableStateOf(hasAllFilesAccess()) }
    val shortcuts = remember(permissionGranted) { if (permissionGranted) standardShortcuts() else emptyList() }
    val initial = remember(permissionGranted) {
        shortcuts.firstOrNull()?.path
            ?: Environment.getExternalStorageDirectory()
            ?: File("/")
    }
    var currentDir by remember(permissionGranted) { mutableStateOf(initial) }
    var refreshTick by remember { mutableStateOf(0) }
    var selected by remember(permissionGranted) { mutableStateOf<File?>(null) }
    // Selection is scoped per-directory: clicking into a new folder
    // shouldn't keep a stale highlight from the old one.
    LaunchedEffect(currentDir) { selected = null }

    // Re-check the permission whenever the panel re-enters composition;
    // the user may have flipped the toggle in Settings while we were
    // backgrounded. Cheaper than registering a lifecycle observer.
    LaunchedEffect(Unit) { permissionGranted = hasAllFilesAccess() }

    val entries: List<File> = remember(currentDir, permissionGranted, refreshTick) {
        val raw = runCatching { currentDir.listFiles()?.toList() }.getOrNull().orEmpty()
        raw
            .filter { f ->
                f.isDirectory ||
                    MESH_EXTENSIONS.contains(f.extension.lowercase())
            }
            .sortedWith(compareByDescending<File> { it.isDirectory }.thenBy { it.name.lowercase() })
    }

    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Pick a model", style = MaterialTheme.typography.titleLarge, color = Color.White)
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleLarge)
                }
            }

            if (!permissionGranted) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "OrcaXR needs \"All files access\" to browse your STL folders. " +
                        "Tap the button below, enable the toggle for OrcaXR, then come back.",
                    color = Color(0xFFB6BEC8),
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        runCatching {
                            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                                data = Uri.parse("package:${ctx.packageName}")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            ctx.startActivity(intent)
                        }.onFailure {
                            // Fallback: open the generic Manage-all-files page.
                            val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            ctx.startActivity(intent)
                        }
                    },
                    shape = RoundedCornerShape(8.dp),
                ) { Text("Grant All Files Access") }
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = { permissionGranted = hasAllFilesAccess() }) {
                    Text("I've granted it — refresh", color = Color(0xFF7BC8FF))
                }
                return@Column
            }

            // Shortcut chips (Downloads / Documents / etc.) for one-tap nav.
            if (shortcuts.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (s in shortcuts) {
                        val active = s.path.absolutePath == currentDir.absolutePath
                        Surface(
                            color = if (active) Color(0xFF7BC8FF) else Color(0xFF1B1F23),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.clickable { currentDir = s.path },
                        ) {
                            Text(
                                s.label,
                                color = if (active) Color(0xFF002D45) else Color.White,
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            }

            // Path bar + up/refresh.
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                IconButton(
                    onClick = { currentDir.parentFile?.let { currentDir = it } },
                    enabled = currentDir.parentFile != null,
                ) { Text("⤴", color = Color.White, style = MaterialTheme.typography.titleMedium) }
                Text(
                    currentDir.absolutePath,
                    color = Color(0xFFB6BEC8),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { refreshTick++ }) {
                    Text("⟳", color = Color.White, style = MaterialTheme.typography.titleMedium)
                }
            }

            Spacer(Modifier.height(8.dp))
            if (entries.isEmpty()) {
                Box(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "No folders or model files (.stl / .3mf / .amf / .obj) here.",
                        color = Color.Gray,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(entries, key = { it.absolutePath }) { f ->
                        FileRow(
                            file = f,
                            isSelected = selected?.absolutePath == f.absolutePath,
                            onClick = {
                                // Directories navigate immediately —
                                // there's no ambiguity and double-click
                                // semantics would fight gaze+pinch.
                                // Files only highlight; the user opens
                                // them via the Open button below.
                                if (f.isDirectory) {
                                    currentDir = f
                                } else {
                                    selected = f
                                }
                            },
                        )
                    }
                }
            }

            // Action row: Cancel + Open. Open is the affirmative action
            // and reads as a primary button so users can scan for it
            // without learning a hidden double-tap convention.
            Spacer(Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    onClick = onClose,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.weight(1f),
                ) { Text("Cancel") }
                Button(
                    onClick = { selected?.let(onFileSelected) },
                    enabled = selected != null,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    // Was previously "Open <filename>", but long names
                    // overflowed the button on the panel's authored
                    // width — selection is already shown in the file
                    // list above, so the button just confirms the
                    // action.
                    Text("Open")
                }
            }
        }
    }
}

@Composable
private fun FileRow(file: File, isSelected: Boolean, onClick: () -> Unit) {
    val containerColor = if (isSelected) Color(0xFF1F4D6E) else Color(0xFF1B1F23)
    Surface(
        color = containerColor,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (file.isDirectory) "📁" else "📄",
                modifier = Modifier.padding(end = 10.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    file.name,
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (!file.isDirectory) {
                    Text(
                        "${file.length() / 1024} KB",
                        color = Color.Gray,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            if (isSelected) {
                Text("✓", color = Color(0xFF7BC8FF), style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

/**
 * Per-printer status the panel surfaces while we ping/upload/start.
 * The panel itself doesn't talk to Moonraker — it raises action
 * callbacks and renders whatever status string the host provides.
 */
data class PrinterStatus(
    val message: String,
    val tone: PrinterStatusTone = PrinterStatusTone.Info,
    /**
     * Determinate progress 0.0..1.0 to render under the status text as
     * a progress bar. Null = no progress bar (the default for ping /
     * test / start-print / completed states). Used during the
     * `/server/files/upload` POST so a 17 MB dragon at 0.5 Mbps Wi-Fi
     * (4 minutes elapsed) doesn't look stuck.
     */
    val progress: Float? = null,
)

enum class PrinterStatusTone { Info, Success, Error }

@Composable
fun PrinterPanel(
    printers: List<PrinterConfig>,
    statuses: Map<String, PrinterStatus>,
    snapshots: Map<String, PrintSnapshot>,
    webcamFrames: Map<String, androidx.compose.ui.graphics.ImageBitmap>,
    canSendCurrentSlice: Boolean,
    discovery: List<DiscoveredPrinter>,
    isScanning: Boolean,
    onScanToggle: () -> Unit,
    onAddDiscovered: (DiscoveredPrinter) -> Unit,
    onAddPrinter: (name: String, host: String, port: Int, apiKey: String?) -> Unit,
    onTestPrinter: (PrinterConfig) -> Unit,
    onSendSlice: (PrinterConfig) -> Unit,
    onPausePrinter: (PrinterConfig) -> Unit,
    onResumePrinter: (PrinterConfig) -> Unit,
    onCancelPrint: (PrinterConfig) -> Unit,
    onRenamePrinter: (PrinterConfig, String) -> Unit,
    onDeletePrinter: (PrinterConfig) -> Unit,
    onClose: () -> Unit,
) {
    var editingId by remember { mutableStateOf<String?>(null) }
    var addOpen by remember { mutableStateOf(printers.isEmpty()) }

    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Printers", style = MaterialTheme.typography.titleLarge, color = Color.White)
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleLarge)
                }
            }

            Text(
                "Klipper-based printers (Moonraker on the LAN). " +
                    "Snapmaker U1 and Elegoo Centauri Carbon both qualify.",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(12.dp))

            // Discovery row. Scan toggles _snapmaker._tcp browsing on
            // the LAN; results show up below as tap-to-add cards. The
            // user can still hand-enter addresses below if discovery
            // doesn't see their printer (some routers block multicast).
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "Discovered on LAN",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(
                    onClick = onScanToggle,
                    shape = RoundedCornerShape(8.dp),
                ) { Text(if (isScanning) "Stop scan" else "Scan LAN") }
            }
            Spacer(Modifier.height(6.dp))
            if (discovery.isEmpty()) {
                Text(
                    if (isScanning) "Scanning mDNS + sweeping the local /24…"
                    else "Tap Scan LAN to find Klipper printers (mDNS + subnet probe).",
                    color = Color.Gray,
                    style = MaterialTheme.typography.labelSmall,
                )
            } else {
                // Cap height so we always leave room for the
                // configured-printers list and the Add form below.
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 220.dp),
                ) {
                    items(discovery, key = { it.host }) { d ->
                        Surface(
                            color = Color(0xFF1F4D6E),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onAddDiscovered(d) },
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("📡", modifier = Modifier.padding(end = 8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(d.name, color = Color.White, fontWeight = FontWeight.Bold)
                                    Text(
                                        buildString {
                                            append(d.host)
                                            append(':')
                                            append(d.port)
                                            d.version?.let { append("  · v"); append(it) }
                                            d.sn?.let { append("  · ").append(it.take(10)) }
                                        },
                                        color = Color.LightGray,
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                                Text("+", color = Color(0xFF7BC8FF), fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))

            if (printers.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "No printers configured yet.",
                        color = Color.Gray,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f, fill = false).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(printers, key = { it.id }) { p ->
                        PrinterRow(
                            printer = p,
                            status = statuses[p.id],
                            snapshot = snapshots[p.id],
                            webcam = webcamFrames[p.id],
                            canSend = canSendCurrentSlice,
                            isEditing = editingId == p.id,
                            onStartRename = { editingId = p.id },
                            onCancelRename = { editingId = null },
                            onCommitRename = { newName ->
                                onRenamePrinter(p, newName)
                                editingId = null
                            },
                            onTest = { onTestPrinter(p) },
                            onSend = { onSendSlice(p) },
                            onPause = { onPausePrinter(p) },
                            onResume = { onResumePrinter(p) },
                            onCancelPrint = { onCancelPrint(p) },
                            onDelete = { onDeletePrinter(p) },
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { addOpen = !addOpen },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (addOpen) "▾" else "▸", color = Color.White)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Add printer",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    if (addOpen) {
                        Spacer(Modifier.height(8.dp))
                        AddPrinterForm(onAdd = { name, host, port, apiKey ->
                            onAddPrinter(name, host, port, apiKey)
                            addOpen = false
                        })
                    }
                }
            }
        }
    }
}

@Composable
private fun PrinterRow(
    printer: PrinterConfig,
    status: PrinterStatus?,
    snapshot: PrintSnapshot?,
    webcam: androidx.compose.ui.graphics.ImageBitmap?,
    canSend: Boolean,
    isEditing: Boolean,
    onStartRename: () -> Unit,
    onCancelRename: () -> Unit,
    onCommitRename: (String) -> Unit,
    onTest: () -> Unit,
    onSend: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onCancelPrint: () -> Unit,
    onDelete: () -> Unit,
) {
    Surface(
        color = Color(0xFF1B1F23),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            if (isEditing) {
                var draft by remember(printer.id) { mutableStateOf(printer.name) }
                TextField(
                    value = draft,
                    onValueChange = { draft = it },
                    singleLine = true,
                    label = { Text("Printer name") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = onCancelRename,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.weight(1f),
                    ) { Text("Cancel") }
                    Button(
                        enabled = draft.isNotBlank(),
                        onClick = { onCommitRename(draft.trim()) },
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.weight(1f),
                    ) { Text("Save name") }
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(printer.name, color = Color.White, fontWeight = FontWeight.Bold)
                        Text(
                            "${printer.host}:${printer.port}",
                            color = Color.Gray,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    IconButton(onClick = onStartRename) {
                        Text("✎", color = Color.Gray)
                    }
                    IconButton(onClick = onDelete) {
                        Text("✕", color = Color.Gray)
                    }
                }
                Spacer(Modifier.height(6.dp))
                // Action row morphs to match what makes sense given
                // the printer's current state: idle → Test + Send,
                // printing → Pause + Cancel, paused → Resume + Cancel.
                when (snapshot?.state) {
                    "printing" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = onPause,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                        ) { Text("Pause") }
                        Button(
                            onClick = onCancelPrint,
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7A1F1F)),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                        ) { Text("Cancel print") }
                    }
                    "paused" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = onResume,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                        ) { Text("Resume") }
                        Button(
                            onClick = onCancelPrint,
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7A1F1F)),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                        ) { Text("Cancel print") }
                    }
                    else -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = onTest,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                        ) { Text("Test") }
                        Button(
                            onClick = onSend,
                            enabled = canSend,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                        ) { Text(if (canSend) "Send" else "Send (slice first)") }
                    }
                }
            }
            if (status != null) {
                Spacer(Modifier.height(6.dp))
                val color = when (status.tone) {
                    PrinterStatusTone.Success -> Color(0xFF7BFFB1)
                    PrinterStatusTone.Error -> Color(0xFFFF9F4A)
                    PrinterStatusTone.Info -> Color(0xFFB6BEC8)
                }
                Text(status.message, color = color, style = MaterialTheme.typography.labelSmall)
                if (status.progress != null) {
                    Spacer(Modifier.height(4.dp))
                    LinearProgressIndicator(
                        progress = { status.progress.coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().height(4.dp),
                        color = color,
                        trackColor = Color(0xFF2C3138),
                    )
                }
            }
            if (snapshot != null && snapshot.isActive) {
                Spacer(Modifier.height(8.dp))
                if (webcam != null) {
                    androidx.compose.foundation.Image(
                        bitmap = webcam,
                        contentDescription = "Printer webcam",
                        contentScale = androidx.compose.ui.layout.ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp)),
                    )
                    Spacer(Modifier.height(8.dp))
                }
                LivePrintStatus(snapshot)
            }
        }
    }
}

@Composable
fun LivePrintStatus(s: PrintSnapshot) {
    val accent = when (s.state) {
        "printing" -> Color(0xFF7BFFB1)
        "paused" -> Color(0xFFFFD27B)
        else -> Color(0xFFB6BEC8)
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                s.state.replaceFirstChar { it.titlecase() },
                color = accent,
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.width(8.dp))
            if (s.filename.isNotBlank()) {
                Text(
                    s.filename,
                    color = Color.LightGray,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                )
            }
        }
        // Determinate progress bar — Moonraker reports 0.0..1.0.
        LinearProgressIndicator(
            progress = { s.progress },
            modifier = Modifier.fillMaxWidth(),
            color = accent,
            trackColor = Color(0xFF2A2F35),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "${(s.progress * 100f).toInt()}%",
                color = Color.White,
                style = MaterialTheme.typography.labelSmall,
            )
            // Layer counter — only present when the slicer (Orca does)
            // emitted SET_PRINT_STATS_INFO during the print.
            if (s.currentLayer != null && s.totalLayers != null) {
                Text(
                    "L ${s.currentLayer}/${s.totalLayers}",
                    color = Color.LightGray,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            Text(
                "${formatHms(s.printDurationSec)} elapsed",
                color = Color.LightGray,
                style = MaterialTheme.typography.labelSmall,
            )
            s.etaSec?.let { eta ->
                Text(
                    "ETA ${formatHms(eta)}",
                    color = Color.LightGray,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Nozzle ${s.nozzleTemp.toInt()}°/${s.nozzleTarget.toInt()}°",
                color = Color.LightGray,
                style = MaterialTheme.typography.labelSmall,
            )
            Text(
                "Bed ${s.bedTemp.toInt()}°/${s.bedTarget.toInt()}°",
                color = Color.LightGray,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        if (s.message.isNotBlank()) {
            Text(
                s.message,
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.labelSmall,
            )
        }
        // Phase I.2: per-slot runout badges. Hidden when the printer
        // didn't expose `filament_detect` (older firmware / non-
        // Snapmaker host). Empty slots get an amber "T_N empty"
        // pill; loaded slots stay invisible to keep the row compact
        // (a printer with all 4 slots loaded is the common case).
        val emptySlots = s.slotLoaded.withIndex()
            .filter { (_, loaded) -> !loaded }
            .map { it.index }
        if (emptySlots.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    "⚠",
                    color = Color(0xFFFF9F4A),
                    style = MaterialTheme.typography.labelSmall,
                )
                for (idx in emptySlots) {
                    Surface(
                        color = Color(0xFF3A1E1E),
                        shape = RoundedCornerShape(4.dp),
                    ) {
                        Text(
                            "T${idx + 1} empty",
                            color = Color(0xFFFF9F4A),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun formatHms(secondsRaw: Float): String {
    val total = secondsRaw.toInt().coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return when {
        h > 0 -> "%d:%02d:%02d".format(h, m, s)
        else -> "%d:%02d".format(m, s)
    }
}

/**
 * Big centered "Loading <filename>" overlay that floats in the user's
 * field of view while a model is being parsed + a preview GLB is
 * being written. The inline spinner in [LeftProjectPanel]'s model
 * row is too small to register at headset distance — for big 3MFs
 * (1M+ triangle dragons take ~10 s through the colored-GLB writer)
 * the user wonders if the app froze. This sits front-and-center so
 * the wait reads as "active" rather than "stuck".
 *
 * Hide the parent SpatialPanel when [label] is null. Kept here as a
 * pure Composable so the parent decides when/where to host it.
 */
@Composable
fun ModelLoadingOverlayPanel(label: String?) {
    if (label == null) return
    Surface(
        color = Color(0xE6121518),
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            CircularProgressIndicator(
                color = Color(0xFF7BC8FF),
                strokeWidth = 4.dp,
                modifier = Modifier.size(56.dp),
            )
            Spacer(modifier = Modifier.height(20.dp))
            Text(
                "Loading model",
                color = Color.White,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                label,
                color = Color(0xFF7BC8FF),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                "Reading mesh and preparing preview…",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/**
 * Always-visible live print monitor for the active printer. Mirrors
 * the in-PrinterPanel `LivePrintStatus` card but adds the pause /
 * resume / cancel controls right next to it so the user doesn't have
 * to open the device-management panel just to see what's happening
 * with the print they just sent. Hidden when [snapshot] is null or
 * [snapshot.state] is "standby" / "complete" / blank — i.e., when
 * there's nothing worth surfacing.
 */
@Composable
fun PrintMonitorPanel(
    printerName: String,
    snapshot: PrintSnapshot?,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onCancel: () -> Unit,
) {
    val s = snapshot ?: return
    if (s.state == "standby" || s.state.isBlank()) return

    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                printerName,
                color = Color.White,
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.titleMedium,
            )
            // LivePrintStatus claims whatever vertical room is left
            // after the title and the (fixed-height) control row
            // below, so the buttons stay visible no matter how dense
            // the status text gets. Without weight = 1f the dense
            // content was pushing the button row past the panel's
            // 180dp clip and the buttons rendered as empty pills.
            Box(modifier = Modifier.weight(1f, fill = true)) {
                LivePrintStatus(s)
            }

            // Control row. Pause / resume / cancel get color-coded;
            // Pause and Resume are mutually exclusive (one is enabled
            // based on state), Cancel is always available while the
            // printer is doing anything other than standby.
            // Explicit defaultMinSize keeps the buttons readable even
            // when the panel is dragged narrower than the authored
            // 400dp width.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 36.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (s.state == "paused") {
                    Button(
                        onClick = onResume,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF7BFFB1),
                            contentColor = Color(0xFF002D1B),
                        ),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        modifier = Modifier.weight(1f),
                    ) { Text("Resume", fontWeight = FontWeight.Bold, maxLines = 1) }
                } else {
                    OutlinedButton(
                        onClick = onPause,
                        enabled = s.state == "printing",
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        modifier = Modifier.weight(1f),
                    ) { Text("Pause", maxLines = 1) }
                }
                OutlinedButton(
                    onClick = onCancel,
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = Color(0xFFFF8A8A),
                    ),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f),
                ) { Text("Cancel", maxLines = 1) }
            }
        }
    }
}

@Composable
private fun AddPrinterForm(
    onAdd: (name: String, host: String, port: Int, apiKey: String?) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    // Default 80 — most Klipper installs front Moonraker with nginx
    // serving Mainsail/Fluidd on port 80, with `/printer/*` and
    // `/server/*` proxied through to localhost:7125. That's the
    // configuration both target printers ship with. Test-time probing
    // still tries 7125 as a fallback for raw Moonraker setups.
    var portText by remember { mutableStateOf("80") }
    var apiKey by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Name") },
            placeholder = { Text("Snapmaker U1 / Centauri Carbon") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        TextField(
            value = host,
            onValueChange = { host = it },
            label = { Text("Host or IP") },
            placeholder = { Text("192.168.1.42 or printer.local") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextField(
                value = portText,
                onValueChange = { portText = it.filter(Char::isDigit).take(5) },
                label = { Text("Port") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(120.dp),
            )
            TextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = { Text("API key (optional)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        Text(
            "80 = Mainsail/Fluidd web UI (Snapmaker U1, Centauri Carbon, " +
                "MainsailOS, FluiddPi). 7125 = raw Moonraker bind.",
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.labelSmall,
        )
        Button(
            enabled = host.isNotBlank() && name.isNotBlank(),
            onClick = {
                onAdd(name.trim(), host.trim(), portText.toIntOrNull() ?: 80, apiKey.trim().ifBlank { null })
                name = ""; host = ""; portText = "80"; apiKey = ""
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save printer") }
    }
}

/**
 * Phase XR_OBJ_2 — numeric transform panel for the selected model.
 *
 * X / Y / Z TextFields per axis for translate, rotate, and scale; three
 * mirror toggles; "Place on bed", "Reset all", and per-axis "↺" reset
 * buttons. The panel never tries to free-drag — every edit is typed,
 * and the model preview re-bakes when the LE in MainActivity sees the
 * new field values (gotcha #43-style hand-tracking jitter rules out 3D
 * gizmo handles, see ORCASLICER_PARITY_PLAN §3).
 *
 * The legacy TopNavigationPill rotate/scale chips still cycle the same
 * `rotZDeg` / `scalePct` fields; this panel covers everything else
 * plus the precise typed values.
 *
 * `model = null` reads as "nothing selected" — the panel renders an
 * empty-state hint and disables every input.
 */
@Composable
fun TransformPanel(
    model: PlacedModel?,
    onTranslateChange: (xMm: Float, yMm: Float, zMm: Float) -> Unit,
    onRotateChange: (xDeg: Float, yDeg: Float, zDeg: Float) -> Unit,
    onScaleChange: (xPct: Float, yPct: Float, zPct: Float) -> Unit,
    onMirrorChange: (x: Boolean, y: Boolean, z: Boolean) -> Unit,
    onPlaceOnBed: () -> Unit,
    onResetAll: () -> Unit,
    /** Phase XR_OBJ_3 — Auto-orient. The handler runs the libslic3r
     *  `orient(ModelObject*)` JNI call on a coroutine and applies the
     *  returned Euler angles via [onRotateChange]. Null disables the
     *  button (e.g. when no model selected). */
    onAutoOrient: (() -> Unit)? = null,
    /** True while an auto-orient call is in flight. Disables the
     *  button and shows a "..." label. */
    autoOrientBusy: Boolean = false,
    /** Phase XR_OBJ_3 — Lay-on-face mode toggle. Tapping the button
     *  arms the laser-pick pipeline (PaintMode.LayOnFace); the next
     *  controller-laser click on the model lands the picked face on
     *  the bed. Null disables the button. */
    onToggleLayOnFace: (() -> Unit)? = null,
    /** True iff PaintMode.LayOnFace is currently active — drives the
     *  button into a "Cancel" state so the user can back out. */
    layOnFaceActive: Boolean = false,
    /** Phase XR_OBJ_4 — open the file picker to attach a volume of
     *  [ModelVolumeType] to the selected model. The picked
     *  STL/3MF rides into the slice via libslic3r's multi-volume
     *  ModelObject. Null disables the buttons (e.g. when nothing is
     *  selected). The five callable variants (Add Part / Modifier /
     *  Negative / Support Enforcer / Support Blocker) all dispatch
     *  through this single callback with the appropriate type. */
    onAddVolume: ((ModelVolumeType) -> Unit)? = null,
    /** Phase XR_OBJ_4 — list of volumes already attached to the
     *  selected model. Empty = no volumes attached, no list rendered.
     *  The TransformPanel renders an expandable row per volume
     *  with edit TextFields for per-volume translate/rotate/scale. */
    volumes: List<PlacedVolume> = emptyList(),
    /** Phase XR_OBJ_4 — replace the volume at [volumeId] with [updated].
     *  Null leaves the list immutable from the panel's perspective
     *  (useful when nothing is selected). */
    onUpdateVolume: ((volumeId: String, updated: PlacedVolume) -> Unit)? = null,
    /** Phase XR_OBJ_4 — remove the volume with the given id. */
    onRemoveVolume: ((volumeId: String) -> Unit)? = null,
    /** Phase XR_OBJ_5 — run libslic3r's cut with horizontal plane at
     *  the given Z. Null disables the button (e.g. when no model is
     *  selected). The Apply path replaces the source model with the
     *  cut output 3MF. */
    onCutAtZ: ((Float) -> Unit)? = null,
    /** Phase XR_OBJ_6 — split the selected model into per-component
     *  PlacedModels via libslic3r's `ModelObject::split`. Replaces
     *  the source with N PlacedModels (1 for single-component
     *  meshes — split is idempotent). Null disables the button. */
    onSplit: (() -> Unit)? = null,
    /** Phase XR_OBJ_6 — arm the Boolean A/B picker. The selected
     *  model becomes "A"; the host wires the next scene tap on a
     *  different PlacedModel as "B" and runs the op immediately
     *  ([SlicerEngine.BoolOp.UNION / DIFFERENCE / INTERSECTION]).
     *  Null disables (e.g. <2 models on the bed). */
    onStartBoolean: ((op: Int) -> Unit)? = null,
    /** Phase XR_OBJ_6 — non-null while waiting for the second tap
     *  (A is captured, B not yet picked). Drives a banner inside
     *  the panel telling the user what to do, plus a Cancel button. */
    booleanPickerOp: Int? = null,
    /** Phase XR_OBJ_6 — drop out of A/B picker without running the
     *  op. Wired to the Cancel button on the active-picker banner. */
    onCancelBoolean: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — toggle Support Enforcer paint mode. Tapping
     *  the next triangle on the model stamps state ENFORCER (1) into
     *  `supportFlags` for that triangle (and the brush-radius BFS
     *  expansion). Drag-paints. Tapping the button again disengages
     *  the mode (Off). Null disables the button. */
    onToggleSupportEnforcer: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — toggle Support Blocker paint mode (state
     *  BLOCKER, 2). Same semantics as enforcer. */
    onToggleSupportBlocker: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — current support paint mode for label tinting:
     *  null/Off = neither; SupportEnforcer/SupportBlocker = the
     *  matching button shows "Cancel pick…". */
    supportPaintMode: PaintMode = PaintMode.Off,
    /** Phase XR_OBJ_8 — clear all support paint on the selected model
     *  (resets [PlacedModel.supportFlags] to null). Null disables the
     *  button. */
    onClearSupportPaint: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — true if any support paint exists on the
     *  current model. Used to gate the Clear button label. */
    hasSupportPaint: Boolean = false,
    /** Phase XR_OBJ_8 — toggle Seam Enforcer paint mode (state
     *  ENFORCER stamped into seamFlags). Same toggle semantics as
     *  the Support buttons. */
    onToggleSeamEnforcer: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — toggle Seam Blocker paint mode. */
    onToggleSeamBlocker: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — clear seam paint on the selected model. */
    onClearSeamPaint: (() -> Unit)? = null,
    /** Phase XR_OBJ_8 — true if any seam paint exists. */
    hasSeamPaint: Boolean = false,
    /** Phase XR_OBJ_8 — clone the selected model into a linear
     *  pattern of [count] copies spaced [spacingMm] apart along
     *  axis ('x' or 'y'). Null disables. */
    onClonePattern: ((count: Int, spacingMm: Float, axis: Char) -> Unit)? = null,
    /** Phase XR_OBJ_4 (final) — current per-object config overrides.
     *  The Object Settings section reads from this map and writes via
     *  [onObjectConfigChange]; an empty value reverts the key to the
     *  global profile default. */
    objectConfigOverrides: Map<String, String> = emptyMap(),
    /** Phase XR_OBJ_4 (final) — change a single per-object config
     *  override. Empty value removes the key (reverts to global
     *  profile default); non-empty upserts. Null disables editing. */
    onObjectConfigChange: ((key: String, value: String) -> Unit)? = null,
) {
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF15181B))
            .verticalScroll(scroll)
            .padding(16.dp),
    ) {
        Text("Transform", style = MaterialTheme.typography.titleLarge, color = Color.White)
        Spacer(Modifier.height(4.dp))
        if (model == null) {
            Text(
                "Select a model on the bed to edit its transform.",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )
            return@Column
        }
        val w = model.baseBboxXmm * model.effectiveScaleX
        val d = model.baseBboxYmm * model.effectiveScaleY
        val h = model.baseBboxZmm * model.effectiveScaleZ
        Text(
            "${model.label}  •  ${"%.1f".format(w)} × ${"%.1f".format(d)} × ${"%.1f".format(h)} mm",
            color = Color(0xFF7BC8FF),
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(12.dp))

        TransformAxisSection(
            label = "Translate",
            unit = "mm",
            x = model.translateXmm,
            y = model.translateYmm,
            z = model.translateZmm,
            onChange = onTranslateChange,
            onResetAxis = { axis ->
                when (axis) {
                    0 -> onTranslateChange(0f, model.translateYmm, model.translateZmm)
                    1 -> onTranslateChange(model.translateXmm, 0f, model.translateZmm)
                    2 -> onTranslateChange(model.translateXmm, model.translateYmm, 0f)
                }
            },
        )
        Spacer(Modifier.height(8.dp))
        TransformAxisSection(
            label = "Rotate",
            unit = "°",
            x = model.rotXDeg,
            y = model.rotYDeg,
            z = model.rotZDeg.toFloat(),
            onChange = onRotateChange,
            onResetAxis = { axis ->
                when (axis) {
                    0 -> onRotateChange(0f, model.rotYDeg, model.rotZDeg.toFloat())
                    1 -> onRotateChange(model.rotXDeg, 0f, model.rotZDeg.toFloat())
                    2 -> onRotateChange(model.rotXDeg, model.rotYDeg, 0f)
                }
            },
        )
        Spacer(Modifier.height(8.dp))
        TransformAxisSection(
            label = "Scale",
            unit = "%",
            x = model.effectiveScaleX * 100f,
            y = model.effectiveScaleY * 100f,
            z = model.effectiveScaleZ * 100f,
            onChange = onScaleChange,
            onResetAxis = { axis ->
                val ex = model.effectiveScaleX * 100f
                val ey = model.effectiveScaleY * 100f
                val ez = model.effectiveScaleZ * 100f
                when (axis) {
                    0 -> onScaleChange(100f, ey, ez)
                    1 -> onScaleChange(ex, 100f, ez)
                    2 -> onScaleChange(ex, ey, 100f)
                }
            },
        )
        Spacer(Modifier.height(12.dp))

        Text("Mirror", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MirrorToggle("X", model.mirrorX) {
                onMirrorChange(it, model.mirrorY, model.mirrorZ)
            }
            MirrorToggle("Y", model.mirrorY) {
                onMirrorChange(model.mirrorX, it, model.mirrorZ)
            }
            MirrorToggle("Z", model.mirrorZ) {
                onMirrorChange(model.mirrorX, model.mirrorY, it)
            }
        }
        Spacer(Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPlaceOnBed, modifier = Modifier.weight(1f)) {
                Text("Place on bed")
            }
            OutlinedButton(onClick = onResetAll, modifier = Modifier.weight(1f)) {
                Text("Reset all")
            }
        }
        Spacer(Modifier.height(8.dp))
        // Phase XR_OBJ_3 — Auto-orient (libslic3r-backed). One button,
        // because the call is "find the printable orientation for me"
        // — there's nothing to configure beyond the input mesh.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onAutoOrient?.invoke() },
                enabled = onAutoOrient != null && !autoOrientBusy,
                modifier = Modifier.weight(1f),
            ) {
                Text(if (autoOrientBusy) "Orienting…" else "Auto-orient")
            }
            // Phase XR_OBJ_3 — Lay on face. Arms the laser pipeline
            // (PaintMode.LayOnFace); next click on the model picks
            // a triangle, the model rotates so that face lands flush
            // on the bed, mode disengages.
            OutlinedButton(
                onClick = { onToggleLayOnFace?.invoke() },
                enabled = onToggleLayOnFace != null,
                modifier = Modifier.weight(1f),
            ) {
                Text(if (layOnFaceActive) "Cancel pick…" else "Lay on face")
            }
        }
        Spacer(Modifier.height(8.dp))
        // Phase XR_OBJ_4 — Add Part / Modifier / Negative Volume /
        // Support Enforcer / Support Blocker. Each button attaches a
        // child volume of the corresponding libslic3r ModelVolumeType
        // to the selected model. The "Add part" label shows the
        // total volume count so users have feedback that taps
        // landed; the four sibling buttons sit in a 2×2 grid below
        // so the panel doesn't grow too tall.
        Text("Add child volume", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        OutlinedButton(
            onClick = { onAddVolume?.invoke(ModelVolumeType.MODEL_PART) },
            enabled = onAddVolume != null,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                if (volumes.isNotEmpty()) "Part  •  ${volumes.size} attached"
                else "Part",
            )
        }
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onAddVolume?.invoke(ModelVolumeType.PARAMETER_MODIFIER) },
                enabled = onAddVolume != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) { Text("Modifier", style = MaterialTheme.typography.bodySmall) }
            OutlinedButton(
                onClick = { onAddVolume?.invoke(ModelVolumeType.NEGATIVE_VOLUME) },
                enabled = onAddVolume != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) { Text("Negative", style = MaterialTheme.typography.bodySmall) }
        }
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onAddVolume?.invoke(ModelVolumeType.SUPPORT_ENFORCER) },
                enabled = onAddVolume != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) { Text("Sup. enforce", style = MaterialTheme.typography.bodySmall) }
            OutlinedButton(
                onClick = { onAddVolume?.invoke(ModelVolumeType.SUPPORT_BLOCKER) },
                enabled = onAddVolume != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) { Text("Sup. block", style = MaterialTheme.typography.bodySmall) }
        }
        // Phase XR_OBJ_4 — per-volume list with inline edit. Empty
        // list (the common case for fresh models) renders nothing
        // and adds no vertical noise to the panel.
        if (volumes.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            for (vol in volumes) {
                key(vol.id) {
                    PlacedVolumeRow(
                        volume = vol,
                        onUpdate = { updated -> onUpdateVolume?.invoke(vol.id, updated) },
                        onRemove = { onRemoveVolume?.invoke(vol.id) },
                    )
                    Spacer(Modifier.height(4.dp))
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        // Phase XR_OBJ_3 — Convert units (mirrors OrcaSlicer's
        // Model::convert_units). Multiplies the per-axis scale by
        // 25.4 (inch → mm: model was authored in inches so 1.0 vertex
        // = 1 inch = 25.4 mm) or by 1/25.4 (mm → inch). Pure scale
        // math — no JNI, no preview re-bake required beyond the LE
        // already keyed on scaleX/Y/Zpct.
        Text("Convert units", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    val ex = model.effectiveScaleX * 100f * 25.4f
                    val ey = model.effectiveScaleY * 100f * 25.4f
                    val ez = model.effectiveScaleZ * 100f * 25.4f
                    onScaleChange(ex, ey, ez)
                },
                modifier = Modifier.weight(1f),
            ) {
                Text("Inches → mm")
            }
            OutlinedButton(
                onClick = {
                    val ex = model.effectiveScaleX * 100f / 25.4f
                    val ey = model.effectiveScaleY * 100f / 25.4f
                    val ez = model.effectiveScaleZ * 100f / 25.4f
                    onScaleChange(ex, ey, ez)
                },
                modifier = Modifier.weight(1f),
            ) {
                Text("mm → Inches")
            }
        }
        // Phase XR_OBJ_5 — Cut. Wraps libslic3r's
        // Cut::perform_with_plane. Default Z = half the model's
        // effective height, so the user gets a sensible suggestion.
        // Apply replaces the source PlacedModel with the cut output
        // (a multi-object 3MF re-loaded as a single PlacedModel for
        // now — splitting into N PlacedModels is a follow-up).
        Spacer(Modifier.height(12.dp))
        Text("Cut", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        val defaultCutZ = (model.baseBboxZmm * model.effectiveScaleZ) * 0.5f
        var cutZText by remember(model.id, defaultCutZ) {
            mutableStateOf(formatAxisValue(defaultCutZ))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Plane Z",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.width(76.dp),
            )
            TextField(
                value = cutZText,
                onValueChange = { cutZText = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = Color(0xFF1B1F23),
                    focusedContainerColor = Color(0xFF1B1F23),
                    unfocusedTextColor = Color.White,
                    focusedTextColor = Color.White,
                ),
                modifier = Modifier.width(120.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text("mm", color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(30.dp))
            Spacer(Modifier.weight(1f))
            OutlinedButton(
                onClick = {
                    val z = cutZText.trim().toFloatOrNull()
                    if (z != null) onCutAtZ?.invoke(z)
                },
                enabled = onCutAtZ != null && cutZText.trim().toFloatOrNull() != null,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            ) { Text("Apply") }
        }
        // Phase XR_OBJ_6 — Split. Wraps `ModelObject::split` to
        // separate a multi-component mesh into one PlacedModel per
        // disconnected piece. No-op for single-component inputs;
        // libslic3r returns the source as-is and we still produce a
        // single output for contract uniformity.
        Spacer(Modifier.height(12.dp))
        Text("Split into pieces", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        OutlinedButton(
            onClick = { onSplit?.invoke() },
            enabled = onSplit != null,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Split disconnected components")
        }
        // Phase XR_OBJ_6 — Boolean operations (Union / Difference /
        // Intersection) between two PlacedModels. The selected model
        // is "A"; tapping a button arms the picker and the next tap
        // on a different model in the scene becomes "B". Disabled
        // unless onStartBoolean was supplied (i.e. ≥2 models exist).
        Spacer(Modifier.height(12.dp))
        Text("Boolean", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        if (booleanPickerOp != null) {
            // Active picker: show "tap second model" banner + Cancel.
            // The Toast already announced what to do; this is the
            // persistent in-panel reinforcement so a user who looked
            // away doesn't lose track of the mode.
            val opLabel = when (booleanPickerOp) {
                0 -> "Union"
                1 -> "Difference"
                2 -> "Intersection"
                else -> "Boolean"
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF2A2520))
                    .padding(8.dp),
            ) {
                Text(
                    "$opLabel: tap second model on the bed…",
                    color = Color(0xFFFFC65C),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { onCancelBoolean?.invoke() }) {
                    Text("Cancel", color = Color(0xFFFF7070))
                }
            }
        } else {
            // Idle: 3 op buttons. enabled = onStartBoolean != null;
            // host disables when <2 models on bed.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { onStartBoolean?.invoke(0) },
                    enabled = onStartBoolean != null,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
                ) {
                    Text("Union", style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(
                    onClick = { onStartBoolean?.invoke(1) },
                    enabled = onStartBoolean != null,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
                ) {
                    Text("Subtract", style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(
                    onClick = { onStartBoolean?.invoke(2) },
                    enabled = onStartBoolean != null,
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
                ) {
                    Text("Intersect", style = MaterialTheme.typography.bodySmall)
                }
            }
            if (onStartBoolean == null) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "Add a second model to enable boolean ops.",
                    color = Color(0xFF7A8392),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        // Phase XR_OBJ_8 — Support paint. Two modes (Enforcer /
        // Blocker) that arm the laser pipeline and stamp ENFORCER (1)
        // or BLOCKER (2) into supportFlags. Drag-paint, then disengage
        // by tapping the same button again. Painted regions force
        // (or forbid) supports under that footprint at slice time via
        // `mv->supported_facets`.
        Spacer(Modifier.height(12.dp))
        Text("Paint supports", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onToggleSupportEnforcer?.invoke() },
                enabled = onToggleSupportEnforcer != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) {
                Text(
                    if (supportPaintMode == PaintMode.SupportEnforcer) "Cancel paint…" else "Force support",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            OutlinedButton(
                onClick = { onToggleSupportBlocker?.invoke() },
                enabled = onToggleSupportBlocker != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) {
                Text(
                    if (supportPaintMode == PaintMode.SupportBlocker) "Cancel paint…" else "Block support",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        if (hasSupportPaint) {
            Spacer(Modifier.height(4.dp))
            TextButton(
                onClick = { onClearSupportPaint?.invoke() },
                enabled = onClearSupportPaint != null,
            ) { Text("Clear support paint", color = Color(0xFFFF7070)) }
        }
        // Phase XR_OBJ_8 — Seam paint. Force / forbid the layer-
        // start seam in the painted region. Same UI shape as the
        // support paint above.
        Spacer(Modifier.height(12.dp))
        Text("Paint seam", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { onToggleSeamEnforcer?.invoke() },
                enabled = onToggleSeamEnforcer != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) {
                Text(
                    if (supportPaintMode == PaintMode.SeamEnforcer) "Cancel paint…" else "Force seam",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            OutlinedButton(
                onClick = { onToggleSeamBlocker?.invoke() },
                enabled = onToggleSeamBlocker != null,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
            ) {
                Text(
                    if (supportPaintMode == PaintMode.SeamBlocker) "Cancel paint…" else "Block seam",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        if (hasSeamPaint) {
            Spacer(Modifier.height(4.dp))
            TextButton(
                onClick = { onClearSeamPaint?.invoke() },
                enabled = onClearSeamPaint != null,
            ) { Text("Clear seam paint", color = Color(0xFFFF7070)) }
        }
        // Phase XR_OBJ_8 — Clone pattern (linear). Duplicates the
        // selected model [count]× along an axis with mm spacing.
        Spacer(Modifier.height(12.dp))
        Text("Clone pattern", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        var cloneCountText by remember(model.id) { mutableStateOf("3") }
        var cloneSpacingText by remember(model.id) { mutableStateOf("5") }
        var cloneAxis by remember(model.id) { mutableStateOf('X') }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Count", color = Color(0xFFB6BEC8), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(60.dp))
            TextField(
                value = cloneCountText,
                onValueChange = { cloneCountText = it.filter { c -> c.isDigit() } },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = Color(0xFF1B1F23),
                    focusedContainerColor = Color(0xFF1B1F23),
                    unfocusedTextColor = Color.White,
                    focusedTextColor = Color.White,
                ),
                modifier = Modifier.width(80.dp),
            )
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Spacing", color = Color(0xFFB6BEC8), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(60.dp))
            TextField(
                value = cloneSpacingText,
                onValueChange = { cloneSpacingText = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = Color(0xFF1B1F23),
                    focusedContainerColor = Color(0xFF1B1F23),
                    unfocusedTextColor = Color.White,
                    focusedTextColor = Color.White,
                ),
                modifier = Modifier.width(80.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text("mm", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Axis", color = Color(0xFFB6BEC8), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(60.dp))
            OutlinedButton(
                onClick = { cloneAxis = 'X' },
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                border = BorderStroke(1.dp, if (cloneAxis == 'X') Color(0xFF7BC8FF) else Color(0xFF3A4148)),
            ) { Text("X", color = if (cloneAxis == 'X') Color(0xFF7BC8FF) else Color(0xFFB6BEC8)) }
            OutlinedButton(
                onClick = { cloneAxis = 'Y' },
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                border = BorderStroke(1.dp, if (cloneAxis == 'Y') Color(0xFF7BC8FF) else Color(0xFF3A4148)),
            ) { Text("Y", color = if (cloneAxis == 'Y') Color(0xFF7BC8FF) else Color(0xFFB6BEC8)) }
            Spacer(Modifier.weight(1f))
            OutlinedButton(
                onClick = {
                    val c = cloneCountText.toIntOrNull()?.coerceIn(1, 16)
                    val s = cloneSpacingText.toFloatOrNull()
                    if (c != null && s != null) onClonePattern?.invoke(c, s, cloneAxis)
                },
                enabled = onClonePattern != null &&
                    cloneCountText.toIntOrNull() != null &&
                    cloneSpacingText.toFloatOrNull() != null,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
            ) { Text("Apply") }
        }
        // Phase XR_OBJ_4 (final) — Object Settings. Curated 4-key
        // starter set. Empty TextField = revert to global profile
        // default; non-empty upserts into the per-object config map
        // and rides the slice via libslic3r's per-ModelObject
        // DynamicPrintConfig (set_deserialize_nothrow on
        // mo->config()).
        Spacer(Modifier.height(12.dp))
        Text("Object settings", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        ObjectConfigRow(
            label = "Layer height",
            unit = "mm",
            key = "layer_height",
            value = objectConfigOverrides["layer_height"] ?: "",
            onChange = { v -> onObjectConfigChange?.invoke("layer_height", v) },
            enabled = onObjectConfigChange != null,
        )
        ObjectConfigRow(
            label = "Wall loops",
            unit = "",
            key = "wall_loops",
            value = objectConfigOverrides["wall_loops"] ?: "",
            onChange = { v -> onObjectConfigChange?.invoke("wall_loops", v) },
            enabled = onObjectConfigChange != null,
        )
        ObjectConfigRow(
            label = "Infill",
            unit = "%",
            key = "sparse_infill_density",
            value = objectConfigOverrides["sparse_infill_density"] ?: "",
            onChange = { v -> onObjectConfigChange?.invoke("sparse_infill_density", v) },
            enabled = onObjectConfigChange != null,
        )
        ObjectConfigRow(
            label = "Support",
            unit = "0/1",
            key = "enable_support",
            value = objectConfigOverrides["enable_support"] ?: "",
            onChange = { v -> onObjectConfigChange?.invoke("enable_support", v) },
            enabled = onObjectConfigChange != null,
        )
    }
}

/** Phase XR_OBJ_4 (final) — one row in the Object Settings section.
 *  Empty value clears the override; non-empty upserts into
 *  PlacedModel.configOverrides. The local `text` state mirrors the
 *  cursor-stability pattern from gotcha #56 (TransformPanel
 *  TextFields) — keyed on the canonical [value] so external resets
 *  flow in but mid-typing edits don't get clobbered. */
@Composable
private fun ObjectConfigRow(
    label: String,
    unit: String,
    key: String,
    value: String,
    onChange: (String) -> Unit,
    enabled: Boolean,
) {
    var text by remember(value) { mutableStateOf(value) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
        Text(
            label,
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.width(100.dp),
        )
        TextField(
            value = text,
            onValueChange = {
                text = it
                onChange(it.trim())
            },
            singleLine = true,
            placeholder = { Text("(profile)", color = Color.Gray, style = MaterialTheme.typography.bodySmall) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            colors = TextFieldDefaults.colors(
                unfocusedContainerColor = Color(0xFF1B1F23),
                focusedContainerColor = Color(0xFF1B1F23),
                unfocusedTextColor = Color.White,
                focusedTextColor = Color.White,
            ),
            enabled = enabled,
            modifier = Modifier.width(96.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(unit, color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(28.dp))
    }
}

@Composable
private fun TransformAxisSection(
    label: String,
    unit: String,
    x: Float,
    y: Float,
    z: Float,
    onChange: (xVal: Float, yVal: Float, zVal: Float) -> Unit,
    onResetAxis: (axis: Int) -> Unit,
) {
    Text(label, color = Color.White, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        AxisFieldRow("X", unit, x, { newX -> onChange(newX, y, z) }) { onResetAxis(0) }
        AxisFieldRow("Y", unit, y, { newY -> onChange(x, newY, z) }) { onResetAxis(1) }
        AxisFieldRow("Z", unit, z, { newZ -> onChange(x, y, newZ) }) { onResetAxis(2) }
    }
}

/**
 * Single labeled TextField for one transform axis. Holds its own
 * `text: String` state alongside the canonical numeric value so the
 * user can type freely (incl. partial / negative / decimal-point-only
 * input) without the parsed re-format clobbering their cursor on every
 * recomposition. Commits to [onChange] on every successful parse;
 * commits the unchanged value when parse fails (the field stays
 * red-tinted via placeholder-like hint until the user fixes it).
 */
@Composable
private fun AxisFieldRow(
    axis: String,
    unit: String,
    value: Float,
    onChange: (Float) -> Unit,
    onReset: () -> Unit,
) {
    var text by remember(value) { mutableStateOf(formatAxisValue(value)) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            axis,
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.width(20.dp),
        )
        Spacer(Modifier.width(6.dp))
        TextField(
            value = text,
            onValueChange = { newText ->
                text = newText
                val parsed = newText.trim().toFloatOrNull()
                if (parsed != null) onChange(parsed)
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            colors = TextFieldDefaults.colors(
                unfocusedContainerColor = Color(0xFF1B1F23),
                focusedContainerColor = Color(0xFF1B1F23),
                unfocusedTextColor = Color.White,
                focusedTextColor = Color.White,
            ),
            modifier = Modifier.width(120.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(unit, color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(24.dp))
        Spacer(Modifier.weight(1f))
        TextButton(onClick = onReset, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("↺", color = Color(0xFF7BC8FF))
        }
    }
}

private fun formatAxisValue(v: Float): String {
    // Match how the user expects to see the number — integer when
    // .0, two decimals otherwise. Avoids dropping the user mid-edit
    // by re-rounding "0.5" into "0.50" on the next compose pass.
    return if (v == v.toInt().toFloat()) v.toInt().toString() else "%.2f".format(v)
}

/**
 * Phase XR_OBJ_4 — one row in TransformPanel's per-volume list. Shows
 * the volume's type label + filename + remove button collapsed; tap
 * the chevron to expand and reveal X/Y/Z translate/rotate plus uniform
 * scale TextFields. Edits push back through [onUpdate]; removal calls
 * [onRemove].
 */
@Composable
private fun PlacedVolumeRow(
    volume: PlacedVolume,
    onUpdate: (PlacedVolume) -> Unit,
    onRemove: () -> Unit,
) {
    var expanded by remember(volume.id) { mutableStateOf(false) }
    val typeLabel = when (volume.type) {
        ModelVolumeType.MODEL_PART -> "Part"
        ModelVolumeType.PARAMETER_MODIFIER -> "Modifier"
        ModelVolumeType.NEGATIVE_VOLUME -> "Negative"
        ModelVolumeType.SUPPORT_ENFORCER -> "Sup. enf."
        ModelVolumeType.SUPPORT_BLOCKER -> "Sup. blk."
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(Color(0xFF1B1F23))
            .padding(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "[$typeLabel]",
                color = Color(0xFF7BC8FF),
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.width(72.dp),
            )
            Text(
                volume.source.name,
                color = Color.White,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                modifier = Modifier.weight(1f).padding(end = 4.dp),
            )
            TextButton(
                onClick = { expanded = !expanded },
                contentPadding = PaddingValues(horizontal = 6.dp),
            ) { Text(if (expanded) "▴" else "▾", color = Color(0xFF7BC8FF)) }
            TextButton(
                onClick = onRemove,
                contentPadding = PaddingValues(horizontal = 6.dp),
            ) { Text("✕", color = Color(0xFFFF7070)) }
        }
        if (expanded) {
            Spacer(Modifier.height(4.dp))
            // Translate
            VolumeAxisRow(
                "T", "mm",
                volume.translateXmm, volume.translateYmm, volume.translateZmm,
            ) { x, y, z -> onUpdate(volume.copy(translateXmm = x, translateYmm = y, translateZmm = z)) }
            // Rotate
            VolumeAxisRow(
                "R", "°",
                volume.rotXDeg, volume.rotYDeg, volume.rotZDeg,
            ) { x, y, z -> onUpdate(volume.copy(rotXDeg = x, rotYDeg = y, rotZDeg = z)) }
            // Scale (uniform-driven via X — sets all three to the same value)
            VolumeAxisRow(
                "S", "%",
                volume.scaleXPct, volume.scaleYPct, volume.scaleZPct,
            ) { x, y, z -> onUpdate(volume.copy(scaleXPct = x, scaleYPct = y, scaleZPct = z)) }
        }
    }
}

@Composable
private fun VolumeAxisRow(
    label: String,
    unit: String,
    x: Float,
    y: Float,
    z: Float,
    onChange: (Float, Float, Float) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.width(20.dp),
        )
        VolumeAxisField(x, { newX -> onChange(newX, y, z) })
        Spacer(Modifier.width(4.dp))
        VolumeAxisField(y, { newY -> onChange(x, newY, z) })
        Spacer(Modifier.width(4.dp))
        VolumeAxisField(z, { newZ -> onChange(x, y, newZ) })
        Spacer(Modifier.width(4.dp))
        Text(unit, color = Color.Gray, style = MaterialTheme.typography.labelSmall, modifier = Modifier.width(20.dp))
    }
}

@Composable
private fun VolumeAxisField(value: Float, onChange: (Float) -> Unit) {
    var text by remember(value) { mutableStateOf(formatAxisValue(value)) }
    TextField(
        value = text,
        onValueChange = { newText ->
            text = newText
            val parsed = newText.trim().toFloatOrNull()
            if (parsed != null) onChange(parsed)
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        textStyle = MaterialTheme.typography.bodySmall,
        colors = TextFieldDefaults.colors(
            unfocusedContainerColor = Color(0xFF15181B),
            focusedContainerColor = Color(0xFF15181B),
            unfocusedTextColor = Color.White,
            focusedTextColor = Color.White,
        ),
        modifier = Modifier.width(72.dp),
    )
}

@Composable
private fun MirrorToggle(label: String, on: Boolean, onChange: (Boolean) -> Unit) {
    val border = if (on) Color(0xFF7BC8FF) else Color(0xFF3A4148)
    val background = if (on) Color(0xFF1F3548) else Color(0xFF1B1F23)
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .border(BorderStroke(1.dp, border), RoundedCornerShape(8.dp))
            .clickable { onChange(!on) },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (on) Color(0xFF7BC8FF) else Color(0xFFB6BEC8),
            style = MaterialTheme.typography.titleMedium,
        )
    }
}