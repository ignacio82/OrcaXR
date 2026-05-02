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
        put("bias_percent", e.biasPercent)
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
