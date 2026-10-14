package dev.orcaxr.core

/**
 * Android core bridge for the Smart Paint subsystem (P4.9):
 * proposal validation, geometric projection onto volume meshes,
 * and batch intent planning.
 */
object ProjectSmartPaint {
    /**
     * Validates a raw Smart Paint proposal JSON string returned by an assistant.
     * Returns JSON: `{"valid": true, "proposal": {...}}` or `{"valid": false, "error": "...", "message": "..."}`.
     */
    fun validateProposal(proposalJson: String): String =
        NativeProject.smartPaintValidateProposal(proposalJson)

    /**
     * Minimal geometry description (triangle count and bounding extent mm only).
     * Strictly avoids exposing vertices, transforms, or confidential model identifiers.
     */
    fun describeGeometry(session: ProjectSession, volumeId: String): String =
        session.smartPaintDescribeGeometry(volumeId)

    /**
     * Projects a validated proposal onto the volume's mesh facets.
     * Returns `SmartPaintProjection` JSON.
     */
    fun project(session: ProjectSession, volumeId: String, proposalJson: String): String =
        session.smartPaintProject(volumeId, proposalJson)

    /**
     * Builds an atomic [ProjectIntents.Batch] intent JSON string containing [ProjectIntents.FacetStroke]
     * commands applying the user's region assignments.
     */
    fun buildBatch(
        session: ProjectSession,
        volumeId: String,
        channel: String,
        proposalJson: String,
        assignmentsJson: String,
    ): String =
        session.smartPaintBuildBatch(volumeId, channel, proposalJson, assignmentsJson)
}
