package dev.orcaxr.app

import java.io.File

/**
 * Renders a parsed [StlMesh] to a triangle-mesh GLB for preview before
 * slicing. Mirrors [ToolpathGlb]'s "mm-in, scale-outside" contract so
 * the preview lines up with the build plate and (post-slice) toolpath
 * GLB at the same world scale.
 *
 * Recentering: same as ToolpathGlb — bbox xy-center, zMin → 0. That
 * means a model authored with its base on z=0 sits flush on the build
 * plate, and the bed center aligns with the model's footprint center.
 *
 * Coloring: generic STLs use solid off-white via vertex colors.
 * Extracted multi-object 3MF parts can pass a default extruder color,
 * and painted triangles can override per-face. We don't compute
 * normals here — the GLB is unlit (KHR_materials_unlit).
 */
object StlPreviewGlb {
    /** Soft off-white — visible against the dark passthrough but not
     *  so bright that it competes with the toolpath colors after
     *  slicing. Used for unpainted triangles. */
    private val DEFAULT_RGB = floatArrayOf(0.78f, 0.82f, 0.86f)

    /** Roadmap A6 — saturated red used to highlight off-bed triangles
     *  in the preview GLB. Bright enough to read against the dark XR
     *  passthrough and against any DEFAULT_RGB / paint slot color so
     *  the user can immediately see *where* the model overflows the
     *  printable polygon (the banner only tells them which axes). */
    private val OFF_BED_RGB = floatArrayOf(0.95f, 0.10f, 0.10f)

    fun write(
        mesh: StlMesh,
        out: File,
        /** Color for unpainted/default triangles. Multi-object 3MF
         *  parts extracted as STLs use this to preserve the source
         *  object's default extruder color in preview. */
        defaultRgb: FloatArray? = null,
        /** Phase J: per-triangle filament-slot byte array. Length must
         *  match `mesh.triCount` when non-null; entry i = 0 means
         *  "use [defaultRgb]"; i = 1..N indexes [paletteRgb] for
         *  the paint color (slot N at `paletteRgb[(N-1)*3 ..]`).
         *  Null = unpainted (existing single-color preview). */
        paintFilamentIndex: ByteArray? = null,
        /** Per-slot RGB triples (size = 3 * numSlots). Required when
         *  [paintFilamentIndex] is non-null. */
        paletteRgb: FloatArray? = null,
        /** Roadmap A6 — triangle indices that overflow the printable
         *  polygon (per [BedCollision.detect]). When non-null these
         *  triangles render in [OFF_BED_RGB] instead of their paint
         *  color, so the user can see exactly which faces of the
         *  silhouette poke off the bed. Out-of-range indices are
         *  silently dropped — the bed-collision pass and the GLB bake
         *  share `mesh.triCount` so this should never trigger in
         *  practice, but a stale array shouldn't take down preview. */
        offBedTriIndices: IntArray? = null,
    ) {
        if (mesh.triCount == 0) {
            // Degenerate: emit a single hidden triangle so GLB load doesn't crash.
            GlbBuilder(
                positions = floatArrayOf(0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f),
                indices = intArrayOf(0, 1, 2),
                mode = GlbBuilder.MODE_TRIANGLES,
            ).writeTo(out)
            return
        }

        val cx = (mesh.bboxMin.x + mesh.bboxMax.x) * 0.5f
        val cy = (mesh.bboxMin.y + mesh.bboxMax.y) * 0.5f
        val cz = mesh.bboxMin.z

        val n = mesh.triCount * 3
        val positions = FloatArray(n * 3)
        val colors = FloatArray(n * 3)
        val indices = IntArray(n)

        // When paint is supplied but malformed (size mismatch), fall
        // back to single-color rather than crashing — Phase J §4.5
        // re-bakes are best-effort and shouldn't take down the
        // preview pipeline on a stale paint array.
        val paint = paintFilamentIndex?.takeIf { it.size == mesh.triCount }
        val palette = paletteRgb?.takeIf { it.size >= 3 }
        // A6: build a BooleanArray once so per-tri lookup is O(1) on
        // the hot path. Unbounded indices are clamped — see param doc.
        val offBed: BooleanArray? = offBedTriIndices?.takeIf { it.isNotEmpty() }?.let { src ->
            val mask = BooleanArray(mesh.triCount)
            for (idx in src) if (idx in 0 until mesh.triCount) mask[idx] = true
            mask
        }
        val baseRgb = defaultRgb?.takeIf { it.size >= 3 } ?: DEFAULT_RGB
        var pi = 0; var ci = 0
        var src = 0
        for (tri in 0 until mesh.triCount) {
            val rgb: FloatArray = when {
                offBed != null && offBed[tri] -> OFF_BED_RGB
                else -> {
                    val slot = paint?.get(tri)?.toInt()?.and(0xFF) ?: 0
                    if (slot in 1..MAX_PAINT_SLOTS && palette != null) {
                        val base = (slot - 1) * 3
                        if (base + 2 < palette.size) {
                            floatArrayOf(palette[base], palette[base + 1], palette[base + 2])
                        } else DEFAULT_RGB
                    } else baseRgb
                }
            }
            for (v in 0 until 3) {
                positions[pi++] = mesh.positions[src++] - cx
                positions[pi++] = mesh.positions[src++] - cy
                positions[pi++] = mesh.positions[src++] - cz
                colors[ci++] = rgb[0]; colors[ci++] = rgb[1]; colors[ci++] = rgb[2]
                indices[tri * 3 + v] = tri * 3 + v
            }
        }

        // Multiply the flat per-corner colors by a Lambert + voxel-AO
        // shade. Without this the preview is a flat-yellow silhouette
        // and the user can't see eye sockets / mouth grooves / finger
        // gaps. See `BakedShading` for the recipe and gotcha #14 for
        // why we bake into vertex colors instead of running runtime
        // PBR + IBL.
        val (aoMin, aoMax, aoMean) = BakedShading.bakeStlPreview(positions, colors)
        android.util.Log.i("OrcaXR/preview", "shade bake: AO min=%.3f max=%.3f mean=%.3f"
            .format(aoMin, aoMax, aoMean))

        GlbBuilder(
            positions = positions,
            indices = indices,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colors,
        ).writeTo(out)
    }
}
