package dev.orcaxr.core

import java.util.concurrent.TimeUnit

/** The printer's storage, history, console and cameras through
 * [PrinterExchanges] against the Moonraker simulator: each operation planned,
 * carried out and read by the shared policy — files listed, read, downloaded
 * byte for byte, moved and deleted, a traversal refused before anything is
 * sent; history pages and totals; a script sent and an empty one refused,
 * macros read with their parameters; cameras listed and a frame fetched
 * through Moonraker with the key and directly from the camera's own URL. */
object ProjectPrinterExchangesChecks {
    private const val WAIT_S = 15L
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun absentFinite() = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
    private fun absentText() = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
    private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)

    @JvmStatic fun run(endpoint: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val config = ProjectIntents.MoonrakerTransportConfig(
            units(endpoint), absentFinite(), absentText(), absentText(),
            ProjectIntents.MoonrakerVersionPolicyInput(ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite()),
            ProjectIntents.OptionalText.Value(units("OrcaXR Android")), absentText(),
            absentFinite(), absentFinite(), absentFinite(), absentFinite(),
            ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite(), absentFinite(), absentFinite(), absentFinite()),
        )
        MoonrakerClient(config).use { client ->
            check(client.setCredentials(apiKey = "exchange-key") == null, "credentials")
            client.connect().result.get(WAIT_S, TimeUnit.SECONDS)
            val exchanges = PrinterExchanges(client, endpoint)

            // Storage: a file uploaded the way a send uploads it.
            val content = "G28\nG1 X10 ; exchange\n".toByteArray()
            client.upload(
                "/server/files/upload",
                // The simulator files an upload under its multipart name, folder included.
                MoonrakerUpload(listOf("root" to "gcodes"), "jobs/part.gcode", content),
                MoonrakerRequestOptions(operation = "upload_gcode"),
            ).result.get(WAIT_S, TimeUnit.SECONDS)
            val folder = ProjectIntents.PrinterStorageOperation.List(ProjectIntents.PrinterText(units("jobs")))
            val listing = exchanges.storage(folder).get(WAIT_S, TimeUnit.SECONDS).result
            val files = (listing as? ProjectIntents.PrinterStorageResult.Listing)?.value?.files.orEmpty()
            check(files.any { text(it.name) == "part.gcode" }, "listed $listing")
            val path = ProjectIntents.PrinterText(units("jobs/part.gcode"))
            val metadata = exchanges.storage(ProjectIntents.PrinterStorageOperation.Metadata(path)).get(WAIT_S, TimeUnit.SECONDS).result
            check(metadata is ProjectIntents.PrinterStorageResult.Metadata, "metadata $metadata")
            val download = exchanges.storage(ProjectIntents.PrinterStorageOperation.Download(path)).get(WAIT_S, TimeUnit.SECONDS)
            check(download.result is ProjectIntents.PrinterStorageResult.Done && download.bytes.contentEquals(content), "downloaded")
            val renamed = exchanges.storage(
                ProjectIntents.PrinterStorageOperation.Rename(ProjectIntents.PrinterStorageRename(units("jobs/part.gcode"), units("kept.gcode"))),
            ).get(WAIT_S, TimeUnit.SECONDS).result
            check((renamed as? ProjectIntents.PrinterStorageResult.Moved)?.let { text(it.value.text) } == "jobs/kept.gcode", "renamed $renamed")
            val kept = ProjectIntents.PrinterText(units("jobs/kept.gcode"))
            check(exchanges.storage(ProjectIntents.PrinterStorageOperation.Delete(kept)).get(WAIT_S, TimeUnit.SECONDS).result
                is ProjectIntents.PrinterStorageResult.Done, "deleted")
            val after = exchanges.storage(folder).get(WAIT_S, TimeUnit.SECONDS).result
            check((after as ProjectIntents.PrinterStorageResult.Listing).value.files.none { text(it.name) == "kept.gcode" }, "gone")
            val escape = exchanges.storage(
                ProjectIntents.PrinterStorageOperation.Delete(ProjectIntents.PrinterText(units("../config/printer.cfg"))),
            ).get(WAIT_S, TimeUnit.SECONDS).result
            check((escape as? ProjectIntents.PrinterStorageResult.Failed)?.value?.code == ProjectIntents.PrinterStorageErrorCode.InvalidTarget, "traversal_refused")
            val missing = exchanges.storage(
                ProjectIntents.PrinterStorageOperation.Metadata(ProjectIntents.PrinterText(units("absent.gcode"))),
            ).get(WAIT_S, TimeUnit.SECONDS).result
            check((missing as? ProjectIntents.PrinterStorageResult.Failed)?.value?.code == ProjectIntents.PrinterStorageErrorCode.MetadataUnavailable, "missing_metadata")

            // History: a page of the printer's own records, and its totals.
            val page = exchanges.history(
                ProjectIntents.PrintHistoryOperation.Page(ProjectIntents.PrintHistoryPageRequest(absentFinite(), ProjectIntents.OptionalFinite.Value(2.0))),
            ).get(WAIT_S, TimeUnit.SECONDS)
            val read = (page as? ProjectIntents.PrintHistoryResult.Page)?.value
            check(read != null && read.jobs.size == 2 && read.total == 3.0, "history_page $page")
            check(text(PrintHistory.jobView(read!!.jobs[0]).status) == "Completed", "history_view")
            val totals = exchanges.history(ProjectIntents.PrintHistoryOperation.Totals(ProjectIntents.Empty)).get(WAIT_S, TimeUnit.SECONDS)
            check(totals is ProjectIntents.PrintHistoryResult.Totals, "history_totals $totals")
            val refusedPage = exchanges.history(
                ProjectIntents.PrintHistoryOperation.Page(ProjectIntents.PrintHistoryPageRequest(absentFinite(), ProjectIntents.OptionalFinite.Value(500.0))),
            ).get(WAIT_S, TimeUnit.SECONDS)
            check((refusedPage as? ProjectIntents.PrintHistoryResult.Failed)?.value?.code == ProjectIntents.PrintHistoryErrorCode.InvalidPage, "history_refused")

            // Console: a script sent; an empty one refused; macros and their parameters.
            check(exchanges.console(ProjectIntents.ConsoleOperation.Send(ProjectIntents.PrinterText(units("M105"))))
                .get(WAIT_S, TimeUnit.SECONDS) is ProjectIntents.ConsoleResult.Sent, "script_sent")
            val empty = exchanges.console(ProjectIntents.ConsoleOperation.Send(ProjectIntents.PrinterText(units("   "))))
                .get(WAIT_S, TimeUnit.SECONDS)
            check((empty as? ProjectIntents.ConsoleResult.Failed)?.value?.code == ProjectIntents.ConsoleErrorCode.EmptyScript, "empty_refused")
            val macros = exchanges.console(ProjectIntents.ConsoleOperation.Macros(ProjectIntents.Empty)).get(WAIT_S, TimeUnit.SECONDS)
            val load = (macros as? ProjectIntents.ConsoleResult.Macros)?.value?.firstOrNull { text(it.name) == "LOAD_FILAMENT" }
            check(load != null && load.parameters.map { text(it.name) } == listOf("TEMP"), "macros $macros")

            // Cameras: listed against the endpoint; a frame through Moonraker
            // with the key, and one fetched from the camera's own URL.
            val cameras = (exchanges.cameras().get(WAIT_S, TimeUnit.SECONDS) as? ProjectIntents.CameraListResult.Cameras)?.value.orEmpty()
            check(cameras.map { text(it.name) } == listOf("Nozzle", "Bed"), "cameras $cameras")
            val nozzle = cameras[0]
            val transported = exchanges.snapshot(nozzle, ProjectIntents.CameraMechanism.Transport).get(WAIT_S, TimeUnit.SECONDS)
            check(transported.getOrNull()?.copyOfRange(0, 4).contentEquals(PNG), "frame_through_moonraker")
            val fetched = exchanges.snapshot(nozzle, ProjectIntents.CameraMechanism.Direct).get(WAIT_S, TimeUnit.SECONDS)
            check(fetched.getOrNull()?.copyOfRange(0, 4).contentEquals(PNG), "frame_direct")
            val bed = exchanges.snapshot(cameras[1]).get(WAIT_S, TimeUnit.SECONDS)
            check((bed.exceptionOrNull() as? CameraFrameException)?.failure?.code == ProjectIntents.CameraErrorCode.NoSnapshot, "stream_only_refused")
        }
        return checks
    }
}
