package dev.orcaxr.core

/** The printer directory through the Kotlin wrapper: every request of the
 * browser's corpus round-trips and answers the browser's reply. */
object ProjectPrinterDirectoryChecks {
    /** [script] lines: `<section>\t<request>\t<reply>`; a load's request is
     * the stored text (`-` for nothing stored) and a save's reply the text. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "directory_${columns[0]}_$checks"
            val reply = { text: String -> ProjectIntents.decodePrinterDirectoryReply(text) }
            when (columns[0]) {
                "loads" -> check(PrinterDirectory.load(columns[1].takeIf { it != "-" }) == ProjectIntents.decodePrinterDirectory(columns[2])) { label }
                "saves" -> {
                    val directory = ProjectIntents.decodePrinterDirectory(columns[1])
                    check(PrinterDirectory.save(directory) == columns[2]) { label }
                    // What is saved loads back as itself.
                    check(PrinterDirectory.load(PrinterDirectory.save(directory)) == PrinterDirectory.load(columns[2])) { label }
                }
                "adds" -> check(PrinterDirectory.add(ProjectIntents.decodePrinterDirectoryAdd(columns[1])) == reply(columns[2])) { label }
                "updates" -> check(PrinterDirectory.update(ProjectIntents.decodePrinterDirectoryUpdate(columns[1])) == reply(columns[2])) { label }
                "removes" -> check(PrinterDirectory.remove(ProjectIntents.decodePrinterDirectorySelect(columns[1])) == reply(columns[2])) { label }
                "defaults" -> check(PrinterDirectory.setDefault(ProjectIntents.decodePrinterDirectorySelect(columns[1])) == reply(columns[2])) { label }
                "adopts" -> check(PrinterDirectory.adopt(ProjectIntents.decodePrinterDirectoryAdopt(columns[1])) == ProjectIntents.decodePrinterDirectory(columns[2])) { label }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        return checks
    }
}
