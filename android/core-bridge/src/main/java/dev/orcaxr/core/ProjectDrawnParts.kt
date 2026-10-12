package dev.orcaxr.core

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.abs

/**
 * What the Emboss and SVG part tools act on (the browser's
 * `brimEarTargetObject`, `embossTargetVolume` and `svgTargetVolume`): the one
 * object owning the model parts the selection takes on the active plate,
 * which a new part is added to, and — when the selection takes exactly one
 * model part and it is embossed text, or an SVG part — that part, which
 * applying re-cuts instead.
 */
data class DrawnPartTarget(
    val objectId: String? = null,
    val textVolumeId: String? = null,
    val svgVolumeId: String? = null,
)

/** How "Add embossed text" (`emboss_apply`, `applyEmboss`) ended. */
sealed interface EmbossApplied {
    /** Nothing to add to or re-cut: the browser's "Select one model part to add embossed text to." */
    data object NoTarget : EmbossApplied
    /** The cut refused, in the core's words (the browser's "Emboss failed: …"). */
    data class Failed(val message: String) : EmbossApplied
    /** Part [volumeId] added, or re-cut when [recut], as one undoable step. */
    data class Cut(val volumeId: String, val recut: Boolean, val preview: ProjectIntents.EmbossPreview) : EmbossApplied
}

/** How "Add SVG part" (`svg_apply`, `applySvgPart`) ended. */
sealed interface SvgPartApplied {
    /** Nothing to add to or re-cut: the browser's "Select one model part to add the drawing to." */
    data object NoTarget : SvgPartApplied
    /** The cut refused, in the core's words (the browser's "SVG part failed: …"). */
    data class Failed(val message: String) : SvgPartApplied
    /** Part [volumeId] added, or re-cut when [recut], as one undoable step. */
    data class Cut(val volumeId: String, val recut: Boolean, val preview: ProjectIntents.SvgPartPreview) : SvgPartApplied
}

private fun units(text: String) = text.map { it.code }
private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

/**
 * `value.toFixed(digits)` as JavaScript writes it: the exact binary value
 * rounded half up (the larger of two equally near), trailing zeros kept, a
 * negative value that rounds to zero still signed.
 */
internal fun jsFixed(value: Double, digits: Int): String {
    if (!value.isFinite() || abs(value) >= 1e21) return JsText.number(value)
    val rounded = BigDecimal(abs(value)).setScale(digits, RoundingMode.HALF_UP).toPlainString()
    return if (value < 0) "-$rounded" else rounded
}

/**
 * The Emboss tool's recipe and words as the browser's workspace and panel
 * keep and compute them (`OrcaWorkspace`'s emboss tool, `EmbossPanel`), for
 * the words the browser writes without a message catalogue entry. Its
 * catalogue messages are the app's string resources.
 */
object ProjectEmbossing {
    private val ABSENT = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)

    /**
     * The recipe a tool starts with (`DEFAULT_EMBOSS_TEXT_CONFIGURATION`):
     * "Text", 10 mm high, 1 mm deep, centred, no font named yet.
     */
    val DEFAULT_CONFIGURATION = ProjectIntents.EmbossConfiguration(
        units("Text"), emptyList(), emptyList(), units("file_name"),
        ProjectIntents.EmbossFontProperty(
            0.0, 0.0, 10.0, 0.0, 0.0, false,
            ProjectIntents.EmbossHorizontalAlign.Center, ProjectIntents.EmbossVerticalAlign.Center, 0.0,
        ),
        ProjectIntents.EmbossProjection(1.0, false),
        ABSENT, ABSENT, ABSENT, ABSENT,
    )

    /** The panel's number fields, in its order: Size, Depth, Letter gap, Line gap. */
    enum class Field { SIZE, DEPTH, CHAR_GAP, LINE_GAP }

    /** [configuration] named after font file [name] as `loadEmbossFont` names it: its style keeps an earlier name. */
    fun named(configuration: ProjectIntents.EmbossConfiguration, name: String) = configuration.copy(
        styleName = configuration.styleName.ifEmpty { units(name) },
        fontDescriptor = units(name),
        fontDescriptorType = units("file_name"),
    )

    fun text(configuration: ProjectIntents.EmbossConfiguration): String = text(configuration.text)
    fun withText(configuration: ProjectIntents.EmbossConfiguration, value: String) = configuration.copy(text = units(value))

    /** A number field's value: Size is the line height (`lineHeightMm`). */
    fun number(configuration: ProjectIntents.EmbossConfiguration, field: Field): Double = when (field) {
        Field.SIZE -> configuration.font.lineHeightMm
        Field.DEPTH -> configuration.projection.depthMm
        Field.CHAR_GAP -> configuration.font.charGapMm
        Field.LINE_GAP -> configuration.font.lineGapMm
    }

    /** `setEmbossRecipe` with one number: taken as handed over, the cut refusing what it cannot use. */
    fun withNumber(configuration: ProjectIntents.EmbossConfiguration, field: Field, value: Double) = when (field) {
        Field.SIZE -> configuration.copy(font = configuration.font.copy(lineHeightMm = value))
        Field.DEPTH -> configuration.copy(projection = configuration.projection.copy(depthMm = value))
        Field.CHAR_GAP -> configuration.copy(font = configuration.font.copy(charGapMm = value))
        Field.LINE_GAP -> configuration.copy(font = configuration.font.copy(lineGapMm = value))
    }

    fun withAlign(configuration: ProjectIntents.EmbossConfiguration, horizontal: ProjectIntents.EmbossHorizontalAlign) =
        configuration.copy(font = configuration.font.copy(horizontal = horizontal))
    fun withAlign(configuration: ProjectIntents.EmbossConfiguration, vertical: ProjectIntents.EmbossVerticalAlign) =
        configuration.copy(font = configuration.font.copy(vertical = vertical))

    // ---- The workspace's statuses and the panel's words that no message catalogue entry carries ----

    /** The tool opened (`embossTool`); the browser adds that it cannot read installed fonts, which an app is not limited to. */
    fun start(fontLoaded: Boolean) =
        if (fontLoaded) "Emboss: type the text, then add it to the selected part." else "Emboss: choose a .ttf font file first."

    fun loaded(name: String) = "Loaded $name for embossing."
    fun unreadable(message: String) = "Could not read that font: $message"
    fun failed(message: String?) = "Emboss failed: ${message.orEmpty()}"

    /**
     * A cut's status (`applyEmboss`): the characters font [fontName] has no
     * glyph for and any edges that did not close, or the cut's triangles.
     */
    fun embossed(fontName: String, preview: ProjectIntents.EmbossPreview): String {
        val notes = buildList {
            if (preview.missingCodePoints.isNotEmpty()) {
                add("$fontName has no glyph for ${preview.missingCodePoints.joinToString(" ") { String(Character.toChars(it.toInt())) }}")
            }
            // An open mesh still prints, but it prints wrong; say so.
            if (preview.openEdgeCount > 0) add("${preview.openEdgeCount} edges did not close")
        }
        return if (notes.isNotEmpty()) "Embossed the text — ${notes.joinToString("; ")}." else "Embossed the text as ${preview.triangleCount} triangles."
    }

    /**
     * The panel's hint (`getEmbossSnapshot`): what applying does now. The
     * browser adds that it cannot read installed fonts, which an app is not
     * limited to.
     */
    fun hint(fontLoaded: Boolean, target: DrawnPartTarget): String = when {
        !fontLoaded -> "Choose a .ttf font file."
        target.textVolumeId != null -> "Editing the selected text re-cuts its mesh; undo restores the previous cut."
        target.objectId != null -> "Adds the text as a new part of the selected model."
        else -> "Select one model part to add the text to."
    }

    /** A font file too large to read (past [ProjectEmbossFont.MAX_FONT_BYTES]); the browser reads any size. */
    const val TOO_LARGE = "That file is too large to read as a font"
}

/**
 * The SVG part tool's recipe and words as the browser's workspace and panel
 * keep and compute them (`OrcaWorkspace`'s SVG tool, `SvgPanel`), for the
 * words the browser writes without a message catalogue entry.
 */
object ProjectSvgParts {
    /** The depth a tool starts with (`DEFAULT_SVG_PART_DEPTH_MM`). */
    const val DEFAULT_DEPTH_MM = 2.0

    /** The panel's width as `setSvgPartSize` keeps it: none (the drawing's own size) unless greater than zero. */
    fun width(value: Double): Double? = if (value > 0) value else null

    /** The cut's request (`applySvgPart`'s options): file [fileName], [depthMm], [widthMm] when chosen. */
    fun request(fileName: String, depthMm: Double, widthMm: Double?) = ProjectIntents.SvgPartRequest(
        units(fileName),
        depthMm,
        widthMm?.let { ProjectIntents.OptionalFinite.Value(it) } ?: ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty),
        false,
        ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
    )

    fun start(drawingLoaded: Boolean) =
        if (drawingLoaded) "SVG part: set the size, then add it to the selected part." else "SVG part: choose an .svg file to cut."

    /** A drawing loaded (`loadSvgDrawing`): its size, and how many of its parts cannot be cut. */
    fun loaded(name: String, drawing: ProjectIntents.SvgDrawingSummary): String {
        val notes = if (drawing.unsupportedCount > 0) " ${drawing.unsupportedCount} part(s) of it cannot be cut." else ""
        return "Loaded $name at ${jsFixed(drawing.sizeMm[0], 1)} x ${jsFixed(drawing.sizeMm[1], 1)} mm.$notes"
    }

    fun unreadable(message: String) = "Could not read that drawing: $message"
    fun failed(message: String?) = "SVG part failed: ${message.orEmpty()}"

    /** A cut's status (`applySvgPart`): its size, the first thing not cut and any edges that did not close. */
    fun cut(name: String, preview: ProjectIntents.SvgPartPreview): String {
        val notes = preview.unsupported.firstOrNull()?.let { " Not cut: ${text(it.detail)}" }.orEmpty()
        val open = if (preview.openEdgeCount > 0) " ${preview.openEdgeCount} edges did not close." else ""
        return "Cut $name at ${jsFixed(preview.sizeMm[0], 1)} x ${jsFixed(preview.sizeMm[1], 1)} mm.$notes$open"
    }

    /**
     * The panel's hint (`getSvgPartSnapshot`): what applying does now; none
     * where the app's catalogue message ("Select one model part to add the
     * drawing to.") says it.
     */
    fun hint(drawingLoaded: Boolean, target: DrawnPartTarget): String? = when {
        !drawingLoaded -> "Choose an .svg file; its filled shapes become a solid part."
        target.svgVolumeId != null -> "Changing the size re-cuts the selected part; undo restores it."
        target.objectId != null -> "Adds the drawing as a new part of the selected model."
        else -> null
    }

    /** A drawing too large to read (past [ProjectSvgPart.MAX_DRAWING_BYTES], the core's bound). */
    const val TOO_LARGE = "That file is too large to read as a drawing"

    /** The details of what the drawing holds that cannot be cut, as the panel lists them. */
    fun unsupported(drawing: ProjectIntents.SvgDrawingSummary): List<String> = drawing.unsupported.map { text(it.detail) }
}
