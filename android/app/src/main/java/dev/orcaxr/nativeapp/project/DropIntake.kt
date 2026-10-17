package dev.orcaxr.nativeapp.project

import dev.orcaxr.nativeapp.shell.ShellArea

/**
 * Files dropped on the window, as the browser's drop (web/src/main.ts
 * `intakeFiles`, `OrcaWorkspace.openFile`) takes them, one after another:
 * a model (STL, OBJ, AMF, ZIP) is imported through the Project area's
 * preview, a 3MF asks the operator whether to open as project or import
 * geometry only when objects exist (or opens directly when empty) — guarded
 * like any Open — and G-code opens in Preview. Anything else is refused in the browser's words.
 *
 * The browser reads the bytes before it decides (the content wins over an
 * extension it does not know); a drop here is decided by the file's name —
 * or, for an extension the browser does not know, by the type its provider
 * reports — before anything is read. The import and Open still check the
 * content, as from the pickers.
 */
object DropIntake {
    /** Where a dropped file goes. */
    enum class Kind { Model, Project, Gcode }

    /** A dropped file as the drag carries it: its URI, display name and reported type, and whether the system shares it ([shared]: a `content:` URI). */
    class Dropped(val uri: String, val name: String, val mimeType: String?, val shared: Boolean)

    /** A dropped file to load. */
    class Item(val uri: String, val name: String, val kind: Kind)

    /**
     * What one drop loads: the models and projects, in order, for the
     * Project area; the G-code Preview shows (the last one, as the browser's
     * viewer is left with the last it opened); and the refusals.
     */
    class Plan(val project: List<Item>, val gcode: Item?, val refusals: List<String>) {
        /** The area the drop turns to: the Project area holds the import preview and the unsaved-changes question. */
        val area: ShellArea? = when {
            project.isNotEmpty() -> ShellArea.Project
            gcode != null -> ShellArea.Preview
            else -> null
        }
    }

    /** A handed-over file the system does not share (`ProjectModel.openIncoming`'s words). */
    const val NOT_SHARED = "OrcaXR opens only documents shared through the system."

    /** The browser's `fileExtension`: the last name segment's extension, lower case, or none. */
    fun extension(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return ""
        return base.substring(dot + 1).lowercase()
    }

    /** Where a file named [name], of the provider's [mimeType], goes; none when it cannot be loaded. */
    fun kind(name: String, mimeType: String?): Kind? = when (extension(name)) {
        // The pinned Snapmaker v2.3.4 file dialogs' model extensions (detect.ts `EXTENSION_FORMATS`).
        "stl", "obj", "amf", "amfz", "zip" -> Kind.Model
        "3mf" -> Kind.Project
        "gcode", "gco", "g" -> Kind.Gcode
        in REFUSED -> null
        else -> type(mimeType)?.let(MIME_KINDS::get)
    }

    /** The browser's status line for a file it could not load (`Failed to load …`, with `unsupportedMessage`'s reason). */
    fun refusal(name: String, mimeType: String? = null): String {
        val format = extension(name).takeIf { it in REFUSED } ?: type(mimeType)?.let(MIME_REFUSED::get).orEmpty()
        return "Failed to load $name: " + when (format) {
            "step", "stp" -> "$name is a STEP file, which this build cannot convert to a mesh"
            "svg" -> "$name is an SVG; import it through the SVG/emboss workflow"
            else -> "$name is not a recognised model format"
        }
    }

    /** What a drop of [files] loads and refuses, in the order dropped. */
    fun plan(files: List<Dropped>): Plan {
        val project = mutableListOf<Item>()
        var gcode: Item? = null
        val refusals = mutableListOf<String>()
        for (file in files) {
            if (!file.shared) {
                if (NOT_SHARED !in refusals) refusals += NOT_SHARED
                continue
            }
            when (val kind = kind(file.name, file.mimeType)) {
                null -> refusals += refusal(file.name, file.mimeType)
                Kind.Gcode -> gcode = Item(file.uri, file.name, kind)
                Kind.Model, Kind.Project -> project += Item(file.uri, file.name, kind)
            }
        }
        return Plan(project, gcode, refusals)
    }

    /** A reported type without its parameters, in lower case. */
    private fun type(mimeType: String?) = mimeType?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

    /** Files the browser recognises but cannot load (detect.ts `UNSUPPORTED_REASONS`), by extension. */
    private val REFUSED = setOf("step", "stp", "svg")

    /** Their types, for an extension the browser does not know. */
    private val MIME_REFUSED = mapOf("model/step" to "step", "application/step" to "step", "image/svg+xml" to "svg")

    /** Types providers report, for an extension the browser does not know. */
    private val MIME_KINDS = mapOf(
        "model/3mf" to Kind.Project,
        "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" to Kind.Project,
        "application/3mf" to Kind.Project,
        "application/x-3mf" to Kind.Project,
        "model/stl" to Kind.Model,
        "model/x.stl-binary" to Kind.Model,
        "model/x.stl-ascii" to Kind.Model,
        "application/sla" to Kind.Model,
        "application/vnd.ms-pki.stl" to Kind.Model,
        "application/x-stl" to Kind.Model,
        "model/obj" to Kind.Model,
        "model/wavefront-obj" to Kind.Model,
        "model/amf" to Kind.Model,
        "application/x-amf" to Kind.Model,
        "application/zip" to Kind.Model,
        "text/x-gcode" to Kind.Gcode,
        "text/gcode" to Kind.Gcode,
        "application/x-gcode" to Kind.Gcode,
    )
}
