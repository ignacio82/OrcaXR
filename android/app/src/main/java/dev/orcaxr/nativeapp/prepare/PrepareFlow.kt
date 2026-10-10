package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectIntents
import java.io.FilterOutputStream
import java.io.OutputStream
import java.util.Locale

/** Where the external slicer connection stands (the browser controller's phases). */
enum class SlicerPhase { Idle, Probing, Connected, Failed }

/** The engine an external slicer attested: the native Snapmaker Orca CLI or the WASM build, and its commit. */
data class AttestedEngine(val cli: Boolean, val commit: String)

/**
 * The external slicer connection as the browser's
 * `ExternalSlicerConnectionController` keeps it: one canonical endpoint,
 * whether external slicing is on — only once its engine attested — the
 * attestation it remembers (informational: every slice attests again), a
 * phase and why it failed. Whatever makes a check in flight moot (a new
 * candidate, a token edit, turning it off) advances [generation], and a
 * check's answer counts only in the generation it began in.
 */
data class SlicerConnection(
    val endpoint: String = "",
    val enabled: Boolean = false,
    val engine: AttestedEngine? = null,
    val phase: SlicerPhase = SlicerPhase.Idle,
    val reason: String = "",
    val generation: Long = 0,
) {
    /** A check in flight is abandoned; the route stays as it was. */
    fun invalidate() = copy(generation = generation + 1, phase = if (enabled) SlicerPhase.Connected else SlicerPhase.Idle, reason = "")

    /** Off: the endpoint is kept, and nothing is sliced on it until it is connected again. */
    fun disable() = invalidate().copy(enabled = false, engine = null, phase = SlicerPhase.Idle)

    /** Removed: a deliberate choice, kept on the next start too. */
    fun clear() = SlicerConnection(generation = generation + 1)

    /** Checking [candidate] (canonical already): off until its engine attests. */
    fun probing(candidate: String) = disable().let { it.copy(endpoint = candidate, generation = it.generation + 1, phase = SlicerPhase.Probing) }

    /** A candidate that is no usable address, in the policy's words. */
    fun refused(reason: String) = disable().copy(phase = SlicerPhase.Failed, reason = reason)

    /** A check's answer, for the generation it began in: [engine] when it attested, else why not. */
    fun probed(generation: Long, engine: AttestedEngine?, reason: String): SlicerConnection = when {
        generation != this.generation || phase != SlicerPhase.Probing -> this
        engine != null -> copy(enabled = true, engine = engine, phase = SlicerPhase.Connected, reason = "")
        else -> copy(phase = SlicerPhase.Failed, reason = reason)
    }
}

/**
 * The endpoints the operator agreed to upload plates to. The browser has no
 * such question; the plan's rule does: no model leaves the device for a
 * server the operator has not authorised, so the first slice on each
 * endpoint asks, and removing a slicer forgets its answer.
 */
data class SliceConsent(val endpoints: Set<String> = emptySet()) {
    fun allows(endpoint: String) = endpoint in endpoints
    fun grant(endpoint: String) = SliceConsent(endpoints + endpoint)
    fun revoke(endpoint: String) = SliceConsent(endpoints - endpoint)
}

/** One preflight issue as the browser's `SlicePreflightPanel` card shows it. */
data class PreflightCard(
    val id: String,
    val error: Boolean,
    /** "Error" or "Warning", then the stable code (with its detail code). */
    val heading: String,
    val message: String,
    val help: String,
    val path: String?,
    /** "kind: id" for each affected entity. */
    val entities: List<String>,
)

/** The browser's words for Prepare, with the few an Android device needs of its own. */
object PrepareWords {
    const val NO_MODELS = "No models to slice."
    const val STALE = "The project changed while slicing; the stale result was discarded. Slice again."
    const val ROUTE_CHANGED = "External slicer consent or endpoint changed after the route was captured."
    const val CHANGED_WHILE_CHECKING = "The external slicer changed while its engine was being checked."
    const val CANCELLED_BY_USER = "Cancelled by user"
    const val CONNECTED = "External slicer connected — external slicing is on."
    const val CONNECTION_FAILED = "External slicer connection failed — slicing is unavailable."
    const val REMOVED = "External slicer removed — slicing is unavailable."
    const val CHECKING = "Checking engine…"
    const val OFFLINE = "Offline"
    const val ON = "On — models will be sliced on the external server."
    /** The browser slices locally when off; this device has no engine of its own yet. */
    const val OFF = "Off — this device has no slicing engine of its own; connect an external slicer to slice."
    /** A sliced plate whose project changed afterwards: Preview withdraws it, as the browser does. */
    const val OUT_OF_DATE = "The project changed after this plate was sliced; its G-code was withdrawn. Slice again."

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** The engine as the browser names it, with its commit shortened. */
    fun engine(engine: AttestedEngine): String =
        "${if (engine.cli) "the native Snapmaker Orca CLI" else "the OrcaXR WASM engine"} at ${engine.commit.take(12)}"

    /** The connection's status line (`ExternalSlicerSettings.render`): the attested engine, or why it is not. */
    fun status(connection: SlicerConnection): String = when {
        connection.phase == SlicerPhase.Probing -> CHECKING
        connection.phase == SlicerPhase.Failed -> connection.reason
        connection.enabled -> "Online — attested" + (connection.engine?.let { " (${engine(it)})" } ?: "")
        else -> OFFLINE
    }

    fun hint(connection: SlicerConnection): String = if (connection.enabled) ON else OFF

    /** The route a slice would take and why — the plan's rule: shown before anything is uploaded. */
    fun route(connection: SlicerConnection): String = when {
        connection.enabled && connection.engine != null ->
            "Slicing route: the external slicer at ${connection.endpoint}, whose engine attested as ${engine(connection.engine)}."
        connection.enabled -> "Slicing route: the external slicer at ${connection.endpoint}."
        else -> "Slicing route: none. This device has no slicing engine of its own; connect an external slicer whose engine attests."
    }

    fun consentTitle(endpoint: String) = "Upload this plate to $endpoint?"
    const val CONSENT_DETAIL = "Slicing sends the plate's models, settings and custom G-code to that external slicer, " +
        "which returns the G-code. OrcaXR asks once for each slicer; removing the slicer forgets the answer."

    /** A failed slice in the browser's status line. */
    fun failed(message: String) = "slice failed: $message"

    /** A route whose engine did not attest (`resolveCanonicalSliceRoute`). */
    fun unattested(reason: String) = failed("the external slicer is not an attested engine route. $reason")

    /** A slice's progress (`renderCanonicalSliceStatus`). */
    fun progress(message: String) = "Slicing: $message"

    /** The browser's summary of a finished slice; layers are its fallback count of layer-change markers. */
    fun sliced(elapsedMs: Long, bytes: Long, lines: Long, layers: Long, warnings: Int): String {
        val suffix = if (warnings > 0) ", $warnings warning(s)" else ""
        return "SLICED in $elapsedMs ms\n${String.format(Locale.ROOT, "%.0f", bytes / 1024.0)} KB, $lines lines, $layers layers$suffix"
    }

    /** A preflight with blocking issues (`SlicePreflightError`). */
    fun preflightBlocked(summary: ProjectIntents.PreflightSummary, issues: List<ProjectIntents.PreflightIssue>): String {
        val first = issues.firstOrNull { it.severity == ProjectIntents.PreflightSeverity.Error }
        val count = summary.blockingCount
        return "Slice preflight blocked plate ${text(summary.plateId)} with $count error${if (count == 1L) "" else "s"}." +
            (first?.let { " ${text(it.message)}" } ?: "")
    }

    /** A preflight code as the browser writes it (`instance-outside-build-volume`). */
    fun code(code: ProjectIntents.PreflightCode): String = kebab(code.name)

    private fun kebab(name: String): String = buildString {
        for ((index, c) in name.withIndex()) {
            if (c.isUpperCase() && index > 0) append('-')
            append(c.lowercaseChar())
        }
    }

    private fun entity(entity: ProjectIntents.PreflightEntity): String = when (entity) {
        is ProjectIntents.PreflightEntity.Project -> "project"
        is ProjectIntents.PreflightEntity.Plate -> "plate: ${text(entity.value)}"
        is ProjectIntents.PreflightEntity.Object -> "object: ${text(entity.value)}"
        is ProjectIntents.PreflightEntity.Volume -> "volume: ${text(entity.value)}"
        is ProjectIntents.PreflightEntity.Instance -> "instance: ${text(entity.value)}"
        is ProjectIntents.PreflightEntity.LayerRange -> "layer-range: ${text(entity.value)}"
        is ProjectIntents.PreflightEntity.Filament -> "filament: ${text(entity.value)}"
    }

    fun card(issue: ProjectIntents.PreflightIssue): PreflightCard {
        val error = issue.severity == ProjectIntents.PreflightSeverity.Error
        val detail = (issue.detailCode as? ProjectIntents.OptionalText.Value)?.let { text(it.value) }
        return PreflightCard(
            id = text(issue.id),
            error = error,
            heading = "${if (error) "Error" else "Warning"} ${code(issue.code)}${detail?.let { " / $it" } ?: ""}",
            message = text(issue.message),
            help = text(issue.help),
            path = (issue.path as? ProjectIntents.OptionalText.Value)?.let { text(it.value) },
            entities = issue.entities.map(::entity),
        )
    }

    /** "N hidden issue(s)", as the browser's panel counts what the operator put away. */
    fun hidden(count: Int) = if (count == 1) "1 hidden issue" else "$count hidden issues"

    private val UNSAFE = Regex("[^A-Za-z0-9._-]+")

    /** The browser's printer-safe G-code file name (`sanitizeGcodeFilename`). */
    fun gcodeFilename(filename: String): String {
        val base = filename.split('/', '\\').last().trim()
        val stem = if (base.endsWith(".gcode", ignoreCase = true)) base.dropLast(".gcode".length) else base.replace(Regex("\\.[^.]*$"), "")
        val safe = stem.replace(UNSAFE, "_").replace(Regex("^[_.]+"), "").take(110)
        return if (safe.isNotEmpty()) "$safe.gcode" else "orcaxr_print.gcode"
    }

    /** A sliced plate's file name, as the browser names one it sends: `<project>_<plate>.gcode`. */
    fun slicedFilename(project: String, plate: String) = gcodeFilename("${project}_$plate.gcode")
}

/**
 * Counts what a G-code stream holds as it passes through to [out]: its bytes,
 * its lines (`split('\n').length`) and its layer-change markers (the browser's
 * fallback layer count, `/; CHANGE_LAYER|;LAYER_CHANGE/g`), matched across
 * chunk boundaries.
 */
class GcodeTally(out: OutputStream) : FilterOutputStream(out) {
    var bytes = 0L
        private set
    private var newlines = 0L
    var layers = 0L
        private set
    val lines: Long get() = newlines + 1
    private val progress = IntArray(MARKERS.size)

    override fun write(b: Int) {
        out.write(b)
        count(b.toByte())
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        out.write(b, off, len)
        for (i in off until off + len) count(b[i])
    }

    private fun count(byte: Byte) {
        bytes++
        if (byte == '\n'.code.toByte()) newlines++
        for ((index, marker) in MARKERS.withIndex()) {
            var matched = progress[index]
            // The markers repeat no prefix of themselves, so a mismatch restarts at the first byte.
            if (marker[matched] != byte) matched = if (marker[0] == byte) 0 else -1
            matched++
            if (matched == marker.size) {
                layers++
                matched = 0
            }
            progress[index] = matched
        }
    }

    private companion object {
        val MARKERS = listOf("; CHANGE_LAYER", ";LAYER_CHANGE").map { it.toByteArray(Charsets.US_ASCII) }
    }
}
