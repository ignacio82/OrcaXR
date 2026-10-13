package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * The File menu's model exports on real sessions, over JNI.
 *
 * The Kotlin readers first take every reply of the browser's corpus
 * (`model-export-vectors.json`) and every output name, asked again of the
 * core. Then each recorded state is opened as a session and every STL export
 * of it is written through the export capture: the reply, and the file's
 * length and SHA-256, are the browser's; a refusal writes nothing.
 *
 * Then the workspace journey: the posed state, saved by the core as a 3MF and
 * opened in a [ProjectWorkspace], exports as one STL and as an archive with
 * nothing selected, one instance selected and two — each the browser's file
 * byte for byte — without touching the history or the saved state; with a
 * negative volume added the export is refused in the browser's words and the
 * destination is never opened; a destination that cannot be opened fails the
 * export; an imported cube exports as `cube.stl`.
 */
object ProjectModelExportChecks {
    private const val WAIT_S = 60L

    private class Memory(val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long? get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    /** A destination that records whether it was opened. */
    private class Target(private val failing: Boolean = false) : ProjectDocumentOutput {
        val bytes = ByteArrayOutputStream()
        var opened = false
        override fun openOutput(): OutputStream {
            opened = true
            if (failing) throw IOException("PRIVATE provider detail")
            return bytes
        }
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun failure(future: CompletableFuture<*>): Throwable? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        thrown.cause
    }
    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view.undo}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun objects(value: Any): List<ProjectJsonObject> = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as ProjectJsonObject } }
    private fun has(obj: ProjectJsonObject, key: String) = obj.keys().asSequence().any { it == key }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** [stateJson] as a session, its meshes from [library] (asset ID to bytes) in the state's declaration order. */
    private fun session(scope: ProjectPreparation, stateJson: String, library: Map<String, ByteArray>): ProjectSession {
        // In the state's declaration order (canonical JSON lists `sourceAssets` once; a state may carry
        // lone surrogates the strict reader refuses, so the order is read from the text).
        val section = stateJson.substring(stateJson.indexOf("\"sourceAssets\":["))
        val assets = library.keys.filter { section.contains("\"$it\"") }.sortedBy { section.indexOf("\"$it\"") }.map(library::getValue)
        val bytes = stateJson.toByteArray(Charsets.UTF_8)
        val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
        upload.sealDocument()
        for ((position, mesh) in assets.withIndex()) {
            kotlin.check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
            for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
            upload.finishAsset()
        }
        return scope.own(upload.open())
    }

    /** [corpus] is `model-export-vectors.json`; [cube] a binary STL. */
    @JvmStatic fun run(corpus: String, cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }

        // The corpus's replies through the Kotlin readers, and every name asked again.
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        val cases = objects(reference.get("stl"))
        for (case in cases) {
            val reply = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            when (val read = ModelExports.stl(case.get("replyJson") as String)) {
                is StlExport.Refused -> check(!has(case, "sha256") && read.message == reply.get("error"), "refused ${case.get("requestJson")}")
                is StlExport.Written -> check(
                    has(case, "sha256") && read.filename == reply.get("filename") && read.mediaType == reply.get("mediaType") &&
                        read.triangleCount == (reply.get("triangleCount") as Number).toLong() &&
                        read.instanceCount == (reply.get("instanceCount") as Number).toLong() &&
                        read.instanceIds == objects2(reply.get("instanceIds")),
                    "written ${case.get("requestJson")}",
                )
            }
        }
        for (case in objects(reference.get("names"))) {
            val request = CanonicalJson.read(case.get("requestJson") as String) as ProjectJsonObject
            val kind = ExportNameKind.entries.single { it.wire == request.get("kind") }
            val expected = (CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject).get("filename")
            check(ModelExports.filename(kind, request.get("name") as? String) == expected, "name ${case.get("requestJson")}")
        }
        check(ModelExports.GCODE_FILENAME == "orcaxr.gcode" && ModelExports.CONFIG_FILENAME == "orcaxr_config.json", "constants")

        // Every recorded state as a session: each STL export through the export capture.
        val assets = objects(reference.get("assets")).associate {
            ((CanonicalJson.read(it.get("descriptorJson") as String) as ProjectJsonObject).get("id") as String) to
                Base64.getDecoder().decode(it.get("base64") as String)
        }
        val states = objects(reference.get("states"))
        var posedArchive: ByteArray? = null
        // One session at a time: the core admits four live documents per process.
        for (state in states) ProjectPreparation().use { scope ->
            run {
                val name = state.get("name") as String
                val session = session(scope, state.get("stateJson") as String, assets)
                session.captureGuard().use { guard ->
                    session.captureExport(guard).use { capture ->
                        for (case in cases.filter { it.get("state") == name }) {
                            val written = ByteArrayOutputStream()
                            val answer = capture.writeStl(case.get("requestJson") as String, written)
                            check(answer == ModelExports.stl(case.get("replyJson") as String), "answer $name ${case.get("requestJson")}")
                            if (has(case, "sha256")) {
                                check(written.size().toLong() == (case.get("bytes") as Number).toLong() && sha(written.toByteArray()) == case.get("sha256"), "bytes $name ${case.get("requestJson")}")
                            } else {
                                check(written.size() == 0, "refusal wrote nothing $name ${case.get("requestJson")}")
                            }
                        }
                        for (case in objects(reference.get("projects")).filter { it.get("state") == name }) {
                            val written = ByteArrayOutputStream()
                            val answer = capture.writeProjectArchive(ProjectWorkspace.ARCHIVE, written)
                            check(answer == ModelExports.projectArchive(case.get("replyJson") as String), "3MF answer $name")
                            if (has(case, "sha256")) {
                                check(answer is ProjectArchiveExport.Written && written.size().toLong() == (case.get("bytes") as Number).toLong() &&
                                    sha(written.toByteArray()) == case.get("sha256"), "3MF bytes $name")
                            } else {
                                check(answer is ProjectArchiveExport.Refused && written.size() == 0, "3MF refusal wrote nothing $name")
                            }
                        }
                        if (name == "posed") posedArchive = capture.writeArchive(ProjectWorkspace.ARCHIVE).use { output ->
                            val out = ByteArrayOutputStream()
                            var offset = 0L
                            while (offset < output.length()) {
                                val chunk = output.read(offset, minOf(ProjectArchive.MAX_CHUNK_BYTES.toLong(), output.length() - offset))
                                out.write(chunk); offset += chunk.size
                            }
                            out.toByteArray()
                        }
                    }
                }
            }
        }

        // The workspace journey on the posed state.
        val posed = CanonicalJson.read(states.single { it.get("name") == "posed" }.get("stateJson") as String) as ProjectJsonObject
        val active = objects(posed.get("plates")).single { it.get("id") == posed.get("activePlateId") }
        val instances = objects(active.get("objects")).flatMap { objects(it.get("instances")) }.map { it.get("id") as String }
        fun expected(archive: Boolean, selected: List<String>): ProjectJsonObject =
            cases.single { it.get("state") == "posed" && it.get("requestJson") == ModelExports.stlRequest(archive, selected) }
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            done(workspace.open(Memory(checkNotNull(posedArchive)), "posed.3mf"))
            val opened = until(workspace, "open") { it.ready && it.document == "posed.3mf" }
            val history = opened.undo to opened.dirty
            fun exported(archive: Boolean, selected: List<String>, label: String) {
                val target = Target()
                val answer = done(workspace.exportStl(archive, target))
                val case = expected(archive, selected)
                check(answer == ModelExports.stl(case.get("replyJson") as String), "workspace answer $label")
                val bytes = target.bytes.toByteArray()
                check(target.opened && bytes.size.toLong() == (case.get("bytes") as Number).toLong() && sha(bytes) == case.get("sha256"), "workspace bytes $label")
                check((workspace.view.undo to workspace.view.dirty) == history, "export leaves the history $label")
            }
            // Export as 3MF…: the browser's Save of this very state, byte for byte; the project stays unsaved.
            val project = Target()
            val saved = done(workspace.export3mf(project)) as ProjectArchiveExport.Written
            val posedCase = objects(reference.get("projects")).single { it.get("state") == "posed" }
            check(saved == ModelExports.projectArchive(posedCase.get("replyJson") as String) && saved.filename == "Untitled project.3mf", "workspace 3MF $saved")
            check(sha(project.bytes.toByteArray()) == posedCase.get("sha256") && (workspace.view.undo to workspace.view.dirty) == history, "workspace 3MF bytes")
            exported(false, emptyList(), "plate")
            exported(true, emptyList(), "plate archive")
            done(workspace.selectInstance(instances.first()))
            until(workspace, "one") { it.selection.instances == setOf(instances.first()) }
            exported(false, listOf(instances.first()), "one")
            exported(true, listOf(instances.first()), "one archive")
            done(workspace.selectInstance(instances.last()))
            until(workspace, "last") { it.selection.instances == setOf(instances.last()) }
            exported(false, listOf(instances.last()), "last")
            // A destination that cannot be opened fails the export, in the provider's redacted code.
            val unopened = Target(failing = true)
            val thrown = failure(workspace.exportStl(false, unopened))
            check(unopened.opened && thrown != null && thrown.message?.contains("PRIVATE") != true, "failing destination ${thrown?.message}")
            // A negative volume: refused in the browser's words; the destination never opens.
            done(workspace.selectInstance(instances.first()))
            until(workspace, "first again") { it.selection.instances == setOf(instances.first()) }
            val added = done(workspace.setNegativePart()) as NegativePartResult.Added
            until(workspace, "negative") { it.undo == "Add negative part to object" }
            for (archive in listOf(false, true)) {
                val target = Target()
                val answer = done(workspace.exportStl(archive, target))
                check(answer == StlExport.Refused("Volume ${added.added.volumeId} requires canonical CSG before STL export") && !target.opened, "negative refused $archive $answer")
            }
            done(workspace.undo())
            until(workspace, "undone") { it.undo == history.first }
            exported(false, listOf(instances.first()), "after undo")
        }

        // An imported cube exports under its name.
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            val empty = Target()
            check(done(workspace.exportStl(false, empty)) == StlExport.Refused("STL export requires at least one instance") && !empty.opened, "empty plate")
            check(done(workspace.exportStl(true, Target())) == StlExport.Refused("No models to export"), "empty archive")
            // An empty project saves (the browser's Save does too), under the project's name.
            val blank = Target()
            check((done(workspace.export3mf(blank)) as ProjectArchiveExport.Written).filename == "Untitled project.3mf" && blank.opened, "empty 3MF")
            done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            until(workspace, "import") { it.undo != null }
            val target = Target()
            val answer = done(workspace.exportStl(false, target)) as StlExport.Written
            val bytes = target.bytes.toByteArray()
            check(answer.filename == "cube.stl" && answer.triangleCount == 12L && answer.instanceCount == 1L && answer.mediaType == ModelExports.STL_MEDIA_TYPE, "cube $answer")
            check(bytes.size == 84 + 50 * 12 && String(bytes, 0, 27, Charsets.US_ASCII) == "OrcaXR canonical binary STL" && bytes[80].toInt() == 12, "cube bytes")
            check(ModelExports.exportedStatus(answer) { "%,d".format(it) } == "Exported 1 model as 12 STL triangles.", "status")
            check(ModelExports.failedStatus("x") == "STL export failed: x", "failed status")
        }
        return checks
    }

    private fun objects2(value: Any): List<String> = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
}
