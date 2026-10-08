package dev.orcaxr.core

/** Mesh renderer packets through the Kotlin wrapper: every request of the
 * browser's script round-trips and answers the browser's reply, each
 * packet's paged bytes hash to the browser's, its chunk table tiles the
 * mesh's triangles in order at aligned offsets inside the packet, a page past
 * the end is refused, and a disposed session packs nothing. */
object ProjectMeshPacketChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun sha256(bytes: ByteArray) =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** [script] holds one request per line:
     * `P\t<request>\t<reply>\t<bytes SHA-256>\t<window SHA-256>`; an empty
     * field is absent. */
    @JvmStatic fun run(source: String, assets: List<ByteArray>, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 2_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == assets.size.toLong())
            for ((position, mesh) in assets.withIndex()) {
                check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open(longArrayOf(1, 2, 3, 4)))
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                check(entry[0] == "P") { "unknown script entry ${entry[0]}" }
                val request = ProjectIntents.decodeMeshPacketRequest(entry[1])
                check(ProjectIntents.decodeMeshPacketRequest(ProjectIntents.encodeMeshPacketRequest(request)) == request) { "packet_request_$checks" }; checks++
                session.meshPacket(request).use { packet ->
                    val reply = packet.reply()
                    check(reply == ProjectIntents.decodeMeshPacketReply(entry[2])) { "packet_reply_$checks" }; checks++
                    if (reply is ProjectIntents.MeshPacketReply.Prepared) {
                        val length = reply.value.byteLength
                        val all = java.io.ByteArrayOutputStream()
                        var at = 0L
                        while (at < length) {
                            val count = minOf(ProjectMeshPacket.MAX_PAGE, length - at)
                            all.write(packet.bytes(at, count)); at += count
                        }
                        check(sha256(all.toByteArray()) == entry[3] && (entry[4].isEmpty() || sha256(packet.bytes(16, 64)) == entry[4])) { "packet_bytes_$checks" }
                        check(failure { packet.bytes(length, 1) } == "invalid_request") { "packet_end_$checks" }
                        checks++
                        val chunks = packet.chunks(reply.value.chunkCount)
                        var first = 0L
                        var end = reply.value.chunkCount * ProjectMeshPacket.TABLE_ENTRY_BYTES
                        for (chunk in chunks) {
                            check(chunk.firstTriangle == first && chunk.triangleCount > 0 && chunk.byteOffset == end && chunk.byteOffset % 4 == 0L) { "packet_chunk_$checks" }
                            first += chunk.triangleCount
                            end = chunk.byteOffset + (chunk.vertexCount * 24 + chunk.triangleCount * 3 * reply.value.indexBytes + 3) / 4 * 4
                        }
                        check(first == reply.value.triangleCount && end == length) { "packet_table_$checks" }; checks++
                    } else {
                        check(failure { packet.bytes(0, 1) } == "invalid_request") { "packet_refused_$checks" }
                    }
                }
            }
            session.dispose()
            check(failure { session.meshPacket(ProjectIntents.decodeMeshPacketRequest("""{"assetId":[120],"maxChunkVertices":3}""")).close() } == "disposed"); checks++
        }
        return checks
    }
}
