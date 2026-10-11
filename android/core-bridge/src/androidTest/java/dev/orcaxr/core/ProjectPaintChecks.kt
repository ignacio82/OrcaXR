package dev.orcaxr.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** The browser's painter on a real [ProjectWorkspace] ([ProjectPainter]): a
 * cube given two filaments paints where a ray meets it — the palette with its
 * keyboard numbers, a stroke opened on the part, sampled with the workspace's
 * Circle brush, previewed in the filament's colour, committed as one
 * "Paint colour facets" that undo and redo take back and restore — erases,
 * paints support in its fixed colour, refuses a helper volume, an unknown
 * filament and a band without a plate Z in the painter's words, commits
 * nothing for an untouched stroke and nothing for a stale one, and erases all
 * painting of the selected instance's object or, with nothing selected, of
 * every model part (never the helper volume); the core enables the paint
 * tools and palette rows. */
object ProjectPaintChecks {
    private const val WAIT_S = 60L
    private const val RED = "#ff0000"
    private const val BLUE = "#0000ff"

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun <T> attempt(future: CompletableFuture<T>): Result<T> = try {
        Result.success(future.get(WAIT_S, TimeUnit.SECONDS))
    } catch (thrown: ExecutionException) {
        Result.failure(thrown.cause ?: thrown)
    }
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "view never settled: ${workspace.view.actions.keys}" }
            Thread.sleep(10)
        }
        return workspace.view
    }

    /** The model parts and helper volumes of object [objectId], in order, with their roles. */
    private fun parts(workspace: ProjectWorkspace, objectId: String): List<Pair<String, Double>> = done(workspace.inspect { session ->
        session.snapshot().use { snapshot ->
            snapshot.query().use { root ->
                ProjectFacts.objectNode(root, objectId)!!.use { node ->
                    node.children(QueryRelation.VOLUMES, 0).use { list ->
                        buildList {
                            ProjectFacts.rows(list) { at, row ->
                                list.node(at).use { add(ProjectFacts.text(it, QueryText.ID)!! to row.values.getValue(QueryNumber.ROLE)) }
                                true
                            }
                        }
                    }
                }
            }
        }
    })

    /** Where a ray from far along +X through ([y], [z]) meets the active plate, as a host's pointer meets it. */
    private fun hit(workspace: ProjectWorkspace, x: Double, y: Double, z: Double): ProjectIntents.PickHit = done(workspace.inspect { session ->
        val plate = session.snapshot().use { snapshot -> snapshot.query().use { root -> ProjectFacts.plates(root).single { it.active }.id } }
        session.pickScene(ProjectIntents.PickSceneRequest(units(plate), false)).use { scene ->
            (scene.pick(ProjectIntents.PickRay(listOf(x + 400.0, y, z), listOf(-1.0, 0.0, 0.0))) as ProjectIntents.PickReply.Hit).value
        }
    })

    private fun paintHit(hit: ProjectIntents.PickHit, previous: List<Double>? = null) =
        PaintHit(hit.triangle, hit.localPoint, hit.localOrigin, previous)

    private val unmoved = ProjectIntents.Transform(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))
    private fun scaledBy(vararg scale: Double) =
        PaintPlacement(ProjectIntents.Transform(listOf(5.0, 6.0, 7.0), listOf(0.0, 0.0, 0.0, 1.0), scale.toList()), unmoved)

    /** [facets]' summary and its whole facets, closing it. */
    private fun read(facets: ProjectPaintFacets): Pair<PaintFacetsSummary, Set<Int>> = facets.use {
        val summary = it.summary()
        val runs = PaintFacetPackets.runs(it.runs(0, ProjectPaintFacets.MAX_PAGE))
        summary to (runs.indices step 3).flatMap { at -> (runs[at] until runs[at] + runs[at + 1]) }.toSet()
    }

    @JvmStatic fun run(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            val painter = ProjectPainter(workspace)
            // No filament yet: the palette is its inheriting row alone.
            check(done(painter.palette()).entries.map { it.kind } == listOf(ProjectIntents.PaintPaletteKind.Default), "palette_default_alone")

            val cube = done(workspace.addPrimitive(PrimitiveShape.CUBE))!!
            val volume = parts(workspace, cube.objectId).single().first
            done(
                workspace.execute(
                    ProjectIntents.Command.SyncPhysicalFilaments(
                        ProjectIntents.SyncPhysicalFilaments(
                            listOf(
                                ProjectIntents.PrinterSlot(0, units("#FF0000"), units("PLA"), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)),
                                ProjectIntents.PrinterSlot(1, units("#0000ff"), units("PETG"), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)),
                            ),
                            ProjectIntents.OptionalIds.Value(listOf(units("0c792039-0d6d-4a46-93e8-2bbf4ca9af1e"), units("1089f201-ff94-437e-a01f-1aa18f170be0"))),
                        ),
                    ),
                ),
            )
            val palette = done(painter.palette()).entries
            check(palette.size == 3 && palette.drop(1).map { text(it.displayColor) } == listOf(RED, BLUE), "palette_physical ${palette.map { text(it.displayColor) }}")
            check(palette.drop(1).map { (it.keyboardNumber as? ProjectIntents.OptionalCounter.Value)?.value } == listOf(1L, 2L), "palette_keys")
            val blue = (palette[2].filamentId as ProjectIntents.OptionalText.Value).value
            check(text(blue) == "1089f201-ff94-437e-a01f-1aa18f170be0", "palette_ids")
            // The core enables the palette's rows and Erase all; every paint tool wants a selected instance.
            done(workspace.deselectAll())
            val view = until(workspace) { it.selection.total == 0L && it.actions["tool_paint"]?.enabled == false }
            check(view.actions.getValue("tool_paint").reason == "Select a model instance for this action.", "paint_needs_instance")
            check(view.actions.getValue("paint_select_filament_2").enabled && view.actions.getValue("paint_erase_all").enabled, "palette_rows_enabled")
            done(workspace.selectInstance(cube.instanceId))
            val selected0 = until(workspace) { it.actions["tool_paint"]?.enabled == true }
            check(PaintChannel.entries.all { selected0.actions.getValue(it.toolAction).enabled }, "paint_tools_enabled")
            done(workspace.deselectAll())

            // A Circle stroke where the ray meets the cube's +X face: a preview in blue, then one step.
            val first = hit(workspace, 100.0, 100.0, 10.0)
            check(text(first.volumeId) == volume, "hit_the_cube")
            val stroke = done(painter.open(volume, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(blue)))
            val sampled = stroke.sampleWith(paintHit(first), PaintToolSettings.WORKSPACE) as PaintStrokeStep.Sampled
            val selected = (sampled.reply as ProjectIntents.PaintStrokeSampleReply.Sampled).value
            check(selected.selectedTriangles > 0 && !selected.refined, "circle_selects ${selected.selectedTriangles}")
            check((sampled.sample.tool as ProjectIntents.FacetRegionTool.Circle).value.radiusMm == 4.0, "workspace_radius")
            val (preview, previewed) = read(stroke.previewFacets())
            check(preview.colors == listOf(BLUE) && previewed.size.toLong() == selected.strokeTriangles && preview.leaves == 0L, "preview_in_blue")
            // A dragged second sample sweeps on from the first.
            val second = hit(workspace, 100.0, 104.0, 6.0)
            check(stroke.sampleWith(paintHit(second, first.localPoint), PaintToolSettings.WORKSPACE) is PaintStrokeStep.Sampled, "drag_sample")
            check(done(painter.commit(stroke)) == PaintStrokeOutcome.APPLIED, "stroke_applied")
            stroke.close()
            check(workspace.view.undo == "Paint colour facets", "stroke_label ${workspace.view.undo}")
            val (canonical, painted) = read(done(painter.facets(volume, PaintChannel.COLOR)))
            check(canonical.colors == listOf(BLUE) && painted.containsAll(previewed) && canonical.facets == painted.size.toLong(), "canonical_blue")
            done(workspace.undo())
            check(read(done(painter.facets(volume, PaintChannel.COLOR))).second.isEmpty() && workspace.view.redo == "Paint colour facets", "undo_unpaints")
            done(workspace.redo())
            check(read(done(painter.facets(volume, PaintChannel.COLOR))).second == painted, "redo_repaints")

            // The default row erases: one "Erase colour facets" step.
            val eraser = done(painter.open(volume, PaintChannel.COLOR, null))
            val erasing = eraser.sampleWith(paintHit(first), PaintToolSettings.WORKSPACE.copy(tool = PaintToolKind.FILL)) as PaintStrokeStep.Sampled
            check(read(eraser.previewFacets()).first.colors == listOf("#ffffff"), "erase_previews_white")
            check(done(painter.commit(eraser)) == PaintStrokeOutcome.APPLIED && workspace.view.undo == "Erase colour facets", "erase_stroke")
            eraser.close()
            check((erasing.reply as ProjectIntents.PaintStrokeSampleReply.Sampled).value.selectedTriangles > 0, "fill_selects")
            check(read(done(painter.facets(volume, PaintChannel.COLOR))).second.size < painted.size, "erased_some")

            // Support paint draws in its fixed colour.
            val support = done(painter.open(volume, PaintChannel.SUPPORT, ProjectIntents.PaintValueInput.Text(units("enforce"))))
            check(support.sampleWith(paintHit(first), PaintToolSettings(PaintToolKind.TRIANGLE)) is PaintStrokeStep.Sampled, "support_sample")
            check(done(painter.commit(support)) == PaintStrokeOutcome.APPLIED && workspace.view.undo == "Paint support facets", "support_label")
            support.close()
            val (supportFacets, supported) = read(done(painter.facets(volume, PaintChannel.SUPPORT)))
            check(supportFacets.colors == listOf("#39d353") && supported == setOf(first.triangle.toInt()), "support_colour")

            // The painter's refusals, in its words, and a part that cannot be painted.
            val refusing = done(painter.open(volume, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(blue)))
            val flat = refusing.sampleWith(paintHit(first).copy(placement = scaledBy(1.0, 0.0, 1.0)), PaintToolSettings(PaintToolKind.HEIGHT_RANGE))
            check(flat == PaintStrokeStep.Refused("invalid_hit", "The paint placement must be finite and invertible"), "flat_placement")
            check(done(painter.commit(refusing)) == PaintStrokeOutcome.NOTHING_TOUCHED, "untouched_commits_nothing")
            refusing.close()

            // The brush measures the bed: on a 200% placement a 4 mm sphere takes what the part's own 2 mm
            // takes, and 2 mm takes less; a stretched placement selects on the bed; the band starts at the
            // hit's bed Z.
            fun sampled(hit: PaintHit, settings: PaintToolSettings): PaintStrokeStep.Sampled {
                val placed = done(painter.open(volume, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(blue)))
                try { return placed.sampleWith(hit, settings) as PaintStrokeStep.Sampled } finally { placed.close() }
            }
            fun leaves(step: PaintStrokeStep.Sampled) = (step.reply as ProjectIntents.PaintStrokeSampleReply.Sampled).value.selectedLeaves
            val sphere = PaintToolSettings(PaintToolKind.SPHERE, radiusMm = 4.0, triangleSplitting = true)
            val doubled = sampled(paintHit(first).copy(placement = scaledBy(2.0, 2.0, 2.0)), sphere)
            val own = sampled(paintHit(first), sphere.copy(radiusMm = 2.0))
            check(doubled.reply == own.reply && leaves(own) > 0, "placed_brush_in_bed_mm ${doubled.reply}")
            val transform = (doubled.sample.transform as ProjectIntents.OptionalFacetSelectionTransform.Value).value
            check(transform.scalingFactors.all { kotlin.math.abs(it - 2.0) < 1e-12 } && transform.translation == listOf(5.0, 6.0, 7.0), "placed_transform")
            check(leaves(sampled(paintHit(first).copy(placement = scaledBy(2.0, 2.0, 2.0)), sphere.copy(radiusMm = 2.0))) < leaves(doubled), "placed_smaller_brush")
            val stretched = sampled(paintHit(first).copy(placement = scaledBy(2.0, 1.0, 0.5)), sphere)
            check((stretched.sample.transform as ProjectIntents.OptionalFacetSelectionTransform.Value).value.scalingFactors == listOf(2.0, 1.0, 0.5), "stretched_transform")
            val band = sampled(paintHit(first).copy(placement = scaledBy(2.0, 2.0, 2.0)), PaintToolSettings(PaintToolKind.HEIGHT_RANGE))
            val bedZ = (2.0 * first.localPoint[2].toFloat().toDouble() + 7.0).toFloat().toDouble()
            check((band.sample.tool as ProjectIntents.FacetRegionTool.HeightRange).value.startZMm == bedZ, "band_from_bed_z")
            check(attempt(painter.open(volume, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(units("filament:gone")))).exceptionOrNull()?.message == "unknown_filament", "unknown_filament")
            done(workspace.selectInstance(cube.instanceId))
            val modifier = done(workspace.addHelperVolume(HelperVolumeRole.MODIFIER))!!
            check(attempt(painter.open(modifier.volumeId, PaintChannel.COLOR, null)).exceptionOrNull()?.message == "unsupported_role", "helper_refused")
            check(parts(workspace, cube.objectId).map { it.second } == listOf(0.0, 1.0), "cube_and_modifier")

            // A stroke whose project changed meanwhile changes nothing.
            val late = done(painter.open(volume, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(blue)))
            check(late.sampleWith(paintHit(first), PaintToolSettings.WORKSPACE) is PaintStrokeStep.Sampled, "late_sample")
            done(workspace.renameObject(cube.objectId, "Painted cube"))
            val before = workspace.view.undo
            check(done(painter.commit(late)) == PaintStrokeOutcome.STALE && workspace.view.undo == before, "stale_commits_nothing")
            late.close()

            // Erase all: the selected instance's object only; then every model part, never the modifier.
            val other = done(workspace.addPrimitive(PrimitiveShape.CUBE))!!
            val otherVolume = parts(workspace, other.objectId).single().first
            for (target in listOf(volume, otherVolume)) {
                val brush = done(painter.open(target, PaintChannel.COLOR, ProjectIntents.PaintValueInput.Text(blue)))
                brush.sampleWith(PaintHit(0, listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 100.0)), PaintToolSettings(PaintToolKind.TRIANGLE))
                check(done(painter.commit(brush)) == PaintStrokeOutcome.APPLIED, "painted_$target")
                brush.close()
            }
            done(workspace.selectInstance(other.instanceId))
            check(done(painter.eraseAll(PaintChannel.COLOR)) == PaintEraseAll(1, 1) && workspace.view.undo == "Erase all colour facets", "erase_all_selected")
            check(read(done(painter.facets(otherVolume, PaintChannel.COLOR))).second.isEmpty() && read(done(painter.facets(volume, PaintChannel.COLOR))).second.isNotEmpty(), "erase_all_scoped")
            done(workspace.deselectAll())
            check(done(painter.eraseAll(PaintChannel.COLOR)) == PaintEraseAll(2, 1), "erase_all_plate")
            check(read(done(painter.facets(volume, PaintChannel.COLOR))).second.isEmpty(), "erase_all_cleared")
            val settled = workspace.view.undo
            check(done(painter.eraseAll(PaintChannel.COLOR)) == PaintEraseAll(2, 0) && workspace.view.undo == settled, "erase_all_nothing_left")
            // Support paint stays: Erase all erases the channel asked.
            check(read(done(painter.facets(volume, PaintChannel.SUPPORT))).second.isNotEmpty(), "erase_all_keeps_support")
            done(workspace.deleteAll())
            check(done(painter.eraseAll(PaintChannel.COLOR)) == null, "erase_all_empty_plate")
        }
        return checks
    }
}
