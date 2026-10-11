package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.engine.LocalEngineState
import dev.orcaxr.nativeapp.engine.LocalEngineWords
import dev.orcaxr.nativeapp.engine.LocalSliceBudget

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

/** Where a slice goes: this device's engine, the external slicer, or nowhere. */
enum class SliceRouteKind { Local, External, None }

/**
 * The route a slice takes now, by the browser's rule: the external slicer
 * when the operator turned it on and its engine attested (their preference),
 * otherwise the engine on this device ([local], with the memory it measured).
 * A slicer the operator did not turn on is never chosen in its place.
 */
fun sliceRoute(connection: SlicerConnection, local: LocalEngineState): SliceRouteKind = when {
    connection.enabled -> SliceRouteKind.External
    local.available -> SliceRouteKind.Local
    else -> SliceRouteKind.None
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
    /** The browser's words for the same, when this device slices instead (as the browser does in-browser). */
    const val CONNECTION_FAILED_LOCAL = "External slicer connection failed — slicing locally."
    const val REMOVED_LOCAL = "External slicer removed — slicing locally."
    const val CHECKING = "Checking engine…"
    const val OFFLINE = "Offline"
    const val ON = "On — models will be sliced on the external server."
    /** Off on a device that cannot slice itself (no engine in this build, or too little memory). */
    const val OFF = "Off — this device cannot slice on its own now; connect an external slicer to slice."
    /** The browser's "Off — slicing locally in-browser.", for this device's engine. */
    const val OFF_LOCAL = "Off — slicing on this device."
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

    fun hint(connection: SlicerConnection, local: LocalEngineState = LocalEngineState.NONE): String = when {
        connection.enabled -> ON
        local.available -> OFF_LOCAL
        else -> OFF
    }

    /** The status after a failed connection check: the browser's words when the device slices instead. */
    fun connectionFailed(local: LocalEngineState) = if (local.available) CONNECTION_FAILED_LOCAL else CONNECTION_FAILED

    /** The status after the slicer was removed. */
    fun removed(local: LocalEngineState) = if (local.available) REMOVED_LOCAL else REMOVED

    /**
     * The route a slice would take and why — the plan's rule, shown before
     * anything is sliced or uploaded: the attested external slicer the
     * operator turned on, or this device's engine with the plate size its
     * memory admits now, or none and why.
     */
    fun route(connection: SlicerConnection, local: LocalEngineState = LocalEngineState.NONE): String = when (sliceRoute(connection, local)) {
        SliceRouteKind.External -> if (connection.engine != null) {
            "Slicing route: the external slicer at ${connection.endpoint}, whose engine attested as ${engine(connection.engine)}."
        } else {
            "Slicing route: the external slicer at ${connection.endpoint}."
        }
        SliceRouteKind.Local ->
            "Slicing route: this device's own engine (${LocalEngineWords.engine(local.commit.orEmpty())}), as external slicing is off. " +
                "Plates of up to ${LocalEngineWords.megabytes(LocalSliceBudget.largestArchive(local.availableMemory))} fit the memory this device has now."
        SliceRouteKind.None ->
            "Slicing route: none. ${local.reason ?: LocalEngineWords.NOT_PACKAGED} Connect an external slicer whose engine attests."
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
