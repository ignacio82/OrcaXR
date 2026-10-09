package dev.orcaxr.core

/** What is already on the printer and what may be done with it
 * (`orcaxr_printer::storage`), as the browser's `PrinterStorage` answers it:
 * the request or download an operation sends, or why it is refused before
 * anything leaves; the result an exchange that ended without a reply reads
 * as; a listing or metadata reply read; and a size put to an operator. The
 * host carries each exchange out. A listing carries each entry's name and a
 * metadata reply each thumbnail's reported relative path, so a result is
 * linear in its reply; [entryPath] and [thumbnailPath] join them. */
object PrinterStorage {
    fun plan(operation: ProjectIntents.PrinterStorageOperation): ProjectIntents.PrinterStoragePlan =
        ProjectIntents.decodePrinterStoragePlan(NativeProject.printerStoragePlan(ProjectIntents.encodePrinterStorageOperation(operation)))
    fun finish(request: ProjectIntents.PrinterStorageFinish): ProjectIntents.PrinterStorageResult =
        ProjectIntents.decodePrinterStorageResult(NativeProject.printerStorageFinish(ProjectIntents.encodePrinterStorageFinish(request)))
    /** [reply] is Moonraker's `result`, as JSON. */
    fun read(operation: ProjectIntents.PrinterStorageOperation, reply: String): ProjectIntents.PrinterStorageResult =
        ProjectIntents.decodePrinterStorageResult(NativeProject.printerStorageRead(ProjectIntents.encodePrinterStorageOperation(operation), reply))
    fun size(bytes: Double): ProjectIntents.OptionalText = ProjectIntents.decodeOptionalText(NativeProject.printerStorageSize(bytes))

    /** A listed entry's path (UTF-16 units): its listing's joined with its name. */
    fun entryPath(listing: ProjectIntents.PrinterStorageListing, entry: ProjectIntents.PrinterStorageEntry): List<Int> =
        join(listing.path, entry.name)
    /** A thumbnail's path (UTF-16 units): its file's folder joined with the
     * path the printer reported relative to it. */
    fun thumbnailPath(metadata: ProjectIntents.PrinterStorageMetadata, thumbnail: ProjectIntents.PrinterStorageThumbnail): List<Int> {
        val slash = metadata.path.lastIndexOf('/'.code)
        return join(if (slash == -1) emptyList() else metadata.path.subList(0, slash), thumbnail.relativePath)
    }
    private fun join(directory: List<Int>, name: List<Int>): List<Int> =
        if (directory.isEmpty()) name else directory + '/'.code + name
}
