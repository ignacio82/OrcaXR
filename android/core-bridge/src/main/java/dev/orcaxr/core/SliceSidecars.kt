package dev.orcaxr.core

/** The engine a slice route runs, as attested or packaged (`SliceEngineMetadata`). */
data class SliceEngine(val commit: String, val artifactHash: String)

/**
 * A slice route's metadata (`SliceRouteMetadata`) as the shared core names it:
 * the external server's from its endpoint and attested engine
 * (`CanonicalSlicerClientRoute`), or this device's engine
 * (`slicer-client:android-native:<artifactHash>`). [json] is its canonical text.
 */
class SliceRoute internal constructor(val id: String, val kind: String, val engine: SliceEngine, internal val json: String) {
    override fun toString() = json
}

/**
 * The effective profile snapshot a plate is sliced with
 * (`CanonicalStateProfileResolver.capture`): one SHA-256 over the canonical
 * effective configuration and a reference for the printer, the process and
 * each engine filament slot. [json] is its canonical text.
 */
class SliceProfiles internal constructor(val effectiveConfigHash: String, val references: Int, internal val json: String) {
    override fun toString() = json
}

/**
 * What one slice output is bound to (`GcodeStatisticsBinding`): the job and
 * plate, the project's revision, store and asset-bundle fingerprints, the
 * archive the engine read, the G-code it wrote, the effective configuration
 * and the engine.
 */
data class SliceBinding(
    val jobId: String,
    val plateId: String,
    val sourceRevision: Long,
    val sourceHash: String,
    val sourceAssetHash: String,
    val projectInputHash: String,
    val gcodeOutputHash: String,
    val effectiveConfigHash: String,
    val engineCommit: String,
    val engineArtifactHash: String,
) {
    /** The binding as canonical JSON, its keys in UTF-16 order. */
    fun json(): String = buildString {
        append("{\"effectiveConfigHash\":").append(CanonicalJson.quote(effectiveConfigHash))
        append(",\"engineArtifactHash\":").append(CanonicalJson.quote(engineArtifactHash))
        append(",\"engineCommit\":").append(CanonicalJson.quote(engineCommit))
        append(",\"gcodeOutputHash\":").append(CanonicalJson.quote(gcodeOutputHash))
        append(",\"jobId\":").append(CanonicalJson.quote(jobId))
        append(",\"plateId\":").append(CanonicalJson.quote(plateId))
        append(",\"projectInputHash\":").append(CanonicalJson.quote(projectInputHash))
        append(",\"sourceAssetHash\":").append(CanonicalJson.quote(sourceAssetHash))
        append(",\"sourceHash\":").append(CanonicalJson.quote(sourceHash))
        append(",\"sourceRevision\":").append(sourceRevision)
        append('}')
    }

    companion object {
        /** `sha256:` and a lowercase hex digest, as every SHA-256 identity is spelled. */
        fun sha256(hex: String): String = "sha256:$hex"

        /** One plate's binding: [revision] is the state its archive was written from. */
        fun of(
            jobId: String,
            plateId: String,
            revision: ProjectRevision,
            inputSha256: String,
            outputSha256: String,
            profiles: SliceProfiles,
            route: SliceRoute,
        ) = SliceBinding(
            jobId, plateId, revision.revision, revision.semanticHash, revision.assetFingerprint,
            sha256(inputSha256), sha256(outputSha256), profiles.effectiveConfigHash, route.engine.commit, route.engine.artifactHash,
        )
    }
}

/** The shared core's words for why something cannot bind a slice output. */
class SliceSidecarRefused(message: String) : IllegalStateException(message)

/**
 * What binds a slice's output and the sidecar published beside it, computed
 * by the shared core (`orcaxr_project::slicing::sidecar`,
 * `orcaxr_printer::slicer::route`) exactly as the browser computes the
 * profiles, the route and the binding rules (`SliceSidecarExchange.ts`).
 * The sidecar (`orcaxr.slice-output`, version 1) carries the binding, the
 * profiles, the route, the statistics — the route, the published length and
 * the totals the engine wrote into the artifact — and the warnings, and is
 * refused unless the binding names the profiles' and the route's identities.
 */
object SliceSidecars {
    const val SCHEMA = "orcaxr.slice-output"

    private fun read(json: String): ProjectJsonObject = try {
        CanonicalJson.read(json) as? ProjectJsonObject ?: throw InvalidProjectIntent()
    } catch (_: InvalidProjectIntent) {
        throw IllegalStateException("Invalid shared slice sidecar reply")
    }

    /** The reply, or the core's refusal thrown in its words. */
    private fun answer(json: String): ProjectJsonObject {
        val value = read(json)
        if (value.length() == 1 && value.keys().next() == "error") {
            throw SliceSidecarRefused(value.get("error") as? String ?: throw IllegalStateException("Invalid shared slice sidecar reply"))
        }
        return value
    }

    private fun text(value: ProjectJsonObject, key: String): String =
        value.get(key) as? String ?: throw IllegalStateException("Invalid shared slice sidecar reply")

    internal fun profiles(json: String): SliceProfiles {
        val value = answer(json)
        val references = value.get("references") as? ProjectJsonArray ?: throw IllegalStateException("Invalid shared slice profiles")
        return SliceProfiles(text(value, "effectiveConfigHash"), references.length(), json)
    }

    internal fun route(json: String): SliceRoute {
        val value = answer(json)
        val engine = value.get("engine") as? ProjectJsonObject ?: throw IllegalStateException("Invalid shared slice route")
        return SliceRoute(text(value, "id"), text(value, "kind"), SliceEngine(text(engine, "commit"), text(engine, "artifactHash")), json)
    }

    private fun engine(engine: SliceEngine) =
        "{\"artifactHash\":${CanonicalJson.quote(engine.artifactHash)},\"commit\":${CanonicalJson.quote(engine.commit)}}"

    /** The profile snapshot plate [plateId] of a state document is sliced with (a captured project answers through [ProjectSnapshot.sliceProfiles]). */
    fun profiles(stateJson: String, plateId: String): SliceProfiles =
        profiles(NativeProject.sliceProfiles("{\"plateId\":${CanonicalJson.quote(plateId)},\"stateJson\":${CanonicalJson.quote(stateJson)}}"))

    /** The external server's route for its canonical [endpoint] and the engine it attested. */
    fun externalRoute(endpoint: String, engine: SliceEngine): SliceRoute =
        route(NativeProject.externalSlicerRoute("{\"endpoint\":${CanonicalJson.quote(endpoint)},\"engine\":${engine(engine)}}"))

    /** This device's route: the packaged engine's commit and artifact identity. */
    fun nativeRoute(engine: SliceEngine): SliceRoute = route(NativeProject.sliceNativeRoute("{\"engine\":${engine(engine)}}"))

    /** Why [binding] does not bind an output as a sidecar's binding must, in the browser's words; null when it does. */
    fun bindingProblem(binding: SliceBinding): String? = try {
        answer(NativeProject.sliceBinding("{\"binding\":${binding.json()}}"))
        null
    } catch (refused: SliceSidecarRefused) {
        refused.message
    }

    /**
     * The sidecar document of one published plate: [summaryJson] is the
     * engine's totals as the core's tally read them (`null` when a statement
     * was past the metadata bound). Thrown as [SliceSidecarRefused] when the
     * parts do not bind one output.
     */
    fun sidecar(binding: SliceBinding, profiles: SliceProfiles, route: SliceRoute, gcodeBytes: Long, summaryJson: String, warnings: List<String>): String {
        val request = buildString {
            append("{\"binding\":").append(binding.json())
            append(",\"gcodeBytes\":").append(gcodeBytes)
            append(",\"profiles\":").append(profiles.json)
            append(",\"route\":").append(route.json)
            append(",\"summary\":").append(summaryJson)
            append(",\"warnings\":").append(warnings.joinToString(",", "[", "]") { CanonicalJson.quote(it) })
            append('}')
        }
        val document = NativeProject.sliceSidecar(request)
        answer(document)
        return document
    }

    /** The browser's exchanges over the shared core, for replays of its corpus; a malformed request fails with `invalid_request`. */
    object Exchanges {
        fun profiles(request: String): String = NativeProject.sliceProfiles(request)
        fun binding(request: String): String = NativeProject.sliceBinding(request)
        fun route(request: String): String = NativeProject.externalSlicerRoute(request)
        fun nativeRoute(request: String): String = NativeProject.sliceNativeRoute(request)
        fun sidecar(request: String): String = NativeProject.sliceSidecar(request)
    }
}
