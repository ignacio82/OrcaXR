package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.mcp.AiPaintSession
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI paint sessions (C9 milestone 4) — control surface for the
 * headless paint pipeline. See [AiPaintSessionStore] for why this
 * exists.
 *
 * Tools:
 *  - `begin_paint_session(model_id)` — create a session that owns a
 *    private copy of the model's paint state. Returns a session_id.
 *  - `commit_paint_session(session_id)` — atomically replace the
 *    live model's paint with the session's. ONE PaintHistory step,
 *    one paintContentVersion bump, one GLB rebake, one entity swap.
 *  - `discard_paint_session(session_id)` — drop without committing.
 *  - `list_paint_sessions()` — diagnostic / picker.
 *  - `get_paint_session_diff(session_id)` — coverage histogram +
 *    fingerprint comparison.
 *
 * Existing paint and render tools accept an optional `session_id`
 * argument. When present, paint primitives mutate the session in
 * place (no [WorkspaceAction] emitted, no scene rebake) and renders
 * read paint from the session, not the live model.
 */
internal object PaintSessionTools {

    fun all(ws: WorkspaceModel): List<Tool> = listOf(
        BeginPaintSession(ws),
        CommitPaintSession(ws),
        DiscardPaintSession(),
        ListPaintSessions(ws),
        GetPaintSessionDiff(ws),
    )

    private val store: AiPaintSessionStore get() = AiPaintSessionStore.get()

    // ---- begin ----

    class BeginPaintSession(private val ws: WorkspaceModel) : Tool {
        override val name = "begin_paint_session"
        override val description =
            "Open a headless paint session over a model. The session owns a private copy of the " +
                "model's color/support/seam/fuzzy paint arrays, so subsequent paint and render calls " +
                "that pass the returned session_id mutate THAT scratch copy without triggering the " +
                "live model's GLB rebake / scene-entity swap. Use this for LLM-driven iterative " +
                "painting where 30+ small refinements would otherwise interrupt the user's XR view " +
                "30 times. Commit the session with commit_paint_session (one undo step, one rebake) " +
                "or drop it with discard_paint_session. Triangle ids are stable for the session's " +
                "lifetime — DO NOT call repair_model / cut_model / mesh_boolean / split_model / " +
                "emboss_model / simplify_model / add_volume / remove_volume between begin and " +
                "commit; if you must, discard the session first."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id (from list_placed_models)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) {
                return ToolResult.error("OrcaXR's main window isn't currently attached.")
            }
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val model = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            // Tri count comes from the BVH (the source-of-truth for paint
            // primitives) — that's the same space the paint arrays live
            // in (centered_preview frame; see GEMINI.md gotcha #11d).
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error(
                    "Couldn't build a paint BVH for '$modelId'. Make sure the model has loaded.",
                )
            val session = AiPaintSessionStore.get().begin(
                modelId = modelId,
                triCount = bvh.triCount,
                basePaintFilamentIndex = model.paintFilamentIndex,
                baseSupportFlags = model.supportFlags,
                baseSeamFlags = model.seamFlags,
                baseFuzzySkinFlags = model.fuzzySkinFlags,
            )
            val geom = AiIntrospection.geometry(bvh, bins = 1)
            val body = JSONObject().apply {
                put("ok", true)
                put("session_id", session.id)
                put("model_id", modelId)
                put("tri_count", session.triCount)
                put("base_fingerprint", session.baseFingerprint)
                put("created_at_ms", session.createdAtMs)
                val bbox = JSONObject().apply {
                    put("x_min", geom.bboxCenteredPreview.minX.toDouble())
                    put("y_min", geom.bboxCenteredPreview.minY.toDouble())
                    put("z_min", geom.bboxCenteredPreview.minZ.toDouble())
                    put("x_max", geom.bboxCenteredPreview.maxX.toDouble())
                    put("y_max", geom.bboxCenteredPreview.maxY.toDouble())
                    put("z_max", geom.bboxCenteredPreview.maxZ.toDouble())
                }
                put("bbox_centered_preview", bbox)
                put("max_concurrent_sessions", AiPaintSessionStore.MAX_SESSIONS)
            }
            val text = "Began paint session ${session.id} on model $modelId " +
                "(${session.triCount} triangles, base fingerprint ${session.baseFingerprint})"
            return ToolResult.ok(text, body)
        }
    }

    // ---- commit ----

    class CommitPaintSession(private val ws: WorkspaceModel) : Tool {
        override val name = "commit_paint_session"
        override val description =
            "Atomically replace the live model's paint with the session's accumulated state. " +
                "Emits one WorkspaceAction.LoadPaintState which fires exactly one applyPaintMutation " +
                "call: one PaintHistory entry (one undo step undoes the whole session), one " +
                "paintContentVersion bump, one colored-GLB rebake, one GltfModelEntity swap. " +
                "Refuses if the live model's tri count has changed since session begin (a mesh-" +
                "mutating action invalidated the session's triangle indices). M7: also refuses " +
                "if any add_paint_constraint invariant is violated by the session's paint state — " +
                "the response includes per-constraint `violations` so the LLM can issue a " +
                "corrective paint (e.g. paint with merge='only_unpainted' on the violators) " +
                "without losing the rest of the session. Pass force=true to commit anyway; the " +
                "response then surfaces `forced_violations` for audit. After a successful commit " +
                "the session is discarded. discard_on_failure controls whether tri-count drift " +
                "or constraint violation also discards the session (default true; set false to " +
                "keep the session intact for inspection / retry)."
        override val inputSchema = Schemas.obj(
            required = listOf("session_id"),
            properties = mapOf(
                "session_id" to Schemas.string("Id from begin_paint_session"),
                "discard_on_failure" to Schemas.bool(
                    "Drop the session even when commit validation fails (default true). " +
                        "Set false to keep the session for inspection / retry.",
                ),
                "force" to Schemas.bool(
                    "M7: commit even when add_paint_constraint invariants are violated. The " +
                        "response records the violations under `forced_violations` so the LLM " +
                        "can audit. Default false.",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) {
                return ToolResult.error("OrcaXR's main window isn't currently attached.")
            }
            val id = args.optString("session_id").trim()
            if (id.isEmpty()) return ToolResult.error("'session_id' is required.")
            val store = AiPaintSessionStore.get()
            val session = store.get(id)
                ?: return ToolResult.error(
                    "Unknown session_id '$id'. It may have been evicted (LRU cap is " +
                        "${AiPaintSessionStore.MAX_SESSIONS}) or already discarded. Call " +
                        "list_paint_sessions to see what's open.",
                )
            val discardOnFailure = args.optBoolean("discard_on_failure", true)

            val model = ws.placedModels.value.firstOrNull { it.id == session.modelId }
            if (model == null) {
                if (discardOnFailure) store.discard(id)
                return ToolResult.error(
                    "Live model '${session.modelId}' is gone (deleted between begin and commit). " +
                        "Session ${if (discardOnFailure) "discarded" else "kept"}.",
                )
            }
            val liveTriCount = ws.getBvh(session.modelId)?.triCount
                ?: model.paintFilamentIndex?.size
                ?: model.supportFlags?.size
                ?: model.seamFlags?.size
                ?: model.fuzzySkinFlags?.size
                ?: -1
            if (liveTriCount > 0 && liveTriCount != session.triCount) {
                if (discardOnFailure) store.discard(id)
                return ToolResult.error(
                    "Triangle count changed since session begin " +
                        "(${session.triCount} → $liveTriCount). A mesh-mutating action ran " +
                        "(repair / cut / boolean / split / emboss / simplify / volume edit) and " +
                        "invalidated this session's triangle indices. Session " +
                        "${if (discardOnFailure) "discarded" else "kept"}.",
                )
            }

            // M7 — validate attached constraints before doing anything
            // observable. Runs before the no-op check so a session
            // with constraints + zero paint actions still flags
            // `must_be_painted` violations the LLM forgot to fulfill.
            val force = args.optBoolean("force", false)
            val violations = session.validateAttachedConstraints()
            if (violations.isNotEmpty() && !force) {
                if (discardOnFailure) store.discard(id)
                val arr = JSONArray()
                for (v in violations) {
                    arr.put(JSONObject().apply {
                        put("constraint_id", v.constraintId)
                        put("kind", v.kindName)
                        put("description", v.description)
                        put("violating_triangle_count", v.violatingTriangles.size)
                        // Cap the sample so the response stays small
                        // (≥256 indices ≈ 1 KB; full set could blow
                        // the body cap on a Pikachu-class mesh).
                        val sampleCap = 256
                        val sampleArr = JSONArray()
                        val n = minOf(sampleCap, v.violatingTriangles.size)
                        for (i in 0 until n) sampleArr.put(v.violatingTriangles[i])
                        put("violating_triangle_sample", sampleArr)
                        put("sample_truncated", v.violatingTriangles.size > sampleCap)
                    })
                }
                val body = JSONObject().apply {
                    put("ok", false)
                    put("session_id", id)
                    put("model_id", session.modelId)
                    put("rejected", true)
                    put("violation_count", violations.size)
                    put("violations", arr)
                    put("session_kept", !discardOnFailure)
                    put("hint",
                        "Commit rejected: ${violations.size} constraint(s) violated. " +
                            "Apply a corrective paint over the violating triangles " +
                            "(e.g. paint_triangle_list with merge='only_tagged') OR call " +
                            "clear_paint_constraints / pass force=true if the constraint is " +
                            "no longer relevant. The live model is unchanged.",
                    )
                }
                val firstK = violations.first().kindName
                val firstN = violations.first().violatingTriangles.size
                return ToolResult.error(
                    "commit_paint_session $id rejected: ${violations.size} constraint(s) violated " +
                        "(first: $firstK, $firstN tri(s)). Live model untouched; session " +
                        if (discardOnFailure) "discarded." else "kept.",
                    body,
                )
            }

            // No-op short-circuit: commit a session that didn't paint
            // anything is a successful no-op, not an error — but we
            // surface it so the LLM's planning loop notices it didn't
            // apply any work.
            val sessionFp = session.currentFingerprint()
            val noop = sessionFp == session.baseFingerprint && session.totalActions == 0

            val emitId = if (noop) -1L else ws.emit(
                WorkspaceAction.LoadPaintState(
                    modelId = session.modelId,
                    paintFilamentIndex = session.paintFilamentIndex,
                    supportFlags = session.supportFlags,
                    seamFlags = session.seamFlags,
                    fuzzySkinFlags = session.fuzzySkinFlags,
                ),
            )

            // Always discard on success — the session's job is done.
            store.discard(id)

            val body = JSONObject().apply {
                put("ok", true)
                put("session_id", id)
                put("model_id", session.modelId)
                put("noop", noop)
                put("base_fingerprint", session.baseFingerprint)
                put("committed_fingerprint", sessionFp)
                put("total_actions", session.totalActions)
                put("total_triangles_painted", session.totalTrianglesPainted)
                if (emitId > 0) put("emit_id", emitId)
                if (violations.isNotEmpty()) {
                    // Forced commit: surface what we waved through.
                    val arr = JSONArray()
                    for (v in violations) {
                        arr.put(JSONObject().apply {
                            put("constraint_id", v.constraintId)
                            put("kind", v.kindName)
                            put("description", v.description)
                            put("violating_triangle_count", v.violatingTriangles.size)
                        })
                    }
                    put("forced_violations", arr)
                    put("forced", true)
                }
                put("hint", if (noop)
                    "Session had no mutations — nothing was committed."
                else
                    "Live paint replaced. Call flush_actions(emit_id=$emitId) if you want to " +
                        "wait for the GLB rebake to finish before rendering the live path again.",
                )
            }
            val text = if (noop)
                "commit_paint_session $id: no-op (session unchanged from begin)"
            else if (violations.isNotEmpty())
                "commit_paint_session $id: FORCED commit despite ${violations.size} violation(s); " +
                    "applied ${session.totalActions} action(s) (emit_id=$emitId)"
            else
                "commit_paint_session $id: applied ${session.totalActions} action(s) covering " +
                    "${session.totalTrianglesPainted} triangle paints to ${session.modelId} " +
                    "(emit_id=$emitId)"
            return ToolResult.ok(text, body)
        }
    }

    // ---- discard ----

    class DiscardPaintSession : Tool {
        override val name = "discard_paint_session"
        override val description =
            "Drop a paint session without committing. The live model's paint state is untouched " +
                "(no scene rebake). Use this when the LLM's iteration went wrong and the session's " +
                "scratch state should be thrown away."
        override val inputSchema = Schemas.obj(
            required = listOf("session_id"),
            properties = mapOf("session_id" to Schemas.string("Id from begin_paint_session")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("session_id").trim()
            if (id.isEmpty()) return ToolResult.error("'session_id' is required.")
            val ok = AiPaintSessionStore.get().discard(id)
            val body = JSONObject().apply {
                put("ok", ok)
                put("session_id", id)
                put("removed", ok)
            }
            return if (ok) {
                ToolResult.ok("Discarded session $id", body)
            } else {
                ToolResult.error("No session with id '$id' (already discarded or evicted)", body)
            }
        }
    }

    // ---- list ----

    class ListPaintSessions(@Suppress("unused") private val ws: WorkspaceModel) : Tool {
        override val name = "list_paint_sessions"
        override val description =
            "Return every open paint session with model id, tri count, action count, and the " +
                "base/current paint fingerprints. Useful when an LLM resumes after a long pause " +
                "and wants to know which session ids are still valid (LRU cap is " +
                "${AiPaintSessionStore.MAX_SESSIONS} so an older session may have been evicted)."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val sessions = AiPaintSessionStore.get().all()
            val arr = JSONArray()
            for (s in sessions) {
                arr.put(JSONObject().apply {
                    put("session_id", s.id)
                    put("model_id", s.modelId)
                    put("tri_count", s.triCount)
                    put("total_actions", s.totalActions)
                    put("total_triangles_painted", s.totalTrianglesPainted)
                    put("base_fingerprint", s.baseFingerprint)
                    put("current_fingerprint", s.currentFingerprint())
                    put("created_at_ms", s.createdAtMs)
                    put("last_touched_at_ms", s.lastTouchedAtMs)
                    put("version", s.version)
                })
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("count", sessions.size)
                put("max_sessions", AiPaintSessionStore.MAX_SESSIONS)
                put("sessions", arr)
            }
            val text = "${sessions.size} open session(s)" +
                if (sessions.isEmpty()) "" else
                    ": " + sessions.joinToString(", ") { "${it.id}(${it.modelId}, ${it.totalActions} actions)" }
            return ToolResult.ok(text, body)
        }
    }

    // ---- diff ----

    class GetPaintSessionDiff(private val ws: WorkspaceModel) : Tool {
        override val name = "get_paint_session_diff"
        override val description =
            "Return per-kind tag histograms for a paint session — i.e. how many triangles each " +
                "tag covers in the session's CURRENT state, broken down by kind " +
                "(color/support/seam/fuzzy). Pair with the live model's get_paint_summary to see " +
                "which tris would change on commit. Also returns base_fingerprint (paint at begin) " +
                "vs current_fingerprint (paint now) so the caller can confirm whether anything " +
                "actually moved."
        override val inputSchema = Schemas.obj(
            required = listOf("session_id"),
            properties = mapOf("session_id" to Schemas.string("Id from begin_paint_session")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("session_id").trim()
            if (id.isEmpty()) return ToolResult.error("'session_id' is required.")
            val session = AiPaintSessionStore.get().get(id)
                ?: return ToolResult.error("Unknown session '$id'.")
            val diff = session.diffSummary()
            val coverage = JSONObject()
            for (kind in WorkspaceAction.PaintKind.values()) {
                val hist = diff[kind]
                if (hist == null) {
                    coverage.put(kind.name.lowercase(), JSONObject().apply {
                        put("present", false)
                    })
                    continue
                }
                val tagsObj = JSONObject()
                var nonzero = 0
                for ((tag, count) in hist.withIndex()) {
                    if (count > 0) {
                        tagsObj.put(tag.toString(), count)
                        if (tag != 0) nonzero += count
                    }
                }
                coverage.put(kind.name.lowercase(), JSONObject().apply {
                    put("present", true)
                    put("painted_triangles", nonzero)
                    put("tag_histogram", tagsObj)
                })
            }
            val currentFp = session.currentFingerprint()
            val body = JSONObject().apply {
                put("ok", true)
                put("session_id", id)
                put("model_id", session.modelId)
                put("tri_count", session.triCount)
                put("base_fingerprint", session.baseFingerprint)
                put("current_fingerprint", currentFp)
                put("changed", currentFp != session.baseFingerprint)
                put("total_actions", session.totalActions)
                put("total_triangles_painted", session.totalTrianglesPainted)
                put("coverage_by_kind", coverage)
            }
            // Dynamic placement of the live-model context: if the model
            // is still on the bed we add bbox / palette so the LLM can
            // reason without a follow-up call.
            ws.placedModels.value.firstOrNull { it.id == session.modelId }?.let { _ ->
                ws.getBvh(session.modelId)?.let { bvh ->
                    val geom = AiIntrospection.geometry(bvh, bins = 1)
                    body.put("bbox_centered_preview", JSONObject().apply {
                        put("x_min", geom.bboxCenteredPreview.minX.toDouble())
                        put("y_min", geom.bboxCenteredPreview.minY.toDouble())
                        put("z_min", geom.bboxCenteredPreview.minZ.toDouble())
                        put("x_max", geom.bboxCenteredPreview.maxX.toDouble())
                        put("y_max", geom.bboxCenteredPreview.maxY.toDouble())
                        put("z_max", geom.bboxCenteredPreview.maxZ.toDouble())
                    })
                }
            }
            val text = "session $id: ${session.totalActions} action(s); " +
                if (currentFp != session.baseFingerprint) "PAINT CHANGED" else "unchanged"
            return ToolResult.ok(text, body)
        }
    }

    /**
     * Helper used by the session-aware paint primitives. Resolves an
     * optional `session_id` argument:
     *  - empty / missing → null (live-path semantics)
     *  - present + valid + matches modelId → the session
     *  - present + invalid / mismatched → error string
     */
    sealed interface SessionResolution {
        data object NotRequested : SessionResolution
        data class Found(val session: AiPaintSession) : SessionResolution
        data class Error(val message: String) : SessionResolution
    }

    fun resolveSession(args: JSONObject, modelId: String): SessionResolution {
        val raw = args.optString("session_id").trim()
        if (raw.isEmpty()) return SessionResolution.NotRequested
        val s = AiPaintSessionStore.get().get(raw)
            ?: return SessionResolution.Error(
                "Unknown session_id '$raw' (evicted or never opened). Call begin_paint_session " +
                    "first or omit session_id to mutate the live model directly.",
            )
        if (s.modelId != modelId) {
            return SessionResolution.Error(
                "session_id '$raw' targets model '${s.modelId}' but you passed model_id='$modelId'.",
            )
        }
        return SessionResolution.Found(s)
    }
}
