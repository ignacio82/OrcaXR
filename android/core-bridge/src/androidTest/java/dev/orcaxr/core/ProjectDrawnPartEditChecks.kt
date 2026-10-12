package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * The Workspace's Emboss and SVG part tools on a real session, over JNI, as
 * the Android Workspace drives them, against the browser's journey
 * (`drawn-part-vectors.mjs`: the production controller run as the
 * workspace's `applyEmboss` and `applySvgPart` run). The same canonical 3MF
 * is opened with the browser's seeded IDs and every step taken through
 * [ProjectWorkspace]: the selection (an instance, an object's or a part's
 * row, nothing), [ProjectWorkspace.applyEmboss] with the font the operator
 * picked and the panel's recipe, [ProjectWorkspace.applySvgPart] with the
 * picked drawing's bytes and the panel's size — new parts, re-cuts, refused
 * cuts whose IDs are still spent, and no object to add to. After each step
 * the outcome, the target ([ProjectWorkspace.drawnPartTarget]), the
 * semantic hash and the undo label are the browser's; then every entry is
 * undone back to the opened project. The tools' starting recipe and depth,
 * a font's naming of the recipe and the drawings' reads are the browser's
 * too.
 */
object ProjectDrawnPartEditChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun numbers(list: ProjectJsonArray) = List(list.length()) { (list.get(it) as Double) }

    /** The browser's `seededRandom` (web/src/project/domain/ids.ts): xorshift32 words over 2³². */
    private fun seeded(seed: Int): () -> Double {
        var state = if (seed != 0) seed else 0x9e3779b9.toInt()
        return {
            state = state xor (state shl 13)
            state = state xor (state ushr 17)
            state = state xor (state shl 5)
            (state.toLong() and 0xffffffffL) / 4294967296.0
        }
    }

    /** [corpus] is the corpus's `{"defaults","journey"}`, the journey with its archive. */
    @JvmStatic fun run(corpus: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        val defaults = reference.get("defaults") as ProjectJsonObject
        val journey = reference.get("journey") as ProjectJsonObject
        check(
            ProjectIntents.decodeEmbossTextRequest(defaults.get("configuration") as String).configuration == ProjectEmbossing.DEFAULT_CONFIGURATION,
            "default_recipe",
        )
        check(defaults.get("svgDepthMm") as Double == ProjectSvgParts.DEFAULT_DEPTH_MM, "default_depth")

        val fontFile = journey.get("font") as ProjectJsonObject
        val fontName = fontFile.get("name") as String
        val drawings = (journey.get("drawings") as ProjectJsonArray).let { list ->
            List(list.length()) { list.get(it) as ProjectJsonObject }.associate { (it.get("name") as String) to it }
        }
        val bytes = drawings.mapValues { (_, drawing) -> Base64.getDecoder().decode(drawing.get("bytes") as String) }
        for ((name, drawing) in drawings) {
            check(ProjectSvgPart.readDrawing(bytes.getValue(name)) == ProjectIntents.decodeSvgDrawingReply(drawing.get("read") as String), "read_$name")
        }
        val clock = java.time.Instant.parse(journey.get("importedAt") as String).toEpochMilli()
        val ids = ProjectIds(seeded((journey.get("seed") as Double).toInt()))
        ProjectEmbossFont.read(ProjectIntents.EmbossFontRequest(0.0), Base64.getDecoder().decode(fontFile.get("bytes") as String)).use { font ->
            check(font.reply() is ProjectIntents.EmbossFontReply.Read, "font_read")
            ProjectWorkspace(clock = { clock }, resolver = LocalTimestampResolver { it }, ids = ids).use { workspace ->
                done(workspace.ready())
                // A fresh project: one empty object is never in scope, so nothing to emboss onto.
                check(done(workspace.drawnPartTarget()) == DrawnPartTarget(), "empty_target")
                val archive = Base64.getDecoder().decode(journey.get("archive") as String)
                check(done(workspace.open(Memory(archive), "drawn.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
                val opened = (journey.get("opened") as ProjectJsonObject).get("semanticHash") as String
                check(workspace.view.revision?.semanticHash == opened, "opened_hash")
                // The browser's controller drew these for its own empty project before opening.
                ids.next((journey.get("skippedIds") as Double).toInt())

                var first = true
                val steps = journey.get("steps") as ProjectJsonArray
                for (index in 0 until steps.length()) {
                    val step = steps.get(index) as ProjectJsonObject
                    val operation = step.get("operation") as ProjectJsonObject
                    val result = step.get("result") as? ProjectJsonObject
                    val kind = operation.get("kind") as String
                    fun label(name: String) = "step_${index}_$name"
                    when (kind) {
                        "select" -> when (val entity = operation.get("entity") as? String) {
                            null -> done(workspace.deselectAll())
                            "instance" -> done(workspace.selectInstance(operation.get("id") as String))
                            else -> done(workspace.selectRow("$entity:${operation.get("id")}"))
                        }
                        "emboss" -> {
                            val configuration = ProjectIntents.decodeEmbossTextRequest(operation.get("configuration") as String).configuration
                            if (first) {
                                // The panel's recipe: the tool's own, named after the font as `loadEmbossFont` names it.
                                check(configuration == ProjectEmbossing.withText(ProjectEmbossing.named(ProjectEmbossing.DEFAULT_CONFIGURATION, fontName), "AOi"), label("named"))
                                first = false
                            }
                            val applied = done(workspace.applyEmboss(font, configuration))
                            val expected = result!!
                            val ok = when (expected.get("outcome")) {
                                "noTarget" -> applied == EmbossApplied.NoTarget
                                "failed" -> applied == EmbossApplied.Failed(expected.get("message") as String)
                                else -> applied is EmbossApplied.Cut &&
                                    applied.volumeId == expected.get("volumeId") &&
                                    applied.recut == (expected.get("outcome") == "recut") &&
                                    applied.preview.triangleCount == (expected.get("triangleCount") as Double).toLong() &&
                                    applied.preview.missingCodePoints == numbers(expected.get("missingCodePoints") as ProjectJsonArray).map { it.toLong() }
                            }
                            check(ok, label("emboss $applied"))
                        }
                        "svg" -> {
                            val name = operation.get("fileName") as String
                            val request = ProjectSvgParts.request(name, operation.get("depthMm") as Double, operation.get("widthMm") as? Double)
                            val applied = done(workspace.applySvgPart(bytes.getValue(name), request))
                            val expected = result!!
                            val ok = when (expected.get("outcome")) {
                                "noTarget" -> applied == SvgPartApplied.NoTarget
                                "failed" -> applied == SvgPartApplied.Failed(expected.get("message") as String)
                                else -> applied is SvgPartApplied.Cut &&
                                    applied.volumeId == expected.get("volumeId") &&
                                    applied.recut == (expected.get("outcome") == "recut") &&
                                    applied.preview.triangleCount == (expected.get("triangleCount") as Double).toLong() &&
                                    applied.preview.sizeMm == numbers(expected.get("sizeMm") as ProjectJsonArray) &&
                                    applied.preview.unsupportedCount == (expected.get("unsupportedCount") as Double).toLong()
                            }
                            check(ok, label("svg $applied"))
                        }
                        else -> error("unknown operation $kind")
                    }
                    val view = workspace.view
                    check(view.revision?.semanticHash == step.get("semanticHash"), label("hash $kind"))
                    check(view.undo == step.get("undoLabel") as? String, label("undo ${view.undo}"))
                    val target = step.get("target") as ProjectJsonObject
                    val expected = DrawnPartTarget(target.get("objectId") as? String, target.get("textVolumeId") as? String, target.get("svgVolumeId") as? String)
                    check(done(workspace.drawnPartTarget()) == expected, label("target"))
                }
                val undo = journey.get("undo") as ProjectJsonArray
                for (index in 0 until undo.length()) {
                    val entry = undo.get(index) as ProjectJsonObject
                    done(workspace.undo())
                    check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                    check(workspace.view.undo == entry.get("undoLabel") as? String, "undo_${index}_label ${workspace.view.undo}")
                }
                check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
            }
        }
        return checks
    }
}
