package dev.orcaxr.core

/** Tool usage, filament slots and tool mapping through the Kotlin wrappers:
 * every artifact answers the browser's usage, every slot reply and mapping
 * the browser's answer, and a finished scanner is released. */
object ProjectPrinterToolsChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] lines: `U\t<base64 bytes>\t<usage>`, `S\t<reply text>\t<slots>`
     * or `M\t<request>\t<report>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val e = line.split("\t")
            when (e[0]) {
                "U" -> {
                    val scanner = ToolUsageScanner()
                    scanner.append(java.util.Base64.getDecoder().decode(e[1]))
                    check(scanner.finish() == ProjectIntents.decodeGcodeToolUsage(e[2])) { "tools_usage_$checks" }
                    check(failure { scanner.append(byteArrayOf(1)) } == "closed") { "tools_finished_$checks" }
                }
                "S" -> check(PrinterTools.filamentSlots(e[1]) == ProjectIntents.decodeFilamentSlotsReply(e[2])) { "tools_slots_$checks" }
                "M" -> check(PrinterTools.mapping(ProjectIntents.decodeToolMappingRequest(e[1])) == ProjectIntents.decodeToolMappingReport(e[2])) { "tools_mapping_$checks" }
                else -> error("unknown script entry ${e[0]}")
            }
            checks++
        }
        return checks
    }
}
