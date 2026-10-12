package dev.orcaxr.nativeapp.workspace

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.orcaxr.core.DrawnPartTarget
import dev.orcaxr.core.EmbossApplied
import dev.orcaxr.core.ProjectEmbossFont
import dev.orcaxr.core.ProjectEmbossing
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectSvgPart
import dev.orcaxr.core.ProjectSvgParts
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.SvgPartApplied
import dev.orcaxr.nativeapp.R
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException

/**
 * The Workspace's Emboss Text and SVG Part tools, as the browser's workspace
 * runs them (`OrcaWorkspace`'s emboss and SVG tools over the shared core):
 * each a Workspace tool (`add_emboss`, `tool_svg`) whose panel holds what the
 * operator picked — a font file, read by the core's port of the browser's
 * TrueType reader, or a drawing, read as the browser reads a picked file —
 * and the recipe, and applies it to the selection's one object as a new part
 * or to the selected text or SVG part as a re-cut, one undoable step each.
 * Taps in the Workspace still select while either is on. Main thread, except
 * where noted; files are read and cuts made on the project's worker.
 */
class DrawnPartModel(private val host: Host) : AutoCloseable {
    /** What the tools need from the project area. */
    interface Host {
        /** The project's workspace. Worker thread. */
        fun workspace(): ProjectWorkspace
        /** Runs [task] on the project's worker, showing the area busy; a failure becomes its message. */
        fun work(task: () -> Unit)
        /** Runs [task] on the project's worker without showing it busy. */
        fun quietly(task: () -> Unit)
        /** A picked document's display name and bytes — none when it holds more than [limit] bytes. Worker thread. */
        fun read(uri: Uri, limit: Int): Pair<String, ByteArray?>
        /** A message of the app's catalogue, in the operator's language. */
        fun words(id: Int): String
        /** The area's message: a tool's status while its panel is closed. Main thread. */
        fun message(text: String)
        /** Every other Workspace tool off, one tool at a time as the browser's `setTool`. Main thread. */
        fun otherToolsOff()
    }

    private val main = Handler(Looper.getMainLooper())

    /** The Emboss tool is the Workspace's tool. */
    var embossing by mutableStateOf(false)
        private set
    /** The SVG part tool is the Workspace's tool. */
    var svgCutting by mutableStateOf(false)
        private set
    /** What applying acts on, as last read ([refreshTarget]). */
    var target by mutableStateOf(DrawnPartTarget())
        private set

    /** The loaded font's file name; none until one is chosen. */
    var fontName by mutableStateOf<String?>(null)
        private set
    /** The panel's recipe (`embossRecipe`). */
    var recipe by mutableStateOf(ProjectEmbossing.DEFAULT_CONFIGURATION)
        private set
    var embossStatus by mutableStateOf<String?>(null)
        private set
    /** The palette asked for a font: the panel's picker opens. */
    var fontPickPending by mutableStateOf(false)
        private set

    /** The loaded drawing's file name and what reading it found; none until one is chosen. */
    var drawingName by mutableStateOf<String?>(null)
        private set
    var drawing by mutableStateOf<ProjectIntents.SvgDrawingSummary?>(null)
        private set
    var svgDepthMm by mutableDoubleStateOf(ProjectSvgParts.DEFAULT_DEPTH_MM)
        private set
    /** The requested width; none keeps the drawing's own size. */
    var svgWidthMm by mutableStateOf<Double?>(null)
        private set
    var svgStatus by mutableStateOf<String?>(null)
        private set
    /** The palette asked for a drawing: the panel's picker opens. */
    var drawingPickPending by mutableStateOf(false)
        private set

    /** Number-field edits finished: a field shows the recipe's value again after each. */
    var fieldEdits by mutableIntStateOf(0)
        private set

    /** The font as read, with its name: replaced and closed on the worker only. */
    @Volatile private var font: Pair<String, ProjectEmbossFont>? = null
    /** The drawing's name and file bytes, set on the worker only. */
    @Volatile private var loaded: Pair<String, ByteArray>? = null

    private fun cause(failure: Throwable): Throwable =
        if ((failure is ExecutionException || failure is CompletionException) && failure.cause != null) cause(failure.cause!!) else failure

    /** Turns the Emboss tool on (`embossTool`, with its status) or off. */
    fun emboss(on: Boolean) {
        if (on) {
            host.otherToolsOff()
            if (svgCutting) svg(false)
        }
        embossing = on
        embossStatus = if (on) ProjectEmbossing.start(fontName != null) else null
        if (on) refreshTarget()
    }

    /** Turns the SVG part tool on (`svgPartTool`, with its status) or off. */
    fun svg(on: Boolean) {
        if (on) {
            host.otherToolsOff()
            if (embossing) emboss(false)
        }
        svgCutting = on
        svgStatus = if (on) ProjectSvgParts.start(drawingName != null) else null
        if (on) refreshTarget()
    }

    /** Reads what applying acts on again, as the browser's panels do after every change of the project or the selection. */
    fun refreshTarget() = host.quietly {
        val next = host.workspace().drawnPartTarget().get()
        main.post { target = next }
    }

    private fun embossSay(text: String) {
        main.post { if (embossing) embossStatus = text else host.message(text) }
    }

    private fun svgSay(text: String) {
        main.post { if (svgCutting) svgStatus = text else host.message(text) }
    }

    // ---- Emboss Text ----

    /** "Load an emboss font" from the palette: the tool opens and its picker with it. */
    fun requestFont() {
        if (!embossing) emboss(true)
        fontPickPending = true
    }

    fun fontPickShown() {
        fontPickPending = false
    }

    /**
     * A font file the operator picked (`emboss_load_font`, `loadEmbossFont`):
     * read with the recipe's collection index; once read, it is the tool's
     * font and names the recipe. One that cannot be read keeps the font there
     * was, saying why.
     */
    fun loadFont(uri: Uri) {
        val collection = recipe.font.collection
        host.work {
            val (name, bytes) = host.read(uri, ProjectEmbossFont.MAX_FONT_BYTES)
            if (bytes == null) return@work embossSay(ProjectEmbossing.unreadable(ProjectEmbossing.TOO_LARGE))
            val read = ProjectEmbossFont.read(ProjectIntents.EmbossFontRequest(collection), bytes)
            when (val reply = read.reply()) {
                is ProjectIntents.EmbossFontReply.Refused -> {
                    read.close()
                    embossSay(ProjectEmbossing.unreadable(String(CharArray(reply.value.message.size) { reply.value.message[it].toChar() })))
                }
                is ProjectIntents.EmbossFontReply.Read -> {
                    font?.second?.close()
                    font = name to read
                    main.post {
                        fontName = name
                        recipe = ProjectEmbossing.named(recipe, name)
                    }
                    embossSay(ProjectEmbossing.loaded(name))
                }
            }
        }
    }

    fun setText(value: String) {
        recipe = ProjectEmbossing.withText(recipe, value)
    }

    /** A number field handed over (`Number(input.value)`): the recipe takes it as given, the cut refusing what it cannot use. */
    fun setNumber(field: ProjectEmbossing.Field, value: Double) {
        recipe = ProjectEmbossing.withNumber(recipe, field, value)
        fieldEdits++
    }

    fun setHorizontal(value: ProjectIntents.EmbossHorizontalAlign) {
        recipe = ProjectEmbossing.withAlign(recipe, value)
    }

    fun setVertical(value: ProjectIntents.EmbossVerticalAlign) {
        recipe = ProjectEmbossing.withAlign(recipe, value)
    }

    /**
     * "Add embossed text" (`emboss_apply`, `applyEmboss`): the recipe cut with
     * the loaded font as a new part of the selection's one object, or as a
     * re-cut of the selected text part, one undoable step; the status says
     * which characters the font lacks and any edges that did not close.
     */
    fun applyEmboss() {
        val configuration = recipe
        host.work {
            val (name, current) = font ?: return@work embossSay(host.words(R.string.emboss_choose_font))
            val status = try {
                when (val applied = host.workspace().applyEmboss(current, configuration).get()) {
                    EmbossApplied.NoTarget -> host.words(R.string.emboss_select_part)
                    is EmbossApplied.Failed -> ProjectEmbossing.failed(applied.message)
                    is EmbossApplied.Cut -> ProjectEmbossing.embossed(name, applied.preview)
                }
            } catch (failure: Throwable) {
                ProjectEmbossing.failed(cause(failure).message)
            }
            embossSay(status)
            refreshTarget()
        }
    }

    // ---- SVG Part ----

    /** "Load an SVG drawing" from the palette: the tool opens and its picker with it. */
    fun requestDrawing() {
        if (!svgCutting) svg(true)
        drawingPickPending = true
    }

    fun drawingPickShown() {
        drawingPickPending = false
    }

    /**
     * A drawing the operator picked (`svg_load_drawing`, `loadSvgDrawing`):
     * read as the browser reads a picked file; its size and what it holds
     * that cannot be cut are shown. One that cannot be read leaves no drawing.
     */
    fun loadDrawing(uri: Uri) = host.work {
        val (name, bytes) = host.read(uri, ProjectSvgPart.MAX_DRAWING_BYTES)
        val reply = bytes?.let(ProjectSvgPart::readDrawing)
        if (bytes != null && reply is ProjectIntents.SvgDrawingReply.Read) {
            loaded = name to bytes
            main.post {
                drawingName = name
                drawing = reply.value
            }
            svgSay(ProjectSvgParts.loaded(name, reply.value))
        } else {
            loaded = null
            main.post {
                drawingName = null
                drawing = null
            }
            val refusal = (reply as? ProjectIntents.SvgDrawingReply.Refused)?.value?.message
            svgSay(ProjectSvgParts.unreadable(refusal?.let { String(CharArray(it.size) { index -> it[index].toChar() }) } ?: ProjectSvgParts.TOO_LARGE))
        }
    }

    fun setSvgDepth(value: Double) {
        svgDepthMm = value
        fieldEdits++
    }

    /** The width field: 0 (or less) keeps the drawing's own size (`setSvgPartSize`). */
    fun setSvgWidth(value: Double) {
        svgWidthMm = ProjectSvgParts.width(value)
        fieldEdits++
    }

    /**
     * "Add SVG part" (`svg_apply`, `applySvgPart`): the drawing cut at the
     * panel's depth and width as a new part of the selection's one object,
     * named after its file, or as a re-cut of the selected SVG part, one
     * undoable step; the status gives its size, the first thing not cut and
     * any edges that did not close.
     */
    fun applySvg() {
        val depth = svgDepthMm
        val width = svgWidthMm
        host.work {
            val (name, bytes) = loaded ?: return@work svgSay(host.words(R.string.svg_choose_drawing))
            val status = try {
                when (val applied = host.workspace().applySvgPart(bytes, ProjectSvgParts.request(name, depth, width)).get()) {
                    SvgPartApplied.NoTarget -> host.words(R.string.svg_select_part)
                    is SvgPartApplied.Failed -> ProjectSvgParts.failed(applied.message)
                    is SvgPartApplied.Cut -> ProjectSvgParts.cut(name, applied.preview)
                }
            } catch (failure: Throwable) {
                ProjectSvgParts.failed(cause(failure).message)
            }
            svgSay(status)
            refreshTarget()
        }
    }

    /** Releases the font; the project's worker must be done with it. */
    override fun close() {
        font?.second?.close()
        font = null
    }
}
