package dev.orcaxr.core

/** Explicit JSON budgets for one catalog upload. */
data class ProfileCatalogLimits(
    val maxBytes: Long,
    val maxNodes: Long,
    val maxTextUnits: Long,
    val maxNumberBytes: Long,
    val maxDepth: Long,
) {
    internal fun encode() = doubleArrayOf(
        maxBytes.toDouble(), maxNodes.toDouble(), maxTextUnits.toDouble(),
        maxNumberBytes.toDouble(), maxDepth.toDouble(),
    )
}

/** Streams the profile catalog JSON (the bundled `profiles/catalog.json` or a
 * composed corpus). Nothing is built until every byte arrived. */
class ProfileCatalogUpload(bytes: Long, limits: ProfileCatalogLimits) :
    ProjectHandle(NativeProject.catalogUploadNew(bytes, limits.encode())) {
    fun append(offset: Long, bytes: ByteArray) = read {
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES) { "input_limit" }
        NativeProject.catalogUploadAppend(it, offset, bytes)
    }
    /** Consumes this upload on success or failure. Synchronous; run it on an
     * owned task. A refused graph still loads, with diagnostics and no profiles. */
    fun build(collator: PresetCollator? = null): ProfileCatalog = move {
        NativeProject.catalogBuild(it, collator)
        own(it, ::ProfileCatalog)
    }
    /** Consumes this upload as the system catalog of a preset library. [stored]
     * is the text the host saved, if any; unreadable text loads an empty
     * library whose issues say why. Synchronous; run it on an owned task. */
    fun library(
        stored: ByteArray?,
        limits: ProfileCatalogLimits,
        collator: PresetCollator?,
        resolver: LocalTimestampResolver,
        profile: ProjectIntegerProfile,
    ): PresetLibrary = move {
        NativeProject.libraryCreate(it, stored, limits.encode(), collator, resolver, profile.bits)
        own(it, ::PresetLibrary)
    }
}

/** A loaded catalog, read one contract value at a time in browser order. */
class ProfileCatalog internal constructor(handle: Long) : ProjectHandle(handle) {
    fun diagnosticCount(): Long = read { NativeProject.catalogDiagnosticCount(it) }
    fun diagnostic(position: Long): ProjectIntents.CatalogDiagnostic = read {
        ProjectIntents.decodeCatalogDiagnostic(NativeProject.catalogDiagnostic(it, position))
    }
    fun presetCount(): Long = read { NativeProject.catalogPresetCount(it) }
    fun preset(position: Long): ProjectIntents.CatalogPreset = read {
        ProjectIntents.decodeCatalogPreset(NativeProject.catalogPreset(it, position))
    }
    fun profileCount(): Long = read { NativeProject.catalogProfileCount(it) }
    fun profile(position: Long): ProjectIntents.CatalogProfile = read {
        ProjectIntents.decodeCatalogProfile(NativeProject.catalogProfile(it, position))
    }
    /** File → Export Config… of profile [position]: the browser's `orcaxr_config.json`
     * (`exportConfigJson`), its keys in the browser's order. */
    fun configExport(position: Long): String = read { NativeProject.catalogConfigExport(it, position) }
    /** The profile's engine wire configuration, keys in UTF-16 order. */
    fun profileConfig(position: Long): ProjectIntents.CatalogConfig = read {
        ProjectIntents.decodeCatalogConfig(NativeProject.catalogProfileConfig(it, position))
    }
    /** The pinned selection policy: compatible replacements, substitutions and
     * diagnostics, or why no selection can resolve. */
    fun reconcile(request: ProjectIntents.CatalogSelectionRequest): ProjectIntents.CatalogSelection = read {
        ProjectIntents.decodeCatalogSelection(
            NativeProject.catalogReconcile(it, ProjectIntents.encodeCatalogSelectionRequest(request)),
        )
    }
    /** The pickers' choices: every printer, the processes of [machinePresetId]
     * and the filaments of it with [processPresetId], labels disambiguated. */
    fun slicingChoices(machinePresetId: String? = null, processPresetId: String? = null): PresetChoices = read {
        SlicingConfigurations.Json.choices(
            NativeProject.catalogSlicingChoices(it, SlicingConfigurations.Json.choicesRequest(machinePresetId, processPresetId)),
        )
    }
    /** Select presets by ID from [live]; absent parts keep the live choice,
     * a null filament names no preset. Applies only a complete selection. */
    fun selectPresets(
        live: LiveSlicingChoice,
        machinePresetId: String? = null,
        processPresetId: String? = null,
        filamentPresetIds: List<String?>? = null,
    ): ProfileSelection = read {
        checkNotNull(
            SlicingConfigurations.Json.selection(
                NativeProject.catalogSlicingSelect(
                    it, SlicingConfigurations.Json.selectRequest(live, machinePresetId, processPresetId, filamentPresetIds),
                ),
            ),
        )
    }
    /** Select a printer, process and primary filament by typed names (blank keeps the live one). */
    fun selectByNames(live: LiveSlicingChoice, machine: String, process: String, filament: String): ProfileSelection = read {
        checkNotNull(
            SlicingConfigurations.Json.selection(
                NativeProject.catalogSlicingSelectByNames(it, SlicingConfigurations.Json.namesRequest(live, machine, process, filament)),
            ),
        )
    }
    /** Select the catalog's default triple; null when the catalog has no profile. */
    fun defaultSelection(live: LiveSlicingChoice): ProfileSelection? = read {
        SlicingConfigurations.Json.selection(NativeProject.catalogSlicingDefault(it, SlicingConfigurations.Json.liveRequest(live)))
    }
    /** [live] with one filament slot edited as the browser's Filament tab edits
     * it (its slots first synchronized to the palette); a full palette refuses
     * to grow (`slot-limit`) in the browser's words. */
    fun editSlots(live: LiveSlicingChoice, edit: SlotEdit): SlotEditResult = read {
        SlicingConfigurations.Json.slotEdit(NativeProject.catalogSlicingSlots(it, SlicingConfigurations.Json.slotsRequest(live, edit)))
    }
    /** The slicing configuration [live] describes against the state document
     * [stateJson], admitted under [resolver] and [profile]. */
    fun slicingConfiguration(
        live: LiveSlicingChoice,
        stateJson: String,
        resolver: LocalTimestampResolver,
        profile: ProjectIntegerProfile,
    ): SlicingConfiguration = read {
        SlicingConfigurations.Json.configuration(
            NativeProject.catalogSlicingConfiguration(
                it, SlicingConfigurations.Json.configurationRequest(live, stateJson), resolver, profile.bits,
            ),
        )
    }
    /** The catalog target of a live `PreflightRequest` for the selected presets
     * and each head's filament; more than [maxTools] tools is refused. */
    fun preflightTarget(request: ProjectIntents.CatalogTargetRequest, maxTools: Long): ProjectIntents.CatalogPreflightTarget = read {
        ProjectIntents.decodeCatalogPreflightTarget(
            NativeProject.catalogTarget(it, ProjectIntents.encodeCatalogTargetRequest(request), maxTools),
        )
    }
}
