package dev.orcaxr.core

import java.util.Base64

/** Emboss fonts, drawings read on their own and drawn parts through the
 * Kotlin wrapper: every synthetic font of the browser's corpus reads (or is
 * refused) with the browser's reply, a text's outlines and every recipe cut
 * with a font answer the browser's replies, each cut's mesh hashing to the
 * browser's; a refused font gives no outlines and cuts nothing; every drawing
 * read on its own answers the browser's reply; and on the project the
 * browser's tools made, every part answers whether it is drawn, an unknown
 * part refused and a disposed session asked nothing. */
object ProjectDrawnPartChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun sha256(bytes: ByteArray) =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun bytes(base64: String): ByteArray = Base64.getDecoder().decode(base64)

    /**
     * [fonts] holds one step per line: `F\t<file>\t<base64>` (a font file),
     * `R\t<handle>\t<file>\t<request>\t<reply>`, `G\t<handle>\t<request>\t<reply>`
     * or `C\t<handle>\t<request>\t<reply>\t<mesh SHA-256>\t<window SHA-256>`;
     * [drawings] `<base64>\t<reply>`; [assets] `<descriptor>\t<base64>` per
     * line, the project's in order; [parts] `<request>\t<reply>`.
     */
    @JvmStatic fun run(fonts: String, drawings: String, project: String, assets: String, parts: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val files = mutableMapOf<String, ByteArray>()
        val handles = mutableMapOf<String, ProjectEmbossFont>()
        try {
            for (line in fonts.split("\n")) {
                val entry = line.split("\t")
                when (entry[0]) {
                    "F" -> files[entry[1]] = bytes(entry[2])
                    "R" -> {
                        val request = ProjectIntents.decodeEmbossFontRequest(entry[3])
                        val font = ProjectEmbossFont.read(request, files.getValue(entry[2]))
                        handles.put(entry[1], font)?.close()
                        check(font.reply() == ProjectIntents.decodeEmbossFontReply(entry[4]), "font_read_$checks")
                    }
                    "G" -> {
                        val reply = handles.getValue(entry[1]).glyphs(ProjectIntents.decodeEmbossGlyphsRequest(entry[2]))
                        // Outlines carry doubles, which Kotlin writes its own way: the values are the browser's to the bit.
                        check(reply == ProjectIntents.decodeEmbossGlyphsReply(entry[3]), "font_glyphs_$checks")
                    }
                    "C" -> handles.getValue(entry[1]).prepare(ProjectIntents.decodeEmbossTextRequest(entry[2])).use { cut ->
                        val reply = cut.reply()
                        check(reply == ProjectIntents.decodeEmbossReply(entry[3]), "font_cut_$checks")
                        if (reply is ProjectIntents.EmbossReply.Prepared) {
                            check(sha256(cut.mesh(0, reply.value.byteLength)) == entry[4], "font_mesh_$checks")
                            check(entry[5].isEmpty() || sha256(cut.mesh(16, 64)) == entry[5], "font_window_$checks")
                        }
                    }
                    else -> error("unknown font step ${entry[0]}")
                }
            }
        } finally {
            handles.values.forEach(ProjectEmbossFont::close)
        }
        // A refused font has no outlines and cuts nothing.
        ProjectEmbossFont.read(ProjectIntents.EmbossFontRequest(0.0), ByteArray(3)).use { refused ->
            check(refused.reply() is ProjectIntents.EmbossFontReply.Refused, "refused_font")
            check(failure { refused.glyphs(ProjectIntents.EmbossGlyphsRequest(listOf(65))) } == "invalid_request", "refused_glyphs")
        }
        check(failure { ProjectEmbossFont.read(ProjectIntents.EmbossFontRequest(0.0), ByteArray(ProjectEmbossFont.MAX_FONT_BYTES + 1)) } == "input_limit", "font_limit")

        for (line in drawings.split("\n")) {
            val (drawing, reply) = line.split("\t")
            check(ProjectSvgPart.readDrawing(bytes(drawing)) == ProjectIntents.decodeSvgDrawingReply(reply), "drawing_$checks")
        }
        check(failure { ProjectSvgPart.readDrawing(ByteArray(ProjectSvgPart.MAX_DRAWING_BYTES + 1)) } == "input_limit", "drawing_limit")

        ProjectPreparation().use { scope ->
            val document = project.toByteArray(Charsets.UTF_8)
            val payloads = assets.split("\n").map { bytes(it.split("\t")[1]) }
            val upload = scope.own(ProjectUpload(document.size.toLong(), ProjectHostOptions(document.size.toLong(), 1_000_000, 2_000_000, 1024, 128, payloads.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in document.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), document.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, document.size)))
            upload.sealDocument()
            check(upload.assetCount() == payloads.size.toLong(), "asset_count")
            for ((position, payload) in payloads.withIndex()) {
                kotlin.check(upload.beginAsset(position.toLong()) == payload.size.toLong())
                for (start in payload.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), payload.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, payload.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open(longArrayOf(1, 2, 3, 4)))
            for (line in parts.split("\n")) {
                val (request, reply) = line.split("\t")
                val decoded = ProjectIntents.decodeDrawnPartRequest(request)
                check(ProjectIntents.decodeDrawnPartRequest(ProjectIntents.encodeDrawnPartRequest(decoded)) == decoded, "part_request_$checks")
                check(session.drawnPart(decoded) == ProjectIntents.decodeDrawnPartReply(reply), "part_$checks")
            }
            session.dispose()
            check(failure { session.drawnPart(ProjectIntents.DrawnPartRequest(listOf(97))) } == "disposed", "part_disposed")
        }
        return checks
    }
}
