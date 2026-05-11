package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.FilamentEntry
import dev.orcaxr.app.MixedFilamentEntry
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

/**
 * Filament-domain tools — all per-printer because OrcaXR keeps a
 * separate project palette + slot mapping per configured printer
 * (different printers have different extruder counts and the user
 * may load different colors per machine).
 */
internal object FilamentTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        ListFilaments(ctx),
        ListMixedFilaments(ctx),
        ListSlotColors(ctx),
        SetMixedFilamentRow(ctx),
        DeleteMixedFilamentRow(ctx),
    )

    private suspend fun resolvePrinter(ctx: ToolContext, idOrName: String): PrinterConfig? {
        val printers = ctx.printers.printers.first()
        return printers.firstOrNull { it.id == idOrName }
            ?: printers.firstOrNull { it.name.equals(idOrName, ignoreCase = true) }
    }

    private fun encodeEntry(e: FilamentEntry): JSONObject = JSONObject().apply {
        put("id", e.id)
        put("color", e.color)
        if (e.slotIndex != null) put("slot_index", e.slotIndex)
        put("filament_type", e.filamentType)
        if (e.physicalSlot != null) put("physical_slot", e.physicalSlot)
        if (e.virtualSlot != null) put("virtual_slot", e.virtualSlot)
    }

    private fun encodeMixed(e: MixedFilamentEntry): JSONObject = JSONObject().apply {
        put("id", e.id)
        put("component_a", e.componentA)
        put("component_b", e.componentB)
        put("ratio_a", e.ratioA)
        put("ratio_b", e.ratioB)
        put("mix_b_percent", e.mixBPercent)
        put("bias_percent", e.biasPercent)
        if (!e.manualPattern.isNullOrEmpty()) put("manual_pattern", e.manualPattern)
        if (e.gradientComponentIds.isNotEmpty()) put("gradient_component_ids", e.gradientComponentIds)
        if (e.gradientComponentWeights.isNotEmpty()) put("gradient_component_weights", e.gradientComponentWeights)
        put("distribution_mode", e.distributionMode)
        put("local_z_max_sublayers", e.localZMaxSublayers)
        put("pointillism_all_filaments", e.pointillismAllFilaments)
        put("custom", e.custom)
        put("origin_auto", e.originAuto)
        put("enabled", e.enabled)
        put("deleted", e.deleted)
        put("display_color", e.displayColor)
    }

    class ListFilaments(private val ctx: ToolContext) : Tool {
        override val name = "list_filaments"
        override val description =
            "List the project filaments (palette) configured for one printer. Each entry has " +
                "id, color (hex), filament_type, optional slot_index (0-based extruder), " +
                "physical_slot (0-based 'use whatever's loaded at this T_n' override), " +
                "and virtual_slot (1-based FullSpectrum mixed-filament row). " +
                "The active printer is the one selected for printing — pass its id."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name) from list_printers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolvePrinter(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches '${args.optString("printer_id")}'.")
            val entries = ctx.filamentEntries.all.first()[printer.id].orEmpty()
            val arr = JSONArray()
            for (e in entries) arr.put(encodeEntry(e))
            val body = JSONObject().apply {
                put("ok", true)
                put("printer_id", printer.id)
                put("printer_name", printer.name)
                put("count", entries.size)
                put("filaments", arr)
            }
            val text = if (entries.isEmpty()) "${printer.name}: no project filaments configured."
                else entries.joinToString("\n") { e ->
                    "- slot ${e.slotIndex ?: "-"}  ${e.color}  ${e.filamentType}  id=${e.id}"
                }
            return ToolResult.ok(text, body)
        }
    }

    class ListMixedFilaments(private val ctx: ToolContext) : Tool {
        override val name = "list_mixed_filaments"
        override val description =
            "List FullSpectrum virtual mixed-filament rows for one printer. Each row defines " +
                "a virtual filament made by alternating two physical components. Note: the slicer " +
                "engine doesn't yet read these (port pending) — the rows persist for UX continuity."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name)")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolvePrinter(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            val rows = ctx.mixedFilaments.all.first()[printer.id].orEmpty()
            val arr = JSONArray()
            for (r in rows) arr.put(encodeMixed(r))
            val body = JSONObject().apply {
                put("ok", true)
                put("printer_id", printer.id)
                put("count", rows.size)
                put("mixed_filaments", arr)
            }
            val text = if (rows.isEmpty()) "${printer.name}: no mixed-filament rows."
                else rows.joinToString("\n") { r ->
                    "- A=${r.componentA} B=${r.componentB} ratio=${r.ratioA}/${r.ratioB}  " +
                        (if (r.enabled) "" else "[disabled] ") +
                        (if (r.deleted) "[deleted] " else "") +
                        "id=${r.id}"
                }
            return ToolResult.ok(text, body)
        }
    }

    /**
     * Mutator: create or replace a virtual mixed-filament row for one
     * printer. If `id` matches an existing row, the row is updated;
     * otherwise a new row is appended (capped at the FullSpectrum
     * canonical N*(N-1)/2 unordered-pair limit per the per-printer
     * physical filament count).
     */
    class SetMixedFilamentRow(private val ctx: ToolContext) : Tool {
        override val name = "set_mixed_filament_row"
        override val description =
            "Create or update one FullSpectrum virtual mixed-filament row. Pass component_a / " +
                "component_b as 1-based physical filament IDs. Optional fields: ratio_a, ratio_b " +
                "(layer cadence), mix_b_percent (0..100), bias_percent (-100..100), " +
                "distribution_mode (0=LayerCycle, 1=Pointillisme, 2=Simple), " +
                "local_z_max_sublayers (0=off), manual_pattern (digits 1..9 only, e.g. \"1112\"), " +
                "gradient_component_ids (3+ way mix, e.g. \"123\"), gradient_component_weights " +
                "(\"50/25/25\"), enabled. Returns the resulting row."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id", "component_a", "component_b"),
            properties = mapOf(
                "printer_id" to Schemas.string("Printer id (or name)"),
                "id" to Schemas.string("Optional row id; defaults to a stable id derived from the pair"),
                "component_a" to Schemas.integer("1-based physical filament id"),
                "component_b" to Schemas.integer("1-based physical filament id"),
                "ratio_a" to Schemas.integer("Layer cadence count for A (default 1)"),
                "ratio_b" to Schemas.integer("Layer cadence count for B (default 1)"),
                "mix_b_percent" to Schemas.integer("Blend percentage of B in [0..100], default 50"),
                "bias_percent" to Schemas.integer("Signed UI bias [-100..100], default 0"),
                "distribution_mode" to Schemas.integer("0=LayerCycle, 1=Pointillisme, 2=Simple"),
                "local_z_max_sublayers" to Schemas.integer("Local-Z cap; 0 disables"),
                "manual_pattern" to Schemas.string("Optional cycle pattern, digits 1..9"),
                "gradient_component_ids" to Schemas.string("3+ way mix component ids, e.g. \"123\""),
                "gradient_component_weights" to Schemas.string("Weights, e.g. \"50/25/25\""),
                "enabled" to Schemas.bool("Whether this row is exposed (default true)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolvePrinter(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            val a = args.optInt("component_a", -1)
            val b = args.optInt("component_b", -1)
            if (a <= 0 || b <= 0 || a == b) {
                return ToolResult.error("component_a and component_b must be distinct positive 1-based ids.")
            }
            val rows = ctx.mixedFilaments.all.first()[printer.id].orEmpty()
            val rowId = args.optString("id").ifBlank { "row_${a}_${b}" }
            val existing = rows.firstOrNull { it.id == rowId }
            val updated = MixedFilamentEntry(
                id = rowId,
                componentA = a,
                componentB = b,
                ratioA = args.optInt("ratio_a", existing?.ratioA ?: 1).coerceAtLeast(1),
                ratioB = args.optInt("ratio_b", existing?.ratioB ?: 1).coerceAtLeast(1),
                mixBPercent = args.optInt("mix_b_percent", existing?.mixBPercent ?: 50).coerceIn(0, 100),
                biasPercent = args.optInt("bias_percent", existing?.biasPercent ?: 0).coerceIn(-100, 100),
                manualPattern = args.optString("manual_pattern", existing?.manualPattern.orEmpty())
                    .filter { it in '1'..'9' }
                    .ifEmpty { null },
                gradientComponentIds = args.optString(
                    "gradient_component_ids",
                    existing?.gradientComponentIds.orEmpty(),
                ).filter { it in '1'..'9' },
                gradientComponentWeights = args.optString(
                    "gradient_component_weights",
                    existing?.gradientComponentWeights.orEmpty(),
                ),
                distributionMode = args.optInt(
                    "distribution_mode",
                    existing?.distributionMode ?: 0,
                ).coerceIn(0, 2),
                localZMaxSublayers = args.optInt(
                    "local_z_max_sublayers",
                    existing?.localZMaxSublayers ?: 0,
                ).coerceAtLeast(0),
                pointillismAllFilaments = existing?.pointillismAllFilaments ?: false,
                enabled = if (args.has("enabled")) args.optBoolean("enabled", true)
                    else existing?.enabled ?: true,
                deleted = false,
                custom = true,
                originAuto = existing?.originAuto ?: false,
                displayColor = existing?.displayColor ?: "#FFFFFF",
            )
            val nextRows = if (existing != null) rows.map { if (it.id == rowId) updated else it }
                else rows + updated
            ctx.mixedFilaments.set(printer.id, nextRows)
            val body = JSONObject().apply {
                put("ok", true)
                put("printer_id", printer.id)
                put("row", encodeMixed(updated))
            }
            return ToolResult.ok("Set mixed-filament row ${updated.id}.", body)
        }
    }

    /**
     * Mutator: tombstone a virtual mixed-filament row. Sets `deleted=true`
     * rather than removing the row outright so auto-regenerate doesn't
     * resurrect a row the user explicitly killed.
     */
    class DeleteMixedFilamentRow(private val ctx: ToolContext) : Tool {
        override val name = "delete_mixed_filament_row"
        override val description =
            "Delete (tombstone) one virtual mixed-filament row by id. Auto-regenerate keeps " +
                "the row hidden so it doesn't come back next slice."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id", "id"),
            properties = mapOf(
                "printer_id" to Schemas.string("Printer id (or name)"),
                "id" to Schemas.string("Row id to delete"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolvePrinter(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            val rowId = args.optString("id").ifBlank {
                return ToolResult.error("Missing row id.")
            }
            val rows = ctx.mixedFilaments.all.first()[printer.id].orEmpty()
            if (rows.none { it.id == rowId }) {
                return ToolResult.error("No mixed-filament row '$rowId' for printer ${printer.name}.")
            }
            val next = rows.map { if (it.id == rowId) it.copy(deleted = true) else it }
            ctx.mixedFilaments.set(printer.id, next)
            return ToolResult.ok(
                "Tombstoned mixed-filament row $rowId.",
                JSONObject().apply { put("ok", true); put("id", rowId) },
            )
        }
    }

    class ListSlotColors(private val ctx: ToolContext) : Tool {
        override val name = "list_slot_colors"
        override val description =
            "List the per-slot 'loaded in printer' colors for one printer. " +
                "These come from a printer-side detect (queryFilamentSlots) or user override."
        override val inputSchema = Schemas.obj(
            required = listOf("printer_id"),
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name)")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val printer = resolvePrinter(ctx, args.optString("printer_id"))
                ?: return ToolResult.error("No printer matches.")
            val colors = ctx.filamentSlots.all.first()[printer.id].orEmpty()
            val arr = JSONArray()
            for (c in colors) arr.put(c)
            val body = JSONObject().apply {
                put("ok", true)
                put("printer_id", printer.id)
                put("count", colors.size)
                put("slot_colors", arr)
            }
            val text = if (colors.isEmpty()) "${printer.name}: no slot colors stored."
                else colors.mapIndexed { i, c -> "T$i: $c" }.joinToString(", ")
            return ToolResult.ok(text, body)
        }
    }
}
