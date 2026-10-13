package dev.orcaxr.core

/** What a File menu STL export wrote, or the browser's refusal (which wrote nothing). */
sealed interface StlExport {
    /** The file: offered as [filename] with [mediaType], holding [triangleCount] triangles of [instanceCount] instances. */
    data class Written(
        val filename: String,
        val mediaType: String,
        val triangleCount: Long,
        val instanceCount: Long,
        /** The instances it holds, as chosen (selected on the active plate, else the plate's). */
        val instanceIds: List<String>,
    ) : StlExport

    /** The export's own words (`STL export requires at least one instance`, `No models to export`, …). */
    data class Refused(val message: String) : StlExport
}

/** The kinds of output [ModelExports.filename] names. */
enum class ExportNameKind(internal val wire: String) {
    /** A plate's G-code when every plate is downloaded. */
    PLATE_GCODE("plate-gcode"),
    /** A plate's toolpaths as Wavefront OBJ. */
    TOOLPATH_OBJ("toolpath-obj"),
    /** A merged STL, after its instance's, object's or project's name. */
    STL("stl"),
    /** A saved or exported project. */
    PROJECT("project"),
}

/**
 * The browser's File menu exports in the shared core (`orcaxr_archive::exports`,
 * from `stlExport.ts` and `outputNames.ts`): Export as one STL… and Export all
 * objects as STLs… — the same bytes the browser downloads — and the names
 * every output is offered under.
 */
object ModelExports {
    /** The single Download / Export G-code… file (`GCODE_DOWNLOAD_FILENAME`). */
    const val GCODE_FILENAME = "orcaxr.gcode"

    /** File → Export Config…'s file (`CONFIG_EXPORT_FILENAME`). */
    const val CONFIG_FILENAME = "orcaxr_config.json"

    /** The media types the browser downloads them as. */
    const val GCODE_MEDIA_TYPE = "text/plain"
    const val STL_MEDIA_TYPE = "model/stl"
    const val ZIP_MEDIA_TYPE = "application/zip"
    const val OBJ_MEDIA_TYPE = "model/obj"
    const val CONFIG_MEDIA_TYPE = "application/json"

    /** An STL export request: Export all objects as STLs… when [archive], else Export as one STL…, for the [selected] instance IDs. */
    fun stlRequest(archive: Boolean, selected: List<String>): String =
        "{\"archive\":$archive,\"selectedInstanceIds\":[${selected.joinToString(",") { CanonicalJson.quote(it) }}]}"

    /** An STL export's reply. */
    internal fun stl(json: String): StlExport {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        if (obj.keys().asSequence().any { it == "error" }) return StlExport.Refused(obj.get("error") as String)
        val ids = obj.get("instanceIds") as ProjectJsonArray
        return StlExport.Written(
            obj.get("filename") as String,
            obj.get("mediaType") as String,
            (obj.get("triangleCount") as Number).toLong(),
            (obj.get("instanceCount") as Number).toLong(),
            List(ids.length()) { ids.get(it) as String },
        )
    }

    /** The name an output of [kind] is offered under, after [name] (a plate the project no longer has: null). */
    fun filename(kind: ExportNameKind, name: String?): String {
        require(name != null || kind == ExportNameKind.PLATE_GCODE || kind == ExportNameKind.TOOLPATH_OBJ) { "invalid_request" }
        val request = "{\"kind\":\"${kind.wire}\",\"name\":${name?.let(CanonicalJson::quote) ?: "null"}}"
        return (CanonicalJson.read(NativeProject.exportName(request)) as ProjectJsonObject).get("filename") as String
    }

    /** The words the browser's status line shows once Export as one STL… is done, its count grouped by [group] (`toLocaleString`). */
    fun exportedStatus(written: StlExport.Written, group: (Long) -> String): String {
        val instances = written.instanceCount
        val triangles = written.triangleCount
        return "Exported $instances model${if (instances == 1L) "" else "s"} as ${group(triangles)} STL triangle${if (triangles == 1L) "" else "s"}."
    }

    /** The browser's status line when Export as one STL… was refused. */
    fun failedStatus(message: String): String = "STL export failed: $message"
}
