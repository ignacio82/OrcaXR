package dev.orcaxr.core

/** The Moonraker transport's pure policy (`orcaxr_printer::moonraker`), as
 * the browser's `MoonrakerEndpoint`, `SessionCredentials` and
 * `MoonrakerTransport` answer it: the URLs an entered endpoint becomes (by
 * the WHATWG URL Standard), request paths, session credentials and what they
 * match, how a refused response is reported, the handshake, the reconnect
 * policy and backoff, the object subscription and single-method endpoints. */
object MoonrakerPolicy {
    fun endpoint(request: ProjectIntents.MoonrakerEndpointRequest): ProjectIntents.MoonrakerEndpointReply =
        ProjectIntents.decodeMoonrakerEndpointReply(NativeProject.moonrakerEndpoint(ProjectIntents.encodeMoonrakerEndpointRequest(request)))
    fun path(request: ProjectIntents.MoonrakerPathRequest): ProjectIntents.MoonrakerPathReply =
        ProjectIntents.decodeMoonrakerPathReply(NativeProject.moonrakerPath(ProjectIntents.encodeMoonrakerPathRequest(request)))
    fun credentials(check: ProjectIntents.MoonrakerCredentialCheck): ProjectIntents.MoonrakerCredentialReply =
        ProjectIntents.decodeMoonrakerCredentialReply(NativeProject.moonrakerCredentials(ProjectIntents.encodeMoonrakerCredentialCheck(check)))
    fun errorResponse(response: ProjectIntents.MoonrakerErrorResponse): ProjectIntents.MoonrakerTransportFault =
        ProjectIntents.decodeMoonrakerTransportFault(NativeProject.moonrakerErrorResponse(ProjectIntents.encodeMoonrakerErrorResponse(response)))
    fun handshake(request: ProjectIntents.MoonrakerHandshakeRequest): ProjectIntents.MoonrakerHandshakeReply =
        ProjectIntents.decodeMoonrakerHandshakeReply(NativeProject.moonrakerHandshake(ProjectIntents.encodeMoonrakerHandshakeRequest(request)))
    fun reconnectPolicy(input: ProjectIntents.MoonrakerReconnectPolicyInput): ProjectIntents.MoonrakerReconnectPolicyReply =
        ProjectIntents.decodeMoonrakerReconnectPolicyReply(NativeProject.moonrakerReconnectPolicy(ProjectIntents.encodeMoonrakerReconnectPolicyInput(input)))
    fun reconnectDelay(request: ProjectIntents.MoonrakerReconnectDelayRequest): Double =
        NativeProject.moonrakerReconnectDelay(ProjectIntents.encodeMoonrakerReconnectDelayRequest(request))
    fun subscription(entries: List<ProjectIntents.MoonrakerSubscriptionEntry>): ProjectIntents.MoonrakerSubscriptionReply =
        ProjectIntents.decodeMoonrakerSubscriptionReply(NativeProject.moonrakerSubscription(ProjectIntents.encodeMoonrakerObjectSubscription(entries)))
    fun methodCheck(check: ProjectIntents.MoonrakerMethodCheck): ProjectIntents.MoonrakerCheckReply =
        ProjectIntents.decodeMoonrakerCheckReply(NativeProject.moonrakerMethodCheck(ProjectIntents.encodeMoonrakerMethodCheck(check)))
}
