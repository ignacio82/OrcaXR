package dev.orcaxr.core

/** The external slicer's policy through the Kotlin wrapper: every endpoint,
 * plan and read of the browser's corpus round-trips and answers the
 * browser's reply. */
object ProjectExternalSlicerChecks {
    /** [script] lines: `endpoints\t<request>\t<endpoint>\t<attestation plan>\t<submit plan>`,
     * otherwise `<section>\t<request>\t<reply>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "slicer_${columns[0]}_$checks"
            when (columns[0]) {
                "endpoints" -> {
                    val request = ProjectIntents.decodeExternalSlicerEndpointRequest(columns[1])
                    check(ProjectIntents.decodeExternalSlicerEndpointRequest(ProjectIntents.encodeExternalSlicerEndpointRequest(request)) == request) { label }
                    check(ExternalSlicerPolicy.endpoint(request) == ProjectIntents.decodeExternalSlicerEndpoint(columns[2])) { label }
                    check(ExternalSlicerPolicy.attestationPlan(request) == ProjectIntents.decodeExternalSlicerAttestationPlan(columns[3])) { label }
                    check(ExternalSlicerPolicy.submitPlan(request) == ProjectIntents.decodeExternalSlicerPlan(columns[4])) { label }
                }
                "attestations" -> check(
                    ExternalSlicerPolicy.attestation(ProjectIntents.decodeExternalSlicerReply(columns[1])) ==
                        ProjectIntents.decodeExternalSlicerAttestation(columns[2]),
                ) { label }
                "jobPlans" -> check(
                    ExternalSlicerPolicy.jobPlan(ProjectIntents.decodeExternalSlicerJobRequest(columns[1])) ==
                        ProjectIntents.decodeExternalSlicerPlan(columns[2]),
                ) { label }
                "submissions" -> {
                    val read = ProjectIntents.decodeExternalSlicerSubmitRead(columns[1])
                    // The bulk tier carries a whole reply back out, too.
                    check(ProjectIntents.decodeExternalSlicerSubmitRead(ProjectIntents.encodeExternalSlicerSubmitRead(read)) == read) { label }
                    check(ExternalSlicerPolicy.submission(read) == ProjectIntents.decodeExternalSlicerSubmission(columns[2])) { label }
                }
                "polls" -> check(
                    ExternalSlicerPolicy.poll(ProjectIntents.decodeExternalSlicerPollRead(columns[1])) ==
                        ProjectIntents.decodeExternalSlicerPollStep(columns[2]),
                ) { label }
                "cancels" -> check(
                    ExternalSlicerPolicy.cancel(ProjectIntents.decodeExternalSlicerCancelRead(columns[1])) ==
                        ProjectIntents.decodeExternalSlicerCancelStep(columns[2]),
                ) { label }
                "artifacts" -> check(
                    ExternalSlicerPolicy.artifact(ProjectIntents.decodeExternalSlicerArtifactRead(columns[1])) ==
                        ProjectIntents.decodeExternalSlicerArtifact(columns[2]),
                ) { label }
                "downloads" -> check(
                    ExternalSlicerPolicy.download(ProjectIntents.decodeExternalSlicerDownloadRead(columns[1])) ==
                        ProjectIntents.decodeExternalSlicerDownloadStep(columns[2]),
                ) { label }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        check(ExternalSlicerPolicy.supports(ProjectIntents.ExternalSlicerEngine.Wasm, "wave-overhangs")) { "wasm features" }
        check(!ExternalSlicerPolicy.supports(ProjectIntents.ExternalSlicerEngine.Cli, "wave-overhangs")) { "cli features" }
        return checks + 2
    }
}
