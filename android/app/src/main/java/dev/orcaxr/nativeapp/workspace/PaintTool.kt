package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.core.PaintToolSettings
import dev.orcaxr.core.ProjectIntents

/** Whether the next stroke assigns a state or erases to the unpainted one. */
enum class PaintMode { PAINT, ERASE }

/** One palette row as the paint panel shows it (`PaintPaletteEntry`). */
data class PaintRow(
    /** Null for the inheriting default row, which erases. */
    val filamentId: String?,
    val name: String,
    /** `#rrggbb`. */
    val color: String,
    /** Two or more stops when the recipe draws as a gradient. */
    val gradient: List<String>,
    val badge: String,
    val recipe: String?,
    val keyboardNumber: Int?,
    val selectable: Boolean,
    val unavailableReason: String?,
) {
    companion object {
        private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
        private fun optional(value: ProjectIntents.OptionalText) = (value as? ProjectIntents.OptionalText.Value)?.value?.let(::text)

        /** The core's palette ([dev.orcaxr.core.ProjectPainter.palette]) as rows. */
        fun of(palette: ProjectIntents.PaintPalette): List<PaintRow> = palette.entries.map { entry ->
            PaintRow(
                optional(entry.filamentId), text(entry.name), text(entry.displayColor),
                (entry.gradient as? ProjectIntents.OptionalTextList.Value)?.value?.map(::text).orEmpty(),
                text(entry.badge), optional(entry.recipeSummary),
                (entry.keyboardNumber as? ProjectIntents.OptionalCounter.Value)?.value?.toInt(),
                entry.selectable, optional(entry.unavailableReason),
            )
        }
    }
}

/** A state a non-colour channel assigns ([key] its `String(value)`), coloured as the paint panel shows it. */
data class PaintChannelState(val value: ProjectIntents.PaintValueInput, val key: String, val color: Long)

/** The paint panel's number fields: minimum, maximum, step and default (`renderParameters`). */
enum class PaintParameter(val min: Double, val max: Double, val step: Double, val default: Double) {
    RADIUS(.4, 8.0, .1, 4.0),
    SMART_FILL_ANGLE(0.0, 90.0, 1.0, 30.0),
    HEIGHT_RANGE(.1, 8.0, .1, 1.0),
    GAP_AREA(0.0, 5.0, .2, 2.0),
    ;

    /** The stops between the ends a slider over the range offers. */
    val steps: Int get() = Math.round((max - min) / step).toInt() - 1

    /** [value] at the nearest step of the range, as the panel's `step` input holds it. */
    fun stepped(value: Double): Double {
        val stops = Math.round((value.coerceIn(min, max) - min) / step)
        // Rounded to the step's decimals, so 0.1 steps read 0.4, 0.5, … rather than binary noise.
        return Math.round((min + stops * step) * 1000.0) / 1000.0
    }
}

/** What the painter says, as the browser's status line says it (the UI renders each in the browser's words). */
sealed interface PaintStatus {
    /** `Paint ${channel}: drag across a model, Escape cancels.` */
    data class Tool(val channel: PaintChannel) : PaintStatus
    /** `Paint colour: ${name}` */
    data class Filament(val name: String) : PaintStatus
    /** `Paint colour: erase to default` */
    data object EraseToDefault : PaintStatus
    /** `That filament is not in this project.` */
    data object NotInProject : PaintStatus
    /** The row's unavailable reason, or `That filament cannot be painted.` */
    data class Unavailable(val reason: String?) : PaintStatus
    /** `Paint tool: ${tool}` */
    data class ToolKind(val tool: PaintToolKind) : PaintStatus
    /** `Paint ${channel}: ${state}` */
    data class ChannelState(val channel: PaintChannel, val state: String) : PaintStatus
    /** `Painted ${channel} facets.` */
    data class Painted(val channel: PaintChannel) : PaintStatus
    /** `Erased ${channel} facets.` */
    data class Erased(val channel: PaintChannel) : PaintStatus
    /** `Paint failed: ${message}` */
    data class Failed(val message: String) : PaintStatus
    /** `Select a model to erase its ${channel} painting.` */
    data class EraseAllNeedsModel(val channel: PaintChannel) : PaintStatus
    /** `Erased ${channel} painting on ${parts} part(s).` */
    data class ErasedAll(val channel: PaintChannel, val parts: Int) : PaintStatus
    /** `Nothing was painted.` */
    data object NothingPainted : PaintStatus
    /** `That part shows a simplify preview; apply or cancel it first.`: a stroke never starts on a previewed part. */
    data object Previewed : PaintStatus
}

/**
 * The workspace painter's state (`OrcaWorkspace`'s paint settings, filament,
 * mode, channel and channel states) and how each paint panel choice changes
 * it, as the browser's workspace changes it. Platform-free.
 */
data class PaintToolState(
    /** A paint tool is the active tool. */
    val active: Boolean = false,
    val channel: PaintChannel = PaintChannel.COLOR,
    val filamentId: String? = null,
    val mode: PaintMode = PaintMode.PAINT,
    val settings: PaintToolSettings = PaintToolSettings.WORKSPACE,
    /** The assigned state each non-colour channel paints (`DEFAULT_CHANNEL_VALUE` until chosen). */
    val channelValues: Map<PaintChannel, ProjectIntents.PaintValueInput> = DEFAULT_CHANNEL_VALUES,
) {
    companion object {
        private fun text(value: String) = ProjectIntents.PaintValueInput.Text(value.map { it.code })
        val DEFAULT_CHANNEL_VALUES: Map<PaintChannel, ProjectIntents.PaintValueInput> = mapOf(
            PaintChannel.SUPPORT to text("enforce"),
            PaintChannel.SEAM to text("prefer"),
            PaintChannel.FUZZY_SKIN to ProjectIntents.PaintValueInput.Flag(true),
        )

        /** The paint panel's channel states, as the pinned gizmos expose them. */
        val CHANNEL_STATES: Map<PaintChannel, List<PaintChannelState>> = mapOf(
            PaintChannel.SUPPORT to listOf(
                PaintChannelState(text("enforce"), "enforce", 0xff39d353),
                PaintChannelState(text("block"), "block", 0xfff85149),
            ),
            PaintChannel.SEAM to listOf(
                PaintChannelState(text("prefer"), "prefer", 0xff58a6ff),
                PaintChannelState(text("avoid"), "avoid", 0xffff9f43),
            ),
            PaintChannel.FUZZY_SKIN to listOf(PaintChannelState(ProjectIntents.PaintValueInput.Flag(true), "true", 0xffbc8cff)),
        )

        /** `String(value)` of a channel state, as the browser's status prints it. */
        fun stateText(value: ProjectIntents.PaintValueInput): String = when (value) {
            is ProjectIntents.PaintValueInput.Text -> String(CharArray(value.value.size) { value.value[it].toChar() })
            is ProjectIntents.PaintValueInput.Flag -> value.value.toString()
        }

        /** The fields the panel shows for [tool] (`renderParameters`). */
        fun parameters(tool: PaintToolKind): List<PaintParameter> = when (tool) {
            PaintToolKind.CIRCLE, PaintToolKind.SPHERE -> listOf(PaintParameter.RADIUS)
            PaintToolKind.FILL -> listOf(PaintParameter.SMART_FILL_ANGLE)
            PaintToolKind.HEIGHT_RANGE -> listOf(PaintParameter.HEIGHT_RANGE)
            PaintToolKind.GAP_FILL -> listOf(PaintParameter.SMART_FILL_ANGLE, PaintParameter.GAP_AREA)
            PaintToolKind.TRIANGLE -> emptyList()
        }
    }

    /** What a field shows now, its default while unset. */
    fun value(parameter: PaintParameter): Double = when (parameter) {
        PaintParameter.RADIUS -> settings.radiusMm
        PaintParameter.SMART_FILL_ANGLE -> settings.smartFillAngleDegrees
        PaintParameter.HEIGHT_RANGE -> settings.heightRangeMm
        PaintParameter.GAP_AREA -> settings.gapAreaMm2
    } ?: parameter.default

    /**
     * `setTool` for a paint tool: the channel it authors becomes the stroke's,
     * and colour painting with no filament chosen takes the palette's first
     * selectable filament.
     */
    fun start(channel: PaintChannel, palette: List<PaintRow>): Pair<PaintToolState, PaintStatus> {
        val first = palette.firstOrNull { it.filamentId != null && it.selectable }?.filamentId
        val filament = if (channel == PaintChannel.COLOR && filamentId == null && mode == PaintMode.PAINT) first else filamentId
        return copy(active = true, channel = channel, filamentId = filament) to PaintStatus.Tool(channel)
    }

    /** Another tool (or none) became active. */
    fun stop(): PaintToolState = copy(active = false)

    /** `setPaintFilament`: a palette row's filament, or the default row (null) to erase. */
    fun chooseFilament(filamentId: String?, palette: List<PaintRow>): Pair<PaintToolState, PaintStatus> {
        if (filamentId == null) return copy(filamentId = null, mode = PaintMode.ERASE) to PaintStatus.EraseToDefault
        val row = palette.firstOrNull { it.filamentId == filamentId } ?: return this to PaintStatus.NotInProject
        if (!row.selectable) return this to PaintStatus.Unavailable(row.unavailableReason)
        return copy(filamentId = filamentId, mode = PaintMode.PAINT) to PaintStatus.Filament(row.name)
    }

    /** `setPaintFilamentByNumber`: the selectable row showing key [number]; null when none does. */
    fun chooseNumber(number: Int, palette: List<PaintRow>): Pair<PaintToolState, PaintStatus>? {
        val row = palette.firstOrNull { it.keyboardNumber == number && it.selectable && it.filamentId != null } ?: return null
        return chooseFilament(row.filamentId, palette)
    }

    /** `setPaintTool`. */
    fun chooseTool(tool: PaintToolKind): Pair<PaintToolState, PaintStatus> =
        copy(settings = settings.copy(tool = tool)) to PaintStatus.ToolKind(tool)

    /** A panel number field, clamped to its range as the panel's input clamps it. */
    fun chooseParameter(parameter: PaintParameter, value: Double): PaintToolState {
        if (!value.isFinite()) return this
        val clamped = value.coerceIn(parameter.min, parameter.max)
        return copy(
            settings = when (parameter) {
                PaintParameter.RADIUS -> settings.copy(radiusMm = clamped)
                PaintParameter.SMART_FILL_ANGLE -> settings.copy(smartFillAngleDegrees = clamped)
                PaintParameter.HEIGHT_RANGE -> settings.copy(heightRangeMm = clamped)
                PaintParameter.GAP_AREA -> settings.copy(gapAreaMm2 = clamped)
            },
        )
    }

    /** `setPaintMode`. */
    fun chooseMode(mode: PaintMode): PaintToolState = copy(mode = mode)

    /** `setPaintChannelState`: a non-colour channel's state, painting. */
    fun chooseChannelState(value: ProjectIntents.PaintValueInput): Pair<PaintToolState, PaintStatus>? {
        if (channel == PaintChannel.COLOR) return null
        return copy(channelValues = channelValues + (channel to value), mode = PaintMode.PAINT) to PaintStatus.ChannelState(channel, stateText(value))
    }

    /** `activePaintValue`: what the next stroke assigns; null erases. */
    fun target(): ProjectIntents.PaintValueInput? = when {
        mode == PaintMode.ERASE -> null
        channel == PaintChannel.COLOR -> filamentId?.let { id -> ProjectIntents.PaintValueInput.Text(id.map { it.code }) }
        else -> channelValues[channel]
    }

    /** The default row is chosen: erasing, or no filament to paint with. */
    fun erasing(): Boolean = mode == PaintMode.ERASE || (channel == PaintChannel.COLOR && filamentId == null)
}

/** The painter's refusals in the browser's words (`PaintTargetError`, the stroke errors), from the core's codes. */
object PaintFailures {
    /** The browser's name for a part role (`ProjectVolume['role']`). */
    fun role(role: ProjectIntents.VolumeRoleName): String = when (role) {
        ProjectIntents.VolumeRoleName.Model -> "model"
        ProjectIntents.VolumeRoleName.ParameterModifier -> "parameter-modifier"
        ProjectIntents.VolumeRoleName.NegativeVolume -> "negative-volume"
        ProjectIntents.VolumeRoleName.SupportEnforcer -> "support-enforcer"
        ProjectIntents.VolumeRoleName.SupportBlocker -> "support-blocker"
    }

    /** Why a stroke could not open on part [volumeId] (of [role]) for [target] on [channel]: the core's [code] in the browser's words. */
    fun open(code: String?, volumeId: String, role: ProjectIntents.VolumeRoleName?, channel: PaintChannel, target: ProjectIntents.PaintValueInput?, palette: List<PaintRow>): String {
        val value = target?.let(PaintToolState::stateText)
        return when (code) {
            "unsupported_role" -> "${role?.let(::role) ?: "This"} volumes cannot be colour painted"
            "unknown_volume" -> "Unknown volume $volumeId"
            "invalid_mesh" -> "Volume $volumeId has no stored mesh asset"
            "unknown_filament" -> "Unknown filament $value"
            "unavailable_filament" -> palette.firstOrNull { it.filamentId == value }?.unavailableReason ?: "Filament $value cannot be painted"
            "invalid_target" -> "$value is not a valid ${channel.label} state"
            "stale" -> "Facet annotation result is stale (project)"
            else -> code ?: "The project could not open the stroke"
        }
    }

    /** A sample the selector refused: its issues, or a topology that changed. */
    fun sample(reply: ProjectIntents.PaintStrokeSampleReply): String? = when (reply) {
        is ProjectIntents.PaintStrokeSampleReply.Sampled -> null
        is ProjectIntents.PaintStrokeSampleReply.Invalid ->
            "Invalid facet annotations (${reply.value.size} issue${if (reply.value.size == 1) "" else "s"})"
        is ProjectIntents.PaintStrokeSampleReply.Stale -> "Facet annotation result is stale (topology)"
    }
}
