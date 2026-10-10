package dev.orcaxr.core

/** Loading the bundled profile catalog (the browser's `profiles/catalog.json`). */
object ProfileCatalogs {
    /** The bounds the browser's core replays build the catalog under: 8 MiB of
     * JSON, 1 Mi nodes, 8 Mi text units, 64-byte numbers, depth 64. */
    val LIMITS = ProfileCatalogLimits(8L shl 20, 1L shl 20, 8L shl 20, 64, 64)

    @Volatile private var bundled: ProfileCatalog? = null

    /**
     * The one catalog a process builds from [bytes] (read only when it is first
     * built), shared by every window: it never changes, and the core admits only
     * four documents at a time — a catalog per window beside each window's
     * session left New Project in a second window none. Never closed.
     */
    fun shared(bytes: () -> ByteArray): ProfileCatalog =
        bundled ?: synchronized(this) { bundled ?: build(bytes()).also { bundled = it } }

    /** The most tools a catalog preflight target describes: the engine's 64 filaments. */
    const val MAX_TOOLS = 64L

    /** Builds [bytes] as a catalog ordered as the browser orders it (no [collator]: the core's
     * exact ASCII order, as on a host without ICU). Synchronous; run it on an owned task. */
    fun build(bytes: ByteArray, collator: PresetCollator? = EnglishPresetCollator()): ProfileCatalog {
        val upload = ProfileCatalogUpload(bytes.size.toLong(), LIMITS)
        try {
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
                upload.append(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            return upload.build(collator)
        } catch (failure: Throwable) {
            upload.close()
            throw failure
        }
    }

    /**
     * The browser's `catalogPreflightTarget` for the catalog choice [live]
     * against a project of [toolCount] tools: its profile's exact presets and
     * each head's filament preset. None without a profile.
     */
    fun preflightTarget(catalog: ProfileCatalog, live: LiveSlicingChoice, toolCount: Int): ProjectIntents.PreflightTarget? {
        val profile = live.profile ?: return null
        val units = { text: String -> text.map { it.code } }
        val heads = live.heads.map { head ->
            head.presetId?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
        }
        val request = ProjectIntents.CatalogTargetRequest(
            units(profile.machinePresetId), units(profile.processPresetId), units(profile.filamentPresetId), heads, toolCount.toDouble(),
        )
        return ProjectIntents.PreflightTarget.Catalog(catalog.preflightTarget(request, MAX_TOOLS))
    }
}
