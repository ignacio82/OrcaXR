package dev.orcaxr.core

/** The preset library through the Kotlin wrapper: the browser's contract
 * replies decode and re-encode exactly, bundles and stored text round-trip,
 * host collators and timestamp resolvers are consulted and their failures
 * refuse without exposing text, and uploads are consumed and budgeted. */
object ProjectLibraryChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private val limits = ProfileCatalogLimits(8L shl 20, 1L shl 20, 8L shl 20, 64, 64)
    private val utc = LocalTimestampResolver { it }
    private fun upload(scope: ProjectPreparation, bytes: ByteArray): ProfileCatalogUpload {
        val upload = scope.own(ProfileCatalogUpload(bytes.size.toLong(), limits))
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
            upload.append(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
        return upload
    }
    /** A library holds a document slot: callers close it as soon as they can. */
    private fun library(
        scope: ProjectPreparation,
        catalog: ByteArray,
        stored: ByteArray? = null,
        collator: PresetCollator? = null,
        resolver: LocalTimestampResolver = utc,
    ) = upload(scope, catalog).library(stored, limits, collator, resolver, ProjectIntegerProfile.NODE)
    private fun text(value: String) = value.map { it.code }
    private fun string(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** [expected] lines: an install and its outcome, a create and its outcome,
     * the created preset, a refused create with its outcome and first issue,
     * and a coercion and a format with their replies. */
    @JvmStatic fun run(catalog: ByteArray, expected: String): Long {
        val lines = expected.split("\n")
        check(lines.size == 12)
        var checks = 0L
        ProjectPreparation().use { scope ->
            val input = upload(scope, catalog)
            val lib = scope.own(input.library(null, limits, null, utc, ProjectIntegerProfile.NODE))
            check(failure { input.library(null, limits, null, utc, ProjectIntegerProfile.NODE) } == "closed"); checks++
            check(!lib.view().configured && lib.issueCount() == 0L); checks++
            fun replay(operation: String, outcome: String) =
                check(ProjectIntents.encodeLibraryOutcome(lib.apply(ProjectIntents.decodeLibraryOperation(operation))) == outcome)
            replay(lines[0], lines[1]); checks++
            replay(lines[2], lines[3]); checks++
            check(ProjectIntents.encodeLibraryCustomPreset(lib.customPreset(0)) == lines[4]); checks++
            replay(lines[5], lines[6]); checks++
            check(ProjectIntents.encodeLibraryIssue(lib.issue(0)) == lines[7]); checks++
            check(failure { lib.issue(lib.issueCount()) } == "invalid_range"); checks++
            check(ProjectIntents.encodeLibraryCoercedValue(PresetLibrary.coerce(ProjectIntents.decodeLibraryCoerceRequest(lines[8]))) == lines[9]); checks++
            check(ProjectIntents.encodeLibraryFormattedValue(PresetLibrary.format(ProjectIntents.decodeLibraryFormatRequest(lines[10]))) == lines[11]); checks++

            // Bundles and stored text round-trip through a fresh library.
            val bundle = lib.exportBundle("2026-08-20T00:00:00.000Z", 1L shl 20)
            library(scope, catalog).use { copy ->
                check(copy.importBundle(bundle, limits).ok); checks++
                check(copy.state(1L shl 20).contentEquals(lib.state(1L shl 20))); checks++
                check(!copy.importBundle("{ not json".toByteArray(), limits).ok); checks++
            }
            library(scope, catalog, lib.state(1L shl 20)).use { restored ->
                check(restored.issueCount() == 0L && restored.view() == lib.view()); checks++
            }
            library(scope, catalog, "{oops".toByteArray()).use { corrupt ->
                check(corrupt.issue(0).code == ProjectIntents.LibraryIssueCode.UnsupportedSchema); checks++
            }
            check(failure { lib.state(1) } == "output_limit"); checks++

            // The composed catalog and a catalog update.
            check(scope.own(lib.catalog()).presetCount() > 0L); checks++
            val plan = lib.planUpdate(upload(scope, catalog))
            check(plan.applicable && !plan.changed); checks++
            val spent = upload(scope, catalog)
            check(lib.applyUpdate(spent).ok); checks++
            check(failure { spent.append(0, byteArrayOf(1)) } == "closed"); checks++

            // Host policies: a reversing collator reorders the inventory, a
            // failing one refuses, and so does a failing local-time resolver.
            val models = { collator: PresetCollator ->
                library(scope, catalog, collator = collator).use { l -> l.inventory().models.map { string(it.model) } }
            }
            val forward = models { l, r -> java.util.Arrays.compare(l, r) }
            check(models { l, r -> java.util.Arrays.compare(r, l) } == forward.reversed() && forward.size > 1); checks++
            check(failure { library(scope, catalog, collator = PresetCollator { _, _ -> error("PRIVATE collator detail") }) } == "collation_failed"); checks++
            val draft = ProjectIntents.LibraryDraft(
                ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                ProjectIntents.CatalogPresetKind.Filament,
                text("Local PLA"),
                text("Acme PLA"),
                ProjectIntents.OptionalJsonText.Absent(ProjectIntents.Empty),
                ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                ProjectIntents.OptionalProvenanceSource.Absent(ProjectIntents.Empty),
            )
            // A zoneless stamp is local time, which only the resolver can place.
            val local = ProjectIntents.LibraryOperation.Create(ProjectIntents.LibraryCreate(draft, text("2026-08-16T00:00:00")))
            library(scope, catalog, resolver = LocalTimestampResolver { error("PRIVATE timestamp detail") }).use { strict ->
                check(failure { strict.apply(local) } == "timestamp_service"); checks++
            }
            check(lib.apply(local).ok); checks++
            val malformed = ProjectIntents.LibraryOperation.Create(
                ProjectIntents.LibraryCreate(draft.copy(overridesJson = ProjectIntents.OptionalJsonText.Value(text("[]"))), text("2026-08-16T00:00:00Z")),
            )
            check(failure { lib.apply(malformed) } == "invalid_request"); checks++
        }
        return checks
    }
}
