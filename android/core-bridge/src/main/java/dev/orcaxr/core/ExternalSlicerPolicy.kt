package dev.orcaxr.core

/** The external slicer's policy (`orcaxr_printer::slicer`), as the browser's
 * `ExternalEngineAttestation` and `ExternalSlicerJobs` answer it: a captured
 * endpoint made canonical; what attesting the engine, submitting a project
 * and each step of its job send; and how an attestation, a submission, a
 * status poll, a cancellation and a downloaded artifact read — the artifact
 * by the facts its host streamed, so G-code never crosses into the core.
 * [ExternalSlicerClient] carries the exchanges out. */
object ExternalSlicerPolicy {
    /** How long the browser waits between status polls. */
    const val POLL_INTERVAL_MS = 700L
    /** The browser's one deadline for confirming a cancellation: its DELETE,
     * reply bodies, status polls and the delays between them. */
    const val CANCELLATION_TIMEOUT_MS = 30_000L

    fun endpoint(request: ProjectIntents.ExternalSlicerEndpointRequest): ProjectIntents.ExternalSlicerEndpoint =
        ProjectIntents.decodeExternalSlicerEndpoint(NativeProject.externalSlicerEndpoint(ProjectIntents.encodeExternalSlicerEndpointRequest(request)))
    fun attestationPlan(request: ProjectIntents.ExternalSlicerEndpointRequest): ProjectIntents.ExternalSlicerAttestationPlan =
        ProjectIntents.decodeExternalSlicerAttestationPlan(
            NativeProject.externalSlicerAttestationPlan(ProjectIntents.encodeExternalSlicerEndpointRequest(request)),
        )
    fun attestation(reply: ProjectIntents.ExternalSlicerReply): ProjectIntents.ExternalSlicerAttestation =
        ProjectIntents.decodeExternalSlicerAttestation(NativeProject.externalSlicerAttestation(ProjectIntents.encodeExternalSlicerReply(reply)))
    /** The archive and its overrides are the host's multipart fields (`file`, `overrides`). */
    fun submitPlan(request: ProjectIntents.ExternalSlicerEndpointRequest): ProjectIntents.ExternalSlicerPlan =
        ProjectIntents.decodeExternalSlicerPlan(NativeProject.externalSlicerSubmitPlan(ProjectIntents.encodeExternalSlicerEndpointRequest(request)))
    fun jobPlan(request: ProjectIntents.ExternalSlicerJobRequest): ProjectIntents.ExternalSlicerPlan =
        ProjectIntents.decodeExternalSlicerPlan(NativeProject.externalSlicerJobPlan(ProjectIntents.encodeExternalSlicerJobRequest(request)))
    fun submission(read: ProjectIntents.ExternalSlicerSubmitRead): ProjectIntents.ExternalSlicerSubmission =
        ProjectIntents.decodeExternalSlicerSubmission(NativeProject.externalSlicerSubmission(ProjectIntents.encodeExternalSlicerSubmitRead(read)))
    fun poll(read: ProjectIntents.ExternalSlicerPollRead): ProjectIntents.ExternalSlicerPollStep =
        ProjectIntents.decodeExternalSlicerPollStep(NativeProject.externalSlicerPoll(ProjectIntents.encodeExternalSlicerPollRead(read)))
    fun cancel(read: ProjectIntents.ExternalSlicerCancelRead): ProjectIntents.ExternalSlicerCancelStep =
        ProjectIntents.decodeExternalSlicerCancelStep(NativeProject.externalSlicerCancel(ProjectIntents.encodeExternalSlicerCancelRead(read)))
    fun artifact(read: ProjectIntents.ExternalSlicerArtifactRead): ProjectIntents.ExternalSlicerArtifact =
        ProjectIntents.decodeExternalSlicerArtifact(NativeProject.externalSlicerArtifact(ProjectIntents.encodeExternalSlicerArtifactRead(read)))
    /** Whether the attested [engine] carries [feature] (e.g. `wave-overhangs`). */
    fun supports(engine: ProjectIntents.ExternalSlicerEngine, feature: String): Boolean =
        NativeProject.externalSlicerSupports(if (engine == ProjectIntents.ExternalSlicerEngine.Wasm) "wasm" else "cli", feature)
}
