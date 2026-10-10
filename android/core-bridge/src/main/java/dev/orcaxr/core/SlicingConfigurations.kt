package dev.orcaxr.core

/**
 * The project's own slicing configuration from catalog profiles, as the
 * browser workspace makes it (`CatalogSlicingConfiguration.ts`, in the shared
 * core as `orcaxr_project::slicing::{choices, configuration}`): the pickers'
 * choices and labels, matching a typed name, selections by preset ID, by name
 * or the catalog's default, the workspace's slots after a selection, the
 * configuration a live choice describes and the project state it leads to.
 * [ProfileCatalog] and [ProjectSession] carry the operations; this file holds
 * their values and their canonical JSON.
 */

/** A preset a picker offers: its ID, exact name and disambiguated label. */
data class PresetOption(val id: String, val name: String, val label: String)

/** Every printer, the processes of one printer and the filaments of one printer/process pair,
 * and that printer's heads (`profileExtruderCount`; one without a printer). */
data class PresetChoices(
    val machines: List<PresetOption>,
    val processes: List<PresetOption>,
    val filaments: List<PresetOption>,
    val extruders: Int = 1,
)

/** One catalog profile: its printer, process and primary filament presets. */
data class SlicingProfile(val machinePresetId: String, val processPresetId: String, val filamentPresetId: String)

/** One palette slot's filament: its exact preset, when it has one, and its name. */
data class SlicingHead(val name: String, val presetId: String? = null)

/** A palette slot: its colour (`#rrggbb`) and filament type label. */
data class SlicingSlot(val color: String, val type: String)

/**
 * The live slicing choice the browser workspace holds: the selected catalog
 * profile, each palette slot's filament and nozzle, and the palette. A profile
 * the catalog no longer holds reads as none.
 */
data class LiveSlicingChoice(
    val profile: SlicingProfile?,
    val heads: List<SlicingHead>,
    val nozzles: List<String>,
    val palette: List<SlicingSlot>,
) {
    companion object {
        /** `FilamentPalette`'s four starting slots. */
        val DEFAULT_PALETTE = listOf(
            SlicingSlot("#5F605F", "PLA"),
            SlicingSlot("#E22B22", "PLA"),
            SlicingSlot("#FEC134", "PLA"),
            SlicingSlot("#FEFEFE", "PLA"),
        )
        /** No profile yet, the default palette: what a new workspace starts from. */
        val EMPTY = LiveSlicingChoice(null, emptyList(), emptyList(), DEFAULT_PALETTE)
    }
}

enum class SelectionSeverity(internal val wire: String) { INFO("info"), WARNING("warning"), ERROR("error") }

/** What a selection tells the operator: whether it applied, how serious, and why. */
data class SelectionFeedback(val applied: Boolean, val severity: SelectionSeverity, val messages: List<String>)

/** A selection's feedback and, when it applied, the live choice that results. */
data class ProfileSelection(val feedback: SelectionFeedback, val live: LiveSlicingChoice?)

/** When automatic FullSpectrum pairs regenerate: when enabled, for at most four
 * physical filaments or a count the operator confirmed. */
data class AutoPairPolicy(val enabled: Boolean, val confirmedCounts: List<Int> = emptyList())

/** A live choice's slicing configuration against a project. */
sealed interface SlicingConfiguration {
    /** The configuration document, canonical JSON for [SlicingConfigurations.nextState]. */
    data class Configured(val configurationJson: String) : SlicingConfiguration
    /** No profile is selected: nothing to configure. */
    data object NoProfile : SlicingConfiguration
    /** Refused with a code (`orphaned-mixed-component`) and the browser's message. */
    data class Refused(val code: String, val message: String) : SlicingConfiguration
}

/** The project state a configuration leads to. */
sealed interface NextSlicingState {
    data class Changed(val stateJson: String) : NextSlicingState
    data object Unchanged : NextSlicingState
    /** `auto-pairs`, `invalid` or `ids-exhausted`, with the browser's message. */
    data class Refused(val code: String, val message: String) : NextSlicingState
}

/** What staging a live choice on a session did. */
sealed interface SlicingStage {
    /** One "Update slicing configuration" replacement for `executeStaged`. */
    data class Staged(val input: ProjectStagedInput) : SlicingStage
    /** No profile is selected, or the project already has this configuration. */
    data object Unchanged : SlicingStage
    /** `orphaned-mixed-component`, `auto-pairs` or `ids-exhausted`, with the browser's message. */
    data class Refused(val code: String, val message: String) : SlicingStage
}

object SlicingConfigurations {
    /** The words one new pair identity draws; a host passes sixteen per pair it may create. */
    const val WORDS_PER_IDENTITY = 16

    /** Random words for every pair [physicalCount] filaments could need, as `NewProjects.words` draws them. */
    fun words(physicalCount: Int, random: java.security.SecureRandom = java.security.SecureRandom()): DoubleArray =
        DoubleArray(WORDS_PER_IDENTITY * physicalCount * (physicalCount - 1).coerceAtLeast(0) / 2) { random.nextDouble() }

    /** The one option a typed name means: a unique exact label, else a unique
     * exact name, else the one option whose name or label contains it, ignoring case. */
    fun match(options: List<PresetOption>, query: String): PresetOption? {
        val reply = CanonicalJson.read(NativeProject.slicingMatch(Json.matchRequest(options, query))) as ProjectJsonObject
        return (reply.get("option") as? ProjectJsonObject)?.let(Json::option)
    }

    /** The state [configurationJson] leads to from [stateJson]; [words] supply
     * new pair identities. Both states are admitted under [resolver] and [profile]. */
    fun nextState(
        stateJson: String,
        configurationJson: String,
        policy: AutoPairPolicy,
        words: DoubleArray,
        resolver: LocalTimestampResolver,
        profile: ProjectIntegerProfile,
    ): NextSlicingState {
        val reply = CanonicalJson.read(
            NativeProject.slicingNextState(Json.nextRequest(stateJson, configurationJson, policy), words, resolver, profile.bits),
        ) as ProjectJsonObject
        val keys = reply.keys().asSequence().toSet()
        return when {
            "error" in keys -> NextSlicingState.Refused(reply.get("error") as String, reply.get("message") as String)
            "unchanged" in keys -> NextSlicingState.Unchanged
            else -> NextSlicingState.Changed(reply.get("stateJson") as String)
        }
    }

    /** The exchange documents as Kotlin writes and reads them: canonical JSON
     * with every non-ASCII unit escaped, so UTF-16 identities survive. */
    internal object Json {
        private fun string(text: String) = CanonicalJson.quote(text)
        private fun obj(vararg members: Pair<String, String?>): String =
            members.filter { it.second != null }.sortedWith { a, b -> a.first.compareTo(b.first) }
                .joinToString(",", "{", "}") { string(it.first) + ":" + it.second }
        private fun <T> array(items: List<T>, write: (T) -> String) = items.joinToString(",", "[", "]") { write(it) }
        private fun optionJson(option: PresetOption) = obj("id" to string(option.id), "label" to string(option.label), "name" to string(option.name))

        fun live(live: LiveSlicingChoice): String = obj(
            "heads" to array(live.heads) { obj("name" to string(it.name), "presetId" to it.presetId?.let(::string)) },
            "nozzles" to array(live.nozzles, ::string),
            "palette" to array(live.palette) { obj("color" to string(it.color), "type" to string(it.type)) },
            "profile" to (live.profile?.let {
                obj(
                    "filamentPresetId" to string(it.filamentPresetId),
                    "machinePresetId" to string(it.machinePresetId),
                    "processPresetId" to string(it.processPresetId),
                )
            } ?: "null"),
        )
        fun choicesRequest(machine: String?, process: String?) =
            obj("machinePresetId" to machine?.let(::string), "processPresetId" to process?.let(::string))
        fun matchRequest(options: List<PresetOption>, query: String) =
            obj("options" to array(options, ::optionJson), "query" to string(query))
        fun selectRequest(live: LiveSlicingChoice, machine: String?, process: String?, filaments: List<String?>?) = obj(
            "live" to live(live),
            "request" to obj(
                "filamentPresetIds" to filaments?.let { ids -> array(ids) { it?.let(::string) ?: "null" } },
                "machinePresetId" to machine?.let(::string),
                "processPresetId" to process?.let(::string),
            ),
        )
        fun namesRequest(live: LiveSlicingChoice, machine: String, process: String, filament: String) = obj(
            "filament" to string(filament),
            "live" to live(live),
            "machine" to string(machine),
            "process" to string(process),
        )
        fun liveRequest(live: LiveSlicingChoice) = obj("live" to live(live))
        fun configurationRequest(live: LiveSlicingChoice, stateJson: String) =
            obj("live" to live(live), "stateJson" to string(stateJson))
        private fun policy(policy: AutoPairPolicy) = obj(
            "confirmedCounts" to array(policy.confirmedCounts) { it.toString() },
            "enabled" to policy.enabled.toString(),
        )
        fun nextRequest(stateJson: String, configurationJson: String, policy: AutoPairPolicy) = obj(
            "autoPairs" to policy(policy),
            "configurationJson" to string(configurationJson),
            "stateJson" to string(stateJson),
        )
        fun stageRequest(live: LiveSlicingChoice, policy: AutoPairPolicy) =
            obj("autoPairs" to policy(policy), "live" to live(live))

        private fun keys(value: ProjectJsonObject) = value.keys().asSequence().toSet()
        private fun strings(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
        fun option(value: ProjectJsonObject) =
            PresetOption(value.get("id") as String, value.get("name") as String, value.get("label") as String)
        private fun options(value: Any) =
            (value as ProjectJsonArray).let { list -> List(list.length()) { option(list.get(it) as ProjectJsonObject) } }
        fun choices(json: String): PresetChoices {
            val reply = CanonicalJson.read(json) as ProjectJsonObject
            return PresetChoices(
                options(reply.get("machines")), options(reply.get("processes")), options(reply.get("filaments")),
                (reply.get("extruders") as Double).toInt(),
            )
        }
        fun live(value: ProjectJsonObject): LiveSlicingChoice {
            val heads = value.get("heads") as ProjectJsonArray
            val palette = value.get("palette") as ProjectJsonArray
            val profile = value.get("profile") as? ProjectJsonObject
            return LiveSlicingChoice(
                profile?.let {
                    SlicingProfile(it.get("machinePresetId") as String, it.get("processPresetId") as String, it.get("filamentPresetId") as String)
                },
                List(heads.length()) {
                    val head = heads.get(it) as ProjectJsonObject
                    SlicingHead(head.get("name") as String, if ("presetId" in keys(head)) head.get("presetId") as String else null)
                },
                strings(value.get("nozzles")),
                List(palette.length()) {
                    val slot = palette.get(it) as ProjectJsonObject
                    SlicingSlot(slot.get("color") as String, slot.get("type") as String)
                },
            )
        }
        /** A selection's reply; `null` when the catalog offered nothing to select. */
        fun selection(json: String): ProfileSelection? {
            val reply = CanonicalJson.read(json) as ProjectJsonObject
            val names = keys(reply)
            if ("feedback" !in names) return null
            val feedback = reply.get("feedback") as ProjectJsonObject
            val severity = feedback.get("severity") as String
            return ProfileSelection(
                SelectionFeedback(
                    feedback.get("applied") as Boolean,
                    SelectionSeverity.entries.first { it.wire == severity },
                    strings(feedback.get("messages")),
                ),
                if ("live" in names) live(reply.get("live") as ProjectJsonObject) else null,
            )
        }
        fun configuration(json: String): SlicingConfiguration {
            val reply = CanonicalJson.read(json) as ProjectJsonObject
            return when {
                "error" in keys(reply) -> SlicingConfiguration.Refused(reply.get("error") as String, reply.get("message") as String)
                else -> (reply.get("configurationJson") as? String)?.let(SlicingConfiguration::Configured) ?: SlicingConfiguration.NoProfile
            }
        }
    }
}
