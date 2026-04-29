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
 * Coloring: solid translucent off-white via vertex colors. We don't
 * compute normals here — the GLB is unlit (KHR_materials_unlit), so
 * shading wouldn't kick in anyway. The user will see a flat silhouette
 * that's enough to confirm "yes, the model loaded and is positioned
 * correctly" before they slice.
 */
object StlPreviewGlb {
    /** Soft off-white — visible against the dark passthrough but not
     *  so bright that it competes with the toolpath colors after
     *  slicing. Used for unpainted triangles. */
    private val DEFAULT_RGB = floatArrayOf(0.78f, 0.82f, 0.86f)

    fun write(
        mesh: StlMesh,
        out: File,
        /** Phase J: per-triangle filament-slot byte array. Length must
         *  match `mesh.triCount` when non-null; entry i = 0 means
         *  "use [DEFAULT_RGB]"; i = 1..N indexes [paletteRgb] for
         *  the paint color (slot N at `paletteRgb[(N-1)*3 ..]`).
         *  Null = unpainted (existing single-color preview). */
        paintFilamentIndex: ByteArray? = null,
        /** Per-slot RGB triples (size = 3 * numSlots). Required when
         *  [paintFilamentIndex] is non-null. */
        paletteRgb: FloatArray? = null,
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
        var pi = 0; var ci = 0
        var src = 0
        for (tri in 0 until mesh.triCount) {
            val slot = paint?.get(tri)?.toInt()?.and(0xFF) ?: 0
            val rgb: FloatArray = if (slot in 1..MAX_PAINT_SLOTS && palette != null) {
                val base = (slot - 1) * 3
                if (base + 2 < palette.size) {
                    floatArrayOf(palette[base], palette[base + 1], palette[base + 2])
                } else DEFAULT_RGB
            } else DEFAULT_RGB
            for (v in 0 until 3) {
                positions[pi++] = mesh.positions[src++] - cx
                positions[pi++] = mesh.positions[src++] - cy
                positions[pi++] = mesh.positions[src++] - cz
                colors[ci++] = rgb[0]; colors[ci++] = rgb[1]; colors[ci++] = rgb[2]
                indices[tri * 3 + v] = tri * 3 + v
            }
        }

        GlbBuilder(
            positions = positions,
            indices = indices,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colors,
        ).writeTo(out)
    }
}
