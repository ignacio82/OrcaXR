package dev.orcaxr.core

/** Filament slots and tool mapping (`orcaxr_printer::tools`), as the browser's
 * `MoonrakerFilamentSlots` and `PrintToolMapping` answer them. */
object PrinterTools {
    /** A Snapmaker filament query reply, as received. */
    fun filamentSlots(text: String): ProjectIntents.FilamentSlotsReply =
        ProjectIntents.decodeFilamentSlotsReply(NativeProject.filamentSlots(text))
    fun mapping(request: ProjectIntents.ToolMappingRequest): ProjectIntents.ToolMappingReport =
        ProjectIntents.decodeToolMappingReport(NativeProject.toolMapping(ProjectIntents.encodeToolMappingRequest(request)))
}

/** Which tools a sliced artifact selects and the filament it declares, read
 * from its bytes in order, decoded as the browser's TextDecoder decodes them.
 * [finish] answers once and releases the scanner. */
class ToolUsageScanner internal constructor(handle: Long) : ProjectHandle(handle) {
    constructor() : this(NativeProject.toolUsageNew())

    fun append(bytes: ByteArray) = read {
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
            NativeProject.toolUsageAppend(it, bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
    }
    fun finish(): ProjectIntents.GcodeToolUsage = move { ProjectIntents.decodeGcodeToolUsage(NativeProject.toolUsageFinish(it)) }
}
