package dev.orcaxr.app

/**
 * D12 — primitive shapes seeded into the workspace from the "Add
 * primitive" path. Mirrors upstream OrcaSlicer's create_mesh helpers
 * (TriangleMesh.hpp:336) plus DISC/SLAB convenience aliases.
 *
 * The integer ordinals match the JNI's switch in
 * `nativeBuildPrimitiveStl` — keep them in lockstep when adding kinds.
 *
 * Each kind has a fixed parameter layout (millimetres for lengths,
 * degrees for the per-segment facet angle). [defaults] returns a
 * 1:1 array suitable for [SlicerEngine.buildPrimitiveStl].
 */
enum class PrimitiveKind(
    val nativeOrdinal: Int,
    val displayName: String,
    /** Parameter names in canonical order, parallel to [defaults]. */
    val paramNames: List<String>,
    /** Default parameter values. Lengths in mm, angles in degrees. */
    val defaults: FloatArray,
) {
    CUBE(
        nativeOrdinal = 0,
        displayName = "Cube",
        paramNames = listOf("x_mm", "y_mm", "z_mm"),
        defaults = floatArrayOf(20f, 20f, 20f),
    ),
    CYLINDER(
        nativeOrdinal = 1,
        displayName = "Cylinder",
        paramNames = listOf("radius_mm", "height_mm", "facet_angle_deg"),
        defaults = floatArrayOf(10f, 20f, 2f),
    ),
    SPHERE(
        nativeOrdinal = 2,
        displayName = "Sphere",
        paramNames = listOf("radius_mm", "facet_angle_deg"),
        defaults = floatArrayOf(10f, 2f),
    ),
    CONE(
        nativeOrdinal = 3,
        displayName = "Cone",
        paramNames = listOf("radius_mm", "height_mm", "facet_angle_deg"),
        defaults = floatArrayOf(10f, 20f, 2f),
    ),
    TORUS(
        nativeOrdinal = 4,
        displayName = "Torus",
        paramNames = listOf("major_radius_mm", "minor_radius_mm", "facet_angle_deg"),
        defaults = floatArrayOf(10f, 3f, 6f),
    ),
    DISC(
        nativeOrdinal = 5,
        displayName = "Disc",
        paramNames = listOf("radius_mm", "thickness_mm", "facet_angle_deg"),
        defaults = floatArrayOf(15f, 1f, 2f),
    ),
    /**
     * Audit H24 (2026-05-07): a SLAB is a rectangular prism with
     * non-uniform dimensions (default 40×40×2 mm = a flat tile). It
     * is NOT a placeholder cube — the cube primitive is a separate
     * kind ([CUBE]) and the JNI dispatches them via different default
     * values, not different mesh generators. If we ever want a
     * non-prism slab (chamfered edges, fillet), add a new
     * `CHAMBERED_SLAB` kind rather than mutating this one — callers
     * persist primitives by `nativeOrdinal` and a silent shape change
     * would re-bake their saved geometry.
     */
    SLAB(
        nativeOrdinal = 6,
        displayName = "Slab",
        paramNames = listOf("x_mm", "y_mm", "z_mm"),
        defaults = floatArrayOf(40f, 40f, 2f),
    );

    /**
     * Build a parameter array from a sparse [overrides] map keyed by
     * [paramNames]. Missing keys fall back to the corresponding entry
     * in [defaults]. Unknown keys are ignored — callers can reuse the
     * same sparse map across primitive kinds.
     */
    fun paramsFromMap(overrides: Map<String, Float>): FloatArray {
        val out = defaults.copyOf()
        for ((i, name) in paramNames.withIndex()) {
            overrides[name]?.let { out[i] = it }
        }
        return out
    }

    companion object {
        /** Resolve a kind by its case-insensitive name. */
        fun fromName(raw: String): PrimitiveKind? =
            values().firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}
