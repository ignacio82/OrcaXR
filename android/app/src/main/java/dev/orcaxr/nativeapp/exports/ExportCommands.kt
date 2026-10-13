package dev.orcaxr.nativeapp.exports

import dev.orcaxr.core.ModelExports
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.StlExport
import dev.orcaxr.nativeapp.R

/**
 * What a status line says: the browser's catalogued [message] (a string
 * resource, read in the operator's language), then [text] — the browser's
 * own uncatalogued words, or Android's (`Export 3MF failed` and its reason).
 */
data class ExportWords(val message: Int? = null, val text: String = "")

/**
 * The browser's File menu exports and its Download actions as the app
 * carries them out, kept free of Android so the rules are checked on the
 * JVM: which the app performs, when each is enabled — the core's registry
 * gate given the slicing area's facts ([ProjectActionState]s read with the
 * published slice's `gcodeReady`), and not while another export is being
 * written — what each writes, and the browser's words for what happened.
 */
object ExportCommands {
    const val DOWNLOAD = "save_gcode_to_downloads"
    const val EXPORT_GCODE = "file_export_gcode"
    const val DOWNLOAD_ALL = "save_all_plate_gcode"
    const val EXPORT_ALL_PLATES = "file_export_all_plates"
    const val EXPORT_STL = "file_export_stl"
    const val EXPORT_ALL_STLS = "file_export_all_stls"
    const val EXPORT_3MF = "file_export_3mf"

    /** The exports the app performs, in the catalogue's order. */
    val IDS = listOf(EXPORT_GCODE, EXPORT_ALL_PLATES, EXPORT_STL, EXPORT_ALL_STLS, EXPORT_3MF, DOWNLOAD, DOWNLOAD_ALL)

    /** The File menu's export section as the browser's menu lists it (Download All Plates is in its file section too). */
    val MENU = listOf(EXPORT_GCODE, EXPORT_ALL_PLATES, EXPORT_STL, EXPORT_ALL_STLS, EXPORT_3MF, DOWNLOAD_ALL)

    /** The G-code a download writes: the published slice (the single Download and Export G-code…). */
    fun isGcode(id: String): Boolean = id == DOWNLOAD || id == EXPORT_GCODE

    /** Whether [id] writes one file per sliced plate into a folder the operator picks. */
    fun isPlates(id: String): Boolean = id == DOWNLOAD_ALL || id == EXPORT_ALL_PLATES

    /**
     * The type a document named [filename] is created with. A provider keeps
     * a name's extension only when the type asked for is the one the device
     * associates with it ([lookup], `MimeTypeMap`), and otherwise appends the
     * type's own (`orcaxr.gcode` as `text/plain` becomes `orcaxr.gcode.txt`)
     * or numbers a copy after the extension (`orcaxr.gcode (1)`). So the type
     * is the device's for the extension, else `application/octet-stream`,
     * which keeps any name: the file keeps the browser's name, and a copy is
     * numbered as a browser numbers a download (`orcaxr (1).gcode`).
     */
    fun documentType(filename: String, lookup: (String) -> String?): String {
        val extension = filename.substringAfterLast('.', "").lowercase()
        return extension.takeIf { it.isNotEmpty() }?.let(lookup) ?: "application/octet-stream"
    }

    /** Android-only words: one export at a time, as the system's picker serves one document at a time. */
    const val BUSY = "Another export is being written; wait for it to finish."

    /**
     * [action] enabled as the app runs it: the core's registry gate from
     * [core] (read with the slicing area's facts), and not while [busy]
     * writing another export; unchanged when it is none of the exports.
     */
    fun state(action: ProjectActionState, core: Map<String, ProjectActionState>, busy: Boolean): ProjectActionState {
        if (action.id !in IDS) return action
        val gate = core[action.id] ?: return action.copy(enabled = false, reason = action.reason)
        return when {
            busy -> action.copy(enabled = false, reason = BUSY)
            else -> action.copy(enabled = gate.enabled, reason = if (gate.enabled) null else gate.reason)
        }
    }

    // --- The browser's words (OrcaWorkspace) ---

    /** `downloadAllPlateGcode` with no Slice All Plates results. */
    val SLICE_ALL_FIRST = ExportWords(R.string.export_slice_all_first)

    /** `downloadAllPlateGcode` when the project left the sliced state; a single download checks the same when it writes. */
    val STALE = ExportWords(R.string.export_stale)

    /** `exportAllPlates` with nothing to slice. */
    val NOTHING_TO_SLICE = ExportWords(R.string.export_nothing_to_slice)

    /** `downloadAllPlateGcode`'s status. */
    fun downloaded(count: Int) = ExportWords(text = "Downloaded $count plate G-code file(s).")

    /** What the status line says once [id]'s STL [answer] was written ([group] formats a count as `toLocaleString` does). */
    fun stlWritten(id: String, answer: StlExport.Written, group: (Long) -> String): ExportWords =
        if (id == EXPORT_ALL_STLS) ExportWords(R.string.export_all_stls_done) else ExportWords(text = ModelExports.exportedStatus(answer, group))

    /** `exportPlate3mf`'s status once written. */
    val EXPORTED_3MF = ExportWords(R.string.export_3mf_done)

    /** `exportPlate3mf`'s status when the project cannot be saved: `Export 3MF failed: ` and why, from the core's code. */
    fun failed3mf(code: String) = ExportWords(
        R.string.export_3mf_failed,
        ": " + when (code) {
            "resource_limit" -> "The project is too large for this device."
            "cancelled" -> "Cancelled."
            else -> "This project cannot be written as a 3MF (the browser's Save refuses it too)."
        },
    )

    /** What the status line says when [id]'s STL export was refused for [message]. */
    fun stlRefused(id: String, message: String): ExportWords =
        if (id == EXPORT_ALL_STLS) ExportWords(R.string.export_stl_failed) else ExportWords(text = ModelExports.failedStatus(message))

    // --- Android-only words: a document provider's failures, which a browser download has none of ---

    /** A G-code saved, under the name the provider gave it. */
    fun saved(name: String) = ExportWords(text = "Saved $name.")

    /** Why a write to [name] failed, from [ProjectDocumentException][dev.orcaxr.core.ProjectDocumentException]'s code. */
    fun failed(name: String, code: String?) = ExportWords(
        text = when (code) {
            "document_storage_full" -> "There is no room left for $name. Free some space or choose another place."
            "document_permission", "document_unavailable" -> "OrcaXR can no longer write to $name. Choose the place again."
            "document_not_writable" -> "$name cannot be written there. Choose another place."
            else -> "$name could not be written."
        },
    )

    /** The words to show for [words], with [resource] reading a catalogued message in the operator's language. */
    fun text(words: ExportWords, resource: (Int) -> String): String = (words.message?.let(resource) ?: "") + words.text
}
