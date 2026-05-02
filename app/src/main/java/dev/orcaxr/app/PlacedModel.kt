package dev.orcaxr.app

import java.io.File

/**
 * Phase XR_OBJ_4 — kind of [PlacedVolume] within a multi-volume
 * [PlacedModel]. Mirrors `Slic3r::ModelVolumeType` (libslic3r
 * `Model.hpp:341-348`); the integer values match the C++ enum so the
 * Kotlin enum can flow straight through the JNI without a translation
 * table.
 *
 * - [MODEL_PART] — solid additive geometry. Every [PlacedModel] has
 *   at least one MODEL_PART volume (the primary mesh).
 * - [PARAMETER_MODIFIER] — region overrides print settings (e.g.
 *   denser infill in this part of the model).
 * - [NEGATIVE_VOLUME] — boolean-subtracted at slice time.
 * - [SUPPORT_ENFORCER] / [SUPPORT_BLOCKER] — force / forbid
 *   generated supports within the volume's footprint.
 *
 * libslic3r's enum has additional values (`INVALID = -1`,
 * `INTERNAL_INFILL = 4`, `MODEL_NEGATIVE = 6` is treated as
 * `NEGATIVE_VOLUME`); we expose only the user-author-able set.
 */
/**
 * Paint full-feature-parity (Brim Ears) — one user-placed brim ear
 * anchor on a [PlacedModel]. Mirrors upstream libslic3r's
 * `Slic3r::BrimPoint` (`libslic3r/BrimEarsPoint.hpp`).
 *
 * - [x], [y], [z] are in mesh-local printer mm. Z is typically near 0
 *   (the bed plane) but the point survives at any Z so the user can
 *   place an ear high on a vertical face if they want a side-brim.
 * - [headRadiusMm] sizes the printed brim ear disc. Default 5 mm
 *   matches OrcaSlicer's default `brim_ears_max_angle` companion.
 */
data class BrimEarPoint(
    val x: Float,
    val y: Float,
    val z: Float = 0f,
    val headRadiusMm: Float = 5f,
)

enum class ModelVolumeType(val nativeOrdinal: Int) {
    // Values match `Slic3r::ModelVolumeType` in
    // `third_party/OrcaSlicer/src/libslic3r/Model.hpp:341-348` exactly:
    //   MODEL_PART = 0, NEGATIVE_VOLUME = 1, PARAMETER_MODIFIER = 2,
    //   SUPPORT_BLOCKER = 3, SUPPORT_ENFORCER = 4.
    // Pass the ordinal straight through the JNI without translation.
    MODEL_PART(0),
    NEGATIVE_VOLUME(1),
    PARAMETER_MODIFIER(2),
    SUPPORT_BLOCKER(3),
    SUPPORT_ENFORCER(4),
}

/**
 * Phase XR_OBJ_4 — one volume inside a [PlacedModel]. Future "Add
 * part / Add modifier / Add negative volume / Add support
 * enforcer/blocker" UI flows append entries here; today only the
 * primary `MODEL_PART` volume of a 3MF / STL is implicit (a
 * [PlacedModel] with empty [PlacedModel.volumes] still slices
 * correctly via the single-mesh JNI path).
 *
 * - [id] uniquely identifies the volume within its [PlacedModel].
 * - [source] is a separate mesh container on disk — the 3MF / STL
 *   the user picked when adding this volume. Multiple volumes can
 *   reference the same source (e.g. cloning a modifier).
 * - [type] determines libslic3r's slicing semantics.
 * - [translateMm] / [rotDeg] / [scalePct] / [mirror] are LOCAL
 *   transforms relative to the parent [PlacedModel]'s space.
 * - [configOverrides] is a sparse SAFE_KEYS subset that becomes
 *   `mv->config().set_deserialize_nothrow(...)` at slice time.
 *   Only meaningful for [PARAMETER_MODIFIER] volumes today.
 * - [paintFilamentIndex] / [supportFlags] / [seamFlags] /
 *   [fuzzySkinFlags] are per-triangle byte arrays paralleling the
 *   volume's source mesh triangle order. Null = no paint authored
 *   for this volume.
 */
data class PlacedVolume(
    val id: String,
    val source: File,
    val type: ModelVolumeType,
    val translateXmm: Float = 0f,
    val translateYmm: Float = 0f,
    val translateZmm: Float = 0f,
    val rotXDeg: Float = 0f,
    val rotYDeg: Float = 0f,
    val rotZDeg: Float = 0f,
    val scaleXPct: Float = 100f,
    val scaleYPct: Float = 100f,
    val scaleZPct: Float = 100f,
    val mirrorX: Boolean = false,
    val mirrorY: Boolean = false,
    val mirrorZ: Boolean = false,
    val configOverrides: Map<String, String> = emptyMap(),
    val paintFilamentIndex: ByteArray? = null,
    val supportFlags: ByteArray? = null,
    val seamFlags: ByteArray? = null,
    val fuzzySkinFlags: ByteArray? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PlacedVolume) return false
        return id == other.id &&
            source == other.source &&
            type == other.type &&
            translateXmm == other.translateXmm &&
            translateYmm == other.translateYmm &&
            translateZmm == other.translateZmm &&
            rotXDeg == other.rotXDeg &&
            rotYDeg == other.rotYDeg &&
            rotZDeg == other.rotZDeg &&
            scaleXPct == other.scaleXPct &&
            scaleYPct == other.scaleYPct &&
            scaleZPct == other.scaleZPct &&
            mirrorX == other.mirrorX &&
            mirrorY == other.mirrorY &&
            mirrorZ == other.mirrorZ &&
            configOverrides == other.configOverrides &&
            byteArraysEqual(paintFilamentIndex, other.paintFilamentIndex) &&
            byteArraysEqual(supportFlags, other.supportFlags) &&
            byteArraysEqual(seamFlags, other.seamFlags) &&
            byteArraysEqual(fuzzySkinFlags, other.fuzzySkinFlags)
    }
    override fun hashCode(): Int {
        var r = id.hashCode()
        r = 31 * r + source.hashCode()
        r = 31 * r + type.hashCode()
        r = 31 * r + translateXmm.hashCode()
        r = 31 * r + translateYmm.hashCode()
        r = 31 * r + translateZmm.hashCode()
        r = 31 * r + rotXDeg.hashCode()
        r = 31 * r + rotYDeg.hashCode()
        r = 31 * r + rotZDeg.hashCode()
        r = 31 * r + scaleXPct.hashCode()
        r = 31 * r + scaleYPct.hashCode()
        r = 31 * r + scaleZPct.hashCode()
        r = 31 * r + mirrorX.hashCode()
        r = 31 * r + mirrorY.hashCode()
        r = 31 * r + mirrorZ.hashCode()
        r = 31 * r + configOverrides.hashCode()
        r = 31 * r + (paintFilamentIndex?.contentHashCode() ?: 0)
        r = 31 * r + (supportFlags?.contentHashCode() ?: 0)
        r = 31 * r + (seamFlags?.contentHashCode() ?: 0)
        r = 31 * r + (fuzzySkinFlags?.contentHashCode() ?: 0)
        return r
    }
}

private fun byteArraysEqual(a: ByteArray?, b: ByteArray?): Boolean {
    if (a === b) return true
    if (a == null || b == null) return false
    return a.contentEquals(b)
}

/**
 * One model the user has plated. Phase G replaces the single
 * `loadedStl` state with `List<PlacedModel>` so the user can drop
 * several STL/3MF/AMF files on the same bed and slice them in one
 * job via [SlicerEngine.sliceMulti].
 *
 * - [id] is unique within an XrShell session and stable across edits
 *   (so per-model GLB cache files at `stl_preview_${id}_v${n}.glb`
 *   stay associated with this row through transforms).
 * - [source] is the original on-disk input. For 3MFs / AMFs it's the
 *   real container; the slicer reads it directly.
 * - [translateXmm] / [translateYmm] are bed-XY offsets in mm,
 *   snapped to 5 mm by [snapAndClampOffset] at edit time. (0, 0) is
 *   the bed center *before* the JNI's group-recenter step (which
 *   shifts the whole group onto the printable area centroid). So
 *   only the relative spacing between models matters here, not the
 *   absolute placement on the bed.
 * - [rotZDeg] cycles 0/90/180/270 via the top-nav Rotate tool.
 * - [scalePct] is uniform scale, cycles through SCALE_PRESETS.
 * - [baseBboxXmm/Ymm/Zmm] cache the loaded mesh's STL-frame bbox at
 *   scale=100 / rot=0. Auto-arrange uses these to size the per-model
 *   spacing without re-reading the mesh on every layout.
 */
data class PlacedModel(
    val id: String,
    val source: File,
    val label: String,
    val translateXmm: Float = 0f,
    val translateYmm: Float = 0f,
    /** Phase XR_OBJ_2 — Z translate (vertical lift). Default 0; the
     *  bed-drop in the JNI re-grounds the model after rotation, so a
     *  positive value lifts the model off the bed (rare for FDM, but
     *  needed for stacked multi-volume assemblies). */
    val translateZmm: Float = 0f,
    val rotZDeg: Int = 0,
    /** Phase XR_OBJ_2 — X/Y rotation in degrees. Stored as Float to
     *  accept arbitrary user-typed values (45.5°, 22.5°, etc.); the
     *  TopNavigationPill quick-cycle still updates [rotZDeg] in 90°
     *  steps. */
    val rotXDeg: Float = 0f,
    val rotYDeg: Float = 0f,
    val scalePct: Int = 100,
    /** Phase XR_OBJ_2 — per-axis scale percentages. Default 100% means
     *  "track [scalePct] for back-compat with the TopNavigationPill
     *  uniform cycle." Diverging values (e.g. 100/100/200 for "stretch
     *  twice as tall") flow through to the slicer via the widened
     *  per-input transforms tuple. */
    val scaleXPct: Float = 100f,
    val scaleYPct: Float = 100f,
    val scaleZPct: Float = 100f,
    /** Phase XR_OBJ_2 — mirror flags. Implemented as sign flips on the
     *  per-instance scaling factor at JNI time, matching upstream
     *  OrcaSlicer's `Selection::mirror` semantics (which writes a
     *  negative scale). */
    val mirrorX: Boolean = false,
    val mirrorY: Boolean = false,
    val mirrorZ: Boolean = false,
    val baseBboxXmm: Float = 0f,
    val baseBboxYmm: Float = 0f,
    val baseBboxZmm: Float = 0f,
    val previewPath: String? = null,
    val previewVersion: Int = 0,
    /** Original container path (e.g. the 3MF) when [source] is an
     *  extracted STL. Null if [source] is the original input. */
    val originalSource: File? = null,
    /** Rotation that the current [previewPath] was rendered with. The
     *  re-preview LaunchedEffect compares against this so navigating
     *  between two already-rendered models doesn't trigger a 10-second
     *  re-bake of the colored GLB on each selection change. */
    val previewRotZDeg: Int = -1,
    val previewScalePct: Int = -1,
    /** One-based filament/extruder index used to tint STL previews
     *  that came from a colored multi-object 3MF. Extracting a 3MF
     *  object as STL preserves geometry for per-object selection, but
     *  STL has no material metadata; this carries the source object's
     *  default extruder color into the preview GLB. 0 = generic STL
     *  preview color. */
    val previewFilamentIndex: Int = 0,
    /** Phase B9 — Group ID for multi-object archives. All parts from
     *  the same 3MF share this ID (often the source file's SHA-256).
     *  Null = standalone file. */
    val groupId: String? = null,
    /** Phase B9 — Index of this object within the multi-object
     *  container. */
    val groupOrdinal: Int = 0,
    /** Phase E3 — Plate ID this model belongs to. Default is plate 1. */
    val plateId: Int = 1,
    /** Phase J in-XR paint state. Per-triangle filament slot index;
     *  size = source-mesh triangle count. 0 = unpainted (use the
     *  default profile path), 1..32 = filament slot tag that flows
     *  into `mmu_segmentation_facets` at slice time. Null means
     *  "never painted" and short-circuits the JNI authoring path on
     *  every slice. Allocated lazily on first stamp via
     *  [stampTriangle] / [stampTriangles]. See
     *  `docs/PHASE_J_PAINTING_PLAN.md` §4.2. */
    val paintFilamentIndex: ByteArray? = null,
    /** Phase XR_OBJ_8 in-XR support paint state. Per-triangle byte
     *  (size = source-mesh triangle count) that flows into
     *  `mv->supported_facets` at slice time:
     *    0 = unpainted (auto-support pipeline decides)
     *    1 = ENFORCER (force a support pillar in this region even
     *        if libslic3r's overhang heuristic wouldn't add one)
     *    2 = BLOCKER (forbid supports in this region — useful for
     *        cosmetic faces the user doesn't want scarred)
     *  Higher values reserved. Null = never painted, short-circuits
     *  the JNI write. Allocated lazily by [stampTriangle] /
     *  [stampTriangles] reusing the color paint helpers — the
     *  encoding bytes happen to be 1/2 in both cases (the
     *  EnforcerBlockerType enum's first two values). */
    val supportFlags: ByteArray? = null,
    /** Phase XR_OBJ_8 — in-XR seam paint state. Same encoding as
     *  [supportFlags] (0=unpainted, 1=ENFORCER, 2=BLOCKER) but
     *  flows into `mv->seam_facets` so libslic3r's seam picker
     *  forces (or forbids) the layer-start seam in the painted
     *  region. Useful for steering visible seam placement on
     *  cosmetic prints. Null = never painted. */
    val seamFlags: ByteArray? = null,
    /** Paint full-feature-parity (Brim Ears) — user-placed brim ear
     *  anchor points. Each point is a position in mesh-local mm + a
     *  head radius. Flows into `ModelObject::brim_points` at slice
     *  / save time so libslic3r emits a brim ear under each point on
     *  the printed first layer. Empty = no user-placed ears (the
     *  global brim_type still applies). */
    val brimEars: List<BrimEarPoint> = emptyList(),
    /** Paint full-feature-parity — in-XR fuzzy-skin paint state. Per-
     *  triangle byte (size = source-mesh triangle count) that flows
     *  into `mv->fuzzy_skin_facets` at slice time. State 1 marks the
     *  triangle as part of the fuzzy-skin region; state 0 leaves the
     *  surface smooth. State 2 is reserved by libslic3r's
     *  EnforcerBlockerType but unused for fuzzy paint — the upstream
     *  `GLGizmoFuzzySkin` only writes FUZZY_SKIN (1). Null = never
     *  painted, short-circuits the JNI write. */
    val fuzzySkinFlags: ByteArray? = null,
    /** Phase XR_OBJ_4 — additional volumes (modifiers, negative
     *  volumes, support enforcer/blocker) the user has appended to
     *  this model. The primary mesh from [source] always slices as
     *  the implicit `MODEL_PART` volume; entries here ride alongside
     *  it via `nativeSliceMulti`'s multi-volume bridge. Defaults to
     *  empty so existing single-mesh PlacedModels behave exactly as
     *  pre-Phase-XR_OBJ_4. */
    val volumes: List<PlacedVolume> = emptyList(),
    /** Phase XR_OBJ_4 — per-object config overrides. Sparse SAFE_KEYS
     *  subset applied at slice time via `mo->config().set_deserialize_
     *  nothrow(...)`. Mirrors OrcaSlicer's "Object Settings" panel
     *  (per-object layer height, wall count, etc.). Default empty
     *  means "use the global profile / `printSettingsOverrides`
     *  values for everything." */
    val configOverrides: Map<String, String> = emptyMap(),
) {
    // Custom equality: data-class default uses identity comparison
    // for ByteArray, which would make `placedModels.map { ... }` cycles
    // think the list mutated on every recomposition (because each map()
    // produces a new array instance even when contents match). The
    // existing call sites (LeftProjectPanel rerenders, grab-handle
    // re-positioning LE, the multi-model auto-arrange path) all key
    // off `id` to identify a model and either don't hit equals at all
    // or hit it via Compose's snapshot identity check on the list as
    // a whole — so the structural comparison here keeps things
    // composer-stable without forcing an @JvmInline value-class wrap.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PlacedModel) return false
        return id == other.id &&
            source == other.source &&
            label == other.label &&
            translateXmm == other.translateXmm &&
            translateYmm == other.translateYmm &&
            translateZmm == other.translateZmm &&
            rotZDeg == other.rotZDeg &&
            rotXDeg == other.rotXDeg &&
            rotYDeg == other.rotYDeg &&
            scalePct == other.scalePct &&
            scaleXPct == other.scaleXPct &&
            scaleYPct == other.scaleYPct &&
            scaleZPct == other.scaleZPct &&
            mirrorX == other.mirrorX &&
            mirrorY == other.mirrorY &&
            mirrorZ == other.mirrorZ &&
            baseBboxXmm == other.baseBboxXmm &&
            baseBboxYmm == other.baseBboxYmm &&
            baseBboxZmm == other.baseBboxZmm &&
            previewPath == other.previewPath &&
            previewVersion == other.previewVersion &&
            previewRotZDeg == other.previewRotZDeg &&
            previewScalePct == other.previewScalePct &&
            previewFilamentIndex == other.previewFilamentIndex &&
            groupId == other.groupId &&
            groupOrdinal == other.groupOrdinal &&
            plateId == other.plateId &&
            paintArraysEqual(paintFilamentIndex, other.paintFilamentIndex) &&
            paintArraysEqual(supportFlags, other.supportFlags) &&
            paintArraysEqual(seamFlags, other.seamFlags) &&
            paintArraysEqual(fuzzySkinFlags, other.fuzzySkinFlags) &&
            brimEars == other.brimEars &&
            volumes == other.volumes &&
            configOverrides == other.configOverrides
    }
    override fun hashCode(): Int {
        var r = id.hashCode()
        r = 31 * r + source.hashCode()
        r = 31 * r + label.hashCode()
        r = 31 * r + translateXmm.hashCode()
        r = 31 * r + translateYmm.hashCode()
        r = 31 * r + translateZmm.hashCode()
        r = 31 * r + rotZDeg
        r = 31 * r + rotXDeg.hashCode()
        r = 31 * r + rotYDeg.hashCode()
        r = 31 * r + scalePct
        r = 31 * r + scaleXPct.hashCode()
        r = 31 * r + scaleYPct.hashCode()
        r = 31 * r + scaleZPct.hashCode()
        r = 31 * r + mirrorX.hashCode()
        r = 31 * r + mirrorY.hashCode()
        r = 31 * r + mirrorZ.hashCode()
        r = 31 * r + baseBboxXmm.hashCode()
        r = 31 * r + baseBboxYmm.hashCode()
        r = 31 * r + baseBboxZmm.hashCode()
        r = 31 * r + (previewPath?.hashCode() ?: 0)
        r = 31 * r + previewVersion
        r = 31 * r + previewRotZDeg
        r = 31 * r + previewScalePct
        r = 31 * r + previewFilamentIndex
        r = 31 * r + (groupId?.hashCode() ?: 0)
        r = 31 * r + groupOrdinal
        r = 31 * r + plateId
        r = 31 * r + (paintFilamentIndex?.contentHashCode() ?: 0)
        r = 31 * r + (supportFlags?.contentHashCode() ?: 0)
        r = 31 * r + (seamFlags?.contentHashCode() ?: 0)
        r = 31 * r + (fuzzySkinFlags?.contentHashCode() ?: 0)
        r = 31 * r + brimEars.hashCode()
        r = 31 * r + volumes.hashCode()
        r = 31 * r + configOverrides.hashCode()
        return r
    }

    /** Phase XR_OBJ_2 — effective per-axis scale factor (1.0 = 100%).
     *  TransformPanel writes [scaleXPct] / [scaleYPct] / [scaleZPct]
     *  directly; the legacy uniform [scalePct] is the fallback when the
     *  per-axis fields are at default 100. */
    val effectiveScaleX: Float
        get() = if (scaleXPct != 100f) scaleXPct / 100f else scalePct / 100f
    val effectiveScaleY: Float
        get() = if (scaleYPct != 100f) scaleYPct / 100f else scalePct / 100f
    val effectiveScaleZ: Float
        get() = if (scaleZPct != 100f) scaleZPct / 100f else scalePct / 100f
}

private fun paintArraysEqual(a: ByteArray?, b: ByteArray?): Boolean {
    if (a === b) return true
    if (a == null || b == null) return false
    return a.contentEquals(b)
}

/** Has [m]'s preview GLB on disk been rendered with the current
 *  rotation + scale? Used by the re-preview LE to skip redundant
 *  bakes when the user just switches selection without changing
 *  geometry. */
fun PlacedModel.isPreviewFresh(): Boolean =
    previewPath != null &&
        rotZDeg == previewRotZDeg &&
        scalePct == previewScalePct

/**
 * Effective XY footprint of [m] after rotation + scale.
 *
 * Returns (width, depth) in mm. At rotZDeg = 90° / 270° the X and Y
 * axes swap. We treat any other angle conservatively: pre-Phase-G
 * the rotate tool only emits 0/90/180/270, so the swap-on-odd-quarter
 * heuristic is exact for the cases the UI actually produces. If a
 * future tool emits arbitrary angles we'd need a real bbox rotation
 * (rotate corners, take min/max) — guard against that by only
 * trusting this for multiples of 90°.
 */
fun PlacedModel.footprintMm(): Pair<Float, Float> {
    val w = baseBboxXmm * effectiveScaleX
    val d = baseBboxYmm * effectiveScaleY
    val swap = ((rotZDeg % 360) + 360) % 360 % 180 == 90
    return if (swap) d to w else w to d
}

/**
 * Maximum number of models the multi-model UI accepts on a single
 * plate. The cap matches the SceneCore draw-call budget guideline
 * in the SNAPMAKER_PARITY_PLAN Phase G note ("GLB count under
 * SceneCore may pressure draw-call budget"). Exceeding it disables
 * the "Add another" button rather than silently dropping inputs.
 */
const val MAX_PLACED_MODELS = 16

/**
 * Phase XR_OBJ_8 — compute per-clone (dx, dy) offset deltas for a
 * linear clone pattern. Returns [count] entries for clones i = 1..count;
 * each entry is the offset *relative to the source*, in mm, BEFORE
 * the bed snap+clamp pass (so call sites can add `source.translate{X,Y}mm`
 * and route through [snapAndClampOffset]).
 *
 * Pitch = source's effective footprint along the chosen axis + [spacingMm].
 * Axis is 'x' or 'y' (case-insensitive); any other char defaults to 'x'.
 *
 * Extracted from [MainActivity.runClonePattern] so the math can be
 * regression-tested without spinning up a Compose host.
 */
fun clonePatternOffsets(
    source: PlacedModel,
    count: Int,
    spacingMm: Float,
    axis: Char,
): List<Pair<Float, Float>> {
    require(count > 0) { "count must be > 0, got $count" }
    val (fw, fd) = source.footprintMm()
    val isY = axis.lowercaseChar() == 'y'
    val pitch = if (isY) fd + spacingMm else fw + spacingMm
    return (1..count).map { i ->
        if (isY) 0f to pitch * i else pitch * i to 0f
    }
}

/**
 * Lay [models] out left-to-right with [gapMm] between footprints,
 * centered on bed origin (X=0). Y is reset to 0 on every model.
 *
 * - For 1 model returns the same model with translation reset to
 *   (0, 0) so a "remove all but one + Auto-arrange" returns to a
 *   centered single-model state.
 * - The JNI's `nativeSliceMulti` re-centers the whole group on the
 *   printable area, so the absolute X here is irrelevant — only
 *   the relative spacing matters. We center on 0 for symmetry in
 *   the in-XR preview (where the workspace's coordinate space is
 *   "0 = bed center" already).
 * - Rotation/scale are honored via [footprintMm].
 */
fun autoArrangeModels(
    models: List<PlacedModel>,
    gapMm: Float = 5f,
): List<PlacedModel> {
    if (models.isEmpty()) return models
    if (models.size == 1) {
        val m = models.first()
        return if (m.translateXmm == 0f && m.translateYmm == 0f) models
        else listOf(m.copy(translateXmm = 0f, translateYmm = 0f))
    }
    val widths = models.map { it.footprintMm().first }
    val total = widths.sum() + gapMm * (models.size - 1)
    var cursor = -total / 2f
    val out = ArrayList<PlacedModel>(models.size)
    for (i in models.indices) {
        val m = models[i]
        val w = widths[i]
        val centerX = cursor + w / 2f
        cursor += w + gapMm
        out += m.copy(translateXmm = centerX, translateYmm = 0f)
    }
    return out
}
