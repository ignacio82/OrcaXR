package dev.orcaxr.core

/** The printers an operator installed and the presets they authored, over a
 * pinned catalog. Every change is validated and atomic; issues of the latest
 * outcome are read one at a time. */
class PresetLibrary internal constructor(handle: Long) : ProjectHandle(handle) {
    /** One of the browser's library operations. */
    fun apply(operation: ProjectIntents.LibraryOperation): ProjectIntents.LibraryOutcome = read {
        ProjectIntents.decodeLibraryOutcome(
            NativeProject.libraryApply(it, ProjectIntents.encodeLibraryOperation(operation)),
        )
    }
    /** Replace the library from a bundle, all or nothing. */
    fun importBundle(bundle: ByteArray, limits: ProfileCatalogLimits): ProjectIntents.LibraryOutcome = read {
        ProjectIntents.decodeLibraryOutcome(NativeProject.libraryImport(it, bundle, limits.encode()))
    }
    fun issueCount(): Long = read { NativeProject.libraryIssueCount(it) }
    fun issue(position: Long): ProjectIntents.LibraryIssue = read {
        ProjectIntents.decodeLibraryIssue(NativeProject.libraryIssue(it, position))
    }
    /** The bundle to hand the operator, UTF-8 sorted JSON. */
    fun exportBundle(exportedAt: String, maxBytes: Long): ByteArray = read {
        NativeProject.libraryExport(it, exportedAt, maxBytes)
    }
    /** The text to store after a successful change. */
    fun state(maxBytes: Long): ByteArray = read { NativeProject.libraryState(it, maxBytes) }
    fun view(): ProjectIntents.LibraryView = read { ProjectIntents.decodeLibraryView(NativeProject.libraryView(it)) }
    fun customPreset(position: Long): ProjectIntents.LibraryCustomPreset = read {
        ProjectIntents.decodeLibraryCustomPreset(NativeProject.libraryCustomPreset(it, position))
    }
    /** Every installable printer by vendor, model and nozzle. */
    fun inventory(): ProjectIntents.LibraryInventory = read {
        ProjectIntents.decodeLibraryInventory(NativeProject.libraryInventory(it))
    }
    /** Presets a new custom preset may derive from. */
    fun bases(request: ProjectIntents.LibraryBaseRequest): ProjectIntents.LibraryBases = read {
        ProjectIntents.decodeLibraryBases(
            NativeProject.libraryBases(it, ProjectIntents.encodeLibraryBaseRequest(request)),
        )
    }
    /** The composed catalog as the profile catalog the app reads. */
    fun catalog(): ProfileCatalog = read { own(NativeProject.libraryCatalog(it), ::ProfileCatalog) }
    /** What a newer catalog would do; consumes [next]. */
    fun planUpdate(next: ProfileCatalogUpload): ProjectIntents.LibraryUpdatePlan = next.move { upload ->
        read { ProjectIntents.decodeLibraryUpdatePlan(NativeProject.libraryPlanUpdate(it, upload)) }
    }
    /** Move onto a newer catalog when nothing would be orphaned; consumes [next]. */
    fun applyUpdate(next: ProfileCatalogUpload): ProjectIntents.LibraryOutcome = next.move { upload ->
        read { ProjectIntents.decodeLibraryOutcome(NativeProject.libraryApplyUpdate(it, upload)) }
    }

    companion object {
        /** Typed override text in the inherited value's shape. */
        fun coerce(request: ProjectIntents.LibraryCoerceRequest): ProjectIntents.LibraryCoercedValue =
            ProjectIntents.decodeLibraryCoercedValue(
                NativeProject.libraryCoerce(ProjectIntents.encodeLibraryCoerceRequest(request)),
            )
        /** How an inherited value is presented for editing. */
        fun format(request: ProjectIntents.LibraryFormatRequest): ProjectIntents.LibraryFormattedValue =
            ProjectIntents.decodeLibraryFormattedValue(
                NativeProject.libraryFormat(ProjectIntents.encodeLibraryFormatRequest(request)),
            )
    }
}
