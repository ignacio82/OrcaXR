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
    /** The catalog target of a live `PreflightRequest` for the selected presets
     * and each head's filament; more than [maxTools] tools is refused. */
    fun preflightTarget(request: ProjectIntents.CatalogTargetRequest, maxTools: Long): ProjectIntents.CatalogPreflightTarget = read {
        ProjectIntents.decodeCatalogPreflightTarget(
            NativeProject.catalogTarget(it, ProjectIntents.encodeCatalogTargetRequest(request), maxTools),
        )
    }
}
