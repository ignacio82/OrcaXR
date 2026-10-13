package dev.orcaxr.renderer

import dev.orcaxr.core.ProjectAssembly
import dev.orcaxr.core.ProjectIntents

/**
 * The exploded assembly view, as the browser's workspace draws it
 * (`setExplosionFactor` → `applyExplosion`): every instance the active plate
 * draws moved away from their common centre by its offset from it times
 * `factor − 1` (the core's `projectExplosion`), on screen only. The project
 * is never changed: each draw's placement stays canonical, so painting,
 * measuring and every edit read the project, while what is drawn — and what
 * a pick meets — is exploded.
 */
object SceneExplosion {
    /** Each instance among [draws] once, in their order, at its canonical translation: the browser's inputs. */
    fun parts(draws: List<ProjectScene.Draw>): List<ProjectIntents.ExplosionPart> =
        draws.distinctBy { it.instanceId }.map { draw ->
            ProjectIntents.ExplosionPart(draw.instanceId.map { it.code }, draw.placement.instance.translationMm)
        }

    /** Each instance's view-only offset (mm) at [factor]; none at 1 (assembled), or when the core refuses the factor or the result. */
    fun offsets(draws: List<ProjectScene.Draw>, factor: Double): Map<String, Point3> {
        if (factor == 1.0 || draws.isEmpty()) return emptyMap()
        val reply = ProjectAssembly.explosion(ProjectIntents.ExplosionRequest(parts(draws), factor))
        val offsets = (reply as? ProjectIntents.ExplosionReply.Exploded)?.value ?: return emptyMap()
        return offsets.associate { offset ->
            String(CharArray(offset.id.size) { offset.id[it].toChar() }) to Point3(offset.offsetMm[0], offset.offsetMm[1], offset.offsetMm[2])
        }
    }

    /**
     * [draws] drawn at [offsets]: each instance's draws moved by its offset,
     * as the browser moves the instance's group; a draw whose moved place is
     * beyond the scene's transforms (±10⁹ mm) stays where it is.
     */
    fun exploded(draws: List<ProjectScene.Draw>, offsets: Map<String, Point3>): List<ProjectScene.Draw> {
        if (offsets.isEmpty()) return draws
        return draws.map { draw ->
            val offset = offsets[draw.instanceId] ?: return@map draw
            val instance = draw.placement.instance
            val (x, y, z) = instance.translationMm
            val moved = instance.copy(translationMm = listOf(x + offset.x, y + offset.y, z + offset.z))
            runCatching {
                draw.copy(transform = ModelTransform.fromCanonical(moved) * ModelTransform.fromCanonical(draw.placement.volume))
            }.getOrDefault(draw)
        }
    }
}
