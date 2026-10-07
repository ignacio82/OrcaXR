package dev.orcaxr.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Real JNI with controlled timestamp/preparation callbacks, shared by JVM and device. */
object ProjectActorChecks {
    private fun await(latch: CountDownLatch) { check(latch.await(10, TimeUnit.SECONDS)) { "actor_check_timeout" } }
    private fun uninterruptibly(latch: CountDownLatch) {
        var interrupted = false
        while (true) try { await(latch); break } catch (_: InterruptedException) { interrupted = true }
        if (interrupted) Thread.currentThread().interrupt()
    }
    private fun outcome(request: ProjectRequest): ProjectOutcome = request.completion.toCompletableFuture().get(10, TimeUnit.SECONDS)
    private fun completed(request: ProjectRequest) = outcome(request) as ProjectOutcome.Completed
    private fun ack(request: ProjectRequest) = (completed(request).reply.result as ProjectIntents.SessionResult.Acknowledged).value
    private fun query(actor: ProjectActor) = actor.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty))
    private fun input(scope: ProjectPreparation, source: String, resolver: LocalTimestampResolver = LocalTimestampResolver { it }): ProjectUpload {
        val bytes = source.toByteArray(Charsets.UTF_8)
        val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 4_000_000, 1024, 128, 10, 16_777_216, 33_554_432, 100, 33_554_432)
        return scope.own(ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM)).also { upload ->
            for (start in bytes.indices step 997) {
                scope.checkActive()
                upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + 997, bytes.size)))
            }
            upload.sealDocument()
        }
    }
    private fun actor(source: String, effects: (ProjectEffects) -> Unit = {}, maxPending: Int = 32, resolver: LocalTimestampResolver = LocalTimestampResolver { it }) =
        ProjectActor.open({ scope, generation -> input(scope, source, resolver).open(generation) }, effects, maxPending).also {
            check((completed(it.ready).reply.result as ProjectIntents.SessionResult.Welcome).value.maxPending == 32L)
        }
    private fun add(guard: ProjectIntents.SessionGuard, id: List<Int> = "import:plate:actor".map { it.code }) = ProjectIntents.SessionOperation.Execute(
        ProjectIntents.GuardedIntent(guard, ProjectIntents.Intent(1, ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(id, listOf(78), 2.0, true)))))
    private fun refused(request: ProjectRequest, reason: ProjectRefusal) { check(outcome(request) == ProjectOutcome.NotStarted(reason)) }
    private fun closed(handle: ProjectHandle) {
        try { handle.reference() } catch (failure: IllegalStateException) { check(failure.message == "closed"); return }
        error("native handle leaked")
    }

    @JvmStatic fun run(source: String): Long {
        var passed = 0L
        fun actorThreads() = Thread.getAllStackTraces().keys.filter { it.name in setOf("orcaxr-project", "orcaxr-prepare", "orcaxr-effects") }.toSet()
        val originalThreads = actorThreads()
        val local = Regex("\"(createdAt|updatedAt)\":\"[^\"]*\"").replace(source) { "\"${it.groupValues[1]}\":\"2026-10-05T12:00:00\"" }
        // Effects are observed before acknowledgements and all reads/commits run
        // off the caller. Twenty full mutation/undo cycles leave no retained work.
        val caller = Thread.currentThread()
        val events = java.util.Collections.synchronizedList(mutableListOf<Int>())
        val capturedEffects = AtomicReference<ProjectEffects>()
        actor(source, { effects ->
            check(Thread.currentThread() !== caller && Thread.currentThread().name == "orcaxr-effects")
            capturedEffects.set(effects)
            for (i in 0 until effects.count()) events.add(effects.kind(i))
        }).use { actor ->
            repeat(20) {
                val before = ack(query(actor))
                events.clear()
                val added = ack(actor.submit(add(before.guard)))
                check(added.changed && added.history.undoCount == 1L)
                check(events.first() == ProjectHost.EFFECT_PROJECT && events.last() == ProjectHost.EFFECT_HISTORY)
                closed(capturedEffects.get())
                val undone = ack(actor.submit(ProjectIntents.SessionOperation.Undo(added.guard)))
                check(undone.history.undoCount == 0L && undone.history.redoCount == 1L)
            }
            passed++
        }

        // A blocked projection consumer keeps the entire admission charge and
        // cannot block the authority. Completing a public future cannot forge an ack.
        val delivering = CountDownLatch(1); val deliver = CountDownLatch(1)
        actor(source, { delivering.countDown(); await(deliver) }, 2).use { actor ->
            val mutation = actor.submit(add(ack(query(actor)).guard))
            val forged = mutation.completion.toCompletableFuture()
            forged.complete(ProjectOutcome.NotStarted(ProjectRefusal.CANCELLED))
            await(delivering)
            val queued = query(actor)
            refused(query(actor), ProjectRefusal.BUSY)
            check(!mutation.cancel())
            deliver.countDown()
            check(completed(mutation).projection == ProjectProjection.DELIVERED)
            check(ack(queued).history.undoCount == 1L)
            passed++
        }

        // The actual native command's timestamp callback holds the authority.
        // Queued cancellation must remove work, and submitted mutable lists must
        // already be captured even though their later stale guard is refused.
        val entered = CountDownLatch(1); val resume = CountDownLatch(1); val armed = AtomicBoolean(false)
        val resolver = LocalTimestampResolver { value -> if (armed.get()) { entered.countDown(); uninterruptibly(resume) }; value }
        actor(local, maxPending = 4, resolver = resolver).use { actor ->
            val guard = ack(query(actor)).guard
            armed.set(true)
            val active = actor.submit(add(guard))
            await(entered)
            val id = "import:plate:captured".map { it.code }.toMutableList()
            val pending = actor.submit(add(guard, id))
            id.clear()
            val cancelled = query(actor)
            check(cancelled.cancel()); refused(cancelled, ProjectRefusal.CANCELLED)
            check(!cancelled.cancel() && !active.cancel())
            resume.countDown()
            check(ack(active).changed)
            check(completed(pending).reply.result == ProjectIntents.SessionResult.Error(ProjectIntents.SessionError.Stale))
            check(ack(query(actor)).history.undoCount == 1L)
            passed++
        }

        // Open preparation is independent of the authority; edits while reading
        // invalidate the replacement, and a failed newer Open cannot revive it.
        actor(source).use { actor ->
            val started = CountDownLatch(1); val finish = CountDownLatch(1)
            val opening = actor.openDocument { scope -> started.countDown(); await(finish); input(scope, source).prepare() }
            await(started)
            val changed = ack(actor.submit(add(ack(query(actor)).guard)))
            finish.countDown()
            refused(opening, ProjectRefusal.STALE)
            check(ack(query(actor)).guard == changed.guard)
            val olderStarted = CountDownLatch(1); val olderFinish = CountDownLatch(1)
            val older = actor.openDocument { scope -> olderStarted.countDown(); await(olderFinish); input(scope, source).prepare() }
            await(olderStarted)
            refused(actor.openDocument { error("PRIVATE preparation detail") }, ProjectRefusal.PREPARATION_FAILED)
            olderFinish.countDown(); refused(older, ProjectRefusal.STALE)
            val opened = outcome(actor.openDocument { scope -> input(scope, source).prepare() }) as ProjectOutcome.Opened
            check(opened.history.undoCount == 0L && opened.history.dirtyCategories.isEmpty())
            check(opened.guard.revision > changed.guard.revision)
            passed++
        }

        // Cancelling preparation closes its native input without killing the
        // session. A producer ignoring interruption cannot publish a late result.
        actor(source).use { actor ->
            val started = CountDownLatch(1); val finish = CountDownLatch(1); val stopped = CountDownLatch(1)
            val input = AtomicReference<ProjectUpload>()
            val opening = actor.openDocument { scope ->
                try {
                    val upload = input(scope, source); input.set(upload)
                    started.countDown(); uninterruptibly(finish); upload.prepare()
                } finally { stopped.countDown() }
            }
            await(started)
            check(opening.cancel()); refused(opening, ProjectRefusal.CANCELLED); closed(input.get())
            check(ack(query(actor)).history.undoCount == 0L)
            finish.countDown(); await(stopped)
            check(outcome(actor.openDocument { scope -> input(scope, source).prepare() }) is ProjectOutcome.Opened)
            passed++
        }

        actor(source, { error("PRIVATE projection detail") }).use { actor ->
            val result = completed(actor.submit(add(ack(query(actor)).guard)))
            check(result.projection == ProjectProjection.FAILED)
            check((result.reply.result as ProjectIntents.SessionResult.Acknowledged).value.changed)
            check(ack(query(actor)).history.undoCount == 1L)
            passed++
        }

        // A failed transaction must dispatch its complete rollback effects before
        // returning the failure receipt, then remain usable at the new revision.
        val rollbackEffects = java.util.Collections.synchronizedList(mutableListOf<Int>())
        actor(source, { effects -> for (i in 0 until effects.count()) rollbackEffects.add(effects.kind(i)) }).use { actor ->
            val before = ack(query(actor))
            val command = add(before.guard).value.intent.command
            val result = completed(actor.submit(ProjectIntents.SessionOperation.Transaction(ProjectIntents.GuardedBatch(
                before.guard, ProjectIntents.Batch(1, listOf(84), listOf(command, command))))))
            check(result.reply.result == ProjectIntents.SessionResult.Error(ProjectIntents.SessionError.CommandFailed))
            check(result.projection == ProjectProjection.DELIVERED && rollbackEffects.count { it == ProjectHost.EFFECT_PROJECT } >= 2)
            val after = ack(query(actor))
            check(after.guard.semanticHash == before.guard.semanticHash && after.guard.revision > before.guard.revision)
            check(after.history.undoCount == 0L)
            passed++
        }

        // A confirmed reply awaiting a blocked callback survives close, while its
        // borrowed effects are invalidated and no second callback starts afterward.
        val inDelivery = CountDownLatch(1); val finishDelivery = CountDownLatch(1)
        val effectsOwner = AtomicReference<ProjectEffects>()
        val closeDelivery = actor(source, { effects -> effectsOwner.set(effects); inDelivery.countDown(); uninterruptibly(finishDelivery) })
        val confirmed = closeDelivery.submit(add(ack(query(closeDelivery)).guard))
        await(inDelivery); closeDelivery.close(); closed(effectsOwner.get())
        finishDelivery.countDown()
        val confirmedResult = completed(confirmed)
        check(confirmedResult.projection == ProjectProjection.CLOSED)
        check((confirmedResult.reply.result as ProjectIntents.SessionResult.Acknowledged).value.changed)
        passed++

        // Close during native execution is explicitly uncertain; the queued edit
        // is confirmed not started. Close itself does not wait for JNI to return.
        val executing = CountDownLatch(1); val release = CountDownLatch(1); val block = AtomicBoolean(false)
        val exited = CountDownLatch(1)
        val actor = actor(local, resolver = LocalTimestampResolver { value ->
            if (block.get()) { executing.countDown(); uninterruptibly(release); exited.countDown() }; value
        })
        val guard = ack(query(actor)).guard
        block.set(true)
        val active = actor.submit(add(guard)); await(executing)
        val queued = query(actor)
        actor.close(); actor.close()
        check(outcome(active) == ProjectOutcome.Uncertain)
        refused(queued, ProjectRefusal.CLOSED); refused(query(actor), ProjectRefusal.CLOSED)
        release.countDown(); await(exited)
        passed++

        // A session returned after close is closed immediately; a failed handshake
        // also destroys its session. Neither consumes a lasting native owner slot.
        val creating = CountDownLatch(1); val create = CountDownLatch(1); val created = CountDownLatch(1)
        val late = AtomicReference<ProjectSession>()
        val lateActor = ProjectActor.open({ _, nonce ->
            creating.countDown(); uninterruptibly(create)
            ProjectPreparation().use { scope -> input(scope, source).open(nonce).also { late.set(it); created.countDown() } }
        }, {})
        await(creating); lateActor.close(); refused(lateActor.ready, ProjectRefusal.CLOSED)
        create.countDown(); await(created)
        // Join cleanup deterministically via the session handle's closed state;
        // this is bounded observation, not a scheduler correctness sleep.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (runCatching { late.get().reference() }.isSuccess && System.nanoTime() < deadline) Thread.yield()
        closed(late.get())
        val foreign = AtomicReference<ProjectSession>()
        ProjectActor.open({ scope, nonce -> input(scope, source).open(nonce.also { it[0] = it[0] xor 1 }).also { foreign.set(it) } }, {}).use { bad ->
            refused(bad.ready, ProjectRefusal.CLOSED); closed(foreign.get())
        }
        passed++
        val longId = "import:actor:" + "x".repeat(131072)
        val oversized = Regex("\"id\":\"[^\"]*\"").replaceFirst(source, "\"id\":\"$longId\"")
        actor(source).use { owner ->
            check(outcome(owner.openDocument { scope -> input(scope, oversized).prepare() }) is ProjectOutcome.OpenedWithoutSummary)
            check(completed(query(owner)).reply.result is ProjectIntents.SessionResult.ReceiptUnavailable)
        }
        passed++
        repeat(20) {
            actor(source).use { owner ->
                check(outcome(owner.openDocument { scope -> input(scope, source).prepare() }) is ProjectOutcome.Opened)
                check(ack(owner.submit(add(ack(query(owner)).guard))).changed)
            }
        }
        val stoppedBy = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while ((actorThreads() - originalThreads).isNotEmpty() && System.nanoTime() < stoppedBy) Thread.yield()
        check((actorThreads() - originalThreads).isEmpty()) { "actor worker leaked" }
        passed++
        return passed
    }
}
