package dev.orcaxr.core

/** Printer storage through the Kotlin wrapper: every operation of the
 * browser's corpus round-trips and answers the browser's reply. */
object ProjectPrinterStorageChecks {
    /** [script] lines: `<section>\t<request>\t<reply>`, a read's request being
     * `<operation>\t<Moonraker result>` and its reply followed by the paths the
     * browser joined (units `,` per path `;`, `-` when unrecorded), and a
     * size's request its number. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "storage_${columns[0]}_$checks"
            when (columns[0]) {
                "plans" -> {
                    val operation = ProjectIntents.decodePrinterStorageOperation(columns[1])
                    check(ProjectIntents.decodePrinterStorageOperation(ProjectIntents.encodePrinterStorageOperation(operation)) == operation) { label }
                    check(PrinterStorage.plan(operation) == ProjectIntents.decodePrinterStoragePlan(columns[2])) { label }
                }
                "finishes" -> check(PrinterStorage.finish(ProjectIntents.decodePrinterStorageFinish(columns[1])) == ProjectIntents.decodePrinterStorageResult(columns[2])) { label }
                "reads" -> {
                    val result = PrinterStorage.read(ProjectIntents.decodePrinterStorageOperation(columns[1]), columns[2])
                    check(result == ProjectIntents.decodePrinterStorageResult(columns[3])) { label }
                    // The bulk tier carries it back out, too.
                    check(ProjectIntents.decodePrinterStorageResult(ProjectIntents.encodePrinterStorageResult(result)) == result) { label }
                    if (columns[4] != "-") check(paths(result) == columns[4]) { label }
                }
                "sizes" -> check(PrinterStorage.size(columns[1].toDouble()) == ProjectIntents.decodeOptionalText(columns[2])) { label }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        return checks
    }

    private fun paths(result: ProjectIntents.PrinterStorageResult): String {
        val paths = when (result) {
            is ProjectIntents.PrinterStorageResult.Listing ->
                (result.value.directories + result.value.files).map { PrinterStorage.entryPath(result.value, it) }
            is ProjectIntents.PrinterStorageResult.Metadata ->
                result.value.thumbnails.map { PrinterStorage.thumbnailPath(result.value, it) }
            else -> emptyList()
        }
        return paths.joinToString(";") { it.joinToString(",") }
    }
}
