package dev.orcaxr.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * A slice's outputs on real sessions: the browser's corpus through the
 * Kotlin owners (what a `thumbnails` value asks for, blocks, where blocks go,
 * the thumbnail camera, which plates a slice slices, each refusal), every
 * injection of it streamed through the core's anchor from a file
 * ([GcodeThumbnails.embed]); the browser-authored placement scene drawn
 * from its one-plate capture with exactly the Rust core's bytes; and the
 * Prepare journey — the catalog's default profile (the U1's `48x48/PNG,
 * 300x300/PNG`), Slice All Plates enabled as the browser's registry enables
 * it, two plates with a model each and an empty one passed over, each
 * plate's archive carrying that plate's own pictures, the G-code carrying
 * them after its header (and a file with its own left alone), the local
 * route's job carrying the same blocks into the output it publishes, and an
 * unprintable plate left out.
 */
object ProjectOutputChecks {
    private const val WAIT_S = 120L
    /** The placement scene's first plate as the Rust core draws it (`orcaxr-archive/tests/thumbnail.rs`). */
    private val DIGESTS = listOf(
        "a379bc23c783bb20284d5491a07510c360439ab2b3e9cf4c2bf5ee1a7e6003e3",
        "715756a8fde33b8b72921ff09128b467251126ac8c52d0ad44064173fb4fadd1",
        "bf5e3788f2d66e9875cb17f33b20660a52f1c066f38021be98044111f563b4d0",
    )
    private val PNG = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 0x0d, 0x0a, 0x1a, 0x0a)

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** The image a block carries, its header's length checked. */
    private fun image(block: String): ByteArray {
        val lines = block.split("\n")
        val begin = lines.indexOfFirst { Regex(" begin \\d+x\\d+ \\d+$").containsMatchIn(it) }
        val end = lines.indexOfFirst { it.endsWith(" end") && !it.contains("BLOCK") }
        val base64 = lines.subList(begin + 1, end).joinToString("") { it.removePrefix("; ") }
        check(lines[begin].substringAfterLast(' ').toInt() == base64.length) { "block length" }
        return Base64.getDecoder().decode(base64)
    }

    /** The archive's one mesh: its vertex count and its directed edges (each once, or the set is smaller). */
    private fun surface(archive: ByteArray): Pair<Int, Set<Pair<Int, Int>>> {
        val model = java.util.zip.ZipInputStream(archive.inputStream()).use { zip ->
            generateSequence { zip.nextEntry }.first { it.name == "3D/3dmodel.model" }
            zip.readBytes().toString(Charsets.UTF_8)
        }
        val vertices = Regex("<vertex ").findAll(model).count()
        val edges = HashSet<Pair<Int, Int>>()
        for (triangle in Regex("<triangle v1=\"(\\d+)\" v2=\"(\\d+)\" v3=\"(\\d+)\"").findAll(model)) {
            val (a, b, c) = triangle.destructured.toList().map(String::toInt)
            edges += listOf(a to b, b to c, c to a)
        }
        return vertices to edges
    }

    /**
     * [script] lines: `<section>\t<request>\t<reply>` for the corpus's answers,
     * `R\t<section>\t<request>` for its refusals. [placement] is the placement
     * scene's state asking for `48x48/PNG, 300x300/PNG, 144x144/JPG, 5000x5000`,
     * [sphere], [cube] and [terrain] its assets; [catalogJson] the bundled catalog.
     */
    @JvmStatic fun run(script: String, catalogJson: ByteArray, placement: String, sphere: ByteArray, cube: ByteArray, terrain: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
        fun refused(block: () -> Unit): String? = try {
            block()
            null
        } catch (failure: IllegalStateException) {
            failure.message
        }
        val scratch = Files.createTempDirectory("orcaxr-outputs-").toFile()
        try {
            // --- The browser's corpus through the Kotlin owners ---
            val injections = mutableListOf<Pair<String, String>>()
            for (line in script.split("\n")) {
                val columns = line.split("\t")
                if (columns[0] == "R") {
                    val answer: (String) -> String = when (columns[1]) {
                        "listRefusals" -> SliceOutputExchanges::list
                        "blockRefusals" -> SliceOutputExchanges::block
                        "injectRefusals" -> SliceOutputExchanges::inject
                        "viewRefusals" -> SliceOutputExchanges::view
                        "planRefusals" -> SliceOutputExchanges::plan
                        else -> error("unknown refusal ${columns[1]}")
                    }
                    check(refused { answer(columns[2]) } == "invalid_request", "refused ${columns[1]} ${columns[2].take(80)}")
                    continue
                }
                val (section, request, reply) = columns
                val answer = when (section) {
                    "lists" -> SliceOutputExchanges.list(request)
                    "blocks" -> SliceOutputExchanges.block(request)
                    "injections" -> SliceOutputExchanges.inject(request).also { injections += request to reply }
                    "views" -> SliceOutputExchanges.view(request)
                    "plans" -> SliceOutputExchanges.plan(request)
                    else -> error("unknown section $section")
                }
                check(answer == reply, "$section ${request.take(80)}")
                if (section == "plans") {
                    // The owner's reading of a state document plans the same.
                    val fields = CanonicalJson.read(request) as ProjectJsonObject
                    val scope = if (fields.get("scope") == "all-plates") SliceScope.AllPlates else SliceScope.CurrentPlate
                    check(SlicePlans.of(fields.get("stateJson") as String, scope) == SlicePlans.read(reply), "plan owner ${request.take(80)}")
                }
            }
            // Every injection again, streamed from a file through the core's anchor, as the app writes G-code.
            for ((index, injection) in injections.withIndex()) {
                val fields = CanonicalJson.read(injection.first) as ProjectJsonObject
                val blocks = fields.get("blocks") as ProjectJsonArray
                val source = File(scratch, "injection-$index.gcode").apply { writeBytes((fields.get("gcode") as String).toByteArray()) }
                val written = ByteArrayOutputStream()
                GcodeThumbnails.embed(source, List(blocks.length()) { blocks.get(it) as String }, written)
                check(written.toByteArray().contentEquals((CanonicalJson.read(injection.second) as String).toByteArray()), "streamed injection $index")
            }

            // --- The placement scene, drawn from its one-plate capture with the Rust core's bytes ---
            ProjectPreparation().use { scope ->
                val bytes = placement.toByteArray(Charsets.UTF_8)
                val assets = listOf(sphere, cube, terrain)
                val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
                for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
                upload.sealDocument()
                for ((position, mesh) in assets.withIndex()) {
                    kotlin.check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
                    for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                    upload.finishAsset()
                }
                val session = scope.own(upload.open())
                val plateId = ((CanonicalJson.read(placement) as ProjectJsonObject).get("plates") as ProjectJsonArray).let { plates ->
                    (plates.get(0) as ProjectJsonObject).get("id") as String
                }
                session.captureGuard().use { guard ->
                    session.captureExport(guard).use { capture ->
                        capture.plate(plateId, LocalTimestampResolver { it }, ProjectIntegerProfile.NODE).use { plate ->
                            val drawn = plate.thumbnails()
                            check(drawn.thumbnails.map { "${it.width}x${it.height}/${it.format}" } == listOf("48x48/PNG", "300x300/PNG", "144x144/JPG"), "placement sizes")
                            check(drawn.thumbnails.map { sha(image(it.block)) } == DIGESTS, "placement bytes are the Rust core's")
                            check(drawn.problems == listOf(ThumbnailProblem("5000x5000", "out-of-range")), "placement problems ${drawn.problems}")
                            check(drawn.thumbnails.all { it.coverage > 0 && it.block.startsWith("; THUMBNAIL_BLOCK_START\n") }, "placement blocks")
                        }
                        capture.project().use { project ->
                            for (scope in SliceScope.entries) {
                                check(project.slicePlan(scope) == SlicePlans.of(placement, scope), "captured plan $scope")
                            }
                        }
                    }
                }
            }

            // --- The Prepare journey on the catalog's default profile ---
            val jobs = File(scratch, "engine-jobs")
            ProfileCatalogs.build(catalogJson, collator = null).use { catalog ->
                val live = checkNotNull(catalog.defaultSelection(LiveSlicingChoice.EMPTY)?.live) { "no_default" }
                ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
                    done(workspace.ready())
                    check(done(workspace.applySlicingChoice(catalog, live)), "profile applied")
                    done(workspace.newProject())
                    // Enablement is the browser's registry gate: models on the active plate, no slice running, no blocking preflight.
                    fun enabled(slicing: Boolean = false, block: Boolean = false) =
                        done(workspace.sliceActions(slicing, block)).mapValues { it.value.enabled }
                    val empty = done(workspace.sliceActions(false, false))
                    check(empty.keys == setOf("slice_active_plate", "slice_all_plates", "slice_cancel"), "slice actions ${empty.keys}")
                    check(empty.getValue("slice_all_plates").label == "Slice All Plates" && !empty.getValue("slice_all_plates").enabled, "nothing to slice")
                    check(done(workspace.slicePlan(SliceScope.AllPlates)).second == SlicePlan.Refused("No printable plate has models to slice."), "no plate with models")

                    val first = checkNotNull(workspace.view.activePlate).id
                    checkNotNull(done(workspace.addPrimitive(PrimitiveShape.CUBE)))
                    check(enabled() == mapOf("slice_active_plate" to true, "slice_all_plates" to true, "slice_cancel" to false), "a model to slice")
                    check(enabled(slicing = true) == mapOf("slice_active_plate" to false, "slice_all_plates" to false, "slice_cancel" to true), "while slicing")
                    check(!enabled(block = true).getValue("slice_all_plates"), "a blocked preflight")
                    val second = checkNotNull(done(workspace.addPlate()))
                    // The browser's rule is the active plate's: an empty one disables Slice All Plates too.
                    check(!enabled().getValue("slice_all_plates"), "an empty active plate")
                    checkNotNull(done(workspace.addPrimitive(PrimitiveShape.CYLINDER)))
                    val third = checkNotNull(done(workspace.addPlate()))
                    done(workspace.activatePlate(second))
                    val (revision, plan) = done(workspace.slicePlan(SliceScope.AllPlates))
                    check(plan == SlicePlan.Plates(listOf(first, second)) && revision == workspace.view.revision, "every plate with a model, the empty one passed over: $plan")
                    check(done(workspace.slicePlan(SliceScope.CurrentPlate)).second == SlicePlan.Plates(listOf(second)), "the active plate")
                    check(third !in (plan as SlicePlan.Plates).ids, "the empty plate")

                    // Each plate's archive carries that plate's own pictures, at the profile's sizes.
                    val written = HashMap<String, ByteArrayOutputStream>()
                    fun archive(plateId: String): ProjectPlateArchive =
                        done(workspace.projectPlate(plateId, object : ProjectDocumentOutput {
                            override fun openOutput(): OutputStream = ByteArrayOutputStream().also { written[plateId] = it }
                        }))
                    val cubePlate = archive(first)
                    val cylinderPlate = archive(second)
                    // The cylinder added on the second plate reaches the engine as one closed surface:
                    // stored as a triangle soup, it sliced to "The print is empty".
                    for ((plateId, triangles) in listOf(first to 12, second to 192)) {
                        val (vertices, edges) = surface(written.getValue(plateId).toByteArray())
                        check(edges.size == triangles * 3 && edges.all { (it.second to it.first) in edges }, "plate $plateId's mesh is closed")
                        check(vertices.toLong() - edges.size / 2 + triangles == 2L, "plate $plateId's mesh is one surface")
                    }
                    check(cubePlate.thumbnails.thumbnails.map { "${it.width}x${it.height}/${it.format}" } == listOf("48x48/PNG", "300x300/PNG"), "the U1's sizes")
                    check(cubePlate.thumbnails.problems.isEmpty(), "every size honoured")
                    for (picture in cubePlate.thumbnails.thumbnails + cylinderPlate.thumbnails.thumbnails) {
                        val png = image(picture.block)
                        check(png.copyOfRange(0, 8).contentEquals(PNG), "a PNG")
                        check(png.copyOfRange(16, 24).contentEquals(java.nio.ByteBuffer.allocate(8).putInt(picture.width).putInt(picture.height).array()), "its size")
                        check(picture.coverage * 50 > picture.width.toLong() * picture.height && picture.coverage * 2 < picture.width.toLong() * picture.height,
                            "the model framed ${picture.coverage}")
                    }
                    check(cubePlate.thumbnails.blocks != cylinderPlate.thumbnails.blocks, "each plate its own picture")
                    check(archive(first).thumbnails.blocks == cubePlate.thumbnails.blocks, "the same plate draws the same bytes")

                    // The G-code carries them after its header and its blank line; a file with its own keeps those.
                    val header = "; HEADER_BLOCK_START\n; generated by Snapmaker Orca\n; HEADER_BLOCK_END\n\n"
                    val body = "; EXECUTABLE_BLOCK_START\nG28\nG1 X10 Y10 E1\n; EXECUTABLE_BLOCK_END\n"
                    val raw = File(scratch, "raw.gcode").apply { writeText(header + body) }
                    val with = ByteArrayOutputStream()
                    check(GcodeThumbnails.embed(raw, cubePlate.thumbnails.blocks, with), "blocks embedded")
                    check(with.toString(Charsets.UTF_8) == header + cubePlate.thumbnails.blocks.joinToString("") + body, "after the header")
                    check(GcodeThumbnails.anchor(raw, 2) == header.length.toLong(), "anchored after the blank line")
                    val own = File(scratch, "own.gcode").apply { writeBytes(with.toByteArray()) }
                    val again = ByteArrayOutputStream()
                    check(!GcodeThumbnails.embed(own, cylinderPlate.thumbnails.blocks, again) && again.toByteArray().contentEquals(with.toByteArray()), "a file with its own left alone")
                    val bare = File(scratch, "bare.gcode").apply { writeText(body) }
                    val top = ByteArrayOutputStream()
                    check(GcodeThumbnails.embed(bare, cubePlate.thumbnails.blocks, top) && top.toString(Charsets.UTF_8).startsWith("; THUMBNAIL_BLOCK_START"), "no header: at the top")

                    // The local route: the staged job carries the plate's blocks into the output it publishes.
                    val job = LocalSlicing.stage(jobs, "0123456789abcdef0123456789abcdef") { output -> done(workspace.projectPlate(first, output)) }
                    try {
                        check(job.thumbnails.blocks == cubePlate.thumbnails.blocks, "the job's pictures")
                        val engine = (header + body).toByteArray()
                        job.output.writeBytes(engine)
                        val verified = LocalSlicing.claim(job, LocalEngineResult.Completed(1, engine.size.toLong(), sha(engine), 0), File(scratch, "slice.gcode.part"))
                        val (published, figures) = SliceStatusTally().use { tally ->
                            LocalSlicing.withThumbnails(verified, job, File(scratch, "thumbnailed.gcode.part"), tally) to tally.figures()
                        }
                        val bytes = published.file.readBytes()
                        check(bytes.contentEquals(with.toByteArray()) && published.bytes == bytes.size.toLong() && published.sha256 == sha(bytes), "published with its pictures")
                        check(!verified.file.exists(), "the engine's own file removed")
                        check(figures.bytes == bytes.size.toLong() && figures.lines == bytes.count { it == '\n'.code.toByte() } + 1L, "the status line counts the pictures too")
                        val destination = File(scratch, "gcode/plate.gcode")
                        check(LocalSlicing.publish(published, job, workspace.view.revision, destination) == destination && destination.readBytes().contentEquals(bytes), "published")
                    } finally {
                        LocalSlicing.discard(job)
                    }

                    // An unprintable plate is left out.
                    done(workspace.setPlatePrintable(first, false))
                    check(done(workspace.slicePlan(SliceScope.AllPlates)).second == SlicePlan.Plates(listOf(second)), "an unprintable plate left out")
                }
            }
        } finally {
            LocalSlicing.deleteTree(scratch.toPath())
        }
        return checks
    }
}
