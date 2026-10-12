package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** The external slicer route through real JNI and OkHttp against the real
 * slicer server: the engine attested (and refused without its token or
 * without a usable address); plate 1 of a two-plate project written by the
 * Project area as the one-plate archive an external slicer loads, its
 * overrides the plate's, reopening as that plate alone, an unknown and an
 * unprintable plate refused with the browser's messages before anything is
 * written; the archive tagged with the project state it was written from,
 * which its plate's preflight describes too (the unprintable plate's blocks)
 * and a new project leaves; the archive
 * sliced — submitted, polled with progress, the artifact streamed byte for
 * byte with its digest checked, released; a download cut off halfway and one
 * whose bytes did not match fetched again from the result the server keeps,
 * into a fresh output, checked and released; a held job cancelled and the
 * cancellation confirmed; a failed job reported in the policy's words; a
 * tokenless slice and an unusable address refused before any upload. */
object ProjectExternalSlicerClientChecks {
    private const val WAIT_S = 60L

    private class Memory(var bytes: ByteArray = ByteArray(0)) : ProjectDocumentInput, ProjectDocumentOutput {
        var opened = false
        override val reportedLength: Long? get() = bytes.size.toLong().takeIf { it > 0 }
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream {
            opened = true
            return object : ByteArrayOutputStream() {
                override fun close() { bytes = toByteArray() }
            }
        }
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun hex(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun failure(future: CompletableFuture<*>): Throwable? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        thrown.cause
    }
    private fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "view never settled: ${workspace.view}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun plates(view: ProjectView): List<String> = view.rows.mapNotNull { row ->
        ((row.entity as? ProjectIntents.OptionalObjectTreeEntity.Value)?.value as? ProjectIntents.ObjectTreeEntity.Plate)?.value?.let(::text)
    }

    @JvmStatic fun run(endpoint: String, token: String, twoPlates: ByteArray, gcode: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val expected = gcode.toByteArray()
        ExternalSlicerClient().use { client ->
            // Attestation against the pinned build, with the token only.
            val attested = done(client.attest(endpoint, token))
            check(attested is ProjectIntents.ExternalSlicerAttestation.Attested, "attested $attested")
            val engine = (attested as ProjectIntents.ExternalSlicerAttestation.Attested).value
            check(engine.engine == ProjectIntents.ExternalSlicerEngine.Cli && text(engine.artifactHash).startsWith("sha256:"), "cli engine")
            check(!ExternalSlicerPolicy.supports(engine.engine, "wave-overhangs"), "cli features")
            // Idle until the server has closed the connection (Node: its 5 s keep-alive and 1 s of
            // grace), as while the operator types a token: never retried, the next request must not reuse it.
            Thread.sleep(7_000)
            check(done(client.attest(endpoint, token)) is ProjectIntents.ExternalSlicerAttestation.Attested, "attested_after_idle")
            val tokenless = done(client.attest(endpoint, null))
            check(
                (tokenless as? ProjectIntents.ExternalSlicerAttestation.Unattested)?.let { text(it.value) } ==
                    "The external slicer requires a token before it will report its engine.",
                "tokenless $tokenless",
            )
            val nowhere = done(client.attest("http://exa mple", token))
            check(
                (nowhere as? ProjectIntents.ExternalSlicerAttestation.Unattested)?.let { text(it.value) } ==
                    "The external slicer could not be reached to check its engine.",
                "unusable address $nowhere",
            )

            ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
                done(workspace.ready())
                done(workspace.open(Memory(twoPlates), "plates.3mf"))
                val opened = until(workspace) { it.plates == 2 && plates(it).size == 2 }
                val ids = plates(opened)
                check(ids.distinct().size == 2, "two plates $ids")

                // Refused with the browser's messages before anything is written:
                // an unknown plate, and this project's second plate, which is not printable.
                val untouched = Memory()
                val unknown = failure(workspace.projectPlate("import:plate:unknown", untouched))
                check((unknown as? ProjectFailure)?.message == "Unknown plate import:plate:unknown", "unknown plate $unknown")
                val unprintable = failure(workspace.projectPlate(ids[1], untouched))
                check((unprintable as? ProjectFailure)?.message == "Plate ${ids[1]} is not printable", "unprintable plate $unprintable")
                check(!untouched.opened, "a refused projection opens nothing")

                // Plate 1 as the archive an external slicer loads.
                val output = Memory()
                val plate = done(workspace.projectPlate(ids[0], output))
                check(output.bytes.size > 22 && output.bytes[0] == 'P'.code.toByte(), "plate archive written")
                check(plate.sourceHash.startsWith("fnv1a64:"), "plate fingerprint ${plate.sourceHash}")
                val inspected = done(workspace.actor.inspect { session -> session.snapshot().use { it.platePrintOverrides(ids[0]) } }
                    .completion.toCompletableFuture()) as ProjectOutcome.Inspected
                check(plate.overrides == inspected.result.getOrThrow(), "plate overrides ${plate.overrides}")
                check(!workspace.view.dirty, "the project's saved state is untouched")
                // The archive is the state the session last acknowledged; its preflight describes that state.
                check(plate.revision != null && plate.revision == workspace.view.revision, "plate revision ${plate.revision}")
                check(opened.activePlate?.id in ids && opened.activePlate?.printable == true, "active plate ${opened.activePlate}")
                val preflight = done(workspace.preflight(ids[0]))
                check(
                    preflight.revision == plate.revision && text(preflight.summary.plateId) == ids[0] &&
                        preflight.issues.size.toLong() == minOf(preflight.summary.issueCount, ProjectWorkspace.MAX_PREFLIGHT_ISSUES),
                    "plate preflight ${preflight.summary}",
                )
                val blocked = done(workspace.preflight(ids[1])).summary
                check(!blocked.canSlice && blocked.blockingCount > 0, "an unprintable plate's preflight blocks ${blocked}")
                ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { second ->
                    done(second.ready())
                    done(second.open(Memory(output.bytes), "plate.3mf"))
                    val reopened = until(second) { plates(it) == listOf(ids[0]) }
                    check(reopened.plates == 1, "one plate ${reopened.plates}")
                }

                // The slice: submitted, polled, streamed, checked and released.
                val archive = ExternalSlicerArchive(output.bytes.size.toLong()) { ByteArrayInputStream(output.bytes) }
                val tagged = plate.overrides + mapOf("orcaxr_test_archive" to hex(output.bytes), "orcaxr_test_plate" to "1")
                val sink = ByteArrayOutputStream()
                val progress = CopyOnWriteArrayList<ProjectIntents.ExternalSlicerProgress>()
                val sliced = done(client.slice(endpoint, token, archive, tagged, ExternalSlicerOutput { sink }) { progress += it }.result)
                check(sink.toByteArray().contentEquals(expected), "artifact streamed byte for byte")
                check(sliced.length == expected.size.toLong() && sliced.sha256 == hex(expected), "artifact facts $sliced")
                check(sliced.released, "result released")
                check(sliced.engine == engine, "attested engine")
                check(progress.any { it.percent == 25.0 && text(it.message) == "Generating G-code" }, "progress $progress")

                // A download cut off halfway, and one whose bytes did not match: the result the server
                // keeps is fetched again into a fresh output, checked the same way, and released.
                for (damage in listOf("drop", "corrupt")) {
                    val outputs = CopyOnWriteArrayList<ByteArrayOutputStream>()
                    val fetched = client.slice(endpoint, token, archive, tagged + ("orcaxr_test" to damage), ExternalSlicerOutput {
                        ByteArrayOutputStream().also { outputs += it }
                    })
                    val again = done(fetched.result)
                    check(
                        outputs.size == 2 && !outputs[0].toByteArray().contentEquals(expected) && outputs[1].toByteArray().contentEquals(expected),
                        "$damage: fetched again ${outputs.map { it.size() }}",
                    )
                    check(again.length == expected.size.toLong() && again.sha256 == hex(expected) && again.released, "$damage: checked and released $again")
                }

                // A held job, cancelled: the server confirms it.
                val holding = CountDownLatch(1)
                val held = client.slice(endpoint, token, archive, tagged + ("orcaxr_test" to "hold"), ExternalSlicerOutput { ByteArrayOutputStream() }) { holding.countDown() }
                check(holding.await(WAIT_S, TimeUnit.SECONDS), "held job running")
                held.cancel()
                check(failure(held.result) is CancellationException, "cancellation confirmed")

                // A failed job, in the policy's words; nothing private.
                val failed = failure(client.slice(endpoint, token, archive, tagged + ("orcaxr_test" to "fail"), ExternalSlicerOutput { ByteArrayOutputStream() }).result)
                check(
                    failed is ExternalSlicerException && failed.kind == ProjectIntents.ExternalSlicerFailureKind.Failed &&
                        failed.message!!.startsWith("External Slicer Failed: ") && !failed.message!!.contains("PRIVATE"),
                    "failed $failed",
                )

                // Refused before any upload: no token, an unusable address.
                val unattested = failure(client.slice(endpoint, null, archive, tagged, ExternalSlicerOutput { ByteArrayOutputStream() }).result)
                check(
                    unattested is ExternalSlicerException &&
                        unattested.message == "The external slicer requires a token before it will report its engine.",
                    "unattested $unattested",
                )
                val credentials = failure(client.slice("http://user:secret@127.0.0.1:9", token, archive, tagged, ExternalSlicerOutput { ByteArrayOutputStream() }).result)
                check(
                    credentials is ExternalSlicerException &&
                        credentials.message == "Canonical external slicer URLs cannot contain credentials, query parameters, or fragments.",
                    "credentials $credentials",
                )

                // A changed project is another state: output from the plate archive is stale.
                done(workspace.newProject())
                check(workspace.view.revision != null && workspace.view.revision != plate.revision, "a new revision ${workspace.view.revision}")
            }
        }
        // The policy's timing, as the browser's.
        check(ExternalSlicerPolicy.POLL_INTERVAL_MS == 700L && ExternalSlicerPolicy.CANCELLATION_TIMEOUT_MS == 30_000L, "browser timing")
        return checks
    }
}
