package dev.orcaxr.core

/** The profile catalog through the Kotlin wrapper: the browser's contract
 * replies decode and re-encode exactly, a host collator orders presets, a
 * failing one refuses the build, and uploads are consumed and budgeted. */
object ProjectCatalogChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private val limits = ProfileCatalogLimits(8L shl 20, 1L shl 20, 8L shl 20, 64, 64)
    private fun upload(scope: ProjectPreparation, bytes: ByteArray, limits: ProfileCatalogLimits = this.limits): ProfileCatalogUpload {
        val upload = scope.own(ProfileCatalogUpload(bytes.size.toLong(), limits))
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
            upload.append(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
        return upload
    }
    /** [expected] lines: diagnostic 0, preset 0, profile 0, config 0, a
     * selection request and its result, a target request and its result. */
    @JvmStatic fun run(catalog: ByteArray, expected: String): Long {
        val lines = expected.split("\n")
        check(lines.size == 8)
        var checks = 0L
        ProjectPreparation().use { scope ->
            val input = upload(scope, catalog)
            val loaded = scope.own(input.build())
            check(failure { input.build() } == "closed"); checks++
            check(ProjectIntents.encodeCatalogDiagnostic(loaded.diagnostic(0)) == lines[0]); checks++
            check(ProjectIntents.encodeCatalogPreset(loaded.preset(0)) == lines[1]); checks++
            check(ProjectIntents.encodeCatalogProfile(loaded.profile(0)) == lines[2]); checks++
            check(ProjectIntents.encodeCatalogConfig(loaded.profileConfig(0)) == lines[3]); checks++
            val selection = loaded.reconcile(ProjectIntents.decodeCatalogSelectionRequest(lines[4]))
            check(ProjectIntents.encodeCatalogSelection(selection) == lines[5]); checks++
            // Numbers are semantic on the wire: compare decoded values.
            val target = loaded.preflightTarget(ProjectIntents.decodeCatalogTargetRequest(lines[6]), 64)
            check(target == ProjectIntents.decodeCatalogPreflightTarget(lines[7])); checks++
            check(failure { loaded.profile(loaded.profileCount()) } == "invalid_range"); checks++
            check(failure { loaded.preflightTarget(ProjectIntents.decodeCatalogTargetRequest(lines[6]), 0) } == "resource_limit"); checks++

            // A host collator decides preset order; kinds still lead.
            val reversed = scope.own(upload(scope, catalog).build(PresetCollator { left, right -> java.util.Arrays.compare(right, left) }))
            check(reversed.presetCount() == loaded.presetCount()); checks++
            check(reversed.preset(0).kind == ProjectIntents.CatalogPresetKind.Filament); checks++
            check(reversed.preset(0).name != loaded.preset(0).name); checks++
            check(reversed.profileCount() == loaded.profileCount()); checks++
            // A failing collator refuses the build without exposing its text.
            check(failure { upload(scope, catalog).build(PresetCollator { _, _ -> error("PRIVATE collator detail") }) } == "collation_failed"); checks++
            check(failure { ProfileCatalogUpload(catalog.size.toLong(), limits.copy(maxBytes = 16)) } == "input_limit"); checks++
        }
        return checks
    }
}
