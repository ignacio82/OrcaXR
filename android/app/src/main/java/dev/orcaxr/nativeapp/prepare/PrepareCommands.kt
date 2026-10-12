package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.nativeapp.send.SendGuard
import dev.orcaxr.nativeapp.send.SendWords

/**
 * Slice, Slice All Plates, Cancel Slice and Send to Printer as the Prepare
 * area's buttons enable them, for the command palette and the plate's menus.
 * The browser's palette asks its own slicing controller for these (its
 * `UiState`'s `isSlicing`, `preflightBlocked` and `gcodeReady`), not a
 * capability host that cannot know them; here that controller is the
 * Prepare area: the route a slice takes, the active plate, its preflight,
 * the job, the core's gate given those facts ([PrepareState.actions]), and
 * for Send the published slice ([SendGuard]) and the Device area's printer.
 * Platform-free, so the rules are checked on the JVM; the Prepare area's own
 * buttons use them too, so the two cannot disagree.
 */
object PrepareCommands {
    const val SLICE = "slice_active_plate"
    const val SLICE_ALL = "slice_all_plates"
    const val CANCEL = "slice_cancel"
    const val SEND = "send_to_printer"

    /** The four, in the catalogue's order. */
    val IDS = listOf(SLICE, SLICE_ALL, CANCEL, SEND)

    /** The browser's `not-slicing` prerequisite, in its words. */
    const val WAIT = "Wait for the current slice to finish or cancel it."

    /** The browser's `preflight-clear` prerequisite, in its words. */
    const val RESOLVE = "Resolve blocking preflight errors first."

    /** The browser's words for an action its state does not enable (Cancel Slice with nothing to cancel). */
    const val NOT_NOW = "Not available in the current workspace state."

    /** What the four are judged by, read from the Prepare and Device areas' state. */
    data class Facts(
        /** The route a slice takes now ([sliceRoute]). */
        val route: SliceRouteKind,
        /** Why there is none: this device's engine's reason ([dev.orcaxr.nativeapp.engine.LocalEngineState.reason]). */
        val routeReason: String? = null,
        /** The active plate's model count; null without an active plate. */
        val plateObjects: Int? = null,
        val job: SliceJob? = null,
        /** Whether the active plate's preflight blocks a slice. */
        val blocked: Boolean = false,
        /** Slice, Slice All Plates and Cancel Slice as the core enables them given these facts (empty until read). */
        val core: Map<String, ProjectActionState> = emptyMap(),
        /** Whether the published slice is still the active plate's, of the project as it stands ([SendGuard]). */
        val sendable: Boolean = false,
        /** Whether the Device area is connected to a printer. */
        val connected: Boolean = false,
        /** Whether a send runs. */
        val sending: Boolean = false,
    ) {
        companion object {
            /** The facts of [state] for the project's [activePlateId], [plateObjects] and [revision], and the Device area's. */
            fun of(
                state: PrepareState,
                activePlateId: String?,
                plateObjects: Int?,
                revision: ProjectRevision?,
                connected: Boolean,
                sending: Boolean,
            ): Facts {
                val result = state.result
                return Facts(
                    route = sliceRoute(state.connection, state.local),
                    routeReason = state.local.reason,
                    plateObjects = plateObjects,
                    job = state.job,
                    blocked = state.preflight?.takeIf { it.plateId == activePlateId }?.canSlice == false,
                    core = state.actions,
                    sendable = result != null && SendGuard.current(result, result, activePlateId, revision),
                    connected = connected,
                    sending = sending,
                )
            }
        }
    }

    /** Prepare's Slice: a route, a plate holding models, no slice running, no blocking preflight, and the core's gate. */
    fun canSlice(facts: Facts): Boolean = facts.route != SliceRouteKind.None && (facts.plateObjects ?: 0) > 0 &&
        facts.job == null && !facts.blocked && facts.core[SLICE]?.enabled != false

    /** Prepare's Slice All Plates: a route, no slice running, and the core's gate (which judges every plate). */
    fun canSliceAll(facts: Facts): Boolean =
        facts.route != SliceRouteKind.None && facts.job == null && facts.core[SLICE_ALL]?.enabled == true

    /** Prepare's Cancel Slice: a slice running and not yet being cancelled. */
    fun canCancel(facts: Facts): Boolean = facts.job != null && !facts.job.cancelling

    /** Prepare's Send to Printer: the current slice, a connected printer, no send running. */
    fun canSend(facts: Facts): Boolean = facts.sendable && facts.connected && !facts.sending

    /**
     * [action] enabled as Prepare's button for it is — with why not, in the
     * browser's words where it has them — or unchanged when it is none of
     * the four.
     */
    fun state(action: ProjectActionState, facts: Facts): ProjectActionState {
        if (action.id !in IDS) return action
        val enabled = enabled(action.id, facts)
        return action.copy(enabled = enabled, reason = if (enabled) null else reason(action.id, facts))
    }

    /** Whether Prepare's button for [id] (one of [IDS]) is enabled now. */
    fun enabled(id: String, facts: Facts): Boolean = when (id) {
        SLICE -> canSlice(facts)
        SLICE_ALL -> canSliceAll(facts)
        CANCEL -> canCancel(facts)
        SEND -> canSend(facts)
        else -> throw IllegalArgumentException("$id is not one of the Prepare area's actions")
    }

    /** Why Prepare's button for [id] (one of [IDS]) is not enabled now, when it is not and the reason is known. */
    fun reason(id: String, facts: Facts): String? {
        val core = facts.core[id]?.takeIf { !it.enabled }?.reason
        return when (id) {
            SLICE, SLICE_ALL -> when {
                facts.route == SliceRouteKind.None -> facts.routeReason ?: core
                id == SLICE && (facts.plateObjects ?: 0) == 0 -> PrepareWords.NO_MODELS
                facts.job != null -> WAIT
                id == SLICE && facts.blocked -> RESOLVE
                else -> core
            }
            CANCEL -> core ?: NOT_NOW
            else -> when {
                !facts.sendable -> SendWords.SLICE_FIRST
                facts.sending -> SendWords.BUSY
                else -> SendWords.CONNECT_FIRST
            }
        }
    }
}
