package dev.orcaxr.app.mcp

/**
 * AI paint pillar — Milestone 7. Declarative invariants the LLM
 * attaches to a [AiPaintSession] so [AiPaintSessionStore] can reject
 * a [commit_paint_session] whose paint state would violate them. This
 * is the highest-frequency LLM correctness lever — without it the
 * loop is "paint, render, eyeball the bleed, paint_undo, retry."
 *
 * A constraint targets a specific triangle index set (typically the
 * triangles of a region the LLM wants to protect, or wants to
 * guarantee gets painted). At commit time the engine walks each
 * constraint against the session's current `paintFilamentIndex` and
 * collects [ConstraintViolation]s. Any violation rejects the commit.
 *
 * Constraints are color-only — they look at `paintFilamentIndex`,
 * not support / seam / fuzzy. The MCP frontier for those kinds is
 * tiny; if real demand surfaces we extend.
 */
sealed interface AiPaintConstraint {
    /** Stable id; the LLM can target a specific constraint with
     *  [clear_paint_constraints]. UUID-style hex. */
    val id: String

    /** Triangle indices the rule covers. Sorted ascending, deduped. */
    val triangleIndices: IntArray

    /** Optional human-readable label the LLM supplied. Surfaced in
     *  violation messages so the LLM can match a violation back to
     *  its plan. */
    val description: String

    /** Human-friendly name of the constraint kind, used in error
     *  messages. */
    val kindName: String

    /**
     * The triangles must end at tag 0 (unpainted). The default for
     * "leave the cabin walls alone."
     */
    data class MustRemainUnpainted(
        override val id: String,
        override val triangleIndices: IntArray,
        override val description: String,
    ) : AiPaintConstraint {
        override val kindName: String get() = "must_remain_unpainted"
    }

    /**
     * The triangles must end at any non-zero tag. For "the hull MUST
     * be painted, I don't care which slot."
     */
    data class MustBePainted(
        override val id: String,
        override val triangleIndices: IntArray,
        override val description: String,
    ) : AiPaintConstraint {
        override val kindName: String get() = "must_be_painted"
    }

    /**
     * The triangles must end at this specific tag. For "the cabin
     * roof MUST be slot 3 (red)."
     */
    data class MustBeTag(
        override val id: String,
        override val triangleIndices: IntArray,
        val tag: Int,
        override val description: String,
    ) : AiPaintConstraint {
        override val kindName: String get() = "must_be_tag"
    }

    /**
     * The triangles must NOT end at this tag. For "the deck MUST NOT
     * be slot 5 (black)."
     */
    data class MustNotBeTag(
        override val id: String,
        override val triangleIndices: IntArray,
        val tag: Int,
        override val description: String,
    ) : AiPaintConstraint {
        override val kindName: String get() = "must_not_be_tag"
    }
}

/**
 * Outcome of validating one constraint against the session's paint
 * arrays. The violating triangles are reported in full so a paint
 * tool can chain a corrective action against them; the response
 * preview caps the array size to keep responses small.
 */
data class ConstraintViolation(
    val constraintId: String,
    val kindName: String,
    val description: String,
    /** Sorted ascending. */
    val violatingTriangles: IntArray,
)

/**
 * Walks every constraint against [paintFilamentIndex] (size = triCount)
 * and returns the violations. Empty list means the session is OK to
 * commit.
 */
internal fun validateConstraints(
    paintFilamentIndex: ByteArray?,
    triCount: Int,
    constraints: List<AiPaintConstraint>,
): List<ConstraintViolation> {
    if (constraints.isEmpty()) return emptyList()
    val arr = paintFilamentIndex
    fun tagAt(tri: Int): Int {
        if (tri < 0 || tri >= triCount) return -1   // out-of-range never violates
        if (arr == null) return 0                   // no paint of this kind ⇒ all unpainted
        return arr[tri].toInt() and 0xff
    }
    val out = ArrayList<ConstraintViolation>()
    for (c in constraints) {
        val violators = ArrayList<Int>()
        for (tri in c.triangleIndices) {
            val t = tagAt(tri)
            val violates = when (c) {
                is AiPaintConstraint.MustRemainUnpainted -> t != 0
                is AiPaintConstraint.MustBePainted -> t == 0
                is AiPaintConstraint.MustBeTag -> t != c.tag
                is AiPaintConstraint.MustNotBeTag -> t == c.tag
            }
            if (violates) violators.add(tri)
        }
        if (violators.isNotEmpty()) {
            out.add(
                ConstraintViolation(
                    constraintId = c.id,
                    kindName = c.kindName,
                    description = c.description,
                    violatingTriangles = violators.toIntArray(),
                ),
            )
        }
    }
    return out
}
