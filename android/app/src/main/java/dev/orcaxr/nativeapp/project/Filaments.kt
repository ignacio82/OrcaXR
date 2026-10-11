package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.FilamentAssignment
import dev.orcaxr.core.FilamentOption
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectView

/**
 * The project's filaments as the browser's workspace lists and assigns them,
 * kept free of Android so they are checked on the JVM: the Filament tab's
 * rows (web/src/main.ts `renderProfileSelects`, the heads panel — one row per
 * palette slot, `H-n` for a printer head and `A-n` for an extra palette
 * colour, which alone can be removed), the selection filament bar
 * (web/src/ui/dom/SelectionFilamentBar.ts: its chips, the choice every scope
 * shares, its status) and the Objects tree's indicators
 * (web/src/ui/dom/ObjectsPanel.ts `appendIndicators`).
 */
object Filaments {
    /** The nozzles a head's picker offers (main.ts `fillSelect`). */
    val NOZZLES = listOf("0.2", "0.4", "0.6", "0.8")

    /** The colours the colour editor offers first: the palette's own and the headset's cycle (`rebuildHeadsPanel`). */
    val SWATCHES = listOf("#5f605f", "#e22b22", "#fec134", "#fefefe", "#2196f3", "#9c27b0", "#cccccc")

    /**
     * One row of the Filaments panel: the slot's position, whether it is a
     * printer head (else an extra palette colour), and the project's
     * filament there — its colour, name, type and nozzle.
     */
    data class Slot(
        val index: Int,
        val head: Boolean,
        val color: String,
        val name: String,
        val type: String,
        val nozzle: String?,
        val enabled: Boolean,
    ) {
        /** `H-1:` or `A-5:`, as the heads panel labels the row. */
        val label: String get() = (if (head) "H-" else "A-") + (index + 1) + ":"
        /** The browser's `{index}`: the slot's number as text. */
        val number: String get() = (index + 1).toString()
        /** Only a palette slot past the printer's heads can be removed (`removeAuxiliaryFilamentSlot`). */
        val removable: Boolean get() = !head
    }

    /**
     * The panel's rows: the project's own physical filaments by tool (the
     * slots the browser adopts from a project), the first [extruders] of them
     * the printer's heads.
     */
    fun slots(view: ProjectView, extruders: Int): List<Slot> {
        val physical = view.filaments.options.filter { !it.mixed }
        val slots = view.filamentSlots
        return slots.palette.indices.map { index ->
            val option = physical.getOrNull(index)
            Slot(
                index = index,
                head = index < extruders.coerceAtLeast(1),
                color = slots.palette[index].color,
                name = option?.name ?: slots.heads.getOrNull(index)?.name.orEmpty(),
                type = slots.palette[index].type,
                nozzle = slots.nozzles.getOrNull(index),
                enabled = option?.enabled ?: true,
            )
        }
    }

    // ---- The selection filament bar ----

    /** Whether the bar shows: the selection has scopes that can take a filament, and nothing that cannot. */
    fun shown(assignment: FilamentAssignment): Boolean = assignment.assignable

    /** The bar's chips: the physical heads, then the mixed recipes, as the snapshot lists them. */
    fun chips(assignment: FilamentAssignment): List<FilamentOption> =
        assignment.options.filter { !it.mixed } + assignment.options.filter { it.mixed }

    /** What the bar says it changes: the one scope's label, or null for several (then "n selected"). */
    fun scopeLabel(assignment: FilamentAssignment): String? = assignment.scopes.singleOrNull()?.label

    /** The choice every selected scope already shares (`uniformAssignment`). */
    sealed interface Choice {
        /** Every scope follows its object default. */
        data object Default : Choice
        data class Filament(val id: String) : Choice
    }

    /** The shared choice, or null when the scopes differ (none is shown as the answer for all). */
    fun uniform(assignment: FilamentAssignment): Choice? {
        val locals = assignment.scopes.map { it.local }.distinct()
        if (locals.size != 1) return null
        return locals.single()?.let(Choice::Filament) ?: Choice.Default
    }

    /** A chip's number: its head's (one-based), or "M" for a mixed filament. */
    fun chipIndex(option: FilamentOption): String =
        if (!option.mixed && option.toolId != null) (option.toolId!! + 1).toString() else "M"

    /** Whether a chip can be pressed: an enabled filament, while nothing is being assigned. */
    fun chipEnabled(option: FilamentOption, assigning: Boolean): Boolean = option.enabled && !assigning

    /** What the bar says after a press (`assign`), in its order of events. */
    sealed interface Status {
        data object Assigning : Status
        /** "<name> assigned". */
        data class Assigned(val name: String) : Status
        /** "Local assignment removed". */
        data object Cleared : Status
        /** The refusal's own words, an error. */
        data class Failed(val message: String) : Status
    }

    /** The status a finished press leaves: assigned or cleared, or its failure's words. */
    fun finished(filamentId: String?, name: String, failure: Throwable?): Status = when {
        failure != null -> Status.Failed(failure.message ?: failure.javaClass.simpleName)
        filamentId != null -> Status.Assigned(name)
        else -> Status.Cleared
    }

    // ---- The Objects tree's indicators ----

    /** One indicator of a tree row, in the panel's order. */
    sealed interface Indicator {
        data object NotPrintable : Indicator
        data class Role(val name: String) : Indicator
        /** The row's filament badge, with its colour; [mixed] and [inherited] as the browser suffixes them. */
        data class Filament(val name: String, val color: String, val mixed: Boolean, val inherited: Boolean) : Indicator
        data class ColorFacets(val count: Long) : Indicator
        data class SupportFacets(val count: Long) : Indicator
        data class Settings(val count: Long) : Indicator
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** A role as the canonical project names it. */
    private fun role(name: ProjectIntents.VolumeRoleName): String = when (name) {
        ProjectIntents.VolumeRoleName.Model -> "model"
        ProjectIntents.VolumeRoleName.NegativeVolume -> "negative-volume"
        ProjectIntents.VolumeRoleName.ParameterModifier -> "parameter-modifier"
        ProjectIntents.VolumeRoleName.SupportBlocker -> "support-blocker"
        ProjectIntents.VolumeRoleName.SupportEnforcer -> "support-enforcer"
    }

    /** A row's indicators as the browser's Objects panel shows them; counts of zero are not shown. */
    fun indicators(row: ProjectIntents.ObjectTreeRow): List<Indicator> = buildList {
        val indicators = row.indicators
        if (indicators.printable == ProjectIntents.ObjectTreePrintable.NotPrintable) add(Indicator.NotPrintable)
        (indicators.volumeRole as? ProjectIntents.OptionalVolumeRoleName.Value)?.let { add(Indicator.Role(role(it.value))) }
        (indicators.filament as? ProjectIntents.OptionalObjectTreeFilament.Value)?.value?.let {
            add(Indicator.Filament(text(it.name), text(it.color), it.mixed, it.inherited))
        }
        (indicators.paint as? ProjectIntents.OptionalObjectTreePaint.Value)?.value?.let { paint ->
            if (paint.colorFacetCount > 0) add(Indicator.ColorFacets(paint.colorFacetCount))
            if (paint.supportFacetCount > 0) add(Indicator.SupportFacets(paint.supportFacetCount))
        }
        (indicators.settingsCount as? ProjectIntents.OptionalCounter.Value)?.value?.let { if (it > 0) add(Indicator.Settings(it)) }
    }

    // ---- Colours ----

    /**
     * A colour as the swatches draw it, ARGB: `#rgb`, `#rrggbb` or
     * `#rrggbbaa` (CSS's hex forms, as the browser paints `background`);
     * anything else the swatch cannot draw (null).
     */
    fun argb(color: String): Long? {
        val hex = color.trim().removePrefix("#").takeIf { color.trim().startsWith("#") } ?: return null
        if (hex.any { it !in '0'..'9' && it.lowercaseChar() !in 'a'..'f' }) return null
        val rgba = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("") + "ff"
            6 -> hex + "ff"
            8 -> hex
            else -> return null
        }
        val value = rgba.toLong(16)
        return ((value and 0xff) shl 24) or (value ushr 8)
    }

    /**
     * What the colour editor commits for [typed]: `#rrggbb` in lower case, as
     * the browser's colour input reports a colour (a missing `#` added);
     * null for anything else.
     */
    fun picked(typed: String): String? {
        val hex = typed.trim().removePrefix("#")
        return if (hex.length == 6 && hex.all { it in '0'..'9' || it.lowercaseChar() in 'a'..'f' }) "#" + hex.lowercase(java.util.Locale.ROOT) else null
    }
}
