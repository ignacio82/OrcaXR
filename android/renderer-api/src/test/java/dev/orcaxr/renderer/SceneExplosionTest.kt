package dev.orcaxr.renderer

import dev.orcaxr.core.PaintPlacement
import dev.orcaxr.core.ProjectIntents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** The exploded view's platform-free parts: its inputs from the draws and the draws it moves. */
class SceneExplosionTest {
    private fun transform(x: Double, y: Double, z: Double) =
        ProjectIntents.Transform(listOf(x, y, z), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))

    private fun draw(instance: String, volume: String, at: ProjectIntents.Transform, part: ProjectIntents.Transform = transform(0.0, 0.0, 0.0)) =
        ProjectScene.Draw(
            "$instance/$volume", "plate", instance, "object", volume, "asset", ProjectIntents.VolumeRoleName.Model,
            ModelTransform.fromCanonical(at) * ModelTransform.fromCanonical(part), PaintPlacement(at, part), 0, true,
        )

    @Test fun eachInstanceIsOnePartAtItsTranslationInDrawOrder() {
        val draws = listOf(
            draw("b", "1", transform(10.0, 20.0, 0.0)), draw("b", "2", transform(10.0, 20.0, 0.0), transform(0.0, 0.0, 5.0)),
            draw("a", "1", transform(-4.0, 7.0, 1.0)),
        )
        val parts = SceneExplosion.parts(draws)
        assertEquals(listOf("b", "a"), parts.map { String(CharArray(it.id.size) { i -> it.id[i].toChar() }) })
        assertEquals(listOf(listOf(10.0, 20.0, 0.0), listOf(-4.0, 7.0, 1.0)), parts.map { it.centerMm })
    }

    @Test fun anInstancesDrawsMoveByItsOffsetAndKeepTheProjectsPlacement() {
        val part = transform(0.0, 0.0, 5.0)
        val draws = listOf(draw("a", "1", transform(10.0, 20.0, 0.0), part), draw("b", "1", transform(0.0, 0.0, 0.0)))
        val moved = SceneExplosion.exploded(draws, mapOf("a" to Point3(3.0, -1.0, 2.0)))
        assertEquals(Point3(13.0, 19.0, 7.0), moved[0].transform.point(Point3(0.0, 0.0, 0.0)))
        assertEquals(draws[0].placement, moved[0].placement)
        assertSame(draws[1], moved[1])
        assertSame(draws, SceneExplosion.exploded(draws, emptyMap()))
    }
}
