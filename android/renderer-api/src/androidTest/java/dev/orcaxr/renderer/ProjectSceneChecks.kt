package dev.orcaxr.renderer

import dev.orcaxr.core.LocalTimestampResolver
import dev.orcaxr.core.ProjectDocumentInput
import dev.orcaxr.core.ProjectWorkspace
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The renderer's view of a real session through JNI: render deltas paged
 * into a [ProjectScene] by [SceneSync], mesh packets decoded into meshes,
 * the imported cube drawn once on the active plate, resting on the bed
 * inside it; undo and redo as deltas; a duplicate import sharing its mesh;
 * "New project" leaving the bed empty and the mesh dropped. */
object ProjectSceneChecks {
    private const val WAIT_S = 30L

    private class Bytes(val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long? = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    @JvmStatic fun run(cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            workspace.ready().get(WAIT_S, TimeUnit.SECONDS)
            val updates = LinkedBlockingQueue<SceneSync.Update>()
            SceneSync(workspace) { updates.add(it) }.use { sync ->
                fun next(): SceneSync.Update {
                    sync.request()
                    return checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)) { "no scene update" }
                }
                fun import() = workspace.commitImport(workspace.prepareImport(Bytes(cube), "cube.stl").get(WAIT_S, TimeUnit.SECONDS), emptyList())
                    .get(WAIT_S, TimeUnit.SECONDS)

                check(next().let { it.draws.isEmpty() && it.meshes.isEmpty() }, "empty_project_draws_nothing")
                import()
                val imported = next()
                val draw = imported.draws.singleOrNull()
                check(draw != null && imported.meshes.keys == setOf(draw.assetId), "cube_drawn_once ${imported.draws.size}")
                check(draw!!.argb == ProjectScene.DEFAULT_ARGB && draw.printable, "default_colour_printable")
                val mesh = imported.meshes.getValue(draw.assetId)
                check(mesh.facetCount == 12, "cube_mesh ${mesh.facetCount}")
                // Placed on the browser's 200 mm plate, dropped to the bed.
                val placed = (0 until mesh.facetCount * 3).map { draw.transform.point(mesh.vertex(it / 3, it % 3)) }
                val low = placed.minOf { it.z }
                check(kotlin.math.abs(low) < 1e-6, "rests_on_bed $low")
                check(placed.all { it.x in 0.0..200.0 && it.y in 0.0..200.0 }, "inside_the_plate")

                workspace.undo().get(WAIT_S, TimeUnit.SECONDS)
                val undone = next()
                check(undone.draws.isEmpty() && undone.removed == setOf(draw.assetId), "undo_removes_draw_and_mesh")
                workspace.redo().get(WAIT_S, TimeUnit.SECONDS)
                check(next().draws.map { it.key } == listOf(draw.key), "redo_restores_draw")

                import()
                val two = next()
                check(two.draws.size == 2 && two.draws.map { it.assetId }.toSet() == setOf(draw.assetId), "duplicate_shares_mesh")
                check(two.meshes.isEmpty(), "shared_mesh_not_fetched_again")
                check(two.draws.map { it.instanceId }.toSet().size == 2, "two_instances")

                // A renderer made afresh gets everything known.
                val everything = LinkedBlockingQueue<SceneSync.Update>()
                sync.snapshot { everything.add(it) }
                val full = checkNotNull(everything.poll(WAIT_S, TimeUnit.SECONDS))
                check(full.draws.size == 2 && full.meshes.keys == setOf(draw.assetId), "snapshot_is_everything")

                workspace.newProject().get(WAIT_S, TimeUnit.SECONDS)
                val fresh = next()
                check(fresh.draws.isEmpty() && fresh.removed == setOf(draw.assetId), "new_project_empties_bed")
            }
        }
        return checks
    }
}
