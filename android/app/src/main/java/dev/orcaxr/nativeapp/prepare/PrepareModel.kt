package dev.orcaxr.nativeapp.prepare

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.AndroidLocalNetwork
import dev.orcaxr.core.AppCredentialVault
import dev.orcaxr.core.ExternalSliceCall
import dev.orcaxr.core.ExternalSlicerArchive
import dev.orcaxr.core.ExternalSlicerClient
import dev.orcaxr.core.ExternalSlicerException
import dev.orcaxr.core.ExternalSlicerPolicy
import dev.orcaxr.core.LocalSliceOutcome
import dev.orcaxr.core.LocalSliceRefusal
import dev.orcaxr.core.LocalSlicing
import dev.orcaxr.core.ProjectDocumentOutput
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectPlateArchive
import dev.orcaxr.core.ProjectPlatePreflight
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.SharedCredentials
import dev.orcaxr.core.SliceStatus
import dev.orcaxr.core.SliceStatusTally
import dev.orcaxr.nativeapp.engine.LocalEngineClient
import dev.orcaxr.nativeapp.engine.LocalEngineDevice
import dev.orcaxr.nativeapp.engine.LocalEngineState
import dev.orcaxr.nativeapp.engine.LocalEngineWords
import dev.orcaxr.nativeapp.engine.LocalSliceBudget
import dev.orcaxr.nativeapp.send.SendGuard
import dev.orcaxr.nativeapp.send.SliceToSend
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/** What Prepare reads of the project: its view, and one plate's preflight and slice archive. */
interface PlateSource {
    val view: ProjectView
    fun preflight(plateId: String): CompletableFuture<ProjectPlatePreflight>
    fun projectPlate(plateId: String, output: ProjectDocumentOutput): CompletableFuture<ProjectPlateArchive>
}

/** The active plate's preflight, as the browser's panel shows it, and the state it describes. */
data class PreflightView(
    val plateId: String,
    val revision: ProjectRevision,
    val canSlice: Boolean,
    val cards: List<PreflightCard>,
    /** Issues the core reported, some of them perhaps not read ([cards] is bounded). */
    val total: Long,
)

/** A slice in flight: its progress message and percent, and whether it is being cancelled. */
data class SliceJob(val message: String, val percent: Double? = null, val cancelling: Boolean = false)

/**
 * A finished slice: its G-code in the app's cache under the name it is sent
 * by, the plate and the state of the project it came from, the route it took
 * (the external slicer's [endpoint], or this device's engine when [local]),
 * and the browser's summary. Identity matters: a send checks it is still the
 * published one. Both routes publish the same way, so Preview and Device
 * treat them alike.
 */
class SlicedPlate(
    val file: File,
    val name: String,
    val plateId: String,
    val plateName: String,
    val revision: ProjectRevision,
    val endpoint: String,
    val summary: String,
    val local: Boolean = false,
)

/** What the Prepare area shows. */
data class PrepareState(
    val connection: SlicerConnection = SlicerConnection(),
    /** This build's engine and this device's memory, as last measured. */
    val local: LocalEngineState = LocalEngineState.NONE,
    val token: String = "",
    /** Whether the record keeps the token on this device (the Device area's switch). */
    val remember: Boolean = true,
    val consent: SliceConsent = SliceConsent(),
    val preflight: PreflightView? = null,
    val job: SliceJob? = null,
    val result: SlicedPlate? = null,
    /** The browser's status line: what the last action did. */
    val status: String? = null,
    /** The endpoint a slice waits for the operator's consent to upload to. */
    val consentFor: String? = null,
)

/**
 * The Prepare area's host adapter: slicing the active plate on the external
 * slicer as the browser's `sliceNow` does. The connection is the browser's
 * controller ([SlicerConnection]) over the shared policy's canonical endpoint
 * and attestation, persisted as its record is; the bearer token lives in the
 * process's remembered-credentials record, so the Device area's remember
 * switch governs it. A slice attests the route, preflights the active plate
 * in the shared core, writes its one-plate archive, uploads it — only to an
 * endpoint the operator agreed to — and streams the G-code into the app's
 * cache; output whose project changed in the meantime is discarded, and
 * Preview opens the rest. Connection work runs on one worker thread and a
 * slice on another, so the route can change (and be noticed) mid-slice.
 *
 * With the external slicer off, the plate is sliced by this device's own
 * engine, as the browser slices in-browser: the same preflight and one-plate
 * archive, staged privately for the engine's own process
 * ([LocalEngineClient]), its G-code claimed, verified and published only
 * for the project state it came from ([LocalSlicing]).
 */
class PrepareModel(application: Application) : AndroidViewModel(application) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "prepare-model") }
    private val slicer = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "prepare-slice") }
    private val checks = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "prepare-preflight") }
    private val preferences = application.getSharedPreferences("orcaxr.slicer", Context.MODE_PRIVATE)
    private val folder = File(application.cacheDir, "prepare")
    private val client = ExternalSlicerClient(localNetwork = AndroidLocalNetwork.permission(application))
    private val engine = LocalEngineClient(application)
    private val jobs = LocalEngineDevice.jobs(application)
    private lateinit var credentials: SharedCredentials
    private var listening: AutoCloseable? = null
    /** Worker-thread state: the token this area last wrote to the record. */
    private var written = ""
    @Volatile private var source: PlateSource? = null

    var state by mutableStateOf(PrepareState())
        private set
    /** A finished slice for Preview to open, once. */
    var sliced by mutableStateOf<SlicedPlate?>(null)
        private set
    /** The slice [state] shows (`state.result`), readable from any thread: the output a send checks it still is. */
    @Volatile private var published: SlicedPlate? = null

    // Shared between the threads, under [lock]: the connection, the token and the slice in flight.
    private val lock = Any()
    private var connection = SlicerConnection()
    private var token = ""
    private var consent = SliceConsent()
    private var call: ExternalSliceCall? = null
    private var running = false
    private var cancelRequested = false
    /** Preflight requests; only the latest is run. */
    private val preflights = AtomicInteger()

    init {
        // Jobs left by an earlier run of the app: none of them runs now, and none is ever claimed.
        slicer.execute { LocalSlicing.sweep(jobs) }
        refreshLocal()
        work {
            credentials = AppCredentialVault.shared(application)
            listening = credentials.subscribe { work(::credentialsChanged) }
            val engine = preferences.getString(ENGINE, null)
            val commit = preferences.getString(COMMIT, null)
            val loaded = text(credentials.current.slicerToken)
            written = loaded
            synchronized(lock) {
                token = loaded
                consent = SliceConsent(preferences.getStringSet(CONSENTED, emptySet()).orEmpty().toSet())
                connection = SlicerConnection(
                    endpoint = preferences.getString(ENDPOINT, null).orEmpty(),
                    enabled = preferences.getBoolean(ENABLED, false),
                    engine = if (engine != null && commit != null) AttestedEngine(engine == CLI, commit) else null,
                )
            }
            main.post { state = state.copy(token = loaded) }
            publish()
            // As the browser starts: an enabled slicer is checked again before anything is sent to it.
            val saved = synchronized(lock) { connection }
            if (saved.enabled && saved.endpoint.isNotEmpty()) probe(saved.endpoint)
        }
    }

    /** The project this area slices. */
    fun bind(project: PlateSource) {
        source = project
    }

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun work(task: () -> Unit) {
        worker.execute {
            try {
                task()
            } catch (failure: Throwable) {
                report(failure.message ?: failure.javaClass.simpleName)
            }
        }
    }

    private fun report(status: String) {
        main.post { state = state.copy(status = status) }
    }

    /** Publishes the shared values (and [change] of the rest) on the main thread. The token
     * field is the operator's: it changes only as they type or when the record lost the token. */
    private fun publish(change: (PrepareState) -> PrepareState = { it }) {
        val (now, agreed) = synchronized(lock) { connection to consent }
        val remember = if (::credentials.isInitialized) credentials.current.remember else true
        main.post { state = change(state).copy(connection = now, consent = agreed, remember = remember) }
    }

    private fun persist(value: SlicerConnection) {
        preferences.edit()
            .putString(ENDPOINT, value.endpoint)
            .putBoolean(ENABLED, value.enabled)
            .putString(ENGINE, value.engine?.let { if (it.cli) CLI else WASM })
            .putString(COMMIT, value.engine?.commit)
            .apply()
    }

    /**
     * The record changed. Its remembering is shown; a token other than the
     * one this area last wrote (forgotten in the Device area) replaces the
     * field's, and a check in flight is moot.
     */
    private fun credentialsChanged() {
        val stored = text(credentials.current.slicerToken)
        if (stored != written) {
            written = stored
            synchronized(lock) {
                token = stored
                connection = connection.invalidate()
            }
            main.post { state = state.copy(token = stored) }
        }
        publish()
    }

    /** "Connect": the candidate made canonical by the shared policy, then its engine checked. */
    fun connect(candidate: String) = work {
        // Off first, as the browser's controller: a replacement stays off until it attests.
        when (val endpoint = ExternalSlicerPolicy.endpoint(ProjectIntents.ExternalSlicerEndpointRequest(units(candidate.trim())))) {
            is ProjectIntents.ExternalSlicerEndpoint.Refused -> {
                val refused = synchronized(lock) { connection.refused(text(endpoint.value)).also { connection = it } }
                persist(refused)
                publish { it.copy(status = PrepareWords.connectionFailed(it.local)) }
            }
            is ProjectIntents.ExternalSlicerEndpoint.Endpoint -> probe(text(endpoint.value))
        }
    }

    /** Checks [endpoint]'s engine with the current token, within the browser's 8 s. */
    private fun probe(endpoint: String) {
        val (generation, held) = synchronized(lock) {
            connection = connection.probing(endpoint)
            connection.generation to token
        }
        persist(synchronized(lock) { connection })
        publish()
        client.attest(endpoint, held.ifEmpty { null }).orTimeout(PROBE_TIMEOUT_S, TimeUnit.SECONDS).whenComplete { answer, failure ->
            work {
                val engine = (answer as? ProjectIntents.ExternalSlicerAttestation.Attested)?.value?.let(::attested)
                val reason = when {
                    answer is ProjectIntents.ExternalSlicerAttestation.Unattested -> text(answer.value)
                    unwrap(failure) is TimeoutException -> "The external slicer connection timed out."
                    else -> unwrap(failure)?.message ?: "The connection failed."
                }
                val (before, after) = synchronized(lock) {
                    val previous = connection
                    connection = connection.probed(generation, engine, reason)
                    previous to connection
                }
                if (after == before) return@work
                persist(after)
                publish { it.copy(status = if (after.enabled) PrepareWords.CONNECTED else PrepareWords.connectionFailed(it.local)) }
            }
        }
    }

    private fun attested(value: ProjectIntents.ExternalSlicerAttested) =
        AttestedEngine(value.engine == ProjectIntents.ExternalSlicerEngine.Cli, text(value.commit))

    /** The switch: off keeps the endpoint; on connects it again. */
    fun setEnabled(enabled: Boolean) = work {
        if (enabled) {
            val endpoint = synchronized(lock) { connection.endpoint }
            if (endpoint.isNotEmpty()) probe(endpoint)
            return@work
        }
        persist(synchronized(lock) { connection.disable().also { connection = it } })
        publish()
    }

    /** "Remove": the slicer forgotten, with the consent given for it. */
    fun remove() = work {
        val removed = synchronized(lock) {
            consent = consent.revoke(connection.endpoint)
            connection = connection.clear()
            connection
        }
        persist(removed)
        preferences.edit().putStringSet(CONSENTED, synchronized(lock) { consent.endpoints }).apply()
        publish { it.copy(status = PrepareWords.removed(it.local)) }
    }

    /**
     * The bearer token as typed, live as the browser's field: a check in
     * flight is abandoned, and the record keeps it — stored on the device
     * only while remembering is on.
     */
    fun setToken(value: String) {
        val trimmed = value.trim()
        if (trimmed == state.token) return
        state = state.copy(token = trimmed)
        synchronized(lock) {
            token = trimmed
            connection = connection.invalidate()
        }
        publish()
        work {
            written = trimmed
            credentials.update { it.copy(slicerToken = units(trimmed)) }
        }
    }

    fun dismissStatus() {
        state = state.copy(status = null)
    }

    /** This build's engine and the device's memory, measured again for the route Prepare shows. */
    fun refreshLocal() {
        checks.execute {
            val measured = LocalEngineDevice.measure(getApplication())
            main.post { state = state.copy(local = measured) }
        }
    }

    /** The active plate's preflight, again; a request made meanwhile replaces this one. */
    fun refreshPreflight() {
        refreshLocal()
        val project = source ?: return
        val plate = project.view.activePlate ?: run {
            state = state.copy(preflight = null)
            return
        }
        val request = preflights.incrementAndGet()
        checks.execute {
            if (preflights.get() != request) return@execute
            val result = try {
                project.preflight(plate.id).get()
            } catch (_: Exception) {
                // Shown as unavailable; a slice preflights again before it uploads anything.
                main.post { state = state.copy(preflight = null) }
                return@execute
            }
            if (preflights.get() == request) main.post { state = state.copy(preflight = preflightView(result)) }
        }
    }

    private fun preflightView(result: ProjectPlatePreflight) = PreflightView(
        text(result.summary.plateId), result.revision, result.summary.canSlice, result.issues.map(PrepareWords::card), result.summary.issueCount,
    )

    /**
     * "Slice", on the route [sliceRoute] chooses: the external slicer the
     * operator turned on (whose first slice asks before anything is uploaded),
     * or this device's engine.
     */
    fun slice() {
        val now = state
        if (now.job != null) return
        when (sliceRoute(now.connection, now.local)) {
            SliceRouteKind.External -> {
                val endpoint = now.connection.endpoint
                if (!now.consent.allows(endpoint)) {
                    state = now.copy(consentFor = endpoint)
                    return
                }
                start(endpoint)
            }
            SliceRouteKind.Local -> launch({ true }) { project, plateId, projectName, plateName ->
                runLocal(project, plateId, projectName, plateName)
            }
            SliceRouteKind.None -> Unit
        }
    }

    /** The operator's answer to "Upload this plate to …?". */
    fun answerConsent(accept: Boolean) {
        val endpoint = state.consentFor ?: return
        state = state.copy(consentFor = null)
        if (!accept) return
        val granted = synchronized(lock) { consent.grant(endpoint).also { consent = it } }
        preferences.edit().putStringSet(CONSENTED, granted.endpoints).apply()
        state = state.copy(consent = granted)
        start(endpoint)
    }

    /** "Cancel Slice": before the upload it stops at the next step; afterwards the client confirms it with the server. */
    fun cancel() {
        val pending = synchronized(lock) {
            if (!running) return
            cancelRequested = true
            call
        }
        state = state.copy(job = state.job?.copy(cancelling = true, message = "cancelling", percent = null))
        pending?.cancel()
    }

    private fun start(endpoint: String) {
        var generation = 0L
        var held = ""
        launch({
            // The route is captured once; a different one is refused, never re-decided mid-job.
            if (!connection.enabled || connection.endpoint != endpoint) {
                false
            } else {
                generation = connection.generation
                held = token
                true
            }
        }) { project, plateId, projectName, plateName -> run(project, endpoint, generation, held, plateId, projectName, plateName) }
    }

    /**
     * Starts one slice of the active plate: [admit] (under the lock) captures
     * its route, then [body] runs on the slicing thread and the outcome is
     * shown — the published slice, or the status line.
     */
    private fun launch(admit: () -> Boolean, body: (PlateSource, String, String, String) -> SlicedPlate) {
        val project = source ?: return
        val view = project.view
        val plate = view.activePlate
        if (plate == null || plate.objects == 0) {
            state = state.copy(status = PrepareWords.NO_MODELS)
            return
        }
        synchronized(lock) {
            if (running || !admit()) return
            running = true
            cancelRequested = false
        }
        // A new slice withdraws the previous output, as the browser's does.
        published = null
        state = state.copy(job = SliceJob("preflighting"), result = null, status = null)
        slicer.execute {
            val outcome = try {
                Outcome.Done(body(project, plate.id, view.name.ifBlank { "Untitled project" }, plate.name))
            } catch (refusal: Refusal) {
                Outcome.Failed(refusal.message)
            } catch (failure: Throwable) {
                Outcome.Failed(describe(failure))
            } finally {
                synchronized(lock) {
                    running = false
                    call = null
                }
            }
            main.post {
                state = when (outcome) {
                    is Outcome.Done -> state.copy(job = null, result = outcome.plate, status = outcome.plate.summary)
                    is Outcome.Failed -> state.copy(job = null, status = outcome.status)
                }
                if (outcome is Outcome.Done) {
                    published = outcome.plate
                    sliced = outcome.plate
                }
            }
        }
    }

    /** Whether to ask for the notification permission before a local slice: once, ever. */
    fun askNotifications(): Boolean {
        if (preferences.getBoolean(NOTIFICATIONS_ASKED, false)) return false
        preferences.edit().putBoolean(NOTIFICATIONS_ASKED, true).apply()
        return true
    }

    fun slicedShown() {
        sliced = null
    }

    /** "Preview": the finished slice again (the screen offers it only while it is the project's). */
    fun showResult() {
        state.result?.let { sliced = it }
    }

    /**
     * "Send to Printer": the finished slice with the browser's `isCurrent`
     * guard — still the published output, of the active plate, of the project
     * as it stands — or `null` when it no longer is.
     */
    fun sendable(): SliceToSend? {
        val sent = published ?: return null
        val project = source ?: return null
        val isCurrent = { project.view.let { SendGuard.current(published, sent, it.activePlate?.id, it.revision) } }
        return if (isCurrent()) SliceToSend(sent.file, sent.name, sent.plateName, isCurrent) else null
    }

    private sealed interface Outcome {
        class Done(val plate: SlicedPlate) : Outcome
        class Failed(val status: String) : Outcome
    }

    /** A slice refused in words already written for the status line. */
    private class Refusal(override val message: String) : Exception(message)

    private fun unwrap(failure: Throwable?): Throwable? =
        if ((failure is ExecutionException || failure is CompletionException) && failure.cause != null) unwrap(failure.cause) else failure

    private fun describe(failure: Throwable): String = when (val cause = unwrap(failure)) {
        is CancellationException -> PrepareWords.failed(cause.message ?: "The external slice was cancelled.")
        is ExternalSlicerException -> PrepareWords.failed(cause.message ?: cause.kind.name)
        else -> PrepareWords.failed(cause?.message ?: cause?.javaClass?.simpleName ?: "unknown error")
    }

    private fun progress(message: String, percent: Double? = null) {
        main.post { state.job?.takeIf { !it.cancelling }?.let { state = state.copy(job = SliceJob(message, percent)) } }
    }

    /** Stops here when the operator cancelled, or the route changed since it was captured. */
    private fun checkpoint(generation: Long, endpoint: String) {
        synchronized(lock) {
            if (cancelRequested) throw Refusal(PrepareWords.failed(PrepareWords.CANCELLED_BY_USER))
            if (connection.generation != generation || !connection.enabled || connection.endpoint != endpoint) {
                throw Refusal(PrepareWords.failed(PrepareWords.ROUTE_CHANGED))
            }
        }
    }

    /** One slice, on the slicing thread: route, preflight, archive, upload, artifact. */
    private fun run(
        project: PlateSource,
        endpoint: String,
        generation: Long,
        held: String,
        plateId: String,
        projectName: String,
        plateName: String,
    ): SlicedPlate {
        val started = SystemClock.elapsedRealtime()
        val bearer = held.ifEmpty { null }
        // The route, attested now: a remembered proof is informational only.
        val route = try {
            client.attest(endpoint, bearer).get(PROBE_TIMEOUT_S, TimeUnit.SECONDS)
        } catch (_: TimeoutException) {
            throw Refusal(PrepareWords.unattested("The external slicer engine check timed out."))
        }
        synchronized(lock) {
            if (connection.generation != generation) throw Refusal(PrepareWords.failed(PrepareWords.CHANGED_WHILE_CHECKING))
        }
        if (route is ProjectIntents.ExternalSlicerAttestation.Unattested) throw Refusal(PrepareWords.unattested(text(route.value)))
        checkpoint(generation, endpoint)

        val preflight = project.preflight(plateId).get()
        main.post { state = state.copy(preflight = preflightView(preflight)) }
        if (!preflight.summary.canSlice) throw Refusal(PrepareWords.failed(PrepareWords.preflightBlocked(preflight.summary, preflight.issues)))
        checkpoint(generation, endpoint)

        progress("serializing")
        folder.mkdirs()
        val archiveFile = File(folder, "plate.3mf")
        val part = File(folder, "slice.gcode.part")
        try {
            val archive = project.projectPlate(plateId, object : ProjectDocumentOutput {
                override fun openOutput() = FileOutputStream(archiveFile)
            }).get()
            // The archive must be the state the preflight judged.
            if (archive.revision != preflight.revision) throw Refusal(PrepareWords.failed(PrepareWords.STALE))
            checkpoint(generation, endpoint)

            progress("Slicing project externally...")
            // What the status line says of it is counted as it streams in, by the shared core.
            val figures = SliceStatusTally(FileOutputStream(part).buffered()).use { tally ->
                val inFlight = client.slice(
                    endpoint, bearer, ExternalSlicerArchive(archiveFile.length()) { archiveFile.inputStream() }, archive.overrides, tally,
                ) { update -> progress(text(update.message).ifEmpty { "slicing" }, update.percent) }
                // A cancel that arrived before the call existed is carried out now.
                val cancelled = synchronized(lock) {
                    call = inFlight
                    cancelRequested
                }
                if (cancelled) inFlight.cancel()
                inFlight.result.get()
                tally.flush()
                tally.figures()
            }
            // Output for a project that has since changed is discarded, never shown.
            if (project.view.revision != archive.revision) throw Refusal(PrepareWords.failed(PrepareWords.STALE))
            val name = PrepareWords.slicedFilename(projectName, plateName)
            val outputs = File(folder, "gcode").apply { mkdirs() }
            outputs.listFiles()?.forEach { it.delete() }
            val file = File(outputs, name)
            check(part.renameTo(file)) { "OrcaXR could not keep the sliced G-code." }
            val elapsed = SystemClock.elapsedRealtime() - started
            val summary = SliceStatus.describe(elapsed, figures, archive.warnings.size)
            return SlicedPlate(file, name, plateId, plateName, archive.revision!!, endpoint, summary)
        } finally {
            archiveFile.delete()
            part.delete()
        }
    }

    /** Stops here when the operator cancelled a local slice. */
    private fun cancelledHere() {
        if (synchronized(lock) { cancelRequested }) throw Refusal(PrepareWords.failed(PrepareWords.CANCELLED_BY_USER))
    }

    /**
     * One slice on this device's engine, on the slicing thread: preflight, the
     * one-plate archive and its overrides staged privately (exactly what the
     * external route uploads), the plate admitted against the memory the
     * device has now, the engine's own process run with progress and
     * cooperative cancel, then its G-code claimed, verified and published only
     * while the project is still the state it was sliced from.
     */
    private fun runLocal(project: PlateSource, plateId: String, projectName: String, plateName: String): SlicedPlate {
        val started = SystemClock.elapsedRealtime()
        val preflight = project.preflight(plateId).get()
        main.post { state = state.copy(preflight = preflightView(preflight)) }
        if (!preflight.summary.canSlice) throw Refusal(PrepareWords.failed(PrepareWords.preflightBlocked(preflight.summary, preflight.issues)))
        cancelledHere()

        progress("serializing")
        val job = LocalSlicing.stage(jobs, UUID.randomUUID().toString().replace("-", "")) { output ->
            project.projectPlate(plateId, output).get()
        }
        try {
            // The archive must be the state the preflight judged.
            if (job.revision != preflight.revision) throw Refusal(PrepareWords.failed(PrepareWords.STALE))
            val measured = LocalEngineDevice.measure(getApplication())
            main.post { state = state.copy(local = measured) }
            if (!LocalSliceBudget.fits(job.archive.bytes, measured)) {
                throw Refusal(PrepareWords.failed(measured.reason ?: LocalEngineWords.tooLarge(job.archive.bytes, measured)))
            }
            cancelledHere()

            progress(LocalEngineWords.STARTING)
            val end = try {
                engine.run(job, { message, percent -> progress(message.ifEmpty { "slicing" }, percent) }) {
                    synchronized(lock) { cancelRequested }
                }
            } catch (refusal: LocalSliceRefusal) {
                throw Refusal(refusal.message ?: PrepareWords.failed(LocalEngineWords.NOT_STARTED))
            }
            val result = when (val outcome = LocalSlicing.outcome(end)) {
                is LocalSliceOutcome.Output -> outcome.result
                else -> throw Refusal(outcome.status ?: PrepareWords.failed(LocalSlicing.UNKNOWN_OUTCOME))
            }
            folder.mkdirs()
            // The verified bytes pass through the shared core's count of what the status line says.
            val (verified, figures) = SliceStatusTally().use { tally ->
                val verified = try {
                    LocalSlicing.claim(job, result, File(folder, "slice.gcode.part"), tally)
                } catch (refusal: LocalSliceRefusal) {
                    throw Refusal(PrepareWords.failed(refusal.message ?: LocalSlicing.MISMATCH))
                }
                verified to tally.figures()
            }
            val name = PrepareWords.slicedFilename(projectName, plateName)
            val outputs = File(folder, "gcode").apply { mkdirs() }
            outputs.listFiles()?.forEach { it.delete() }
            // Output for a project that has since changed is discarded, never shown.
            val file = LocalSlicing.publish(verified, job, project.view.revision, File(outputs, name))
                ?: throw Refusal(PrepareWords.failed(PrepareWords.STALE))
            val elapsed = SystemClock.elapsedRealtime() - started
            val summary = SliceStatus.describe(elapsed, figures, job.warnings)
            return SlicedPlate(file, name, plateId, plateName, job.revision!!, "", summary, local = true)
        } finally {
            LocalSlicing.discard(job)
        }
    }

    override fun onCleared() {
        // A slice still uploading or running is cancelled with the server; the client closes once that settled.
        val pending = synchronized(lock) {
            cancelRequested = true
            call
        }
        if (pending == null) {
            client.close()
        } else {
            pending.cancel()
            pending.result.whenComplete { _, _ -> client.close() }
        }
        worker.execute { listening?.close() }
        // A local slice still running sees the cancel at its next poll; the engine is let go after it.
        slicer.execute { engine.close() }
        worker.shutdown()
        checks.shutdown()
        slicer.shutdown()
    }

    private companion object {
        const val NOTIFICATIONS_ASKED = "notificationsAsked"
        const val ENDPOINT = "endpoint"
        const val ENABLED = "enabled"
        const val ENGINE = "engine"
        const val COMMIT = "commit"
        const val CONSENTED = "consented"
        const val CLI = "cli"
        const val WASM = "wasm"
        /** The browser's probe and engine-check deadline. */
        const val PROBE_TIMEOUT_S = 8L
    }
}
