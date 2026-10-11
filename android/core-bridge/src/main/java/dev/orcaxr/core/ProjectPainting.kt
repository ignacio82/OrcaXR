package dev.orcaxr.core

import java.util.concurrent.CompletableFuture

/** How a finished paint stroke ended. */
enum class PaintStrokeOutcome {
    /** One undoable step that changed the paint. */
    APPLIED,
    /** A step that changed nothing (the facets were already so). */
    UNCHANGED,
    /** The stroke touched no facet: nothing was submitted. */
    NOTHING_TOUCHED,
    /** The project changed after the stroke opened: nothing changed. */
    STALE,
}

/** What Erase all painting did: the parts it erased, and how many of them had paint to erase. */
data class PaintEraseAll(val volumes: Int, val cleared: Int)

/**
 * The browser workspace's painter (`OrcaWorkspace`'s canonical painting over
 * `PaintStrokeService`) on a [ProjectWorkspace]'s session, through the shared
 * core: the painting palette, a gesture opened on the part the pointer met
 * ([open]), sampled off the session ([ProjectPaintStroke.sampleWith]) and
 * previewed ([ProjectPaintStroke.previewFacets]), then committed as exactly
 * one undoable step with the browser's history label ([commit]); Erase all
 * painting ([eraseAll]); and the paint facets a renderer draws ([facets]).
 */
class ProjectPainter(private val workspace: ProjectWorkspace) {
    private fun units(text: String) = text.map { it.code }

    /** The painting palette as the paint panel lists it (`getPaintPalette(true)`): disabled recipes included as unselectable rows. */
    fun palette(): CompletableFuture<ProjectIntents.PaintPalette> = workspace.inspect { session ->
        session.snapshot().use { it.paintPalette(ProjectIntents.PaintPaletteRequest(true)) }
    }

    /**
     * Opens a gesture on [volumeId]'s [channel] that paints [target] (null
     * erases to the unpainted state), against the state the session holds
     * now. A refusal fails with the core's code (`unsupported_role` for a part
     * that is not a model part, `unknown_filament`, `unavailable_filament`,
     * `invalid_target`, `unknown_volume`, `invalid_mesh`, `stale`). The stroke
     * is the caller's to close.
     */
    fun open(volumeId: String, channel: PaintChannel, target: ProjectIntents.PaintValueInput?): CompletableFuture<ProjectPaintStroke> =
        workspace.inspect { session ->
            session.captureGuard().use { guard ->
                session.paintStroke(
                    guard,
                    ProjectIntents.PaintStrokeOpen(
                        units(volumeId), channel.facet,
                        target?.let { ProjectIntents.FacetRegionState.Assigned(it) } ?: ProjectIntents.FacetRegionState.Unpainted(ProjectIntents.Empty),
                    ),
                )
            }
        }

    /**
     * Commits a gesture as one undoable step labelled as the browser labels it
     * ("Paint colour facets", "Erase support facets", "Paint refined colour
     * facets"): the touched facets as one `facetStroke`, or the refined tree.
     * A gesture that touched nothing submits nothing; one whose project
     * changed meanwhile changes nothing. Do not sample the stroke while it
     * commits; it stays the caller's to close.
     */
    fun commit(stroke: ProjectPaintStroke): CompletableFuture<PaintStrokeOutcome> = workspace.refreshed(
        workspace.outcome(workspace.actor.stage { session, _ -> session.stagePaintStroke(stroke) }).thenApply { result ->
            when (result) {
                is ProjectOutcome.Completed -> when (val reply = result.reply.result) {
                    is ProjectIntents.SessionResult.Acknowledged -> if (reply.value.changed) PaintStrokeOutcome.APPLIED else PaintStrokeOutcome.UNCHANGED
                    is ProjectIntents.SessionResult.ReceiptUnavailable -> PaintStrokeOutcome.APPLIED
                    is ProjectIntents.SessionResult.Error ->
                        if (reply.value == ProjectIntents.SessionError.Stale) PaintStrokeOutcome.STALE else throw workspace.failure(result, null)
                    else -> throw workspace.failure(result, null)
                }
                ProjectOutcome.NothingToDo -> PaintStrokeOutcome.NOTHING_TOUCHED
                is ProjectOutcome.NotStarted ->
                    if (result.reason == ProjectRefusal.STALE) PaintStrokeOutcome.STALE else throw workspace.failure(result, null)
                else -> throw workspace.failure(result, null)
            }
        },
    )

    /** The paint facets of [volumeId]'s [channel] in the state the session holds now; the capture is the caller's to close. */
    fun facets(volumeId: String, channel: PaintChannel): CompletableFuture<ProjectPaintFacets> = workspace.inspect { session ->
        session.paintFacets(ProjectIntents.PaintOverlayRequest(units(volumeId), channel.facet))
    }

    /**
     * The paint facets of each of [volumeIds]' [channel], read together from
     * the state the session holds now: a capture (the caller's to close) or
     * the core's refusal (a part gone meanwhile is `unknown_volume`).
     */
    fun facets(volumeIds: List<String>, channel: PaintChannel): CompletableFuture<List<Result<ProjectPaintFacets>>> = workspace.inspect { session ->
        volumeIds.map { volumeId -> runCatching { session.paintFacets(ProjectIntents.PaintOverlayRequest(units(volumeId), channel.facet)) } }
    }

    /** One model part: its ID and the topology a reset's facet guard names. */
    private class Part(val id: String, val topologyRevision: Long, val triangleCount: Long)

    /** Object [objectId]'s model parts, in its order. */
    private fun parts(root: ProjectQueryNode, objectId: String): List<Part> {
        val node = ProjectFacts.objectNode(root, objectId) ?: return emptyList()
        return node.use { item ->
            item.children(QueryRelation.VOLUMES, 0).use { list ->
                buildList {
                    ProjectFacts.rows(list) { at, row ->
                        if (row.values[QueryNumber.ROLE] == MODEL_ROLE) list.node(at).use { volume ->
                            add(
                                Part(
                                    checkNotNull(ProjectFacts.text(volume, QueryText.ID)) { "invalid_projection" },
                                    (row.values[QueryNumber.TOPOLOGY_REVISION] ?: 0.0).toLong(),
                                    (row.values[QueryNumber.TRIANGLE_COUNT] ?: 0.0).toLong(),
                                ),
                            )
                        }
                        true
                    }
                }
            }
        }
    }

    /**
     * The model parts the selection paints on the active plate, in the
     * plate's order (instances, then their object's parts, each part once):
     * the selected parts, the parts of selected objects and of selected
     * instances' objects, or every model part on the plate when no part,
     * object or instance is selected — the browser's
     * `paintableSelectedVolumes`, which took every part on the plate while an
     * instance was selected and tried to erase helper volumes, which cannot be
     * painted (both fixed there too). The rule is
     * [ProjectFacts.selectedModelParts], which Simplify takes as well.
     */
    private fun paintable(session: ProjectSession, snapshot: ProjectSnapshot): List<String> =
        snapshot.query().use { root -> ProjectFacts.selectedModelParts(root, workspace.whole(session).refs).map { it.id } }

    /**
     * Erase all painting (`paint_erase_all`) of [channel] on the model parts
     * the selection paints ([paintable], read once as the browser reads them
     * before its loop): each part reset as its own undoable step ("Erase all
     * colour facets") under the state it meets. Answers how many parts there
     * were and how many had paint to erase, or null when the selection paints
     * nothing.
     */
    fun eraseAll(channel: PaintChannel): CompletableFuture<PaintEraseAll?> =
        workspace.inspect { session -> session.snapshot().use { snapshot -> paintable(session, snapshot) } }
            .thenCompose { volumes ->
                if (volumes.isEmpty()) return@thenCompose CompletableFuture.completedFuture(null)
                var chain: CompletableFuture<Int> = CompletableFuture.completedFuture(0)
                for (volumeId in volumes) chain = chain.thenCompose { cleared -> erase(volumeId, channel).thenApply { cleared + if (it) 1 else 0 } }
                workspace.refreshed(chain.thenApply { cleared -> PaintEraseAll(volumes.size, cleared) })
            }

    /** One part's reset under the state it meets now; answers whether it changed anything (a part gone meanwhile changes nothing). */
    private fun erase(volumeId: String, channel: PaintChannel): CompletableFuture<Boolean> = workspace.inspect { session ->
        session.snapshot().use { snapshot ->
            val part = snapshot.query().use { root -> anyPart(root, volumeId) }
            part?.let {
                ProjectIntents.GuardedIntent(
                    workspace.guardOf(session, snapshot),
                    ProjectIntents.Intent(
                        ProjectIntents.VERSION,
                        ProjectIntents.Command.FacetStroke(
                            ProjectIntents.FacetStroke(
                                ProjectIntents.FacetGuard(snapshot.revision(), units(snapshot.hash()), units(volumeId), it.topologyRevision, it.triangleCount),
                                channel.facet, ProjectIntents.FacetStrokeOperationInput.Reset(ProjectIntents.Empty),
                                ProjectIntents.OptionalText.Value(units("Erase all ${channel.label} facets")),
                            ),
                        ),
                    ),
                )
            }
        }
    }.thenCompose { intent ->
        if (intent == null) CompletableFuture.completedFuture(false)
        else workspace.submitted(ProjectIntents.SessionOperation.Execute(intent)).thenApply { receipt -> receipt?.changed ?: true }
    }

    /** Model part [volumeId] wherever it is in the project, or null. */
    private fun anyPart(root: ProjectQueryNode, volumeId: String): Part? =
        ProjectFacts.instances(root).map { it.objectId }.distinct().firstNotNullOfOrNull { objectId -> parts(root, objectId).firstOrNull { it.id == volumeId } }

    private companion object {
        /** `VolumeRole::Model`'s index in the query projection. */
        const val MODEL_ROLE = 0.0
    }
}
