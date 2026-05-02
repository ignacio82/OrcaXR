package dev.orcaxr.app

/**
 * Phase J in-XR painting (`docs/PHASE_J_PAINTING_PLAN.md`). Per
 * `docs/SNAPMAKER_PARITY_PLAN.md` §J, "color paint" is the v1 scope;
 * "support paint" lands in J.6 as a parallel mode (separate ByteArray
 * on `PlacedModel` — see [PlacedModel.paintFilamentIndex]).
 *
 * The brush is *not* a 3D volume — Jetpack XR alpha13 doesn't expose
 * raw 6DoF controller pose, so we'd have nothing to anchor a brush
 * sphere to. Instead the input is the controller laser raycast
 * (`InteractableComponent` + `InputEvent.hitInfoList[0].hitPosition`),
 * and the "brush" is a flood-fill from the hit triangle outward to
 * neighbors within [radiusMm] geodesic distance. Matches what desktop
 * OrcaSlicer's mouse-driven paint brushes do.
 */
enum class PaintMode {
    /** No painting active — laser pointer drives the existing
     *  `MovableComponent` grab volume on each model. */
    Off,
    /** Color paint — clicked triangles get tagged with [PaintBrush.activeSlot]
     *  in `paintFilamentIndex` and flow through libslic3r's
     *  `mmu_segmentation_facets` pipeline at slice time. */
    Color,
    /** Phase XR_OBJ_3 — Lay on face. The next clicked triangle becomes
     *  the model's bottom face: the rotation is replaced with whatever
     *  aligns the picked triangle's outward normal with -Z (down). The
     *  mode auto-resets to [Off] after a single pick — no stamp state
     *  to write back, just one rotation update. Reuses the same
     *  `InteractableComponent` + BVH raycast pipeline as Color paint. */
    LayOnFace,
    /** Phase XR_OBJ_8 — Support enforcer paint. Clicked triangles get
     *  tagged with state ENFORCER (1) in `supportFlags`, which flows
     *  into `mv->supported_facets` at slice time so libslic3r's
     *  support generator places pillars under those regions even if
     *  its overhang heuristic wouldn't normally suggest one. Useful
     *  for thin spans or attachment points that need extra rigidity
     *  during the print. */
    SupportEnforcer,
    /** Phase XR_OBJ_8 — Support blocker paint. Same pipeline as
     *  [SupportEnforcer] but stamps state BLOCKER (2). Tells the
     *  support generator to leave the painted region clean. Useful
     *  for cosmetic faces the user doesn't want scarred. */
    SupportBlocker,
    /** Phase XR_OBJ_8 — Seam enforcer paint. Stamps ENFORCER (1)
     *  into `seamFlags` so libslic3r's seam picker forces the
     *  layer-start seam to land in the painted region. Useful for
     *  hiding the seam on a back face / corner. */
    SeamEnforcer,
    /** Phase XR_OBJ_8 — Seam blocker paint. Stamps BLOCKER (2);
     *  tells the seam picker to avoid the painted region. */
    SeamBlocker,
    /** Paint full-feature-parity — Fuzzy Skin paint. Clicked triangles
     *  get tagged with state 1 in `fuzzySkinFlags`, which flows into
     *  `mv->fuzzy_skin_facets` at slice time so libslic3r's fuzzy-skin
     *  texture pass roughens the surface in painted regions only. State
     *  2 (BLOCKER) is reserved by the libslic3r facet enum but not
     *  produced by the painter — fuzzy is always additive. Mirrors
     *  upstream OrcaSlicer's `GLGizmoFuzzySkin`. */
    FuzzySkin,
}

/**
 * UI-side brush state. Lives as `var by remember { … }` in `XrShell`.
 * The InteractableComponent listener captures it via
 * `rememberUpdatedState` so live edits to radius / slot land on the
 * next event.
 *
 * @param mode         on/off + paint type.
 * @param activeSlot   1..numSlots. Filament slot the next painted
 *                     triangle gets tagged with. 0 reserved for
 *                     "unpainted / clear paint." Capped at the
 *                     `mmu_segmentation_facets` encoding table size
 *                     ([MAX_PAINT_SLOTS], matches libslic3r's
 *                     `EnforcerBlockerType::ExtruderMax`).
 * @param radiusMm     brush flood-fill radius in printer-frame mm.
 *                     Presets 3 / 6 / 12 — under 1 mm reduces to a
 *                     single-triangle stamp; over the model's bbox
 *                     paints everything.
 */
data class PaintBrush(
    val mode: PaintMode = PaintMode.Off,
    val activeSlot: Int = 1,
    val radiusMm: Float = 6f,
) {
    init {
        require(activeSlot in 0..MAX_PAINT_SLOTS) {
            "activeSlot=$activeSlot out of [0, $MAX_PAINT_SLOTS]"
        }
        require(radiusMm >= 0f) { "radiusMm=$radiusMm must be non-negative" }
    }
}

/**
 * Maximum filament slot index that survives a round-trip through
 * libslic3r's `mmu_segmentation_facets` encoding (the
 * `CONST_FILAMENTS` hex-string table in
 * `third_party/OrcaSlicer/src/libslic3r/Model.cpp:51`). Matches
 * `EnforcerBlockerType::ExtruderMax`. Slot 0 = unpainted.
 */
const val MAX_PAINT_SLOTS = 32

val BRUSH_RADIUS_PRESETS_MM: List<Float> = listOf(3f, 6f, 12f)

/**
 * Stamp a single triangle with [slot] in the per-triangle paint map.
 * Pure: caller passes the previous map (or null for "no paint yet")
 * and gets back a freshly-allocated array with the edit applied.
 *
 * Allocates lazily — a model that's never been painted carries
 * `paintFilamentIndex = null`, and we only allocate the full-size
 * ByteArray on the first stamp.
 *
 * @param previous     existing per-triangle slot map, or null.
 * @param triCount     total triangle count in the source mesh.
 * @param triangleIdx  0-based index to mark.
 * @param slot         filament slot 1..[MAX_PAINT_SLOTS], or 0 to
 *                     clear paint on this triangle.
 */
fun stampTriangle(
    previous: ByteArray?,
    triCount: Int,
    triangleIdx: Int,
    slot: Int,
): ByteArray {
    require(triangleIdx in 0 until triCount) {
        "triangleIdx=$triangleIdx out of [0, $triCount)"
    }
    require(slot in 0..MAX_PAINT_SLOTS) {
        "slot=$slot out of [0, $MAX_PAINT_SLOTS]"
    }
    val out = previous?.copyOf(triCount) ?: ByteArray(triCount)
    out[triangleIdx] = slot.toByte()
    return out
}

/**
 * Stamp many triangles at once with the same [slot]. Used by the
 * radius-flood-fill path so a drag-paint event mutates one ByteArray
 * instead of allocating per-triangle.
 */
fun stampTriangles(
    previous: ByteArray?,
    triCount: Int,
    triangleIndices: IntArray,
    slot: Int,
): ByteArray {
    require(slot in 0..MAX_PAINT_SLOTS) {
        "slot=$slot out of [0, $MAX_PAINT_SLOTS]"
    }
    val out = previous?.copyOf(triCount) ?: ByteArray(triCount)
    val s = slot.toByte()
    for (idx in triangleIndices) {
        require(idx in 0 until triCount) {
            "triangleIdx=$idx out of [0, $triCount)"
        }
        out[idx] = s
    }
    return out
}

/**
 * Returns true when [paint] has at least one non-zero entry. Empty /
 * null paint maps short-circuit the JNI write at slice time so we
 * don't pay the per-triangle authoring cost on unpainted models.
 */
fun hasAnyPaint(paint: ByteArray?): Boolean {
    if (paint == null) return false
    for (b in paint) if (b != 0.toByte()) return true
    return false
}

/**
 * Phase XR_OBJ_3 — Euler XYZ rotation (degrees) that brings [normal]
 * to align with `(0, 0, -1)`. Used by lay-on-face: the picked
 * triangle's outward normal becomes the model's new "down" direction,
 * so the face rests flush on the bed.
 *
 * Output Euler convention matches [StlMesh.transformedFull]:
 * `R = R_z · R_y · R_x` (intrinsic Tait-Bryan, X applied first).
 *
 * Three regimes:
 * - normal already ≈ (0, 0, -1): identity rotation (zero degrees on
 *   every axis).
 * - normal ≈ (0, 0, +1) (face points straight up): 180° around X axis.
 *   `cross(n, target)` is zero in this case so we fall back to the
 *   axis-perpendicular-to-up that's most stable to decompose (X).
 * - General: axis = normalize(cross(n, target)); angle = acos(n·target);
 *   build the axis-angle rotation matrix and decompose to Euler XYZ.
 *
 * Returns degrees as a triple (rotXDeg, rotYDeg, rotZDeg) clamped to
 * `(-180, 180]`.
 */
fun rotationToLayOnFace(normal: dev.orcaxr.app.Vec3f): Triple<Float, Float, Float> {
    // Target: -Z direction in printer-mm space (bed normal points up,
    // so a face's outward normal pointing -Z lands the face on the bed).
    val tx = 0f; val ty = 0f; val tz = -1f
    val nx = normal.x; val ny = normal.y; val nz = normal.z
    val nLen = kotlin.math.sqrt(nx * nx + ny * ny + nz * nz)
    if (nLen < 1e-6f) return Triple(0f, 0f, 0f)
    val nNx = nx / nLen; val nNy = ny / nLen; val nNz = nz / nLen
    val dot = nNx * tx + nNy * ty + nNz * tz
    val dotClamped = dot.coerceIn(-1f, 1f)

    // Already aligned — identity.
    if (dotClamped > 0.99999f) return Triple(0f, 0f, 0f)

    // Anti-aligned — pick X axis for a 180° flip. `R_x(180°)` sends
    // (0,0,+1) → (0,0,-1), which is exactly what we want.
    if (dotClamped < -0.99999f) return Triple(180f, 0f, 0f)

    // General axis-angle. axis = (n × t), angle = acos(n·t).
    val ax = nNy * tz - nNz * ty
    val ay = nNz * tx - nNx * tz
    val az = nNx * ty - nNy * tx
    val aLen = kotlin.math.sqrt(ax * ax + ay * ay + az * az)
    if (aLen < 1e-6f) return Triple(0f, 0f, 0f)
    val axN = ax / aLen; val ayN = ay / aLen; val azN = az / aLen
    val angle = kotlin.math.acos(dotClamped)
    val c = kotlin.math.cos(angle); val s = kotlin.math.sin(angle); val t1 = 1f - c

    // Rodrigues' rotation matrix:
    //   R = I + sin·K + (1-cos)·K²   where K = skew(axis).
    // Result is row-major [r00 r01 r02 | r10 r11 r12 | r20 r21 r22].
    val r00 = c + axN * axN * t1
    val r01 = axN * ayN * t1 - azN * s
    val r02 = axN * azN * t1 + ayN * s
    val r10 = ayN * axN * t1 + azN * s
    val r11 = c + ayN * ayN * t1
    val r12 = ayN * azN * t1 - axN * s
    val r20 = azN * axN * t1 - ayN * s
    val r21 = azN * ayN * t1 + axN * s
    val r22 = c + azN * azN * t1

    // Decompose to Euler XYZ matching R = R_z · R_y · R_x:
    //   r20 = -sin(ry); r21 = cos(ry)·sin(rx); r22 = cos(ry)·cos(rx)
    //   r00 = cos(ry)·cos(rz); r10 = cos(ry)·sin(rz)
    val ryRad: Float
    val rxRad: Float
    val rzRad: Float
    val sinY = (-r20).coerceIn(-1f, 1f)
    if (kotlin.math.abs(sinY) >= 0.99999f) {
        // Gimbal lock: cos(ry) ≈ 0 so the rx/rz decomposition
        // collapses. Fix rx = 0 and recover rz from the remaining
        // matrix entries.
        ryRad = kotlin.math.asin(sinY).toFloat()
        rxRad = 0f
        rzRad = kotlin.math.atan2(-r01, r11).toFloat()
    } else {
        ryRad = kotlin.math.asin(sinY).toFloat()
        rxRad = kotlin.math.atan2(r21, r22).toFloat()
        rzRad = kotlin.math.atan2(r10, r00).toFloat()
    }
    val k = (180.0 / Math.PI).toFloat()
    return Triple(rxRad * k, ryRad * k, rzRad * k)
}
