package dev.orcaxr.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Shared host/device checks against real JNI and independently authored fixtures. */
object ProjectActorClipboardChecks {
    private fun await(latch: CountDownLatch) { check(latch.await(10, TimeUnit.SECONDS)) { "clipboard_check_timeout" } }
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
    private fun refused(request: ProjectRequest, reason: ProjectRefusal) { check(result(request) == ProjectOutcome.NotStarted(reason)) }
    private val limits = ProjectStagingClipboardOptions(2, 57)
    private val pool = ProjectStagingPoolOptions(4, 4096, 16_777_216)
    private fun options(bytes: Int) = ProjectStagingInputOptions(bytes.toLong(), 1_000_000, 4_000_000, 1024, 128, 4096, 16_777_216)
    private fun upload(scope: ProjectPreparation, source: String, mesh: ByteArray, svg: ByteArray): ProjectUpload {
        val bytes = source.toByteArray(Charsets.UTF_8)
        val input = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 4_000_000, 1024, 128, 3, 4096, 4096, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.CHROMIUM))
        for (start in bytes.indices step 997) input.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + 997, bytes.size)))
        input.sealDocument(); check(input.assetCount() == 3L)
        listOf(mesh, svg, svg).forEachIndexed { i, data -> input.beginAsset(i.toLong()); input.appendAsset(0, data); input.finishAsset() }
        return input
    }
    private fun actor(source: String, mesh: ByteArray, svg: ByteArray, raw: AtomicReference<ProjectSession> = AtomicReference(), effects: (ProjectEffects) -> Unit = {}, staging: ProjectStagingPoolOptions = pool): ProjectActor =
        ProjectActor.open({ scope, nonce -> upload(scope, source, mesh, svg).open(nonce).also { raw.set(it) } }, effects, staging = staging)
            .also { check(completed(it.ready).reply.result is ProjectIntents.SessionResult.Welcome) }
    private fun node(snapshot: ProjectSnapshot, plate: Long = 0): ProjectQueryNode = snapshot.query().use { root ->
        root.children(QueryRelation.PLATES, 4096).use { plates -> plates.node(plate).use { p ->
            p.children(QueryRelation.OBJECTS, 0).use { objects -> objects.node(0) }
        } }
    }
    private fun copy(owner: ProjectActor, plate: Long = 0) = result(owner.copyObject(guard(owner), limits) { _, snapshot -> node(snapshot, plate) }) as ProjectOutcome.Copied
    private fun write(writer: ProjectCommandWriter, bytes: ByteArray) { for (start in bytes.indices step 73) writer.append(bytes.copyOfRange(start, minOf(start + 73, bytes.size))) }
    private fun paste(owner: ProjectActor, identity: ProjectActorClipboard, bytes: ByteArray, expected: ProjectActorGuard = guard(owner)) =
        owner.preparePaste(expected, identity, bytes.size.toLong(), options(bytes.size)) { _, _, writer -> write(writer, bytes) }
    private fun undo(owner: ProjectActor, reply: ProjectOutcome.Completed) = completed(owner.submit(ProjectIntents.SessionOperation.Undo(state(reply).guard)))

    @JvmStatic fun run(source: String, payload: String, mesh: ByteArray, svg: ByteArray): Long {
        var checks = 0L
        val bytes = payload.toByteArray(Charsets.UTF_8)
        val raw = AtomicReference<ProjectSession>()
        actor(source, mesh, svg, raw).use { owner ->
            repeat(20) {
                val copied = copy(owner)
                check(copied.clipboard.info == ProjectClipboardInfo(2, 1, 1, 2, 57))
                val added = completed(paste(owner, copied.clipboard, bytes)); check(state(added).changed)
                check(raw.get().stagingUsage() == ProjectStagingUsage(0, 0, 0))
                check(state(undo(owner, added)).history.redoCount == 1L)
            }
            check(result(owner.clearClipboard()) is ProjectOutcome.ClipboardCleared)
        }; checks++

        // A failed newer copy invalidates an older in-flight result, while keeping
        // the previously completed clipboard. No late result revives itself.
        actor(source, mesh, svg).use { owner ->
            val previous = copy(owner); val start = CountDownLatch(1); val resume = CountDownLatch(1)
            val older = owner.copyObject(guard(owner), limits) { _, snapshot -> start.countDown(); await(resume); node(snapshot) }
            await(start)
            refused(owner.copyObject(guard(owner), limits) { _, _ -> error("PRIVATE selector failure") }, ProjectRefusal.PREPARATION_FAILED)
            resume.countDown(); refused(older, ProjectRefusal.STALE)
            check(state(completed(paste(owner, previous.clipboard, bytes))).changed)
        }; checks++

        actor(source, mesh, svg).use { owner ->
            val previous = copy(owner); val start = CountDownLatch(1); val resume = CountDownLatch(1); val stopped = CountDownLatch(1)
            val retained = AtomicReference<ProjectSnapshot>()
            val pending = owner.copyObject(guard(owner), limits) { _, snapshot ->
                retained.set(snapshot); start.countDown()
                try { waitIgnoringInterrupt(resume); node(snapshot) } finally { stopped.countDown() }
            }
            await(start); check(pending.cancel()); refused(pending, ProjectRefusal.CANCELLED)
            check(runCatching { retained.get().revision() }.exceptionOrNull()?.message == "closed")
            resume.countDown(); await(stopped)
            check(state(completed(paste(owner, previous.clipboard, bytes))).changed)
        }; checks++

        actor(source, mesh, svg).use { owner ->
            val previous = copy(owner); val before = query(owner)
            val start = CountDownLatch(1); val resume = CountDownLatch(1)
            val pending = owner.copyObject(checkNotNull(before.authority), limits) { _, snapshot -> start.countDown(); await(resume); node(snapshot) }
            await(start)
            val add = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate("import:plate:clipboard-edit".map { it.code }, listOf(78), 4.0, false))
            completed(owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add)))))
            resume.countDown(); refused(pending, ProjectRefusal.STALE)
            refused(owner.copyObject(checkNotNull(before.authority), limits) { _, _ -> error("stale selector ran") }, ProjectRefusal.STALE)
            check(state(completed(paste(owner, previous.clipboard, bytes))).changed)
        }; checks++

        actor(source, mesh, svg).use { owner ->
            copy(owner); val expected = guard(owner); val start = CountDownLatch(2); val resume = CountDownLatch(1); val stopped = CountDownLatch(2)
            val pending = (0 until 3).map { owner.copyObject(expected, limits) { _, snapshot ->
                start.countDown(); try { waitIgnoringInterrupt(resume); node(snapshot) } finally { stopped.countDown() }
            } }
            await(start)
            refused(owner.copyObject(expected, limits) { _, _ -> error("quota selector ran") }, ProjectRefusal.RESOURCE_LIMIT)
            pending.forEach { check(it.cancel()); refused(it, ProjectRefusal.CANCELLED) }
            resume.countDown(); await(stopped)
            check(copy(owner).clipboard.info.assets == 2L)
        }; checks++

        actor(source, mesh, svg).use { owner ->
            val copied = copy(owner); val start = CountDownLatch(1); val resume = CountDownLatch(1)
            val pending = owner.preparePaste(guard(owner), copied.clipboard, bytes.size.toLong(), options(bytes.size)) { _, _, writer -> start.countDown(); await(resume); write(writer, bytes) }
            await(start); check(result(owner.clearClipboard()) is ProjectOutcome.ClipboardCleared)
            refused(paste(owner, copied.clipboard, bytes), ProjectRefusal.STALE)
            resume.countDown(); check(state(completed(pending)).changed)
        }; checks++

        actor(source, mesh, svg, raw).use { owner ->
            val copied = copy(owner); val start = CountDownLatch(1); val resume = CountDownLatch(1); val stopped = CountDownLatch(1)
            val pending = owner.preparePaste(guard(owner), copied.clipboard, bytes.size.toLong(), options(bytes.size)) { _, _, writer ->
                start.countDown(); try { waitIgnoringInterrupt(resume); write(writer, bytes) } finally { stopped.countDown() }
            }
            await(start); check(pending.cancel()); refused(pending, ProjectRefusal.CANCELLED)
            check(raw.get().stagingUsage() == ProjectStagingUsage(0, 0, 0))
            resume.countDown(); await(stopped)
            check(state(completed(paste(owner, copied.clipboard, bytes))).changed)
        }; checks++

        actor(source, mesh, svg).use { first -> actor(source, mesh, svg).use { second ->
            val clipboard = copy(first).clipboard
            refused(paste(second, clipboard, bytes), ProjectRefusal.STALE)
            refused(first.copyObject(guard(second), limits) { _, _ -> error("foreign selector ran") }, ProjectRefusal.STALE)
            val replaced = copy(first).clipboard
            refused(paste(first, clipboard, bytes), ProjectRefusal.STALE)
            check(state(completed(paste(first, replaced, bytes))).changed)
        } }; checks++

        actor(source, mesh, svg).use { owner ->
            val copied = copy(owner); val start = CountDownLatch(1); val resume = CountDownLatch(1)
            val pending = owner.preparePaste(guard(owner), copied.clipboard, bytes.size.toLong(), options(bytes.size)) { _, _, writer -> start.countDown(); await(resume); write(writer, bytes) }
            await(start); val replacement = copy(owner)
            resume.countDown(); val added = completed(pending); check(state(added).changed)
            val undone = undo(owner, added)
            check(state(completed(paste(owner, replacement.clipboard, bytes, checkNotNull(undone.authority)))).changed)
        }; checks++

        val owner = actor(source, mesh, svg)
        val start = CountDownLatch(1); val resume = CountDownLatch(1); val stopped = CountDownLatch(1)
        val pending = owner.copyObject(guard(owner), limits) { _, snapshot ->
            start.countDown(); try { waitIgnoringInterrupt(resume); node(snapshot) } finally { stopped.countDown() }
        }
        await(start); owner.close(); refused(pending, ProjectRefusal.CLOSED)
        resume.countDown(); await(stopped)
        val owners = (0 until ProjectStaging.MAX_CLIPBOARDS).map { actor(source, mesh, svg).also { copy(it) } }
        try { owners.forEach { check(query(it).authority != null) } } finally { owners.forEach { it.close() } }
        checks++

        actor(source, mesh, svg).use { owner ->
            val expected = guard(owner)
            refused(owner.copyObject(expected, limits) { _, snapshot -> snapshot.query() }, ProjectRefusal.PREPARATION_FAILED)
            refused(owner.copyObject(expected, ProjectStagingClipboardOptions(1, 57)) { _, snapshot -> node(snapshot) }, ProjectRefusal.RESOURCE_LIMIT)
            refused(owner.copyObject(expected, ProjectStagingClipboardOptions(-1, 0)) { _, _ -> error("invalid options") }, ProjectRefusal.INVALID_REQUEST)
            val previous = copy(owner); val started = CountDownLatch(1); val finish = CountDownLatch(1)
            val late = owner.copyObject(guard(owner), limits) { _, snapshot -> started.countDown(); await(finish); node(snapshot) }
            await(started); check(result(owner.clearClipboard()) is ProjectOutcome.ClipboardCleared)
            finish.countDown(); refused(late, ProjectRefusal.STALE)
            refused(paste(owner, previous.clipboard, bytes), ProjectRefusal.STALE)
        }; checks++

        actor(source, mesh, svg, staging = ProjectStagingPoolOptions(0, 0, 0)).use { owner ->
            val copied = copy(owner)
            refused(paste(owner, copied.clipboard, bytes), ProjectRefusal.RESOURCE_LIMIT)
            check(query(owner).authority != null)
        }; checks++
        // Raw owner conversion after source closure, including a saturated native
        // registry. No second slot is needed; repeated conversion preserves data.
        ProjectPreparation().use { scope ->
            val session = scope.own(upload(scope, source, mesh, svg).open())
            val expected = scope.own(session.captureGuard())
            val snapshot = scope.own(session.snapshot())
            val selected = scope.own(node(snapshot))
            val input = scope.own(session.clipboardInput(expected, limits))
            val handle = input.reference()
            session.close()
            val held = mutableListOf<ProjectSelectionInput>()
            try {
                while (true) try { held.add(ProjectSelectionInput()) }
                catch (failure: IllegalStateException) { check(failure.message == "resource_limit"); break }
                check(held.size > 4000)
                val copied = scope.own(input.capture(selected))
                check(runCatching { input.reference() }.exceptionOrNull()?.message == "closed")
                check(runCatching { NativeProject.clipboardInputCapture(handle, selected.reference()) }.exceptionOrNull()?.message == "invalid_handle_kind")
                check(copied.info() == ProjectClipboardInfo(2, 1, 1, 2, 57))
            } finally { held.forEach { it.close() } }
        }; checks++
        return checks
    }

    /** Full acknowledgement/effect comparison from the independent TypeScript
     * fixture, including sorted plate projection. Clear occurs after upload capture. */
    @JvmStatic fun replay(source: String, payload: String, mesh: ByteArray, svg: ByteArray, plate: Long, expectedReply: String, expectedEffects: LongArray): Long {
        val expected = (ProjectIntents.decodeSessionReply(expectedReply).result as ProjectIntents.SessionResult.Acknowledged).value
        val effects = mutableListOf<Long>(); val bytes = payload.toByteArray(Charsets.UTF_8)
        actor(source, mesh, svg, effects = { e -> for (i in 0 until e.count()) effects.add(e.kind(i).toLong()) }).use { owner ->
            val before = query(owner); val copied = copy(owner, plate)
            val started = CountDownLatch(1); val finish = CountDownLatch(1)
            val pending = owner.preparePaste(checkNotNull(before.authority), copied.clipboard, bytes.size.toLong(), options(bytes.size)) { _, _, writer ->
                check(Thread.currentThread().name == "orcaxr-prepare"); started.countDown(); await(finish); write(writer, bytes)
            }
            await(started); check(result(owner.clearClipboard()) is ProjectOutcome.ClipboardCleared)
            finish.countDown(); val pasted = completed(pending)
            check(state(pasted) == expected && effects == expectedEffects.toList())
            val undone = undo(owner, pasted)
            check(state(undone).guard.semanticHash == state(before).guard.semanticHash)
            val redone = completed(owner.submit(ProjectIntents.SessionOperation.Redo(state(undone).guard)))
            check(state(redone).guard.semanticHash == expected.guard.semanticHash)
        }
        return 1
    }
}
