package dev.orcaxr.core

/** What a slice covers (`SliceJobScope`): the active plate ("Slice"), or
 * every printable plate that holds a model ("Slice All Plates"). */
enum class SliceScope(internal val wire: String) {
    CurrentPlate("current-plate"),
    AllPlates("all-plates"),
}

/** The plates a slice slices, in slicing order, or why it slices none. */
sealed interface SlicePlan {
    data class Plates(val ids: List<String>) : SlicePlan
    /** The browser's words: "No models to slice.", "No printable plate has models to slice.", … */
    data class Refused(val message: String) : SlicePlan
}

/**
 * Which plates a slice slices, as the browser decides it (in the shared core
 * as `orcaxr_project::slicing::plate::slice_plan`): the workspace's refusal
 * when nothing it would slice holds a model, then the coordinator's
 * `selectPlateIds` — the active plate, which must be printable, or every
 * printable plate holding a model by plate order. A captured project answers
 * through [ProjectSnapshot.slicePlan]; this answers over a state document,
 * for replays and hosts without a session.
 */
object SlicePlans {
    fun of(stateJson: String, scope: SliceScope): SlicePlan =
        read(NativeProject.slicePlan("{\"scope\":\"${scope.wire}\",\"stateJson\":${CanonicalJson.quote(stateJson)}}"))

    internal fun read(json: String): SlicePlan = try {
        val answer = CanonicalJson.read(json) as? ProjectJsonObject ?: throw InvalidProjectIntent()
        when (answer.keys().asSequence().toSet()) {
            setOf("plateIds") -> {
                val ids = answer.get("plateIds") as? ProjectJsonArray ?: throw InvalidProjectIntent()
                SlicePlan.Plates(List(ids.length()) { ids.get(it) as? String ?: throw InvalidProjectIntent() })
            }
            setOf("refusal") -> SlicePlan.Refused(answer.get("refusal") as? String ?: throw InvalidProjectIntent())
            else -> throw InvalidProjectIntent()
        }
    } catch (_: InvalidProjectIntent) {
        throw IllegalStateException("Invalid shared slice plan")
    }
}

/**
 * The browser's thumbnail and slice-plan exchanges over the shared core
 * (`GcodeThumbnailsExchange`, `PlateThumbnailExchange`, `SlicePlanExchange`):
 * canonical JSON in, canonical JSON out, for replays of the browser's corpus.
 * A malformed request fails with `invalid_request`.
 */
object SliceOutputExchanges {
    fun list(request: String): String = NativeProject.sliceThumbnailList(request)
    fun block(request: String): String = NativeProject.sliceThumbnailBlock(request)
    fun inject(request: String): String = NativeProject.sliceThumbnailInject(request)
    fun view(request: String): String = NativeProject.sliceThumbnailView(request)
    fun plan(request: String): String = NativeProject.slicePlan(request)
}
