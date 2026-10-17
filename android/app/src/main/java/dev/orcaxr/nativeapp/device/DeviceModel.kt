package dev.orcaxr.nativeapp.device

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.AndroidLocalNetwork
import dev.orcaxr.core.AndroidPrinterDiscovery
import dev.orcaxr.core.AppCredentialVault
import dev.orcaxr.core.DeviceRefusal
import dev.orcaxr.core.DeviceTextStore
import dev.orcaxr.core.DeviceWorkspace
import dev.orcaxr.core.DiscoveryProbe
import dev.orcaxr.core.DiscoveryProposal
import dev.orcaxr.core.CameraFrameException
import dev.orcaxr.core.PrintHistory
import dev.orcaxr.core.Diagnostics
import dev.orcaxr.core.PrintJobCommandException
import dev.orcaxr.core.PrinterCamera
import dev.orcaxr.core.PrinterConsole
import dev.orcaxr.core.PrintJobArtifacts
import dev.orcaxr.core.PrintSendProgress
import dev.orcaxr.core.PrinterExchanges
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.send.PrintSendService
import dev.orcaxr.nativeapp.send.SendDialogView
import dev.orcaxr.nativeapp.send.SendState
import dev.orcaxr.nativeapp.send.SendWords
import dev.orcaxr.nativeapp.send.SliceToSend
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/** The printer directory's stored text, in a private preferences file. */
class PreferencesTextStore(context: Context, file: String, private val key: String) : DeviceTextStore {
    private val preferences = context.getSharedPreferences(file, Context.MODE_PRIVATE)
    override fun read(): String? = preferences.getString(key, null)
    override fun write(text: String) {
        check(preferences.edit().putString(key, text).commit()) { "storage_failed" }
    }
}

/** One printer as the list shows it. */
data class PrinterRow(val id: String, val name: String, val address: String)

/** A command the operator must confirm, and how to answer. */
class PendingConfirmation(val intent: ProjectIntents.PrintJobCommandIntent, val answer: CompletableFuture<Boolean>)

/** Something the operator must confirm before it is done. */
class PendingAsk(val title: String, val detail: String, val confirm: String, val action: () -> Unit)

/** A send waiting for the operator: the browser's dialog for it, and how to answer. */
class PendingSend(val view: SendDialogView, val answer: CompletableFuture<ProjectIntents.PrintWorkflowDecision>)

/** The active printer's files: the folder shown, its listing, and the file chosen. */
data class FilesView(
    val path: String = "",
    val listing: ProjectIntents.PrinterStorageListing? = null,
    val selected: ProjectIntents.PrinterStorageMetadata? = null,
    val loading: Boolean = false,
)

/** A page of the printer's history, each job described as the browser's panel does. */
data class HistoryView(
    val jobs: List<Pair<ProjectIntents.PrintHistoryJob, ProjectIntents.PrintHistoryJobView>> = emptyList(),
    val pager: ProjectIntents.PrintHistoryPageView? = null,
    val totals: String = "",
    val loading: Boolean = false,
)

/** The console's transcript (bounded, redacted on the way in) and the printer's macros. */
data class ConsoleView(
    val lines: List<ProjectIntents.ConsoleLine> = emptyList(),
    val macros: List<ProjectIntents.PrinterMacro> = emptyList(),
)

/** The printer's cameras, the one shown and its latest frame. */
data class CameraView(
    val cameras: List<ProjectIntents.PrinterCamera> = emptyList(),
    val selected: Int = 0,
    val frame: ByteArray? = null,
    val failure: String? = null,
    val description: String = "",
)

/** A printer discovery found and verified, as the list shows it; [savedAs] names the saved printer at that machine. */
data class ProposalRow(val key: String, val name: String, val address: String, val needsKey: Boolean, val savedAs: String?)

/** Discovery: whether it is looking, whether it has looked, and what it proposes. */
data class DiscoveryView(val searching: Boolean = false, val searched: Boolean = false, val proposals: List<ProposalRow> = emptyList())

/** What the Device screen shows: a projection of the workspace, never a second copy of it. */
data class DeviceState(
    val printers: List<PrinterRow> = emptyList(),
    val activeId: String? = null,
    val apiKey: String = "",
    val remember: Boolean = true,
    val localNetworkBlocked: Boolean = false,
    val localNetworkGranted: Boolean = true,
    val discovery: DiscoveryView = DiscoveryView(),
    val connected: Boolean = false,
    val connecting: Boolean = false,
    /** The connection in a few words, with the transport's own code when it failed. */
    val connection: String = "",
    val summary: ProjectIntents.PrinterStatusSummary? = null,
    val commands: List<ProjectIntents.PrintJobCommandDescriptor> = emptyList(),
)

private const val TRANSCRIPT_LINES = 200
private const val HISTORY_PAGE = 20.0

/**
 * The Device area's host adapter: it owns the [DeviceWorkspace], runs every
 * call that may block (storage, the Keystore, name resolution, the session)
 * on one worker thread, and publishes a [DeviceState] projection to Compose on
 * the main thread. Sends to the active printer run here too, through the
 * workspace's shared workflow: Prepare offers its finished slice, the
 * operator confirms in the browser's dialog ([sendConfirmation]), and [send]
 * reports progress and the outcome in the browser's words.
 */
class DeviceModel(application: Application) : AndroidViewModel(application) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "device-model") }
    private lateinit var workspace: DeviceWorkspace
    private lateinit var finder: AndroidPrinterDiscovery
    private var subscription: AutoCloseable? = null
    private fun string(resId: Int): String = getApplication<Application>().getString(resId)
    private fun string(resId: Int, vararg args: Any): String = getApplication<Application>().getString(resId, *args)
    private val app: Application get() = getApplication()
    private var prepareTicker: Runnable? = null
    private fun stopPrepareTicker() {
        prepareTicker?.let { main.removeCallbacks(it) }
        prepareTicker = null
    }

    var state by mutableStateOf(DeviceState())
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var confirmation by mutableStateOf<PendingConfirmation?>(null)
        private set
    var ask by mutableStateOf<PendingAsk?>(null)
        private set
    var files by mutableStateOf(FilesView())
        private set
    var history by mutableStateOf(HistoryView())
        private set
    var console by mutableStateOf(ConsoleView())
        private set
    var cameras by mutableStateOf(CameraView())
        private set
    /** The send in progress or the last one's outcome, in the browser's status words. */
    var sendState by mutableStateOf(SendState())
        private set
    /** The confirmation a send waits for, shown above every area. */
    var sendConfirmation by mutableStateOf<PendingSend?>(null)
        private set
    var requestedTab by mutableStateOf<DeviceTab?>(null)

    // Worker-thread state: the client the transcript listens to, and the camera's routes.
    private var listened: dev.orcaxr.core.MoonrakerClient? = null
    private var listening: AutoCloseable? = null
    private val transcript = ArrayDeque<ProjectIntents.ConsoleLine>()
    private var routes: List<ProjectIntents.CameraMechanism> = emptyList()
    private var route = 0
    @Volatile private var fetching = false
    private var searched = false

    init {
        work {
            workspace = DeviceWorkspace(
                PreferencesTextStore(application, "orcaxr.printers", "directory"),
                // One record with Prepare's slicer token: neither area overwrites the other's change.
                AppCredentialVault.shared(application),
                AndroidLocalNetwork.permission(application),
                // The transport's diagnostics (redacted by the core) reach logcat in debuggable builds only.
                logger = if (application.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
                    { log -> android.util.Log.d("OrcaXRPrinter", log.toString()) }
                } else {
                    null
                },
                confirmSend = ::confirmSend,
            )
            finder = AndroidPrinterDiscovery(application, workspace.discovery) { work { publish() } }
            subscription = workspace.subscribe { work { publish() } }
            publish()
        }
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun work(task: () -> Unit) {
        worker.execute {
            try {
                task()
            } catch (refused: DeviceRefusal) {
                main.post { message = refused.message }
            } catch (refused: PrintJobCommandException) {
                main.post { message = refused.message }
            } catch (failure: ExecutionException) {
                main.post { message = failure.cause?.message ?: failure.message }
            } catch (failure: Exception) {
                main.post { message = failure.message }
            }
        }
    }

    private fun units(text: String) = text.map { it.code }
    private val absent = ProjectIntents.Empty

    /** The secrets the transcript strikes out: the active printer's key. */
    private fun secrets(): List<List<Int>> =
        workspace.active?.let { workspace.apiKey(text(it.id)) }?.takeIf { it.isNotEmpty() }?.let { listOf(units(it)) } ?: emptyList()

    private fun appendLine(line: ProjectIntents.ConsoleLine) {
        transcript.addLast(line)
        while (transcript.size > TRANSCRIPT_LINES) transcript.removeFirst()
        val lines = transcript.toList()
        main.post { console = console.copy(lines = lines) }
    }

    /** Listens to the current connection's console responses; a new connection replaces the old. */
    private fun listen() {
        val client = workspace.session.client
        if (client === listened) return
        listening?.close()
        listened = client
        listening = client?.subscribeNotifications { notification ->
            work {
                PrinterConsole.notification(
                    ProjectIntents.ConsoleNotificationRequest(units(notification.method), secrets()),
                    notification.params,
                ).let { it as? ProjectIntents.OptionalConsoleLine.Value }?.let { appendLine(it.value) }
            }
        }
    }

    private fun exchanges(): PrinterExchanges =
        workspace.exchanges() ?: throw IllegalStateException("Connect to the printer first.")

    private fun failure(result: Any?): String? = when (result) {
        is ProjectIntents.PrinterStorageResult.Failed -> text(result.value.message)
        is ProjectIntents.PrintHistoryResult.Failed -> text(result.value.message)
        is ProjectIntents.ConsoleResult.Failed -> text(result.value.message)
        is ProjectIntents.CameraListResult.Failed -> text(result.value.message)
        else -> null
    }

    private fun key(proposal: DiscoveryProposal) = "${proposal.candidate.host}:${proposal.candidate.port}"

    /** Recomputes the projection on the worker and publishes it. */
    private fun publish() {
        listen()
        val found = workspace.discovery
        val discovery = DiscoveryView(
            searching = finder.browsing || found.probing > 0,
            searched = searched,
            proposals = found.proposals.map { proposal ->
                ProposalRow(
                    key(proposal), proposal.name, "${proposal.candidate.host} · port ${proposal.candidate.port}",
                    proposal.probe == DiscoveryProbe.NeedsKey, workspace.savedAs(proposal.candidate)?.let { text(it.name) },
                )
            },
        )
        val directory = workspace.directory
        val active = workspace.active
        val activeId = active?.let { text(it.id) }
        val connection = workspace.session.state
        val next = DeviceState(
            printers = directory.printers.map { entry ->
                val port = entry.port.toLong()
                PrinterRow(text(entry.id), text(entry.name), "${text(entry.host)} · port $port")
            },
            activeId = activeId,
            apiKey = activeId?.let(workspace::apiKey) ?: "",
            remember = workspace.credentials.remember,
            localNetworkBlocked = workspace.localNetworkBlocked(),
            localNetworkGranted = workspace.localNetworkGranted(),
            discovery = discovery,
            connected = connection is ProjectIntents.MoonrakerConnectionState.Connected,
            connecting = connection is ProjectIntents.MoonrakerConnectionState.Connecting ||
                connection is ProjectIntents.MoonrakerConnectionState.Reconnecting,
            connection = when (connection) {
                null -> "Not connected"
                is ProjectIntents.MoonrakerConnectionState.Disconnected -> "Disconnected"
                is ProjectIntents.MoonrakerConnectionState.Connecting -> "Connecting…"
                is ProjectIntents.MoonrakerConnectionState.Connected -> "Connected"
                is ProjectIntents.MoonrakerConnectionState.Reconnecting ->
                    "Reconnecting (attempt ${connection.value.attempt}) after ${connection.value.lastError.code.name}"
                is ProjectIntents.MoonrakerConnectionState.Error -> "Connection failed: ${connection.value.error.code.name}"
            },
            summary = if (active != null) workspace.summary() else null,
            commands = workspace.session.view.availability,
        )
        main.post { state = next }
    }

    /** Re-reads what may have changed outside the app, such as a permission granted in settings. */
    fun refresh() = work { publish() }

    fun dismissMessage() {
        message = null
    }

    fun addPrinter(name: String, address: String, port: Int?) = work {
        workspace.addPrinter(name, address, port)
        main.post { message = "Saved ${name.trim()}." }
    }

    /** Looks for printers that announce themselves on this network; nothing is saved until one is added. */
    fun findPrinters() = work {
        searched = true
        finder.start()
    }

    /** Saves a printer discovery proposed, under the name it gives itself, and makes it the active one. */
    fun addDiscovered(key: String) = work {
        val proposal = workspace.discovery.proposals.firstOrNull { key(it) == key } ?: return@work
        workspace.addDiscovered(proposal)
        val needsKey = proposal.probe == DiscoveryProbe.NeedsKey
        main.post { message = if (needsKey) string(R.string.device_model_saved_needs_key, proposal.name) else string(R.string.device_model_saved, proposal.name) }
    }

    /** Shows a notice the screen itself decided on. */
    fun notify(text: String) {
        message = text
    }

    fun activate(id: String) = work { workspace.activate(id) }

    fun removeActive() = work {
        val id = workspace.active?.let { text(it.id) } ?: return@work
        workspace.removePrinter(id)
    }

    fun setApiKey(key: String) = work {
        val id = workspace.active?.let { text(it.id) } ?: return@work
        workspace.setApiKey(id, key)
    }

    fun setRemember(remember: Boolean) = work {
        workspace.setRemember(remember)
        main.post {
            message = if (remember) {
                string(R.string.device_model_remember_keys)
            } else {
                string(R.string.device_model_forget_keys)
            }
        }
    }

    fun forgetCredentials() = work {
        workspace.forgetCredentials()
        // The browser's words: the slicer token is in the same record.
        main.post { message = string(R.string.device_model_forgot_keys) }
    }

    /** Reports how [future] failed, without holding the worker while it runs. */
    private fun report(future: CompletableFuture<*>) {
        future.whenComplete { _, failure ->
            val cause = (failure as? java.util.concurrent.CompletionException)?.cause ?: failure
            if (cause != null) main.post { message = cause.message }
        }
    }

    fun connect() = work {
        main.post { message = null }
        report(workspace.connect())
    }

    fun disconnect() = work { workspace.disconnect() }

    /** Sends a job command; one that needs confirming asks the operator first. */
    fun command(command: ProjectIntents.PrintJobCommand) = work {
        val intent = workspace.session.captureIntent(command)
        report(
            workspace.session.execute(intent, dialog = { asked, ended ->
                val answer = CompletableFuture<Boolean>()
                // A session that ends while the dialog is open answers no.
                ended.whenComplete { _, _ -> answer.complete(false) }
                main.post { confirmation = PendingConfirmation(asked, answer) }
                answer.whenComplete { _, _ -> main.post { confirmation = null } }
            }),
        )
    }

    fun answer(confirmed: Boolean) {
        confirmation?.answer?.complete(confirmed)
    }

    fun answerAsk(confirmed: Boolean) {
        val pending = ask ?: return
        ask = null
        if (confirmed) work { pending.action() }
    }

    private fun askFirst(title: String, detail: String, confirm: String, action: () -> Unit) {
        main.post { ask = PendingAsk(title, detail, confirm, action) }
    }

    private fun printerName(): String = workspace.active?.let { text(it.name) } ?: string(R.string.device_model_the_printer)

    // --- Send --------------------------------------------------------------------------------

    /** Asks the operator; a send that stops waiting (cancelled, its session ended) withdraws the dialog, sending nothing. */
    private fun confirmSend(
        input: ProjectIntents.PrintWorkflowConfirmation,
        withdrawn: CompletableFuture<Unit>,
    ): CompletableFuture<ProjectIntents.PrintWorkflowDecision> {
        val answer = CompletableFuture<ProjectIntents.PrintWorkflowDecision>()
        val pending = PendingSend(SendDialogView(input), answer)
        withdrawn.whenComplete { _, _ -> answer.complete(SendDialogView.CANCEL) }
        main.post { if (!answer.isDone) sendConfirmation = pending }
        answer.whenComplete { _, _ -> main.post { if (sendConfirmation === pending) sendConfirmation = null } }
        return answer
    }

    /** The operator's answer to the send dialog. */
    fun answerSend(decision: ProjectIntents.PrintWorkflowDecision) {
        sendConfirmation?.answer?.complete(decision)
    }

    /**
     * "Send to Printer" (the browser's `sendToPrinter` and its shell's
     * submission handler): [slice] — `null`, or no longer current, is refused
     * in the browser's words — is opened as an artifact (its digest and tool
     * usage read by the shared core) and sent to the active printer.
     */
    fun send(slice: SliceToSend?) {
        if (sendState.busy) {
            sendState = sendState.copy(status = SendWords.BUSY)
            return
        }
        if (slice == null || !slice.isCurrent()) {
            sendState = SendState(status = SendWords.SLICE_FIRST)
            return
        }
        val printerLabel = state.activeId?.let { id -> state.printers.firstOrNull { it.id == id }?.name } ?: "Printer"
        PrintSendService.start(app, printerLabel, slice.filename)
        PrintSendService.onCancel = { cancelSend() }
        sendState = SendState(busy = true)
        val finish = { status: String ->
            stopPrepareTicker()
            PrintSendService.stop(app)
            PrintSendService.onCancel = null
            main.post { sendState = SendState(status = status) }
        }
        work {
            val artifact = try {
                PrintJobArtifacts.open(slice.file, slice.filename, slice.plateName, slice.isCurrent)
            } catch (failure: Exception) {
                val msg = failure.message?.trim()?.ifEmpty { null } ?: failure.javaClass.simpleName
                android.util.Log.e("OrcaXRSend", "Opening artifact failed: $msg", failure)
                finish(SendWords.failed(msg))
                return@work
            }
            val progress = PrintSendProgress(
                onPhase = { phase ->
                    main.post {
                        if (sendState.busy) {
                            stopPrepareTicker()
                            val baseText = SendWords.phase(phase, slice.filename)
                            sendState = sendState.copy(status = baseText)
                            PrintSendService.update(app, baseText)

                            if (phase == ProjectIntents.PrintSubmissionPhase.Preparing) {
                                val started = System.currentTimeMillis()
                                val ticker = object : Runnable {
                                    override fun run() {
                                        if (!sendState.busy) return
                                        val elapsedMs = System.currentTimeMillis() - started
                                        val seconds = elapsedMs / 1000
                                        val clock = "${seconds / 60}m ${(seconds % 60).toString().padStart(2, '0')}s"
                                        val text = "$baseText ($clock elapsed)"
                                        sendState = sendState.copy(status = text)
                                        PrintSendService.update(app, text)
                                        main.postDelayed(this, 1000)
                                    }
                                }
                                prepareTicker = ticker
                                main.postDelayed(ticker, 1000)
                            }
                        }
                    }
                },
                onUploadElapsed = { elapsed, total ->
                    main.post {
                        if (sendState.busy) {
                            val text = SendWords.uploadElapsed(slice.filename, elapsed, total)
                            sendState = sendState.copy(status = text)
                            PrintSendService.update(app, text)
                        }
                    }
                },
            )
            val sent = try {
                workspace.send(artifact, progress)
            } catch (failure: Exception) {
                CompletableFuture.failedFuture(failure)
            }
            sent.whenComplete { result, thrown ->
                artifact.close()
                val cause = (thrown as? CompletionException)?.cause ?: thrown
                val errorMsg = cause?.let {
                    val direct = it.message?.trim()?.ifEmpty { null }
                    val inner = it.cause?.let { c -> c.message?.trim()?.ifEmpty { null } ?: c.javaClass.simpleName }
                    when {
                        direct != null && inner != null && direct != inner -> "$direct ($inner)"
                        direct != null -> direct
                        inner != null -> "${it.javaClass.simpleName}: $inner"
                        else -> it.javaClass.simpleName
                    }
                }
                if (cause != null) {
                    android.util.Log.e("OrcaXRSend", "DeviceModel send failed: $errorMsg", cause)
                }
                finish(
                    when {
                        cause != null -> SendWords.failed(errorMsg ?: "Unknown error")
                        result == null -> SendWords.DECLINED
                        else -> SendWords.result(result)
                    },
                )
            }
        }
    }

    /** "Cancel send": what the send started stops, and it ends in the workflow's own outcome. */
    fun cancelSend() {
        if (!sendState.busy) return
        stopPrepareTicker()
        sendState = sendState.copy(status = SendWords.CANCELLING)
        work { workspace.cancelSend() }
    }

    fun dismissSend() {
        if (!sendState.busy) sendState = SendState()
    }

    // --- Files -------------------------------------------------------------------------------

    fun openFolder(path: String) = work {
        main.post { files = files.copy(loading = true) }
        val result = exchanges().storage(ProjectIntents.PrinterStorageOperation.List(ProjectIntents.PrinterText(units(path)))).get().result
        failure(result)?.let { failed -> main.post { message = failed; files = files.copy(loading = false) } }
        (result as? ProjectIntents.PrinterStorageResult.Listing)?.let { listing ->
            main.post { files = FilesView(path, listing.value) }
        }
    }

    fun selectFile(path: String) = work {
        val result = exchanges().storage(ProjectIntents.PrinterStorageOperation.Metadata(ProjectIntents.PrinterText(units(path)))).get().result
        failure(result)?.let { failed -> main.post { message = failed } }
        (result as? ProjectIntents.PrinterStorageResult.Metadata)?.let { metadata ->
            main.post { files = files.copy(selected = metadata.value) }
        }
    }

    /**
     * "Print this file": the stored file reprinted through the shared print
     * workflow, as the browser's storage panel does — its confirmation is the
     * send dialog in its stored-file mode — with the browser's words.
     */
    fun printFile(path: String) = work {
        val started = try {
            workspace.startStored(path)
        } catch (failure: Exception) {
            CompletableFuture.failedFuture(failure)
        }
        started.whenComplete { file, thrown ->
            val cause = (thrown as? CompletionException)?.cause ?: thrown
            main.post {
                message = when {
                    cause != null -> cause.message ?: cause.javaClass.simpleName
                    file == null -> string(R.string.device_model_print_cancelled)
                    else -> string(R.string.device_model_printing, file)
                }
            }
        }
    }

    fun deleteFile(path: String) = askFirst(
        string(R.string.device_model_delete_title, path.substringAfterLast('/')),
        string(R.string.device_model_delete_detail),
        string(R.string.device_model_delete_confirm),
    ) {
        val result = exchanges().storage(ProjectIntents.PrinterStorageOperation.Delete(ProjectIntents.PrinterText(units(path)))).get().result
        failure(result)?.let { failed -> main.post { message = failed } }
        main.post { files = files.copy(selected = null) }
        openFolder(files.path)
    }

    // --- History -----------------------------------------------------------------------------

    fun loadHistory(start: Double = 0.0) = work {
        main.post { history = history.copy(loading = true) }
        val exchanges = exchanges()
        val page = exchanges.history(
            ProjectIntents.PrintHistoryOperation.Page(
                ProjectIntents.PrintHistoryPageRequest(ProjectIntents.OptionalFinite.Value(start), ProjectIntents.OptionalFinite.Value(HISTORY_PAGE)),
            ),
        ).get()
        val totals = exchanges.history(ProjectIntents.PrintHistoryOperation.Totals(absent)).get()
        val read = (page as? ProjectIntents.PrintHistoryResult.Page)?.value
        val totalsText = text(
            PrintHistory.totalsText(
                (totals as? ProjectIntents.PrintHistoryResult.Totals)?.let { ProjectIntents.OptionalPrintHistoryTotals.Value(it.value) }
                    ?: ProjectIntents.OptionalPrintHistoryTotals.Absent(absent),
            ).text,
        )
        failure(page)?.let { failed -> main.post { message = failed } }
        val next = HistoryView(
            jobs = read?.jobs.orEmpty().map { it to PrintHistory.jobView(it) },
            pager = read?.let { PrintHistory.pageView(ProjectIntents.PrintHistoryPageShape(it.jobs.size.toDouble(), it.total, it.start, it.limit)) },
            totals = totalsText,
        )
        main.post { history = next }
    }

    /**
     * The printer's part of a diagnostics bundle, as the browser's shell
     * states it: whether a printer is set up, whether it is connected, and
     * its job's state when the session has one — never its address or key.
     */
    fun diagnosticsPrinter(): Diagnostics.Printer {
        val job = if (!::workspace.isInitialized) null
        else (workspace.session.view.snapshot as? ProjectIntents.OptionalPrintJobSnapshot.Value)?.value?.state
        return Diagnostics.Printer(state.activeId != null, state.connected, job?.name?.lowercase())
    }

    // --- Console -----------------------------------------------------------------------------

    /** Sends [script] once its assessment allows: anything that is not report-only is confirmed first. */
    fun sendScript(script: String) = work {
        val job = (workspace.session.view.snapshot as? ProjectIntents.OptionalPrintJobSnapshot.Value)?.value?.state
        val assessment = PrinterConsole.assess(
            ProjectIntents.GcodeAssessRequest(
                units(script),
                job?.let { ProjectIntents.OptionalPrintJobState.Value(it) } ?: ProjectIntents.OptionalPrintJobState.Absent(absent),
            ),
        )
        val send = {
            val result = exchanges().console(ProjectIntents.ConsoleOperation.Send(ProjectIntents.PrinterText(units(script)))).get()
            val failed = failure(result)
            val line = ProjectIntents.ConsoleLine(
                if (failed == null) ProjectIntents.ConsoleLineKind.Sent else ProjectIntents.ConsoleLineKind.Error,
                units(failed ?: script.trim()),
            )
            appendLine(PrinterConsole.line(ProjectIntents.ConsoleLineRequest(line, secrets())))
        }
        if (assessment.level == ProjectIntents.GcodeRiskLevel.Safe) {
            send()
        } else {
            val command = text(assessment.command)
            askFirst(
                if (assessment.level == ProjectIntents.GcodeRiskLevel.Dangerous) string(R.string.device_model_run_anyway, command) else string(R.string.device_model_run_title, command),
                assessment.reasons.joinToString("\n") { text(it) },
                string(R.string.device_model_run_confirm, command),
                send,
            )
        }
    }

    fun loadMacros() = work {
        val result = exchanges().console(ProjectIntents.ConsoleOperation.Macros(absent)).get()
        failure(result)?.let { failed -> main.post { message = failed } }
        (result as? ProjectIntents.ConsoleResult.Macros)?.let { macros -> main.post { console = console.copy(macros = macros.value) } }
    }

    /** Spells a macro with its values (or refuses them) and sends it as a script. */
    fun runMacro(macro: ProjectIntents.PrinterMacro, values: Map<String, String>) = work {
        when (val invocation = PrinterConsole.invocation(
            ProjectIntents.MacroInvocationRequest(macro.name, values.map { (key, value) -> ProjectIntents.MacroValue(units(key), units(value)) }),
        )) {
            is ProjectIntents.MacroInvocation.Refused -> main.post { message = text(invocation.value.message) }
            is ProjectIntents.MacroInvocation.Script -> sendScript(text(invocation.value))
        }
    }

    // --- Cameras -----------------------------------------------------------------------------

    fun loadCameras() = work {
        val result = exchanges().cameras().get()
        failure(result)?.let { failed -> main.post { message = failed } }
        val list = (result as? ProjectIntents.CameraListResult.Cameras)?.value.orEmpty()
        val selected = list.indexOfFirst { it.enabled && PrinterCamera.mechanisms(mechanismsRequest(it)).isNotEmpty() }.coerceAtLeast(0)
        chooseRoutes(list.getOrNull(selected))
        main.post { cameras = CameraView(list, selected, description = describe(list.getOrNull(selected))) }
    }

    fun selectCamera(index: Int) = work {
        val camera = cameras.cameras.getOrNull(index)
        chooseRoutes(camera)
        main.post { cameras = cameras.copy(selected = index, frame = null, failure = null, description = describe(camera)) }
    }

    private fun mechanismsRequest(camera: ProjectIntents.PrinterCamera) =
        ProjectIntents.CameraMechanismsRequest(camera, ProjectIntents.OptionalText.Absent(absent))

    /** The routes worth trying, in order. An app has no page that loads an image itself, so that route is a direct fetch. */
    private fun chooseRoutes(camera: ProjectIntents.PrinterCamera?) {
        routes = camera?.let { PrinterCamera.mechanisms(mechanismsRequest(it)) }.orEmpty()
            .map { if (it == ProjectIntents.CameraMechanism.Image) ProjectIntents.CameraMechanism.Direct else it }
            .distinct()
        route = 0
    }

    private fun describe(camera: ProjectIntents.PrinterCamera?): String = camera?.let {
        text(
            PrinterCamera.describe(
                ProjectIntents.CameraDescribeRequest(
                    it,
                    routes.getOrNull(route)?.let { r -> ProjectIntents.OptionalCameraMechanism.Value(r) } ?: ProjectIntents.OptionalCameraMechanism.Absent(absent),
                    ProjectIntents.OptionalText.Absent(absent),
                ),
            ).text,
        )
    }.orEmpty()

    /** The milliseconds between frames of the camera shown. */
    fun pollIntervalMs(): Long = cameras.cameras.getOrNull(cameras.selected)?.let { PrinterCamera.pollIntervalMs(it).toLong() } ?: 1000L

    /**
     * Fetches one frame along the current route; a failed route gives way to
     * the next, and once every route has failed the last failure stands.
     */
    fun fetchFrame() {
        if (fetching) return
        fetching = true
        work {
            try {
                val camera = cameras.cameras.getOrNull(cameras.selected) ?: return@work
                val mechanism = routes.getOrNull(route) ?: return@work
                val frame = exchanges().snapshot(camera, mechanism).get().mapCatching { bytes ->
                    // Bytes that are not an image (a web server's page in place of a frame)
                    // fail the route as a browser's image would, and the next is tried.
                    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    if (bounds.outWidth <= 0) {
                        val where = if (mechanism == ProjectIntents.CameraMechanism.Transport) camera.snapshotPath else camera.snapshotUrl
                        val named = (where as? ProjectIntents.OptionalPrinterReplyText.Value)?.let { text(it.value) } ?: string(R.string.device_model_the_camera)
                        throw IllegalStateException(string(R.string.device_model_camera_frame_error, named))
                    }
                    bytes
                }
                frame.onSuccess { bytes -> main.post { cameras = cameras.copy(frame = bytes, failure = null) } }
                frame.onFailure { failed ->
                    route++
                    val text = (failed as? CameraFrameException)?.message ?: failed.message
                    val described = describe(camera)
                    main.post { cameras = cameras.copy(failure = text, description = described) }
                }
            } finally {
                fetching = false
            }
        }
    }

    /** Queries loaded filament slots from the connected printer. */
    fun queryFilamentSlots(): CompletableFuture<List<ProjectIntents.MoonrakerFilamentSlot>> {
        val future = CompletableFuture<List<ProjectIntents.MoonrakerFilamentSlot>>()
        worker.execute {
            try {
                workspace.queryFilamentSlots().whenComplete { slots, error ->
                    if (error != null) {
                        main.post { future.completeExceptionally(error) }
                    } else {
                        main.post { future.complete(slots) }
                    }
                }
            } catch (t: Throwable) {
                main.post { future.completeExceptionally(t) }
            }
        }
        return future
    }

    override fun onCleared() {
        stopPrepareTicker()
        PrintSendService.stop(app)
        PrintSendService.onCancel = null
        worker.execute {
            listening?.close()
            subscription?.close()
            if (::finder.isInitialized) finder.close()
            if (::workspace.isInitialized) workspace.close()
        }
        worker.shutdown()
    }
}
