package dev.orcaxr.core

/**
 * The alignments the browser's assembly flow offers (`AssemblyAlignmentKind`),
 * with their wire kinds and the name its "Applied …" status writes.
 */
enum class AssemblyKind(val wire: ProjectIntents.AssemblyAlignmentKind, val browser: String) {
    PARALLEL(ProjectIntents.AssemblyAlignmentKind.Parallel, "parallel"),
    CENTER_COINCIDENCE(ProjectIntents.AssemblyAlignmentKind.CenterCoincidence, "center-coincidence"),
    PARALLEL_DISTANCE(ProjectIntents.AssemblyAlignmentKind.ParallelDistance, "parallel-distance"),
    REVERSE_ROTATION(ProjectIntents.AssemblyAlignmentKind.ReverseRotation, "reverse-rotation"),
    AROUND_FACE_CENTER(ProjectIntents.AssemblyAlignmentKind.AroundFaceCenter, "around-face-center"),
    ;

    companion object {
        fun of(browser: String): AssemblyKind = entries.first { it.browser == browser }
    }
}

/** What the Measure panel's Align section says to do (`assemblySnapshot`'s hint). */
enum class AssemblyHint { PICK, CHOOSE, DIFFERENT_MODELS }

/**
 * The Align section's view of the Measure tool's picks (the browser's
 * `assemblySnapshot`): what the pair allows — none before two picks, or for
 * a pair the core cannot read — whether the second pick's model can move,
 * and the hint.
 */
data class AssemblyView(val available: ProjectIntents.AssemblyAvailability?, val movable: Boolean, val hint: AssemblyHint)

/** Why an alignment was not attempted, in the workspace's words: too few picks, both on one model, or the model to move gone. */
enum class AssemblyPairing { TWO_PICKS, DIFFERENT_MODELS, GONE }

/** What one alignment did (`planAssemblyStep` and its commit). */
sealed interface AssemblyAligned {
    data class Refused(val reason: AssemblyPairing) : AssemblyAligned
    /** The faces already agree: nothing moved and nothing was recorded. */
    data object Aligned : AssemblyAligned
    /** The second pick's instance moved to [transform] as one undoable step. */
    data class Moved(val instanceId: String, val transform: ProjectIntents.Transform) : AssemblyAligned
    /** The pinned plan refused the pair or the parameter, in the core's words. */
    data class Failed(val message: String) : AssemblyAligned
}

/**
 * The browser's assembly flow over the Measure tool's picks
 * (`web/src/workspace/AssemblyAlignment.ts`), on the shared core's pinned
 * alignments ([ProjectAssembly]): the panel's view of the pair, the plan of
 * one alignment for the second pick's instance and the statuses the browser
 * composes from templates its message catalogue does not carry.
 */
object ProjectAssemblies {
    /** The Align section's view of [picks] (the first two count). */
    fun view(picks: List<MeasurePick>): AssemblyView {
        if (picks.size < 2) return AssemblyView(null, false, AssemblyHint.PICK)
        val (first, second) = picks
        val available = (ProjectAssembly.availability(ProjectIntents.AssemblyPair(first.feature, second.feature)) as? ProjectIntents.AssemblyAvailabilityReply.Available)?.value
        val movable = second.instanceId != first.instanceId
        return AssemblyView(available, movable, if (movable) AssemblyHint.CHOOSE else AssemblyHint.DIFFERENT_MODELS)
    }

    /** Why [picks] cannot be aligned before anything is read, or null: two picks, the second on another model. */
    fun refusal(picks: List<MeasurePick>): AssemblyPairing? = when {
        picks.size < 2 -> AssemblyPairing.TWO_PICKS
        picks[1].instanceId == picks[0].instanceId -> AssemblyPairing.DIFFERENT_MODELS
        else -> null
    }

    /**
     * The core's plan of [kind] (with its [parameter]: a gap in millimetres,
     * a turn in degrees) moving [second]'s instance from [current] so its
     * feature meets [first]'s: the move, nothing when the faces already
     * agree, or the plan's refusal.
     */
    fun plan(first: MeasurePick, second: MeasurePick, kind: AssemblyKind, parameter: Double?, current: ProjectIntents.Transform): AssemblyAligned {
        val request = ProjectIntents.AssemblyAlignmentRequest(
            kind.wire, first.feature, second.feature, current,
            parameter?.let { ProjectIntents.OptionalFinite.Value(it) } ?: ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty),
            ProjectIntents.OptionalAssemblyFeature.Absent(ProjectIntents.Empty),
        )
        return when (val reply = ProjectAssembly.alignment(request)) {
            is ProjectIntents.AssemblyAlignmentReply.Planned ->
                if (reply.value.noop) AssemblyAligned.Aligned else AssemblyAligned.Moved(second.instanceId, reply.value.transform)
            is ProjectIntents.AssemblyAlignmentReply.Refused -> AssemblyAligned.Failed(text(reply.value.message))
        }
    }

    /** The status of a committed alignment. */
    fun applied(kind: AssemblyKind) = "Applied ${kind.browser.replace('-', ' ')}. Undo restores the previous placement."

    /** The status of an alignment the plan refused. */
    fun failed(message: String) = "Alignment failed: $message"

    /** The upstream assemble view's explosion range (its slider's): 1, assembled, to 3. */
    const val MAX_EXPLOSION = 3.0

    /** Whether the workspace takes explosion factor [factor] (`setExplosionFactor`): a finite number of at least 1. */
    fun explosionAllowed(factor: Double): Boolean = factor.isFinite() && factor >= 1

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
}
