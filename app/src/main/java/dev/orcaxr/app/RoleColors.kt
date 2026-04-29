package dev.orcaxr.app

/**
 * Color palette for extrusion roles in the toolpath visualization.
 *
 * The convention matches OrcaSlicer's desktop GUI defaults loosely
 * (outer walls = warm red, infill = cool blue/green, supports = gray)
 * so users coming from desktop OrcaSlicer get the same visual language.
 * Values are RGB in [0,1]; the GLB writer copies them per-vertex.
 */
data class Rgb(val r: Float, val g: Float, val b: Float)

object RoleColors {
    private val map: Map<ExtrusionRole, Rgb> = mapOf(
        ExtrusionRole.OuterWall to Rgb(0.95f, 0.35f, 0.35f),       // strong red
        ExtrusionRole.InnerWall to Rgb(0.25f, 0.75f, 0.45f),       // green
        ExtrusionRole.OverhangWall to Rgb(0.95f, 0.55f, 0.20f),    // orange
        ExtrusionRole.SparseInfill to Rgb(0.95f, 0.85f, 0.35f),    // yellow
        ExtrusionRole.InternalSolidInfill to Rgb(0.35f, 0.75f, 0.95f), // sky blue
        ExtrusionRole.TopSurface to Rgb(0.95f, 0.95f, 0.95f),      // near-white
        ExtrusionRole.BottomSurface to Rgb(0.65f, 0.65f, 0.65f),   // light gray
        ExtrusionRole.Ironing to Rgb(0.95f, 0.85f, 0.95f),         // soft pink
        ExtrusionRole.Bridge to Rgb(0.55f, 0.35f, 0.95f),          // purple
        ExtrusionRole.InternalBridge to Rgb(0.45f, 0.25f, 0.85f),  // darker purple
        ExtrusionRole.GapInfill to Rgb(0.85f, 0.65f, 0.35f),       // amber
        ExtrusionRole.Skirt to Rgb(0.55f, 0.95f, 0.95f),           // cyan
        ExtrusionRole.Brim to Rgb(0.35f, 0.85f, 0.85f),            // teal
        ExtrusionRole.Support to Rgb(0.40f, 0.40f, 0.45f),         // dark gray
        ExtrusionRole.SupportInterface to Rgb(0.55f, 0.55f, 0.60f),
        ExtrusionRole.SupportTransition to Rgb(0.50f, 0.50f, 0.55f),
        ExtrusionRole.PrimeTower to Rgb(0.95f, 0.55f, 0.95f),      // magenta
        ExtrusionRole.Custom to Rgb(0.85f, 0.85f, 0.35f),
        ExtrusionRole.Multiple to Rgb(0.75f, 0.75f, 0.75f),
        ExtrusionRole.Unknown to Rgb(0.60f, 0.60f, 0.60f),         // mid gray
    )

    fun colorFor(role: ExtrusionRole): Rgb = map[role] ?: map.getValue(ExtrusionRole.Unknown)
}
