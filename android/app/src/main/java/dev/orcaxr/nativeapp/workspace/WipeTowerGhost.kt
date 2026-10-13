package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.renderer.MarkerShape
import dev.orcaxr.renderer.ModelTransform
import dev.orcaxr.renderer.PacketMeshes
import dev.orcaxr.renderer.SceneMarker

/**
 * The wipe tower's ghost as the browser's workspace draws it on the plate
 * (`rebuildWipeTowerGhost`), from the shared core's plan
 * ([dev.orcaxr.core.ProjectWorkspace.wipeTowerGhost]): a translucent grey box
 * from the tower's front-left corner, as wide as its footprint and as tall as
 * the plate's tallest model part, its edges in a lighter line, and — where the
 * brim and rib wall print outside the body — that footprint outlined in amber
 * just above the bed. Its body is shaded as the scene bakes a model's light,
 * where the browser's is lit (`MeshStandardMaterial`).
 */
internal object WipeTowerGhosts {
    /** The browser's colours and opacities: the body (`0x9e9e9e` at 0.35), its edges (`0xcfd8dc` at 0.8), the footprint (`0xffb74d` at 0.65). */
    const val BODY_ARGB = 0xff9e9e9e.toInt()
    const val BODY_OPACITY = .35f
    const val EDGE_ARGB = 0xffcfd8dc.toInt()
    const val EDGE_OPACITY = .8f
    const val FOOTPRINT_ARGB = 0xffffb74d.toInt()
    const val FOOTPRINT_OPACITY = .65f
    /** The outline's lift above the bed, clear of its grid: the browser's 0.0005 scene units at its 0.00175 units per millimetre. */
    const val FOOTPRINT_LIFT_MM = 0.0005 / 0.00175

    val BODY = MarkerShape.box("wipe-tower-ghost", PacketMeshes::shade)
    val EDGES = MarkerShape.boxEdges("wipe-tower-ghost-edges")
    val FOOTPRINT = MarkerShape.squareOutline("wipe-tower-ghost-footprint")

    /** The markers drawing [ghost]: none without one, or for a box too large for the scene's transforms (beyond ±10⁹ mm). */
    fun markers(ghost: ProjectIntents.WipeTowerGhost?): List<SceneMarker> =
        ghost?.let { runCatching { drawn(it) }.getOrNull() }.orEmpty()

    private fun drawn(ghost: ProjectIntents.WipeTowerGhost): List<SceneMarker> {
        val (x, y) = ghost.positionMm
        val width = ghost.widthMm
        val body = ModelTransform.scaledTranslated(width, width, ghost.heightMm, x, y, 0.0)
        val markers = mutableListOf(
            SceneMarker(BODY, body, BODY_ARGB, BODY_OPACITY, frontOnly = true),
            SceneMarker(EDGES, body, EDGE_ARGB, EDGE_OPACITY),
        )
        val margin = ghost.marginMm
        if (margin > 0) {
            val side = width + 2 * margin
            markers += SceneMarker(
                FOOTPRINT,
                ModelTransform.scaledTranslated(side, side, 1.0, x - margin, y - margin, FOOTPRINT_LIFT_MM),
                FOOTPRINT_ARGB,
                FOOTPRINT_OPACITY,
            )
        }
        return markers
    }
}
