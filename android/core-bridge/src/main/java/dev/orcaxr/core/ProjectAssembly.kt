package dev.orcaxr.core

/** The pinned assembly alignments of two picked surface features (features
 * from [ProjectMeasureVolume.feature], in the frame they were picked): which
 * a pair allows, the instance transform one produces for the second pick's
 * instance — committed through the same guarded transform intent a drag
 * uses — and the view-only exploded layout, which never moves canonical
 * geometry. Session-free: every call is a pure function of its request. */
object ProjectAssembly {
    fun availability(request: ProjectIntents.AssemblyPair): ProjectIntents.AssemblyAvailabilityReply =
        ProjectIntents.decodeAssemblyAvailabilityReply(NativeProject.assemblyAvailability(ProjectIntents.encodeAssemblyPair(request)))
    fun alignment(request: ProjectIntents.AssemblyAlignmentRequest): ProjectIntents.AssemblyAlignmentReply =
        ProjectIntents.decodeAssemblyAlignmentReply(NativeProject.assemblyAlignment(ProjectIntents.encodeAssemblyAlignmentRequest(request)))
    fun explosion(request: ProjectIntents.ExplosionRequest): ProjectIntents.ExplosionReply =
        ProjectIntents.decodeExplosionReply(NativeProject.assemblyExplosion(ProjectIntents.encodeExplosionRequest(request)))
}
