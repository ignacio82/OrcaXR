package dev.orcaxr.core

/** The Moonraker transport policy through the Kotlin wrapper: every request
 * of the browser's corpus round-trips and answers the browser's reply. */
object ProjectMoonrakerPolicyChecks {
    /** [script] lines: `<section>\t<request>\t<reply>`; a delay's reply is its number. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val (section, request, reply) = line.split("\t")
            val label = "moonraker_${section}_$checks"
            when (section) {
                "endpoints" -> {
                    val decoded = ProjectIntents.decodeMoonrakerEndpointRequest(request)
                    check(ProjectIntents.decodeMoonrakerEndpointRequest(ProjectIntents.encodeMoonrakerEndpointRequest(decoded)) == decoded) { label }
                    check(MoonrakerPolicy.endpoint(decoded) == ProjectIntents.decodeMoonrakerEndpointReply(reply)) { label }
                }
                "paths" -> check(MoonrakerPolicy.path(ProjectIntents.decodeMoonrakerPathRequest(request)) == ProjectIntents.decodeMoonrakerPathReply(reply)) { label }
                "credentials" -> check(MoonrakerPolicy.credentials(ProjectIntents.decodeMoonrakerCredentialCheck(request)) == ProjectIntents.decodeMoonrakerCredentialReply(reply)) { label }
                "errors" -> check(MoonrakerPolicy.errorResponse(ProjectIntents.decodeMoonrakerErrorResponse(request)) == ProjectIntents.decodeMoonrakerTransportFault(reply)) { label }
                "handshakes" -> check(MoonrakerPolicy.handshake(ProjectIntents.decodeMoonrakerHandshakeRequest(request)) == ProjectIntents.decodeMoonrakerHandshakeReply(reply)) { label }
                "policies" -> check(MoonrakerPolicy.reconnectPolicy(ProjectIntents.decodeMoonrakerReconnectPolicyInput(request)) == ProjectIntents.decodeMoonrakerReconnectPolicyReply(reply)) { label }
                "delays" -> check(MoonrakerPolicy.reconnectDelay(ProjectIntents.decodeMoonrakerReconnectDelayRequest(request)) == reply.toDouble()) { label }
                "subscriptions" -> check(MoonrakerPolicy.subscription(ProjectIntents.decodeMoonrakerObjectSubscription(request)) == ProjectIntents.decodeMoonrakerSubscriptionReply(reply)) { label }
                "methods" -> check(MoonrakerPolicy.methodCheck(ProjectIntents.decodeMoonrakerMethodCheck(request)) == ProjectIntents.decodeMoonrakerCheckReply(reply)) { label }
                else -> error("unknown script entry $section")
            }
            checks++
        }
        return checks
    }
}
