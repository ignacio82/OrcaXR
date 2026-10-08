package dev.orcaxr.core

/** Paint strokes through the Kotlin wrapper: every open, sample and overlay
 * of the browser's script round-trips and answers the browser's reply, each
 * refusal carries its code, each live preview and canonical overlay packet
 * hashes to the browser's, and each staged commit executes to the browser's
 * outcome, revision, hash and undo label; a disposed session opens nothing. */
object ProjectPaintStrokeChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun sha256(bytes: ByteArray) =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    /** One overlay against its recorded summary, whole packet and window. */
    private fun packets(overlay: ProjectPaintOverlay, summary: String, packet: String, window: String): Boolean = overlay.use {
        it.summary() == ProjectIntents.decodePaintOverlaySummary(summary) &&
            sha256(it.packet(0, ProjectPaintOverlay.MAX_PAGE)) == packet &&
            (window.isEmpty() || sha256(it.packet(1, 2)) == window)
    }

    /** [script] holds one step per line: `O\t<stroke>\t<open>\t<refusal>`,
     * `S\t<stroke>\t<sample>\t<reply>`, `V\t<stroke>\t<overlay>\t<reply>\t<refusal>`,
     * `P\t<stroke>\t<summary>\t<packet>\t<window>` (a live preview),
     * `K\t<request>\t<summary>\t<packet>\t<window>\t<refusal>\t<count>` (a
     * canonical overlay) or
     * `C\t<stroke>\t<label>\t<outcome>\t<revision>\t<hash>\t<undo label>`;
     * an empty field is absent. */
    @JvmStatic fun run(source: String, sphere: ByteArray, terrain: ByteArray, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 2, 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == 2L)
            for ((position, mesh) in listOf(sphere, terrain).withIndex()) {
                check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open(longArrayOf(1, 2, 3, 4)))
            var sequence = 0L
            fun submit(operation: String): String {
                sequence++
                val request = """{"protocolVersion":1,"generation":[1,2,3,4],"requestId":$sequence,"operation":$operation}"""
                return (session.submit(request) ?: session.runNext())!!.use { reply ->
                    reply.wire().also { reply.effects().close() }
                }
            }
            check(submit("""{"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}}""").contains("\"welcome\"")); checks++
            session.configureStaging(ProjectStagingPoolOptions(4, 16, 64_000_000, 16_000_000))
            val strokes = mutableMapOf<String, ProjectPaintStroke>()
            var first: ProjectIntents.PaintStrokeOpen? = null
            try {
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    when (entry[0]) {
                        "P" -> {
                            check(packets(strokes.getValue(entry[1]).preview(), entry[2], entry[3], entry[4])) { "paint_preview_$checks" }; checks++
                        }
                        "K" -> {
                            val request = ProjectIntents.decodePaintOverlayRequest(entry[1])
                            when {
                                entry[5].isEmpty() -> check(packets(session.paintOverlay(request), entry[2], entry[3], entry[4])) { "paint_overlay_packet_$checks" }
                                entry[6].isEmpty() -> check(failure { session.paintOverlay(request).close() } == entry[5]) { "paint_overlay_refusal_$checks" }
                                else -> session.paintOverlay(request).use { overlay ->
                                    check(failure { overlay.packet(0, entry[6].toLong()) } == entry[5]) { "paint_packet_refusal_$checks" }
                                }
                            }
                            checks++
                        }
                        "O" -> {
                            val request = ProjectIntents.decodePaintStrokeOpen(entry[2])
                            check(ProjectIntents.encodePaintStrokeOpen(request) == entry[2]) { "paint_open_$checks" }; checks++
                            session.captureGuard().use { guard ->
                                if (entry[3].isEmpty()) {
                                    strokes[entry[1]] = session.paintStroke(guard, request)
                                    if (first == null) first = request
                                } else {
                                    check(failure { session.paintStroke(guard, request).close() } == entry[3]) { "paint_open_refusal_$checks" }
                                }
                            }
                            checks++
                        }
                        "S" -> {
                            val request = ProjectIntents.decodePaintStrokeSample(entry[2])
                            // Samples carry doubles, so the round trip compares values.
                            check(ProjectIntents.decodePaintStrokeSample(ProjectIntents.encodePaintStrokeSample(request)) == request) { "paint_sample_$checks" }; checks++
                            check(strokes.getValue(entry[1]).sample(request) == ProjectIntents.decodePaintStrokeSampleReply(entry[3])) { "paint_sample_reply_$checks" }; checks++
                        }
                        "V" -> {
                            val request = ProjectIntents.decodePaintStrokeOverlayRequest(entry[2])
                            val stroke = strokes.getValue(entry[1])
                            if (entry[4].isEmpty()) {
                                val page = stroke.overlay(request)
                                check(page == ProjectIntents.decodePaintStrokeOverlay(entry[3])) { "paint_overlay_$checks" }
                                check(page.ranges.size.toLong() <= request.count)
                            } else {
                                check(failure { stroke.overlay(request) } == entry[4]) { "paint_overlay_refusal_$checks" }
                            }
                            checks++
                        }
                        "C" -> {
                            val outcome = strokes.remove(entry[1])!!.use { stroke ->
                                try {
                                    session.stagePaintStroke(stroke, entry[2].ifEmpty { null })?.use { input ->
                                        val reply = submit("""{"executeStaged":{"stagedId":${input.id}}}""")
                                        when {
                                            reply.contains("\"changed\":true") -> "applied"
                                            reply.contains("\"changed\":false") -> "unchanged"
                                            else -> error("paint_commit_$checks: ${reply.take(300)}")
                                        }
                                    } ?: "noop"
                                } catch (refusal: IllegalStateException) {
                                    if (refusal.message != "stale") throw refusal
                                    "stale"
                                }
                            }
                            check(outcome == entry[3]) { "paint_commit_outcome_$checks: $outcome" }; checks++
                            session.snapshot().use { snapshot ->
                                check(snapshot.revision() == entry[4].toLong() && snapshot.hash() == entry[5]) { "paint_commit_state_$checks" }
                            }
                            session.history().use { history ->
                                val label = if (history.hasLabel(true)) String(history.label(true, 0, history.labelLength(true))) else ""
                                check(label == entry[6]) { "paint_commit_label_$checks" }
                            }
                            checks++
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                }
                check(strokes.isEmpty()); checks++
            } finally {
                strokes.values.forEach { it.close() }
            }
            val guard = session.captureGuard()
            guard.use {
                session.dispose()
                check(failure { session.paintStroke(guard, first!!).close() } == "disposed"); checks++
            }
        }
        return checks
    }
}
