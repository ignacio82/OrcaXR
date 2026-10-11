package dev.orcaxr.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** The channels a paint surface authors (`PaintChannel`), each with the browser's tool action and label. */
enum class PaintChannel(internal val wire: String, val facet: ProjectIntents.FacetChannelName, val toolAction: String) {
    COLOR("color", ProjectIntents.FacetChannelName.Color, "tool_paint"),
    SUPPORT("support", ProjectIntents.FacetChannelName.Support, "tool_support_paint"),
    SEAM("seam", ProjectIntents.FacetChannelName.Seam, "tool_seam_paint"),
    FUZZY_SKIN("fuzzySkin", ProjectIntents.FacetChannelName.FuzzySkin, "tool_fuzzy_skin");

    /** `channelLabel`: how statuses and undo labels name the channel. */
    val label: String get() = when (this) {
        COLOR -> "colour"
        SUPPORT -> "support"
        SEAM -> "seam"
        FUZZY_SKIN -> "fuzzy-skin"
    }
}

/** The paint tools (`PaintToolKind`), in the browser panel's order. */
enum class PaintToolKind(val wire: String) {
    CIRCLE("circle"),
    SPHERE("sphere"),
    TRIANGLE("triangle"),
    FILL("fill"),
    HEIGHT_RANGE("heightRange"),
    GAP_FILL("gapFill"),
}

/** The painter's settings (`PaintToolSettings`); an absent parameter takes the painter's default. */
data class PaintToolSettings(
    val tool: PaintToolKind = PaintToolKind.CIRCLE,
    val radiusMm: Double? = null,
    val smartFillAngleDegrees: Double? = null,
    val heightRangeMm: Double? = null,
    val gapAreaMm2: Double? = null,
    val highlightByAngleDegrees: Double? = null,
    val triangleSplitting: Boolean? = null,
    val clippingPlane: ProjectIntents.FacetClippingPlane? = null,
) {
    companion object {
        /** The workspace painter's starting settings (`OrcaWorkspace.paintSettings`). */
        val WORKSPACE = PaintToolSettings(PaintToolKind.CIRCLE, radiusMm = 4.0, smartFillAngleDegrees = 30.0)
    }
}

/**
 * Where a painted part sits on the bed (`PaintPlacement`): the canonical
 * transforms of the instance a hit met and of the part inside it. The core
 * turns them into the selector's transform, so the brush and the band measure
 * bed millimetres (`orcaxr_project::facets::paint_tool::place`).
 */
data class PaintPlacement(val instance: ProjectIntents.Transform, val volume: ProjectIntents.Transform)

/**
 * Where a pointer met a volume (`PaintTargetHit` without its volume): the
 * source facet, the hit and the ray origin in the volume's own millimetres,
 * the previous sample of a drag, and where the part sits on the bed (none is
 * a part at the bed's origin, unscaled and unrotated).
 */
data class PaintHit(
    val triangleIndex: Long,
    val localPoint: List<Double>,
    val localCameraPosition: List<Double>,
    val previousLocalPoint: List<Double>? = null,
    val placement: PaintPlacement? = null,
)

/** The sample one hit makes with the painter's settings, or the painter's refusal. */
sealed interface PaintToolSample {
    data class Sample(val sample: ProjectIntents.PaintStrokeSample) : PaintToolSample
    /** `invalid_hit` or `invalid_settings`, with the painter's words. */
    data class Refused(val code: String, val message: String) : PaintToolSample
}

/** One sample of an open stroke: the sample made and the stroke's reply, or the painter's refusal. */
sealed interface PaintStrokeStep {
    data class Sampled(val sample: ProjectIntents.PaintStrokeSample, val reply: ProjectIntents.PaintStrokeSampleReply) : PaintStrokeStep
    data class Refused(val code: String, val message: String) : PaintStrokeStep
}

/**
 * The browser's painter settings in the shared core
 * (`orcaxr_project::facets::paint_tool`, the browser's `paintSelectionInputs`
 * through `PaintToolExchange.ts`): the paint stroke sample one hit makes —
 * the tool's parameters clamped to the pinned gizmo limits, the workspace's
 * defaults, Gap Fill's palette or pinned state order — and the colours paint
 * draws in.
 */
object PaintTools {
    private fun number(value: Double): String {
        require(value.isFinite()) { "invalid_request" }
        return value.toString()
    }
    private fun vector(value: List<Double>): String {
        require(value.size == 3) { "invalid_request" }
        return value.joinToString(",", "[", "]", transform = ::number)
    }

    private fun transform(value: ProjectIntents.Transform): String {
        require(value.rotation.size == 4) { "invalid_request" }
        return "{\"rotation\":" + value.rotation.joinToString(",", "[", "]", transform = ::number) +
            ",\"scale\":" + vector(value.scale) + ",\"translationMm\":" + vector(value.translationMm) + "}"
    }

    internal fun hitJson(hit: PaintHit): String = buildString {
        append("{\"localCameraPosition\":").append(vector(hit.localCameraPosition))
        append(",\"localPoint\":").append(vector(hit.localPoint))
        hit.placement?.let {
            append(",\"placement\":{\"instance\":").append(transform(it.instance))
            append(",\"volume\":").append(transform(it.volume)).append('}')
        }
        hit.previousLocalPoint?.let { append(",\"previousLocalPoint\":").append(vector(it)) }
        append(",\"triangleIndex\":").append(hit.triangleIndex).append('}')
    }

    internal fun settingsJson(settings: PaintToolSettings): String = buildString {
        append('{')
        settings.clippingPlane?.let { append("\"clippingPlane\":{\"normal\":").append(vector(it.normal)).append(",\"offset\":").append(number(it.offset)).append("},") }
        settings.gapAreaMm2?.let { append("\"gapAreaMm2\":").append(number(it)).append(',') }
        settings.heightRangeMm?.let { append("\"heightRangeMm\":").append(number(it)).append(',') }
        settings.highlightByAngleDegrees?.let { append("\"highlightByAngleDegrees\":").append(number(it)).append(',') }
        settings.radiusMm?.let { append("\"radiusMm\":").append(number(it)).append(',') }
        settings.smartFillAngleDegrees?.let { append("\"smartFillAngleDegrees\":").append(number(it)).append(',') }
        append("\"tool\":\"").append(settings.tool.wire).append('"')
        settings.triangleSplitting?.let { append(",\"triangleSplitting\":").append(it) }
        append('}')
    }

    /** `{"hit","settings"}`, as an open stroke takes a sample. */
    internal fun strokeRequest(hit: PaintHit, settings: PaintToolSettings) =
        "{\"hit\":${hitJson(hit)},\"settings\":${settingsJson(settings)}}"

    private fun refusal(reply: ProjectJsonObject): Pair<String, String>? =
        if (reply.keys().asSequence().any { it == "error" }) (reply.get("error") as String) to (reply.get("message") as String) else null

    /** The raw exchange: `{"channel","hit","settings","stateOrder"}` → `{"sample"}` or `{"error","message"}`. */
    fun sampleJson(request: String): String = NativeProject.paintToolSample(request)

    /** The sample [hit] makes with [settings] on [channel]; Gap Fill's colour precedence is [stateOrder]. */
    fun sample(channel: PaintChannel, hit: PaintHit, settings: PaintToolSettings, stateOrder: List<String>): PaintToolSample {
        val request = "{\"channel\":\"${channel.wire}\",\"hit\":${hitJson(hit)},\"settings\":${settingsJson(settings)}," +
            "\"stateOrder\":${stateOrder.joinToString(",", "[", "]", transform = CanonicalJson::quote)}}"
        val reply = CanonicalJson.read(sampleJson(request)) as ProjectJsonObject
        refusal(reply)?.let { (code, message) -> return PaintToolSample.Refused(code, message) }
        return PaintToolSample.Sample(ProjectIntents.decodePaintStrokeSample(reply.get("sample") as String))
    }

    /** The raw colour exchange: `{"channel","filaments","states"}` → `{"colors"}`. */
    fun colorsJson(request: String): String = NativeProject.paintFacetColors(request)

    internal fun step(json: String): PaintStrokeStep {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        refusal(reply)?.let { (code, message) -> return PaintStrokeStep.Refused(code, message) }
        return PaintStrokeStep.Sampled(
            ProjectIntents.decodePaintStrokeSample(reply.get("sample") as String),
            ProjectIntents.decodePaintStrokeSampleReply(reply.get("reply") as String),
        )
    }
}

/**
 * A paint facets summary: each state (its assigned value, or null unpainted)
 * with the colour the workspace draws it in, the whole facets in runs and the
 * leaves of subdivided facets, under the facet guard of the state read.
 */
data class PaintFacetsSummary(
    val colors: List<String>,
    val states: List<Any?>,
    val facets: Long,
    val runs: Long,
    val leaves: Long,
    val guard: ProjectIntents.FacetGuard,
) {
    companion object {
        fun read(json: String): PaintFacetsSummary {
            val value = CanonicalJson.read(json) as ProjectJsonObject
            fun strings(key: String) = (value.get(key) as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
            val states = value.get("states") as ProjectJsonArray
            val guard = value.get("guard") as ProjectJsonObject
            fun count(from: ProjectJsonObject, key: String) = (from.get(key) as Double).toLong()
            return PaintFacetsSummary(
                strings("colors"),
                List(states.length()) { states.get(it).takeIf { state -> state is String || state is Boolean } },
                count(value, "facets"), count(value, "runs"), count(value, "leaves"),
                ProjectIntents.FacetGuard(
                    count(guard, "revision"), (guard.get("hash") as String).map { it.code },
                    (guard.get("volumeId") as String).map { it.code }, count(guard, "topologyRevision"), count(guard, "triangleCount"),
                ),
            )
        }
    }
}

/** Runs of whole facets: `first`, `count`, `state` per run, from paint facets packets. */
object PaintFacetPackets {
    const val RUN_BYTES = 12
    const val LEAF_BYTES = 44

    /** One run packet as `[first, count, state]` triples. */
    fun runs(packet: ByteArray): IntArray {
        require(packet.size % RUN_BYTES == 0) { "Paint facet runs packet is short" }
        val buffer = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN)
        return IntArray(packet.size / 4) { buffer.getInt(it * 4) }
    }

    /** One leaf packet: nine corners (float32, volume millimetres) per leaf, and each leaf's source facet and state. */
    fun leaves(packet: ByteArray): Triple<FloatArray, IntArray, IntArray> {
        require(packet.size % LEAF_BYTES == 0) { "Paint facet leaves packet is short" }
        val buffer = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN)
        val count = packet.size / LEAF_BYTES
        val corners = FloatArray(count * 9)
        val sources = IntArray(count)
        val states = IntArray(count)
        for (leaf in 0 until count) {
            val at = leaf * LEAF_BYTES
            for (k in 0 until 9) corners[leaf * 9 + k] = buffer.getFloat(at + k * 4)
            sources[leaf] = buffer.getInt(at + 36)
            states[leaf] = buffer.getInt(at + 40)
        }
        return Triple(corners, sources, states)
    }
}
