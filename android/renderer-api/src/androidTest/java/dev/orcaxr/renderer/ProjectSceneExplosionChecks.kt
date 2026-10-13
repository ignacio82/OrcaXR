package dev.orcaxr.renderer

import dev.orcaxr.core.LocalTimestampResolver
import dev.orcaxr.core.ProjectArchiveFormat
import dev.orcaxr.core.ProjectDocumentInput
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectWorkspace
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The exploded assembly view ([SceneExplosion]) over a real session's scene,
 * against the browser's journey (`assembly-vectors.mjs`, its `explode`
 * steps): the journey's canonical 3MF opened, its alignments applied, and
 * the draws [SceneSync] delivers give the browser's explosion request — the
 * same instances in the same order at the same canonical translations — and
 * its offsets; each instance's draws then stand at its translation plus its
 * offset, while their placements stay the project's; at factor 1 nothing
 * moves.
 */
object ProjectSceneExplosionChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun units(text: String) = text.map { it.code }
    private fun numbers(text: String) = text.split(",").map(String::toDouble)

    /**
     * [script] holds the journey's commits and explosions, one per line: a move as
     * `M\t<instance>\t<translation>\t<rotation>\t<scale>\t<hash>` (numbers comma-separated,
     * as JavaScript writes them), an explosion as `X\t<factor>\t<request>\t<reply>\t<hash>`.
     */
    @JvmStatic fun run(script: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            workspace.ready().get(WAIT_S, TimeUnit.SECONDS)
            check(workspace.open(Memory(archive), "assembly.3mf").get(WAIT_S, TimeUnit.SECONDS) == ProjectArchiveFormat.CANONICAL, "opened")
            val updates = LinkedBlockingQueue<SceneSync.Update>()
            SceneSync(workspace) { updates.add(it) }.use { sync ->
                var moves = 0
                for ((index, line) in script.split("\n").withIndex()) {
                    val entry = line.split("\t")
                    when (entry[0]) {
                        // The journey's alignments, as the commits they made.
                        "M" -> {
                            workspace.execute(
                                ProjectIntents.Command.SetInstanceTransform(
                                    ProjectIntents.SetInstanceTransform(
                                        units(entry[1]),
                                        ProjectIntents.Transform(numbers(entry[2]), numbers(entry[3]), numbers(entry[4])),
                                        units("check:${++moves}"),
                                    ),
                                ),
                            ).get(WAIT_S, TimeUnit.SECONDS)
                            check(workspace.view.revision?.semanticHash == entry[5], "line_${index}_hash")
                        }
                        "X" -> {
                            sync.request()
                            var update = checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)) { "no scene update" }
                            // The latest scene: a sync queued before the last edit may arrive first.
                            while (true) update = updates.poll(2, TimeUnit.SECONDS) ?: break
                            val draws = update.draws
                            val factor = entry[1].toDouble()
                            val request = ProjectIntents.ExplosionRequest(SceneExplosion.parts(draws), factor)
                            // Values, not text: Kotlin writes a whole double as `60.0` where JavaScript writes `60`.
                            check(ProjectIntents.decodeExplosionRequest(entry[2]) == request, "line_${index}_request")
                            val offsets = SceneExplosion.offsets(draws, factor)
                            val browser = (ProjectIntents.decodeExplosionReply(entry[3]) as ProjectIntents.ExplosionReply.Exploded).value
                            check(workspace.view.revision?.semanticHash == entry[4], "line_${index}_unchanged")
                            if (factor == 1.0) {
                                check(offsets.isEmpty(), "line_${index}_assembled")
                                check(SceneExplosion.exploded(draws, offsets) === draws, "line_${index}_unmoved")
                                check(browser.all { offset -> offset.offsetMm.all { it == 0.0 } }, "line_${index}_browser_assembled")
                                continue
                            }
                            check(offsets.size == browser.size, "line_${index}_count")
                            for (offset in browser) {
                                val id = String(CharArray(offset.id.size) { offset.id[it].toChar() })
                                check(offsets[id] == Point3(offset.offsetMm[0], offset.offsetMm[1], offset.offsetMm[2]), "line_${index}_offset $id")
                            }
                            val exploded = SceneExplosion.exploded(draws, offsets)
                            for ((drawn, original) in exploded.zip(draws)) {
                                val offset = checkNotNull(offsets[drawn.instanceId])
                                val (x, y, z) = original.placement.instance.translationMm
                                val expected = ModelTransform.fromCanonical(original.placement.instance.copy(translationMm = listOf(x + offset.x, y + offset.y, z + offset.z))) *
                                    ModelTransform.fromCanonical(original.placement.volume)
                                check(drawn.transform.renderMatrix().contentEquals(expected.renderMatrix()), "line_${index}_drawn ${drawn.key}")
                                check(drawn.placement == original.placement, "line_${index}_placement ${drawn.key}")
                            }
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                }
            }
        }
        return checks
    }
}
