package dev.orcaxr.core

/** Named printers and one default (`orcaxr_printer::directory`), as the
 * browser's `PrinterDirectory` answers it: the stored directory read (an
 * unreadable store is an empty one) and written in the browser's own stored
 * form, and each edit — add, update, remove, choose the default, adopt a
 * legacy endpoint — answered as the directory it makes or why it is refused.
 * A machine is the endpoint its address names, so one machine cannot be saved
 * twice under another spelling. The host stores the text, draws each new
 * printer's id and keeps credentials apart. */
object PrinterDirectory {
    /** [stored] is the saved text, or null when nothing is saved. */
    fun load(stored: String?): ProjectIntents.PrinterDirectory =
        ProjectIntents.decodePrinterDirectory(NativeProject.printerDirectoryLoad(stored))
    fun save(directory: ProjectIntents.PrinterDirectory): String =
        NativeProject.printerDirectorySave(ProjectIntents.encodePrinterDirectory(directory))
    fun add(request: ProjectIntents.PrinterDirectoryAdd): ProjectIntents.PrinterDirectoryReply =
        ProjectIntents.decodePrinterDirectoryReply(NativeProject.printerDirectoryAdd(ProjectIntents.encodePrinterDirectoryAdd(request)))
    fun update(request: ProjectIntents.PrinterDirectoryUpdate): ProjectIntents.PrinterDirectoryReply =
        ProjectIntents.decodePrinterDirectoryReply(NativeProject.printerDirectoryUpdate(ProjectIntents.encodePrinterDirectoryUpdate(request)))
    fun remove(request: ProjectIntents.PrinterDirectorySelect): ProjectIntents.PrinterDirectoryReply =
        ProjectIntents.decodePrinterDirectoryReply(NativeProject.printerDirectoryRemove(ProjectIntents.encodePrinterDirectorySelect(request)))
    fun setDefault(request: ProjectIntents.PrinterDirectorySelect): ProjectIntents.PrinterDirectoryReply =
        ProjectIntents.decodePrinterDirectoryReply(NativeProject.printerDirectorySetDefault(ProjectIntents.encodePrinterDirectorySelect(request)))
    fun adopt(request: ProjectIntents.PrinterDirectoryAdopt): ProjectIntents.PrinterDirectory =
        ProjectIntents.decodePrinterDirectory(NativeProject.printerDirectoryAdopt(ProjectIntents.encodePrinterDirectoryAdopt(request)))
}
