package dev.orcaxr.renderer

import dev.orcaxr.core.LocalTimestampResolver
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintHit
import dev.orcaxr.core.PaintStrokeOutcome
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.core.PaintToolSettings
import dev.orcaxr.core.PrimitiveShape
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectPainter
import dev.orcaxr.core.ProjectWorkspace
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The Workspace's paint as a renderer gets it from a real session through
 * [SceneSync]: a cube given a filament draws in its tint; a stroke's preview
 * changes only the facets it touches, at the browser's 55% over what is
 * shown; the committed stroke shows those facets in the filament's colour
 * under each facet's shade (vertex alpha 0) and no others; undo returns them
 * to the mesh's own shades; the support channel shows support paint alone
 * while it is the channel drawn; a renderer made afresh gets every painted
 * facet. */
object ProjectScenePaintChecks {
    private const val WAIT_S = 60L

    @JvmStatic fun run(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun units(text: String) = text.map { it.code }
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            workspace.ready().get(WAIT_S, TimeUnit.SECONDS)
            val painter = ProjectPainter(workspace)
            val updates = LinkedBlockingQueue<SceneSync.Update>()
            SceneSync(workspace) { updates.add(it) }.use { sync ->
                fun next(): SceneSync.Update {
                    sync.request()
                    return checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)) { "no scene update" }
                }
                val cube = workspace.addPrimitive(PrimitiveShape.CUBE).get(WAIT_S, TimeUnit.SECONDS)!!
                workspace.execute(
                    ProjectIntents.Command.SyncPhysicalFilaments(
                        ProjectIntents.SyncPhysicalFilaments(
                            listOf(ProjectIntents.PrinterSlot(0, units("#3366cc"), units("PLA"), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty))),
                            ProjectIntents.OptionalIds.Value(listOf(units("de8102d0-aadb-4963-b472-d7613233db91"))),
                        ),
                    ),
                ).get(WAIT_S, TimeUnit.SECONDS)
                val drawn = next()
                val draw = drawn.draws.single()
                val mesh = drawn.meshes.getValue(draw.assetId)
                check(draw.instanceId == cube.instanceId && drawn.paint.isEmpty(), "unpainted_cube_no_paint")
                // The cube's object takes the filament: its draws tint in its colour, nothing repainted.
                workspace.execute(
                    ProjectIntents.Command.SetObjectFilament(
                        ProjectIntents.SetObjectFilament(units(cube.objectId), ProjectIntents.OptionalId.Value(units("de8102d0-aadb-4963-b472-d7613233db91"))),
                    ),
                ).get(WAIT_S, TimeUnit.SECONDS)
                val tinted = next()
                check(tinted.draws.single().argb == 0xff3366cc.toInt() && tinted.paint.isEmpty(), "object_filament_tints")

                // A stroke on facet 0 and its preview: those facets alone change, at 55% over the tinted shade.
                val stroke = painter.open(draw.volumeId, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(units("de8102d0-aadb-4963-b472-d7613233db91"))).get(WAIT_S, TimeUnit.SECONDS)
                val centre = (0 until 3).map { corner -> mesh.vertex(0, corner) }.let { p -> listOf((p[0].x + p[1].x + p[2].x) / 3, (p[0].y + p[1].y + p[2].y) / 3, (p[0].z + p[1].z + p[2].z) / 3) }
                stroke.sampleWith(PaintHit(0, centre, listOf(centre[0] * 5, centre[1] * 5, centre[2] * 5)), PaintToolSettings(PaintToolKind.TRIANGLE))
                val previewData = stroke.previewFacets().use(PaintFacetData::read)
                sync.preview(draw.volumeId, previewData)
                val previewed = checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)).paint.single()
                val expected = ScenePaint.preview(0x3366cc, ScenePaint.lit(mesh.facetColor(0), 0xff3366cc.toInt()))
                check(previewed.ranges.single().first == 0 && previewed.ranges.single().colors.toList() == listOf(expected), "preview_facet_zero ${previewed.ranges.map { it.first to it.colors.size }}")
                check(stroke.let { painter.commit(it).get(WAIT_S, TimeUnit.SECONDS) } == PaintStrokeOutcome.APPLIED, "stroke_applied")
                stroke.close()
                sync.preview(draw.volumeId, null)
                checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS))
                val painted = next().paint.single()
                check(painted.ranges.single().first == 0 && painted.ranges.single().colors.toList() == listOf(ScenePaint.own(mesh.facetColor(0), 0x3366cc)), "painted_facet_own_colour")
                check(ScenePaint.own(mesh.facetColor(0), 0x3366cc) ushr 24 == 0, "own_colour_alpha_zero")

                // Undo: the facet returns to the mesh's own shade.
                workspace.undo().get(WAIT_S, TimeUnit.SECONDS)
                val undone = next().paint.single()
                check(undone.ranges.single().colors.toList() == listOf(mesh.facetColor(0)), "undo_restores_shade")
                workspace.redo().get(WAIT_S, TimeUnit.SECONDS)
                check(next().paint.single().ranges.single().colors.toList() == listOf(ScenePaint.own(mesh.facetColor(0), 0x3366cc)), "redo_paints")

                // Support paint on facet 2 shows only while support is the channel drawn.
                val support = painter.open(draw.volumeId, PaintChannel.SUPPORT, ProjectIntents.PaintValueInput.Text(units("block"))).get(WAIT_S, TimeUnit.SECONDS)
                val other = (0 until 3).map { corner -> mesh.vertex(2, corner) }.let { p -> listOf((p[0].x + p[1].x + p[2].x) / 3, (p[0].y + p[1].y + p[2].y) / 3, (p[0].z + p[1].z + p[2].z) / 3) }
                support.sampleWith(PaintHit(2, other, listOf(other[0] * 5, other[1] * 5, other[2] * 5)), PaintToolSettings(PaintToolKind.TRIANGLE))
                check(painter.commit(support).get(WAIT_S, TimeUnit.SECONDS) == PaintStrokeOutcome.APPLIED, "support_applied")
                support.close()
                check(next().paint.isEmpty(), "support_hidden_under_colour")
                sync.channel = PaintChannel.SUPPORT
                val shown = checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)).paint.single()
                val changed = shown.ranges.flatMap { range -> range.colors.indices.map { range.first + it to range.colors[it] } }.filter { (facet, color) -> color != mesh.facetColor(facet) }
                check(changed == listOf(2 to ScenePaint.own(mesh.facetColor(2), 0xf85149)), "support_channel_shown $changed")
                // A renderer made afresh gets every painted facet.
                val everything = LinkedBlockingQueue<SceneSync.Update>()
                sync.snapshot { everything.add(it) }
                val full = checkNotNull(everything.poll(WAIT_S, TimeUnit.SECONDS))
                check(full.paint.single().ranges.single().let { it.first == 2 && it.colors.toList() == listOf(ScenePaint.own(mesh.facetColor(2), 0xf85149)) }, "snapshot_paint")
                sync.channel = PaintChannel.COLOR
                val back = checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)).paint.single()
                val colours = back.ranges.flatMap { range -> range.colors.indices.map { range.first + it to range.colors[it] } }.filter { (facet, color) -> color != mesh.facetColor(facet) }
                check(colours == listOf(0 to ScenePaint.own(mesh.facetColor(0), 0x3366cc)), "colour_channel_back")
            }
        }
        return checks
    }
}
