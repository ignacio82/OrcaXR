package dev.orcaxr.core

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Real JNI streaming, immutable bundles and output/checkpoint lifetime races. */
object ProjectActorExportChecks {
    private fun await(latch: CountDownLatch) { check(latch.await(10, TimeUnit.SECONDS)) { "export_check_timeout" } }
    private fun waitIgnoringInterrupt(latch: CountDownLatch) {
        var interrupted = false
        while (true) try { await(latch); break } catch (_: InterruptedException) { interrupted = true }
        if (interrupted) Thread.currentThread().interrupt()
    }
    private fun result(request: ProjectRequest) = request.completion.toCompletableFuture().get(10, TimeUnit.SECONDS)
    private fun completed(request: ProjectRequest) = result(request) as ProjectOutcome.Completed
    private fun state(value: ProjectOutcome.Completed) = (value.reply.result as ProjectIntents.SessionResult.Acknowledged).value
    private fun query(owner: ProjectActor) = completed(owner.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)))
    private fun guard(owner: ProjectActor) = checkNotNull(query(owner).authority)
    private fun exported(request: ProjectRequest) = result(request) as ProjectOutcome.Exported
    private fun refused(request: ProjectRequest, reason: ProjectRefusal) { check(result(request) == ProjectOutcome.NotStarted(reason)) }
    private fun dirty(owner: ProjectActor) = state(query(owner)).history.dirtyCategories.isNotEmpty()
    private val limits = ProjectExportLimits(16_777_216, 3, 78)
    private val discard = object : OutputStream() { override fun write(value: Int) {} ; override fun write(bytes: ByteArray, offset: Int, count: Int) {} }
    private fun upload(scope: ProjectPreparation, source: String, assets: List<ByteArray>, resolver: LocalTimestampResolver = LocalTimestampResolver { it }): ProjectUpload {
        val bytes = source.toByteArray(Charsets.UTF_8)
        val input = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 3, 4096, 4096, 100, 33_554_432), resolver, ProjectIntegerProfile.CHROMIUM))
        for (start in bytes.indices step 997) input.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + 997, bytes.size)))
        input.sealDocument(); check(input.assetCount() == assets.size.toLong())
        assets.forEachIndexed { i, data -> input.beginAsset(i.toLong()); input.appendAsset(0, data); input.finishAsset() }
        return input
    }
    private fun actor(source: String, assets: List<ByteArray>, raw: AtomicReference<ProjectSession> = AtomicReference(), effects: (ProjectEffects) -> Unit = {}, resolver: LocalTimestampResolver = LocalTimestampResolver { it }): ProjectActor =
        ProjectActor.open({ scope, nonce -> upload(scope, source, assets, resolver).open(nonce).also { raw.set(it) } }, effects)
            .also { check(completed(it.ready).reply.result is ProjectIntents.SessionResult.Welcome) }
    private fun write(source: ProjectExportSource, assets: List<ByteArray>, json: OutputStream = discard) {
        check(Thread.currentThread().name == "orcaxr-prepare")
        check(source.assetCount == assets.size.toLong())
        source.writeJson(json)
        for ((index, expected) in assets.withIndex()) {
            check(source.assetLength(index.toLong()) == expected.size.toLong())
            val idLength = source.assetIdLength(index.toLong()); check(idLength > 0)
            check(source.assetId(index.toLong(), 0, idLength).size.toLong() == idLength)
            val output = ByteArrayOutputStream()
            check(source.writeAsset(index.toLong(), output) == expected.size.toLong())
            check(output.toByteArray().contentEquals(expected))
        }
    }
    private fun edit(owner: ProjectActor, id: String = "import:plate:export-edit", order: Double = 4.0): ProjectOutcome.Completed {
        val before = query(owner)
        val add = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(id.map { it.code }, listOf(78), order, false))
        val result = completed(owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add)))))
        check((result.reply.result as? ProjectIntents.SessionResult.Acknowledged)?.value?.changed == true) { "export_edit_not_committed_${(result.reply.result as? ProjectIntents.SessionResult.Error)?.value}" }
        return result
    }
    @JvmStatic fun run(source: String, canonical: String, mesh: ByteArray, svg: ByteArray, empty: String, large: String, largeCanonical: String): Long {
        val assets = listOf(mesh, svg, svg)
        var checks = 0L
        // Independent TypeScript canonical bytes, including all UTF-16 units and
        // enough text to cross many JNI chunks. Owned arrays survive later calls.
        ProjectPreparation().use { scope ->
            val session = scope.own(upload(scope, large, assets).open())
            val expected = scope.own(session.captureGuard())
            val capture = scope.own(session.captureExport(expected))
            val snapshot = scope.own(capture.project())
            session.close()
            val bytes = largeCanonical.toByteArray(Charsets.UTF_8)
            val chunks = mutableListOf<ByteArray>()
            check(snapshot.writeJson(bytes.size.toLong()) { chunk -> check(chunk.isNotEmpty() && chunk.size <= ProjectHost.MAX_CHUNK_BYTES); chunks.add(chunk) } == bytes.size.toLong())
            check(chunks.size > 8)
            val output = ByteArrayOutputStream(); chunks.forEach { output.write(it) }; check(output.toByteArray().contentEquals(bytes))
            var calls = 0
            check(runCatching { snapshot.writeJson(0) { calls++ } }.exceptionOrNull()?.message == "output_limit" && calls == 0)
            check(runCatching { snapshot.writeJson(bytes.size.toLong() - 1) {} }.exceptionOrNull()?.message == "output_limit")
            check(runCatching { snapshot.writeJson(bytes.size.toLong()) { error("PRIVATE destination failure") } }.exceptionOrNull()?.message == "export_service")
            snapshot.writeJson(bytes.size.toLong()) { check(runCatching { snapshot.hash() }.exceptionOrNull()?.message == "busy_or_failed") }
            calls = 0
            check(runCatching { snapshot.writeJson(bytes.size.toLong()) { calls++; snapshot.close() } }.exceptionOrNull()?.message == "closed")
            check(calls == 1)
            for ((index, data) in assets.withIndex()) capture.asset(index.toLong()).use { check(it.read(0, it.length()).contentEquals(data)) }
        }; checks++

        actor(source, assets).use { owner ->
            val retained = AtomicReference<ProjectExportSource>(); val output = ByteArrayOutputStream()
            val done = exported(owner.exportDocument(guard(owner), limits) { _, captured -> retained.set(captured); write(captured, assets, output) })
            check(done.checkpoint == ProjectCheckpoint.NOT_REQUESTED && done.projection == ProjectProjection.DELIVERED)
            check(output.toByteArray().contentEquals(canonical.toByteArray(Charsets.UTF_8)))
            check(runCatching { retained.get().writeJson(discard) }.exceptionOrNull()?.message == "closed_export")
            edit(owner); check(dirty(owner))
            exported(owner.exportDocument(guard(owner), limits) { _, captured -> write(captured, assets) })
            check(dirty(owner))
        }; checks++

        val events = mutableListOf<Int>()
        actor(source, assets, effects = { e -> for (i in 0 until e.count()) events.add(e.kind(i)) }).use { owner ->
            repeat(20) {
                edit(owner, "import:plate:export-$it", it + 1.0); check(dirty(owner)) { "export_edit_not_dirty_$it" }; events.clear()
                val saved = exported(owner.saveDocument(guard(owner), limits) { _, captured -> write(captured, assets) })
                check(saved.checkpoint == ProjectCheckpoint.SAVED && saved.projection == ProjectProjection.DELIVERED)
                check(events == listOf(ProjectHost.EFFECT_HISTORY)) { "checkpoint_effects_${it}_${events.joinToString(",")}" }
                check(!dirty(owner)) { "checkpoint_still_dirty" }
            }
        }; checks++

        // The actual JNI sink callback is blocked while the live authority still
        // answers queries and commits an edit; the exported document stays frozen.
        actor(source, assets).use { owner ->
            val entered = CountDownLatch(1); val resume = CountDownLatch(1); val output = ByteArrayOutputStream()
            val destination = object : OutputStream() {
                override fun write(value: Int) { error("unexpected scalar write") }
                override fun write(bytes: ByteArray, offset: Int, count: Int) { entered.countDown(); await(resume); output.write(bytes, offset, count) }
            }
            val save = owner.saveDocument(guard(owner), limits) { _, captured -> write(captured, assets, destination) }
            await(entered); check(!save.cancel()); val changed = edit(owner)
            resume.countDown(); check(exported(save).checkpoint == ProjectCheckpoint.STALE)
            check(state(query(owner)).guard == state(changed).guard && dirty(owner))
            check(output.toByteArray().contentEquals(canonical.toByteArray(Charsets.UTF_8)))
        }; checks++

        actor(source, assets).use { owner ->
            val expected = guard(owner); val entered = CountDownLatch(1); val resume = CountDownLatch(1)
            val save = owner.saveDocument(expected, limits) { _, captured -> entered.countDown(); await(resume); write(captured, assets) }
            await(entered)
            check(result(owner.resetDocument(expected) { upload(it, empty, emptyList()).prepare() }) is ProjectOutcome.Reset)
            val after = state(query(owner)).guard
            resume.countDown(); check(exported(save).checkpoint == ProjectCheckpoint.STALE)
            check(state(query(owner)).guard == after)
            check(exported(owner.saveDocument(guard(owner), limits.copy(assets = 0, assetBytes = 0)) { _, captured -> write(captured, emptyList()) }).checkpoint == ProjectCheckpoint.SAVED)
        }; checks++

        val raw = AtomicReference<ProjectSession>()
        actor(source, assets, raw).use { owner ->
            edit(owner); val before = guard(owner)
            raw.get().captureGuard().use { raw.get().acknowledgeCheckpoint(it).close() }
            val entered = CountDownLatch(1); val resume = CountDownLatch(1)
            val save = owner.saveDocument(before, limits) { _, captured -> entered.countDown(); await(resume); write(captured, assets) }
            await(entered); raw.get().captureGuard().use { raw.get().acknowledgeCheckpoint(it).close() }
            resume.countDown(); check(exported(save).checkpoint == ProjectCheckpoint.SAVED); check(!dirty(owner))
        }; checks++

        actor(source, assets).use { owner ->
            val entered = CountDownLatch(2); val resume = CountDownLatch(1)
            val blockers = (0 until 2).map { owner.openDocument { entered.countDown(); waitIgnoringInterrupt(resume); error("cancelled provider") } }
            await(entered)
            val queued = owner.saveDocument(guard(owner), limits) { _, _ -> error("cancelled export callback ran") }
            check(queued.cancel()); refused(queued, ProjectRefusal.CANCELLED)
            blockers.forEach { check(it.cancel()) }; resume.countDown(); blockers.forEach { refused(it, ProjectRefusal.CANCELLED) }
            check(exported(owner.saveDocument(guard(owner), limits) { _, captured -> write(captured, assets) }).checkpoint == ProjectCheckpoint.SAVED)
        }; checks++

        actor(source, assets).use { owner ->
            edit(owner)
            check(result(owner.saveDocument(guard(owner), limits) { _, _ -> error("PRIVATE handoff failure") }) == ProjectOutcome.Uncertain)
            check(dirty(owner))
            check(result(owner.saveDocument(guard(owner), limits) { _, captured -> captured.writeJson(discard) }) == ProjectOutcome.Uncertain)
            check(dirty(owner))
            check(result(owner.saveDocument(guard(owner), limits.copy(jsonBytes = 1)) { _, captured -> write(captured, assets) }) == ProjectOutcome.Uncertain)
            check(dirty(owner)); check(exported(owner.saveDocument(guard(owner), limits) { _, captured -> write(captured, assets) }).checkpoint == ProjectCheckpoint.SAVED)
        }; checks++

        val closing = actor(source, assets); val entered = CountDownLatch(1); val resume = CountDownLatch(1); val stopped = CountDownLatch(1)
        val retained = AtomicReference<ProjectExportSource>()
        val pending = closing.saveDocument(guard(closing), limits) { _, captured ->
            retained.set(captured); entered.countDown()
            try { waitIgnoringInterrupt(resume); write(captured, assets) } finally { stopped.countDown() }
        }
        await(entered); check(!pending.cancel()); closing.close(); check(result(pending) == ProjectOutcome.Uncertain)
        resume.countDown(); await(stopped)
        check(runCatching { retained.get().writeJson(discard) }.isFailure)
        checks++

        // Fill the registry only after writing the complete bundle. A checkpoint
        // allocation refusal cannot erase the confirmed external handoff.
        actor(source, assets).use { owner ->
            edit(owner); val held = mutableListOf<ProjectSelectionInput>()
            try {
                val saved = exported(owner.saveDocument(guard(owner), limits) { _, captured ->
                    write(captured, assets)
                    while (true) try { held.add(ProjectSelectionInput()) }
                    catch (failure: IllegalStateException) { check(failure.message == "resource_limit"); break }
                    check(held.size > 4000)
                })
                check(saved.checkpoint == ProjectCheckpoint.UNAVAILABLE && saved.projection == ProjectProjection.DELIVERED)
            } finally { held.forEach { it.close() } }
            check(dirty(owner))
        }; checks++

        actor(source, assets).use { owner -> actor(source, assets).use { foreign ->
            val before = guard(owner)
            refused(owner.saveDocument(guard(foreign), limits) { _, _ -> error("foreign callback") }, ProjectRefusal.STALE)
            refused(owner.saveDocument(before, limits.copy(assets = 2)) { _, _ -> error("over quota callback") }, ProjectRefusal.RESOURCE_LIMIT)
            refused(owner.saveDocument(before, limits.copy(assetBytes = 77)) { _, _ -> error("over quota callback") }, ProjectRefusal.RESOURCE_LIMIT)
            refused(owner.saveDocument(before, limits.copy(jsonBytes = -1)) { _, _ -> error("invalid callback") }, ProjectRefusal.INVALID_REQUEST)
            edit(owner); refused(owner.saveDocument(before, limits) { _, _ -> error("stale callback") }, ProjectRefusal.STALE)
        } }; checks++

        // Explicit queue observation proves handoff completion before closing a
        // blocked authority. No sleep-based guess about the worker's phase.
        val local = Regex("\"(createdAt|updatedAt)\":\"[^\"]*\"").replace(source) { "\"${it.groupValues[1]}\":\"2026-10-05T12:00:00\"" }
        val armed = AtomicBoolean(false); val editing = CountDownLatch(1); val releaseEdit = CountDownLatch(1)
        actor(local, assets, resolver = LocalTimestampResolver { value -> if (armed.get()) { editing.countDown(); waitIgnoringInterrupt(releaseEdit) }; value }).use { owner ->
            val before = query(owner); val writing = CountDownLatch(1); val releaseWrite = CountDownLatch(1)
            val save = owner.saveDocument(checkNotNull(before.authority), limits) { _, captured -> write(captured, assets); writing.countDown(); await(releaseWrite) }
            await(writing); armed.set(true)
            val add = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate("import:plate:blocked-export".map { it.code }, listOf(78), 5.0, false))
            val edit = owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add))))
            await(editing); releaseWrite.countDown()
            val field = ProjectActor::class.java.getDeclaredField("authority").apply { isAccessible = true }
            val executor = field.get(owner) as ThreadPoolExecutor
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (executor.queue.isEmpty() && System.nanoTime() < deadline) Thread.yield()
            check(executor.queue.isNotEmpty()); owner.close()
            val delivered = exported(save)
            check(delivered.checkpoint == ProjectCheckpoint.UNAVAILABLE && delivered.projection == ProjectProjection.CLOSED)
            check(result(edit) == ProjectOutcome.Uncertain); releaseEdit.countDown()
        }; checks++
        val failProjection = AtomicBoolean(false)
        actor(source, assets, effects = { if (failProjection.get()) error("PRIVATE projection failure") }).use { owner ->
            edit(owner); failProjection.set(true)
            val done = exported(owner.saveDocument(guard(owner), limits) { _, captured -> write(captured, assets) })
            check(done.checkpoint == ProjectCheckpoint.SAVED && done.projection == ProjectProjection.FAILED)
            check(!dirty(owner))
        }; checks++
        return checks
    }
}
