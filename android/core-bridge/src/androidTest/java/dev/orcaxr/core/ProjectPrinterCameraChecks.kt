package dev.orcaxr.core

/** Printer cameras through the Kotlin wrapper: every request of the
 * browser's corpus round-trips and answers the browser's reply. */
object ProjectPrinterCameraChecks {
    /** [script] lines: `<section>\t<request>\t<reply>`, a listing read's
     * request being `<request>\t<Moonraker result>` and a poll interval's
     * reply its number; one `listPlan\t\t<reply>` line. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "camera_${columns[0]}_$checks"
            when (columns[0]) {
                "listPlan" -> check(PrinterCamera.listPlan() == ProjectIntents.decodePrinterSend(columns[2])) { label }
                "listReads" -> {
                    val result = PrinterCamera.listRead(ProjectIntents.decodeCameraListRequest(columns[1]), columns[2])
                    check(result == ProjectIntents.decodeCameraListResult(columns[3])) { label }
                    check(ProjectIntents.decodeCameraListResult(ProjectIntents.encodeCameraListResult(result)) == result) { label }
                }
                "listFinishes" -> check(PrinterCamera.listFinish(ProjectIntents.decodeCameraListFinish(columns[1])) == ProjectIntents.decodeCameraListResult(columns[2])) { label }
                "snapshotPlans" -> {
                    val request = ProjectIntents.decodeCameraSnapshotRequest(columns[1])
                    check(ProjectIntents.decodeCameraSnapshotRequest(ProjectIntents.encodeCameraSnapshotRequest(request)) == request) { label }
                    check(PrinterCamera.snapshotPlan(request) == ProjectIntents.decodeCameraSnapshotPlan(columns[2])) { label }
                }
                "snapshotFailures" -> check(PrinterCamera.snapshotFailure(ProjectIntents.decodeCameraSnapshotFinish(columns[1])) == ProjectIntents.decodeCameraFailure(columns[2])) { label }
                "mechanisms" -> check(PrinterCamera.mechanisms(ProjectIntents.decodeCameraMechanismsRequest(columns[1])) == ProjectIntents.decodeCameraMechanisms(columns[2])) { label }
                "describes" -> check(PrinterCamera.describe(ProjectIntents.decodeCameraDescribeRequest(columns[1])) == ProjectIntents.decodePrinterText(columns[2])) { label }
                "pollIntervals" -> check(PrinterCamera.pollIntervalMs(ProjectIntents.decodePrinterCamera(columns[1])) == columns[2].toDouble()) { label }
                "frameUrls" -> check(PrinterCamera.frameUrl(ProjectIntents.decodeCameraFrameRequest(columns[1])) == ProjectIntents.decodeOptionalPrinterReplyText(columns[2])) { label }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        return checks
    }
}
