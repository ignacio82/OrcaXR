package dev.orcaxr.core

/** `TransformControls.mode`: what the gizmo's handles do (Move, Rotate and Scale choose them). */
enum class GizmoMode(internal val wire: String) {
    TRANSLATE("translate"),
    ROTATE("rotate"),
    SCALE("scale"),
}

/** `TransformControls.space`: the axes handles follow (scale always uses the object's). */
enum class GizmoSpace(internal val wire: String) {
    WORLD("world"),
    LOCAL("local"),
}

/** A pointer event's kind: a hover (mouse or pen without a button), a press, a move while pressed, a release. */
enum class GizmoEventKind(internal val wire: String) {
    HOVER("hover"),
    PRESS("press"),
    MOVE("move"),
    RELEASE("release"),
}

/** An object's local position, quaternion `[x, y, z, w]` and scale. */
data class GizmoPose(val position: List<Double>, val quaternion: List<Double>, val scale: List<Double>)

/**
 * A perspective camera (zoom 1) at [position] looking at [target] with [up],
 * in world units: a vertical field of view in degrees (0–180, exclusive), the
 * viewport's width over its height and its clip planes (0 < near < far).
 */
data class GizmoCamera(
    val fovDegrees: Double,
    val aspect: Double,
    val near: Double,
    val far: Double,
    val position: List<Double>,
    val target: List<Double>,
    val up: List<Double>,
)

/**
 * What the gizmo is drawn in: the [camera], the [root] that maps printer
 * millimetres into world units (the browser's is rotated −90° about X and
 * scaled by 0.00175; a renderer in metres uses 0.001), and the mode and space.
 */
data class GizmoScene(
    val camera: GizmoCamera,
    val root: GizmoPose,
    val mode: GizmoMode,
    val space: GizmoSpace = GizmoSpace.WORLD,
)

/**
 * What the controls keep between events, as the core writes it ([json],
 * opaque, exact); [axis], [changed], [dragging] and [proxy] are read from it.
 */
class GizmoState internal constructor(val json: String) {
    private val fields by lazy { CanonicalJson.read(json) as ProjectJsonObject }
    /** The handle under the pointer or being dragged (`X`, `XY`, `XYZE`, `E`, …), or null. */
    val axis: String? get() = fields.get("axis") as? String
    /** Whether the last event moved the proxy: a drag's change to submit. */
    val changed: Boolean get() = fields.get("changed") as Boolean
    val dragging: Boolean get() = fields.get("dragging") as Boolean
    /** The proxy's pose, exactly (a scale drag can make it non-finite). */
    val proxy: GizmoPose get() = (fields.get("proxy") as ProjectJsonObject).let { pose ->
        GizmoPose(TransformGizmo.exact(pose.get("position")), TransformGizmo.exact(pose.get("quaternion")), TransformGizmo.exact(pose.get("scale")))
    }
    override fun equals(other: Any?) = other is GizmoState && other.json == json
    override fun hashCode() = json.hashCode()
    override fun toString() = json
}

/** One handle as drawn: its world matrix (column-major), visibility and highlighted colour (linear) and opacity. */
data class GizmoHandle(
    val group: String,
    val name: String,
    val helper: Boolean,
    val visible: Boolean,
    val matrix: List<Double>,
    val color: List<Double>,
    val opacity: Double,
)

/** What the gizmo shows: the axis, the drag, the proxy and every handle of the mode, gizmo then helper group. */
data class GizmoView(
    val axis: String?,
    val dragging: Boolean,
    val proxy: GizmoPose,
    val handles: List<GizmoHandle>,
    /** The core's canonical reply. */
    val json: String,
)

/** A handle's baked geometry: Float32 positions, a triangle index (null when unindexed), drawn as a mesh or a line strip. */
class GizmoShape(val name: String, val helper: Boolean, val line: Boolean, val positions: FloatArray, val index: IntArray?)

/** Every mode's gizmo, picker and helper handles (in the order a [GizmoView] lists them) and the drag plane. */
class GizmoGeometry(
    val gizmo: Map<GizmoMode, List<GizmoShape>>,
    val picker: Map<GizmoMode, List<GizmoShape>>,
    val helper: Map<GizmoMode, List<GizmoShape>>,
    val plane: GizmoShape,
)

/**
 * The workspace's transform gizmo as the browser has it (three.js r184's
 * `TransformControls`, `OrcaWorkspace.setup2DControls`), in the shared core as
 * `orcaxr_project::placement::gizmo`: [attach] to the selection's proxy pose,
 * [step] every pointer event (normalized device coordinates; a press picks the
 * handle under it and starts a drag on it), [present] once a frame to draw the
 * handles from [geometry], and submit [changes] whenever a step reports
 * [GizmoState.changed]. Stateless: every call takes the state the last returned.
 */
object TransformGizmo {
    private fun number(value: Double): String {
        require(value.isFinite()) { "invalid_request" }
        return value.toString()
    }
    private fun numbers(values: List<Double>) = values.joinToString(",", "[", "]", transform = ::number)
    private fun pose(p: GizmoPose) =
        "{\"position\":${numbers(p.position)},\"quaternion\":${numbers(p.quaternion)},\"scale\":${numbers(p.scale)}}"
    private fun scene(s: GizmoScene): String {
        val c = s.camera
        val camera = "{\"aspect\":${number(c.aspect)},\"far\":${number(c.far)},\"fov\":${number(c.fovDegrees)},\"near\":${number(c.near)}" +
            ",\"position\":${numbers(c.position)},\"target\":${numbers(c.target)},\"up\":${numbers(c.up)}}"
        return "\"camera\":$camera,\"mode\":\"${s.mode.wire}\",\"root\":${pose(s.root)},\"space\":\"${s.space.wire}\""
    }
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as? Double ?: Double.NaN } }
    /** A state's numbers: JSON numbers, or `-0`, `NaN` and the infinities as strings. */
    internal fun exact(value: Any): List<Double> = (value as ProjectJsonArray).let { list ->
        List(list.length()) {
            when (val item = list.get(it)) {
                is Double -> item
                "-0" -> -0.0
                "NaN" -> Double.NaN
                "Infinity" -> Double.POSITIVE_INFINITY
                "-Infinity" -> Double.NEGATIVE_INFINITY
                else -> throw IllegalStateException("invalid_state")
            }
        }
    }
    private fun poseOf(value: Any): GizmoPose = (value as ProjectJsonObject).let {
        GizmoPose(doubles(it.get("position")), doubles(it.get("quaternion")), doubles(it.get("scale")))
    }

    /** New controls attached to a proxy at [proxy] (the selection's pivot, in the root's millimetres). */
    fun attach(proxy: GizmoPose): GizmoState =
        GizmoState(NativeProject.transformGizmoAttach("{\"proxy\":${pose(proxy)}}"))

    /** The state after one pointer event at ([x], [y]) in normalized device coordinates. */
    fun step(scene: GizmoScene, state: GizmoState, kind: GizmoEventKind, x: Double, y: Double): GizmoState =
        GizmoState(
            NativeProject.transformGizmoStep(
                "{${scene(scene)},\"event\":{\"kind\":\"${kind.wire}\",\"x\":${number(x)},\"y\":${number(y)}},\"state\":${state.json}}",
            ),
        )

    /** What [state] shows in [scene]. */
    fun present(scene: GizmoScene, state: GizmoState): GizmoView {
        val json = NativeProject.transformGizmoPresent("{${scene(scene)},\"state\":${state.json}}")
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        val handles = reply.get("handles") as ProjectJsonArray
        return GizmoView(
            reply.get("axis") as? String,
            reply.get("dragging") as Boolean,
            poseOf(reply.get("proxy")),
            List(handles.length()) { index ->
                val handle = handles.get(index) as ProjectJsonObject
                GizmoHandle(
                    handle.get("group") as String,
                    handle.get("name") as String,
                    handle.get("tag") is String,
                    handle.get("visible") as Boolean,
                    doubles(handle.get("matrix")),
                    doubles(handle.get("color")),
                    handle.get("opacity") as? Double ?: Double.NaN,
                )
            },
            json,
        )
    }

    private val shapes: GizmoGeometry by lazy {
        val reply = CanonicalJson.read(NativeProject.transformGizmoGeometry()) as ProjectJsonObject
        fun shape(value: Any): GizmoShape {
            val entry = value as ProjectJsonObject
            val positions = entry.get("positions") as ProjectJsonArray
            val index = entry.get("index") as? ProjectJsonArray
            return GizmoShape(
                entry.get("name") as String,
                entry.get("tag") is String,
                entry.get("kind") == "line",
                FloatArray(positions.length()) { (positions.get(it) as Double).toFloat() },
                index?.let { list -> IntArray(list.length()) { (list.get(it) as Double).toInt() } },
            )
        }
        fun group(name: String): Map<GizmoMode, List<GizmoShape>> = (reply.get(name) as ProjectJsonObject).let { modes ->
            GizmoMode.entries.associateWith { mode ->
                (modes.get(mode.wire) as ProjectJsonArray).let { list -> List(list.length()) { shape(list.get(it)) } }
            }
        }
        GizmoGeometry(group("gizmo"), group("picker"), group("helper"), shape(reply.get("plane")))
    }

    /** Every handle's baked geometry, read once. */
    fun geometry(): GizmoGeometry = shapes

    /**
     * What a drag submits for the proxy at [proxy], having been at
     * [initialProxy] when the drag began: the one instance of [origins] takes
     * the proxy's transform, a selection is carried around the proxy as
     * [tool] says; or the workspace's refusal.
     */
    fun changes(
        initialProxy: GizmoPose,
        proxy: GizmoPose,
        tool: TransformTool,
        origins: List<ProjectIntents.InstanceTransform>,
    ): TransformFieldEdit {
        fun units(text: List<Int>) = String(CharArray(text.size) { text[it].toChar() })
        fun transform(t: ProjectIntents.Transform) =
            "{\"rotation\":${numbers(t.rotation)},\"scale\":${numbers(t.scale)},\"translationMm\":${numbers(t.translationMm)}}"
        val request = "{\"initialProxy\":${pose(initialProxy)},\"mode\":\"${tool.wire}\",\"origins\":" +
            origins.joinToString(",", "[", "]") { "{\"instanceId\":${CanonicalJson.quote(units(it.instanceId))},\"transform\":${transform(it.transform)}}" } +
            ",\"proxy\":${pose(proxy)}}"
        val reply = CanonicalJson.read(NativeProject.transformGizmoChanges(request)) as ProjectJsonObject
        if (reply.keys().asSequence().any { it == "error" }) return TransformFieldEdit.Refused(reply.get("message") as String)
        val changes = reply.get("changes") as ProjectJsonArray
        return TransformFieldEdit.Changes(
            List(changes.length()) { index ->
                val change = changes.get(index) as ProjectJsonObject
                val t = change.get("transform") as ProjectJsonObject
                ProjectIntents.InstanceTransform(
                    (change.get("instanceId") as String).map { it.code },
                    ProjectIntents.Transform(doubles(t.get("translationMm")), doubles(t.get("rotation")), doubles(t.get("scale"))),
                )
            },
        )
    }
}
