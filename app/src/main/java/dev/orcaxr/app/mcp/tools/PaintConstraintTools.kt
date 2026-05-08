package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.AiPaintConstraint
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * AI paint pillar — Milestone 7: declarative constraints on a paint
 * session. Three small MCP tools:
 *
 *  - `add_paint_constraint(session_id, kind, triangle_ids, [tag], [description])`
 *  - `list_paint_constraints(session_id)`
 *  - `clear_paint_constraints(session_id, [constraint_id])`
 *
 * Constraints are validated by `commit_paint_session`. See
 * [PaintSessionTools.CommitPaintSession] for the rejection semantics
 * and the `force=true` override.
 */
internal object PaintConstraintTools {

    fun all(@Suppress("unused") ws: WorkspaceModel): List<Tool> = listOf(
        AddPaintConstraint(),
        ListPaintConstraints(),
        ClearPaintConstraints(),
    )

    private val store: AiPaintSessionStore get() = AiPaintSessionStore.get()

    // ---- add ----

    class AddPaintConstraint : Tool {
        override val name = "add_paint_constraint"
        override val description =
            "Attach a declarative invariant to an open paint session. The invariant is checked at " +
                "commit_paint_session — if the session's paint state would violate it, commit is " +
                "rejected and the live model is left untouched. Kinds: " +
                "'must_remain_unpainted' (triangles must end at tag 0), " +
                "'must_be_painted' (any non-zero tag), " +
                "'must_be_tag' (require [tag] exactly), " +
                "'must_not_be_tag' (forbid [tag]). " +
                "Triangle ids in centered_preview triangle index space (the same space every other " +
                "spatial paint tool returns). The constraint persists for the session's lifetime; " +
                "drop it with clear_paint_constraints or override at commit with force=true."
        override val inputSchema = Schemas.obj(
            required = listOf("session_id", "kind", "triangle_ids"),
            properties = mapOf(
                "session_id" to Schemas.string("Id from begin_paint_session"),
                "kind" to Schemas.string(
                    "'must_remain_unpainted' | 'must_be_painted' | 'must_be_tag' | 'must_not_be_tag'",
                ),
                "triangle_ids" to JSONObject().apply {
                    put("type", "array")
                    put("description", "Triangles the constraint covers (0..total_triangle_count-1)")
                    put("items", Schemas.integer(""))
                },
                "tag" to Schemas.integer("Required for must_be_tag / must_not_be_tag (0..32)"),
                "description" to Schemas.string("Free-text label surfaced in violation reports"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val sessionId = args.optString("session_id").trim()
            if (sessionId.isEmpty()) return ToolResult.error("'session_id' is required")
            val session = store.get(sessionId)
                ?: return ToolResult.error(
                    "Unknown session_id '$sessionId'. The session may have been evicted (LRU cap " +
                        "is ${AiPaintSessionStore.MAX_SESSIONS}) or already discarded.",
                )
            val kindRaw = args.optString("kind", "").lowercase()
            val ids = args.optJSONArray("triangle_ids")
                ?: return ToolResult.error("'triangle_ids' array is required")
            if (ids.length() == 0) return ToolResult.error("'triangle_ids' must be non-empty")
            // Dedupe + range-check + sort. Drop out-of-range silently
            // (matches paint_triangle_list semantics) but surface a count.
            val seen = HashSet<Int>(ids.length())
            var dropped = 0
            for (i in 0 until ids.length()) {
                val v = ids.optInt(i, -1)
                if (v < 0 || v >= session.triCount) dropped++ else seen.add(v)
            }
            if (seen.isEmpty()) {
                return ToolResult.error(
                    "Every supplied triangle id was out of range (triCount=${session.triCount}). " +
                        "Re-fetch with get_model_geometry.",
                )
            }
            val triArr = seen.toIntArray().also { java.util.Arrays.sort(it) }
            val description = args.optString("description", "").trim()
            val constraintId = newId()
            val constraint: AiPaintConstraint = when (kindRaw) {
                "must_remain_unpainted" -> AiPaintConstraint.MustRemainUnpainted(constraintId, triArr, description)
                "must_be_painted" -> AiPaintConstraint.MustBePainted(constraintId, triArr, description)
                "must_be_tag", "must_not_be_tag" -> {
                    val tagAny = args.opt("tag")
                    val tag = when (tagAny) {
                        is Number -> tagAny.toInt()
                        else -> return ToolResult.error("'tag' (integer) is required for kind='$kindRaw'")
                    }
                    if (tag !in 0..32) {
                        return ToolResult.error("'tag' must be 0..32; got $tag")
                    }
                    if (kindRaw == "must_be_tag") {
                        AiPaintConstraint.MustBeTag(constraintId, triArr, tag, description)
                    } else {
                        AiPaintConstraint.MustNotBeTag(constraintId, triArr, tag, description)
                    }
                }
                else -> return ToolResult.error(
                    "Unknown kind '$kindRaw'. Use must_remain_unpainted | must_be_painted | " +
                        "must_be_tag | must_not_be_tag.",
                )
            }
            session.addConstraint(constraint)
            val body = JSONObject().apply {
                put("ok", true)
                put("session_id", sessionId)
                put("constraint_id", constraintId)
                put("kind", constraint.kindName)
                put("triangle_count", triArr.size)
                if (dropped > 0) put("dropped_out_of_range", dropped)
                put("total_constraints", session.listConstraints().size)
            }
            return ToolResult.ok(
                "Added constraint $constraintId (${constraint.kindName}, ${triArr.size} tri(s)) " +
                    "to session $sessionId",
                body,
            )
        }

        private fun newId(): String =
            UUID.randomUUID().toString().replace("-", "").substring(0, 12)
    }

    // ---- list ----

    class ListPaintConstraints : Tool {
        override val name = "list_paint_constraints"
        override val description =
            "Return every constraint attached to a paint session. Useful when an LLM resumes a " +
                "long-running session and wants to confirm what invariants are still in effect."
        override val inputSchema = Schemas.obj(
            required = listOf("session_id"),
            properties = mapOf("session_id" to Schemas.string("Id from begin_paint_session")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("session_id").trim()
            if (id.isEmpty()) return ToolResult.error("'session_id' is required")
            val session = store.get(id)
                ?: return ToolResult.error("Unknown session_id '$id'.")
            val arr = JSONArray()
            for (c in session.listConstraints()) {
                arr.put(JSONObject().apply {
                    put("constraint_id", c.id)
                    put("kind", c.kindName)
                    put("triangle_count", c.triangleIndices.size)
                    put("description", c.description)
                    if (c is AiPaintConstraint.MustBeTag) put("tag", c.tag)
                    if (c is AiPaintConstraint.MustNotBeTag) put("tag", c.tag)
                })
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("session_id", id)
                put("count", arr.length())
                put("constraints", arr)
            }
            return ToolResult.ok(
                "session $id: ${arr.length()} constraint(s)",
                body,
            )
        }
    }

    // ---- clear ----

    class ClearPaintConstraints : Tool {
        override val name = "clear_paint_constraints"
        override val description =
            "Drop one constraint by id, or every constraint on the session if constraint_id is " +
                "omitted. Useful before retrying a commit when an invariant turned out to be " +
                "wrong (e.g. \"the cabin walls must remain unpainted\" — but actually the LLM " +
                "decides to paint them after seeing the render)."
        override val inputSchema = Schemas.obj(
            required = listOf("session_id"),
            properties = mapOf(
                "session_id" to Schemas.string("Id from begin_paint_session"),
                "constraint_id" to Schemas.string("Specific constraint id from list_paint_constraints. Omit to clear all."),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("session_id").trim()
            if (id.isEmpty()) return ToolResult.error("'session_id' is required")
            val session = store.get(id)
                ?: return ToolResult.error("Unknown session_id '$id'.")
            val constraintId = args.optString("constraint_id", "").trim()
            return if (constraintId.isEmpty()) {
                val before = session.listConstraints().size
                session.clearConstraints()
                val body = JSONObject().apply {
                    put("ok", true)
                    put("session_id", id)
                    put("removed", before)
                    put("remaining", 0)
                }
                ToolResult.ok("Cleared $before constraint(s) on session $id", body)
            } else {
                val removed = session.removeConstraint(constraintId)
                val body = JSONObject().apply {
                    put("ok", removed)
                    put("session_id", id)
                    put("constraint_id", constraintId)
                    put("removed", if (removed) 1 else 0)
                    put("remaining", session.listConstraints().size)
                }
                if (removed) {
                    ToolResult.ok("Removed constraint $constraintId from session $id", body)
                } else {
                    ToolResult.error(
                        "No constraint with id '$constraintId' on session $id.",
                        body,
                    )
                }
            }
        }
    }
}
