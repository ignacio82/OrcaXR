package dev.orcaxr.core

/** Assembly alignment through the Kotlin wrapper: every availability,
 * alignment and explosion request of the browser's script round-trips and
 * answers the browser's reply. */
object ProjectAssemblyChecks {
    /** [script] holds one request per line: `A\t<pair>\t<reply>`,
     * `L\t<alignment>\t<reply>` or `E\t<explosion>\t<reply>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val entry = line.split("\t")
            // Requests carry doubles, so round trips compare values.
            when (entry[0]) {
                "A" -> {
                    val request = ProjectIntents.decodeAssemblyPair(entry[1])
                    check(ProjectIntents.decodeAssemblyPair(ProjectIntents.encodeAssemblyPair(request)) == request) { "assembly_pair_$checks" }; checks++
                    check(ProjectAssembly.availability(request) == ProjectIntents.decodeAssemblyAvailabilityReply(entry[2])) { "assembly_availability_$checks" }; checks++
                }
                "L" -> {
                    val request = ProjectIntents.decodeAssemblyAlignmentRequest(entry[1])
                    check(ProjectIntents.decodeAssemblyAlignmentRequest(ProjectIntents.encodeAssemblyAlignmentRequest(request)) == request) { "assembly_request_$checks" }; checks++
                    check(ProjectAssembly.alignment(request) == ProjectIntents.decodeAssemblyAlignmentReply(entry[2])) { "assembly_alignment_$checks" }; checks++
                }
                "E" -> {
                    val request = ProjectIntents.decodeExplosionRequest(entry[1])
                    check(ProjectIntents.decodeExplosionRequest(ProjectIntents.encodeExplosionRequest(request)) == request) { "assembly_explosion_request_$checks" }; checks++
                    check(ProjectAssembly.explosion(request) == ProjectIntents.decodeExplosionReply(entry[2])) { "assembly_explosion_$checks" }; checks++
                }
                else -> error("unknown script entry ${entry[0]}")
            }
        }
        return checks
    }
}
