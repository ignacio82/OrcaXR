package dev.orcaxr.app.voice

/**
 * Roadmap C8 — translate a spoken utterance into a structured
 * [VoiceIntent] that maps onto an existing MCP tool surface.
 *
 * Pure Kotlin, regex-based. Each [matchers] entry is a (regex,
 * builder) pair where the regex's named capture groups feed straight
 * into the builder. Order matters — earlier patterns win on ambiguous
 * utterances. The order below is hand-tuned: more-specific phrases
 * before more-generic ones (e.g. "cancel slice" before "cancel"
 * alone, which would otherwise match "cancel selection").
 *
 * The mapper deliberately stops short of LLM-style intent inference.
 * On-device Android `SpeechRecognizer` produces clean, lower-cased
 * dictation; a small set of canonical phrasings covers the high-
 * frequency commands without the latency, cost, or unpredictability
 * of an LLM round-trip. For ambiguous / novel phrasings, the panel
 * falls back to dispatching the utterance to the in-app LLM
 * assistant (the Devices → AI assistant path) which already owns the
 * full MCP tool surface.
 *
 * **Destructive intents** (delete, cancel slice, clear paint) carry
 * `requiresConfirmation = true` so the panel can render a Confirm
 * button instead of auto-firing. Slice / save / set-mode / etc. are
 * non-destructive and auto-fire on first match.
 */
object VoiceIntentMapper {

    /** Map an utterance into a [VoiceIntent] (or null if no match). */
    fun map(utterance: String): VoiceIntent? {
        val text = utterance.trim().lowercase()
        if (text.isEmpty()) return null
        for ((re, build) in matchers) {
            val m = re.matchEntire(text)
            if (m != null) return build(m)
        }
        return null
    }

    /** Pre-compiled (regex, builder) table. Add new commands here. */
    private val matchers: List<Pair<Regex, (MatchResult) -> VoiceIntent?>> = buildList {
        // --- Slicing -------------------------------------------------------
        add(rx("(?:please )?(?:start )?(?:slice|slice it)(?: (?:the |this )?(?:active |current )?plate)?(?: now)?\\.?") to { _ ->
            VoiceIntent.SliceActivePlate
        })
        add(rx("(?:save (?:the )?(?:g[\\- ]?code|gcode))(?: to (?:the )?downloads)?\\.?") to { _ ->
            VoiceIntent.SaveGcode
        })
        add(rx("save (?:the )?(?:project )?(?:as )?(?:3mf|three[\\- ]?m\\-?f)\\.?") to { _ ->
            VoiceIntent.SaveProjectAs3mf
        })
        add(rx("save (?:the )?(?:model )?(?:as )?(?:s\\-?t\\-?l|stl)\\.?") to { _ ->
            VoiceIntent.SaveModelAsStl
        })
        add(rx("(?:cancel|stop) (?:the )?slice\\.?") to { _ ->
            VoiceIntent.CancelSlice(requiresConfirmation = true)
        })

        // --- Workspace / view ---------------------------------------------
        add(rx("(?:switch to |go to |open )?prepare(?: mode)?\\.?") to { _ ->
            VoiceIntent.SetWorkspaceMode("prepare")
        })
        add(rx("(?:switch to |go to |open )?preview(?: mode)?\\.?") to { _ ->
            VoiceIntent.SetWorkspaceMode("preview")
        })
        add(rx("(?:switch to |go to |open )?(?:devices|printers)(?: mode)?\\.?") to { _ ->
            VoiceIntent.SetWorkspaceMode("devices")
        })
        add(rx("show travels\\.?") to { _ ->
            VoiceIntent.SetPreference("show_travels", true)
        })
        add(rx("hide travels\\.?") to { _ ->
            VoiceIntent.SetPreference("show_travels", false)
        })
        add(rx("(?:enable |turn on |use )(?:tube|tubes)\\.?") to { _ ->
            VoiceIntent.SetPreference("toolpath_tubes", true)
        })
        add(rx("(?:disable |turn off )(?:tube|tubes)\\.?") to { _ ->
            VoiceIntent.SetPreference("toolpath_tubes", false)
        })

        // --- Plate management ---------------------------------------------
        add(rx("(?:switch to |go to |open )?plate (?<n>\\d+)\\.?") to { m ->
            val plateId = m.groups["n"]?.value?.toIntOrNull() ?: return@to null
            VoiceIntent.SetActivePlate(plateId)
        })
        add(rx("(?:auto[\\- ]?arrange|arrange)(?: (?:the |this )?(?:active |current )?plate)?\\.?") to { _ ->
            VoiceIntent.AutoArrangePlate
        })
        add(rx("drop (?:to |on |on the )?bed\\.?") to { _ ->
            VoiceIntent.DropToBed
        })

        // --- Selection / models -------------------------------------------
        add(rx("(?:delete|remove) (?:the )?selected(?: model[s]?)?\\.?") to { _ ->
            VoiceIntent.DeleteSelected(requiresConfirmation = true)
        })
        add(rx("clear (?:the )?selection\\.?") to { _ ->
            VoiceIntent.ClearSelection
        })

        // --- Wipe-tower ---------------------------------------------------
        add(rx("(?:auto |auto[\\- ])?(?:position |place |move )(?:the )?(?:wipe |purge )?tower\\.?") to { _ ->
            VoiceIntent.AutoPositionWipeTower
        })

        // --- Settings backup ----------------------------------------------
        add(rx("export (?:my )?settings\\.?") to { _ ->
            VoiceIntent.ExportSettings
        })

        // --- Handy model load --------------------------------------------
        // "load benchy" / "load the cube" / "load the orca cube".
        // Kept narrow — full MCP `add_handy_model` accepts a wider id
        // set; if a user asks for one we don't recognize, panel falls
        // through to the LLM dispatch.
        add(rx("(?:load|add) (?:the )?(?<id>benchy|orca cube|orca\\-?cube|stanford bunny|cube|calibration cube|temperature tower|retraction tower|pa tower|ringing tower|vfa)\\.?") to { m ->
            val id = m.groups["id"]?.value ?: return@to null
            VoiceIntent.AddHandyModel(normalizeHandyId(id))
        })

        // --- Help ---------------------------------------------------------
        add(rx("(?:show |open |bring up )?(?:the )?help\\.?") to { _ ->
            VoiceIntent.ShowHelp
        })
        add(rx("close (?:the )?help\\.?") to { _ ->
            VoiceIntent.HideHelp
        })

        // --- Settings / panels --------------------------------------------
        add(rx("(?:open |show )?(?:the )?settings\\.?") to { _ ->
            VoiceIntent.OpenSettings
        })

        // --- Undo / redo --------------------------------------------------
        add(rx("undo(?: that)?\\.?") to { _ -> VoiceIntent.Undo })
        add(rx("redo(?: that)?\\.?") to { _ -> VoiceIntent.Redo })
    }

    private fun rx(pattern: String): Regex = Regex(pattern, RegexOption.IGNORE_CASE)

    private fun normalizeHandyId(spoken: String): String = when (spoken.replace("-", " ")) {
        "orca cube", "orcacube" -> "orca_cube"
        "calibration cube", "cube" -> "calibration_cube"
        "stanford bunny", "bunny" -> "stanford_bunny"
        "temperature tower", "temp tower" -> "calib_temperature_tower"
        "retraction tower" -> "calib_retraction_tower"
        "pa tower", "pressure advance tower" -> "calib_pa_tower"
        "ringing tower" -> "calib_ringing_tower"
        "vfa" -> "calib_vfa"
        "benchy" -> "benchy"
        else -> spoken.replace(" ", "_")
    }
}

/**
 * Structured outcome of [VoiceIntentMapper.map]. Each variant maps to
 * one MCP tool call. The dispatcher in `VoiceCommandPanel` knows how
 * to translate each variant into an action emission against
 * `WorkspaceModel` (or, for read-only intents, a direct UI flip).
 *
 * `requiresConfirmation` is the load-bearing safety flag — the panel
 * surfaces a Confirm button instead of auto-firing for destructive
 * intents (delete-selected, cancel-slice, etc.) so a misheard
 * utterance can't trash work.
 */
sealed interface VoiceIntent {
    val requiresConfirmation: Boolean get() = false

    object SliceActivePlate : VoiceIntent
    data class CancelSlice(override val requiresConfirmation: Boolean = true) : VoiceIntent

    object SaveGcode : VoiceIntent
    object SaveProjectAs3mf : VoiceIntent
    object SaveModelAsStl : VoiceIntent

    data class SetWorkspaceMode(val mode: String) : VoiceIntent
    data class SetPreference(val key: String, val value: Any) : VoiceIntent
    data class SetActivePlate(val plateId: Int) : VoiceIntent

    object AutoArrangePlate : VoiceIntent
    object DropToBed : VoiceIntent

    data class DeleteSelected(override val requiresConfirmation: Boolean = true) : VoiceIntent
    object ClearSelection : VoiceIntent

    object AutoPositionWipeTower : VoiceIntent
    object ExportSettings : VoiceIntent

    data class AddHandyModel(val id: String) : VoiceIntent

    object ShowHelp : VoiceIntent
    object HideHelp : VoiceIntent
    object OpenSettings : VoiceIntent

    object Undo : VoiceIntent
    object Redo : VoiceIntent
}
