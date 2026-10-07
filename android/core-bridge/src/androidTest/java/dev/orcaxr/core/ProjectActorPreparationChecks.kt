package dev.orcaxr.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Real native preparation/commit races; these checks also run on Android. */
object ProjectActorPreparationChecks {
    private fun await(latch: CountDownLatch) { check(latch.await(10, TimeUnit.SECONDS)) { "preparation_check_timeout" } }
    private fun waitIgnoringInterrupt(latch: CountDownLatch) {
        var interrupted = false
        while (true) try { await(latch); break } catch (_: InterruptedException) { interrupted = true }
        if (interrupted) Thread.currentThread().interrupt()
    }
    private fun result(request: ProjectRequest) = request.completion.toCompletableFuture().get(10, TimeUnit.SECONDS)
    private fun completed(request: ProjectRequest) = result(request) as ProjectOutcome.Completed
    private val ProjectOutcome.current: ProjectActorGuard get() = checkNotNull(when (this) {
        is ProjectOutcome.Completed -> authority
        is ProjectOutcome.Opened -> authority
        is ProjectOutcome.OpenedWithoutSummary -> authority
        is ProjectOutcome.Reset -> authority
        is ProjectOutcome.ResetWithoutSummary -> authority
        else -> null
    })
    private fun state(reply: ProjectOutcome.Completed) = (reply.reply.result as ProjectIntents.SessionResult.Acknowledged).value
    private fun query(actor: ProjectActor) = completed(actor.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)))
    private fun refused(request: ProjectRequest, reason: ProjectRefusal) { check(result(request) == ProjectOutcome.NotStarted(reason)) }
    private fun units(value: String) = value.map { it.code }
    private fun text(value: List<Int>) = value.map { it.toChar() }.joinToString("")
    private val pool = ProjectStagingPoolOptions(4, 4096, 16_777_216, 16_777_216)
    private fun options(bytes: Int) = ProjectStagingInputOptions(bytes.toLong(), 1_000_000, 4_000_000, 1024, 128, 4096, 16_777_216, 64, 16_777_216)
    private fun add(id: String = "import:plate:prepared") = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(units(id), listOf(78), 2.0, true))
    private fun input(scope: ProjectPreparation, source: String, asset: ByteArray? = null, resolver: LocalTimestampResolver = LocalTimestampResolver { it }): ProjectUpload {
        val bytes = source.toByteArray(Charsets.UTF_8)
        val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 4_000_000, 1024, 128, 10, 16_777_216, 33_554_432, 100, 33_554_432)
        return scope.own(ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM)).also { upload ->
            for (start in bytes.indices step 997) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + 997, bytes.size)))
            upload.sealDocument()
            if (asset != null) { check(upload.assetCount() == 1L); upload.beginAsset(0); upload.appendAsset(0, asset); upload.finishAsset() }
            else check(upload.assetCount() == 0L)
        }
    }
    private fun actor(source: String, raw: AtomicReference<ProjectSession> = AtomicReference(), effects: (ProjectEffects) -> Unit = {}, limits: ProjectStagingPoolOptions = pool,
        resolver: LocalTimestampResolver = LocalTimestampResolver { it }, asset: ByteArray? = null): ProjectActor = ProjectActor.open(
        { scope, nonce -> input(scope, source, asset, resolver).open(nonce).also { raw.set(it) } }, effects, staging = limits,
    ).also { check(completed(it.ready).reply.result is ProjectIntents.SessionResult.Welcome) }

    // Embedded small intents are ASCII. Full records have their own persisted JSON
    // encoding in the independent captured fixture below, outside these wire limits.
    private fun payload(vararg commands: ProjectIntents.Command): ByteArray {
        val encoded = commands.map { command ->
            val intent = ProjectIntents.encodeIntent(ProjectIntents.Intent(1, command)).replace("\\", "\\\\").replace("\"", "\\\"")
            "[${ProjectStaging.COMMAND_INTENT},\"$intent\"]"
        }
        val work = if (commands.size == 1) "[${ProjectStaging.WORK_SINGLE},${encoded.single()}]"
        else "[${ProjectStaging.WORK_TRANSACTION},\"Prepared batch\",[${encoded.joinToString(",")}]]"
        return "[${ProjectStaging.VERSION},$work]".toByteArray(Charsets.UTF_8)
    }
    private fun append(writer: ProjectCommandWriter, bytes: ByteArray) {
        for (start in bytes.indices step 97) writer.append(bytes.copyOfRange(start, minOf(start + 97, bytes.size)))
    }
    private fun prepare(actor: ProjectActor, guard: ProjectActorGuard, bytes: ByteArray = payload(add())) =
        actor.prepareCommands(guard, bytes.size.toLong(), options(bytes.size)) { _, _, writer -> append(writer, bytes) }
    private fun noCharge(raw: ProjectSession) { check(raw.stagingUsage() == ProjectStagingUsage(0, 0, 0, 0)) }
    /** An addObjectWithAsset record on the active plate and its tetrahedron mesh. */
    private fun volumePayload(source: String): Pair<ByteArray, ByteArray> {
        val mesh = java.nio.ByteBuffer.allocate(96).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        listOf(0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f).forEach { mesh.putFloat(it) }
        listOf(0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3).forEach { mesh.putInt(it) }
        val bytes = mesh.array()
        var hash = 0xcbf29ce484222325uL
        for (b in bytes) hash = (hash xor b.toUByte().toULong()) * 0x100000001b3uL
        val digest = "fnv1a64:" + hash.toString(16).padStart(16, '0')
        val plateId = checkNotNull(Regex("\"activePlateId\":\"([^\"]+)\"").find(source)).groupValues[1]
        val descriptor = "{\"byteLength\":96,\"digest\":\"$digest\",\"id\":\"import:asset:actor\",\"kind\":\"mesh\"," +
            "\"mediaType\":\"application/vnd.orcaxr.indexed-mesh\",\"mesh\":{\"indices\":{\"byteLength\":48,\"byteOffset\":48," +
            "\"componentCount\":1,\"componentType\":\"uint32\",\"count\":12},\"positions\":{\"byteLength\":48,\"byteOffset\":0," +
            "\"componentCount\":3,\"componentType\":\"float32\",\"count\":4},\"triangleCount\":4}}"
        val identity = "\"transform\":{\"rotation\":[0,0,0,1],\"scale\":[1,1,1],\"translationMm\":[0,0,0]}"
        val volume = "{\"annotations\":{\"brim\":[],\"color\":[],\"fuzzySkin\":[],\"seam\":[],\"support\":[],\"topologyRevision\":0}," +
            "\"config\":{},\"id\":\"import:volume:actor\",\"name\":\"Actor\",\"role\":\"model\"," +
            "\"source\":{\"assetId\":\"import:asset:actor\",\"topologyRevision\":0,\"triangleCount\":4},$identity}"
        val record = "{\"config\":{},\"id\":\"import:object:actor\",\"instances\":[{\"id\":\"import:instance:actor\",\"printable\":true,$identity}]," +
            "\"layerRanges\":[],\"name\":\"Actor\",\"volumes\":[$volume]}"
        val records = "[${ProjectStaging.VERSION},[${ProjectStaging.WORK_SINGLE},[${ProjectStaging.COMMAND_ADD_OBJECT_WITH_ASSET},\"$plateId\",$record,$descriptor]]]"
        return records.toByteArray(Charsets.UTF_8) to bytes
    }
    private fun closed(handle: ProjectHandle) { check(runCatching { handle.reference() }.exceptionOrNull()?.message == "closed") }

    @JvmStatic fun run(source: String): Long {
        var checks = 0L
        val bytes = payload(add())
        actor(source, limits = ProjectStagingPoolOptions(0, 0, 0, 0)).use { disabled ->
            refused(prepare(disabled, query(disabled).current), ProjectRefusal.RESOURCE_LIMIT)
            for (operation in listOf(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(1)), ProjectIntents.SessionOperation.ReleaseStaged(ProjectIntents.StagedReference(1))))
                refused(disabled.submit(operation), ProjectRefusal.INVALID_REQUEST)
        }
        actor(source).use { first -> actor(source).use { second ->
            val foreign = query(first).current
            refused(prepare(second, foreign), ProjectRefusal.STALE)
            refused(second.resetDocument(foreign) { error("must not prepare") }, ProjectRefusal.STALE)
        } }
        checks++

        val raw = AtomicReference<ProjectSession>()
        actor(source, raw).use { owner ->
            repeat(20) {
                val before = query(owner)
                val retained = AtomicReference<ProjectCommandWriter>()
                val snapshot = AtomicReference<ProjectSnapshot>()
                val operation = owner.prepareCommands(before.current, bytes.size.toLong(), options(bytes.size)) { scope, captured, writer ->
                    check(Thread.currentThread().name == "orcaxr-prepare")
                    scope.checkActive(); snapshot.set(captured); retained.set(writer)
                    check(captured.revision() == before.current.revision && captured.hash() == text(state(before).guard.semanticHash))
                    append(writer, bytes)
                }
                val added = completed(operation)
                check(state(added).changed && state(added).history.undoCount == 1L)
                check(added.current.revision == state(added).guard.revision)
                check(runCatching { retained.get().append(byteArrayOf()) }.exceptionOrNull()?.message == "closed_writer")
                closed(snapshot.get()); noCharge(raw.get())
                val undone = state(completed(owner.submit(ProjectIntents.SessionOperation.Undo(state(added).guard))))
                check(undone.history.undoCount == 0L && undone.history.redoCount == 1L)
            }
        }
        checks++

        // Payload-carrying records: the actor seals the records, streams each declared
        // payload in bounded chunks, then admits and executes exactly once.
        actor(source, raw).use { owner ->
            val (records, mesh) = volumePayload(source)
            val before = query(owner)
            val retained = AtomicReference<ProjectAssetWriter>()
            val added = completed(owner.prepareCommands(before.current, records.size.toLong(), options(records.size), { _, _, writer -> append(writer, records) }) { scope, assets ->
                check(Thread.currentThread().name == "orcaxr-prepare"); scope.checkActive(); retained.set(assets)
                check(assets.count() == 1L && assets.begin(0) == mesh.size.toLong())
                for (start in mesh.indices step 7) assets.append(mesh.copyOfRange(start, minOf(start + 7, mesh.size)))
                assets.finish()
            })
            check(state(added).changed && state(added).history.undoCount == 1L)
            check(runCatching { retained.get().count() }.exceptionOrNull()?.message == "closed_writer")
            noCharge(raw.get())
            // Records whose payloads never arrive fail preparation; nothing is charged.
            refused(owner.prepareCommands(query(owner).current, records.size.toLong(), options(records.size)) { _, _, writer -> append(writer, records) }, ProjectRefusal.PREPARATION_FAILED)
            noCharge(raw.get())
        }
        checks++

        actor(source, raw).use { owner ->
            val before = query(owner); val started = CountDownLatch(1); val finish = CountDownLatch(1)
            val operation = owner.prepareCommands(before.current, bytes.size.toLong(), options(bytes.size)) { _, captured, writer ->
                val hash = captured.hash(); started.countDown(); await(finish)
                check(captured.hash() == hash); append(writer, bytes)
            }
            await(started)
            val edit = completed(owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add("import:plate:other"))))))
            finish.countDown(); refused(operation, ProjectRefusal.STALE); noCharge(raw.get())
            check(state(query(owner)).guard == state(edit).guard)
            refused(owner.prepareCommands(before.current, bytes.size.toLong(), options(bytes.size)) { _, _, _ -> error("stale preparation ran") }, ProjectRefusal.STALE)
        }
        checks++

        // The initial guard check happens when the authority reaches the task,
        // never by silently recapturing current identity behind a queued edit.
        val local = Regex("\"(createdAt|updatedAt)\":\"[^\"]*\"").replace(source) { "\"${it.groupValues[1]}\":\"2026-10-05T12:00:00\"" }
        val armed = AtomicBoolean(false); val executing = CountDownLatch(1); val release = CountDownLatch(1)
        actor(local, resolver = LocalTimestampResolver { value -> if (armed.get()) { executing.countDown(); waitIgnoringInterrupt(release) }; value }).use { owner ->
            val before = query(owner); armed.set(true)
            val edit = owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add("import:plate:queued")))))
            await(executing)
            val pending = owner.prepareCommands(before.current, bytes.size.toLong(), options(bytes.size)) { _, _, _ -> error("rebased preparation ran") }
            release.countDown(); completed(edit); refused(pending, ProjectRefusal.STALE)
        }
        checks++

        actor(source, raw).use { owner ->
            val guard = query(owner).current; val started = CountDownLatch(2); val resume = CountDownLatch(1); val stopped = CountDownLatch(2)
            val held = (0 until ProjectStaging.MAX_PREPARATIONS).map {
                owner.prepareCommands(guard, bytes.size.toLong(), options(bytes.size)) { _, _, writer ->
                    try { started.countDown(); waitIgnoringInterrupt(resume); append(writer, bytes) } finally { stopped.countDown() }
                }
            }
            await(started)
            refused(prepare(owner, guard), ProjectRefusal.RESOURCE_LIMIT)
            held.forEach { check(it.cancel()); refused(it, ProjectRefusal.CANCELLED) }
            noCharge(raw.get())
            resume.countDown(); await(stopped)
            check(state(completed(prepare(owner, guard))).changed)
            noCharge(raw.get())
        }
        checks++

        actor(source, raw).use { owner ->
            val before = query(owner)
            refused(owner.prepareCommands(before.current, bytes.size + 1L, options(bytes.size)) { _, _, _ -> error("invalid budget ran") }, ProjectRefusal.INVALID_REQUEST)
            for (write in listOf<(ProjectCommandWriter) -> Unit>(
                { it.append(byteArrayOf(91)) }, { it.append(ByteArray(ProjectHost.MAX_CHUNK_BYTES + 1)) },
                { it.append(ByteArray(bytes.size)); it.append(byteArrayOf(0)) }, { error("PRIVATE reader failure") },
            )) {
                refused(owner.prepareCommands(before.current, bytes.size.toLong(), options(bytes.size)) { _, _, writer -> write(writer) }, ProjectRefusal.PREPARATION_FAILED)
                noCharge(raw.get())
            }
            refused(prepare(owner, before.current, "[1,[0,[999]]]".toByteArray()), ProjectRefusal.PREPARATION_FAILED)
            check(state(query(owner)).guard == state(before).guard)
            check(state(completed(prepare(owner, before.current))).changed)
        }
        checks++

        actor(source, raw, limits = ProjectStagingPoolOptions(1, 1, 1, 1)).use { owner ->
            val before = query(owner)
            repeat(5) { refused(prepare(owner, before.current), ProjectRefusal.RESOURCE_LIMIT); noCharge(raw.get()) }
            check(state(query(owner)).guard == state(before).guard)
            check(state(completed(owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add())))))).changed)
        }
        checks++

        val effects = mutableListOf<Int>()
        actor(source, raw, effects = { values -> for (i in 0 until values.count()) effects.add(values.kind(i)) }).use { owner ->
            val before = query(owner)
            val failed = completed(prepare(owner, before.current, payload(add(), add())))
            check(failed.reply.result == ProjectIntents.SessionResult.Error(ProjectIntents.SessionError.CommandFailed))
            check(effects.count { it == ProjectHost.EFFECT_PROJECT } >= 2)
            val after = state(query(owner)); check(after.guard.semanticHash == state(before).guard.semanticHash && after.history.undoCount == 0L)
            noCharge(raw.get())
        }
        checks++

        val preparing = CountDownLatch(1); val finish = CountDownLatch(1); val stopped = CountDownLatch(1)
        val snapshot = AtomicReference<ProjectSnapshot>()
        val closing = actor(source)
        val pending = closing.prepareCommands(query(closing).current, bytes.size.toLong(), options(bytes.size)) { _, captured, writer ->
            try { snapshot.set(captured); preparing.countDown(); waitIgnoringInterrupt(finish); append(writer, bytes) } finally { stopped.countDown() }
        }
        await(preparing); closing.close(); refused(pending, ProjectRefusal.CLOSED); closed(snapshot.get())
        finish.countDown(); await(stopped)
        checks++

        val blocked = AtomicBoolean(false); val committing = CountDownLatch(1); val settle = CountDownLatch(1); val nativeReturned = CountDownLatch(1)
        val active = actor(local, resolver = LocalTimestampResolver { value ->
            if (blocked.get()) { check(Thread.currentThread().name == "orcaxr-project"); committing.countDown(); waitIgnoringInterrupt(settle); nativeReturned.countDown() }; value
        })
        val guard = query(active).current; blocked.set(true)
        val uncertain = prepare(active, guard); await(committing); check(!uncertain.cancel())
        active.close(); check(result(uncertain) == ProjectOutcome.Uncertain)
        settle.countDown(); await(nativeReturned)
        checks++

        actor(source).use { owner ->
            val before = query(owner)
            val dirty = completed(prepare(owner, before.current))
            val reading = CountDownLatch(1); val resumeOpen = CountDownLatch(1)
            val open = owner.openDocument { scope -> reading.countDown(); await(resumeOpen); input(scope, source).prepare() }
            await(reading)
            val reset = result(owner.resetDocument(dirty.current) { input(it, source).prepare() }) as ProjectOutcome.Reset
            check(reset.guard.semanticHash == state(before).guard.semanticHash && reset.history.undoCount == 0L && reset.history.dirtyCategories.isEmpty())
            check(reset.current.revision > dirty.current.revision)
            resumeOpen.countDown(); refused(open, ProjectRefusal.STALE)
        }
        checks++

        actor(source).use { owner ->
            val before = query(owner)
            val dirty = completed(prepare(owner, before.current))
            val reading = CountDownLatch(1); val resume = CountDownLatch(1)
            val open = owner.openDocument { scope -> reading.countDown(); await(resume); input(scope, source).prepare() }
            await(reading)
            refused(owner.resetDocument(before.current) { error("stale reset prepared") }, ProjectRefusal.STALE)
            refused(owner.resetDocument(dirty.current) { error("PRIVATE document failure") }, ProjectRefusal.PREPARATION_FAILED)
            resume.countDown(); check(result(open) is ProjectOutcome.Opened)
        }
        checks++

        actor(source, raw).use { owner ->
            val before = query(owner)
            val reading = CountDownLatch(1); val resume = CountDownLatch(1)
            val reset = owner.resetDocument(before.current) { scope -> reading.countDown(); await(resume); input(scope, source).prepare() }
            await(reading)
            // Deliberate history-only fault injection while the authority is idle:
            // bulk edits must stale, while the reset's export guard remains valid.
            raw.get().captureGuard().use { raw.get().acknowledgeCheckpoint(it).close() }
            refused(prepare(owner, before.current), ProjectRefusal.STALE)
            resume.countDown(); check(result(reset) is ProjectOutcome.Reset)
            val current = query(owner)
            raw.get().captureGuard().use { raw.get().acknowledgeCheckpoint(it).close() }
            check(result(owner.resetDocument(current.current) { input(it, source).prepare() }) is ProjectOutcome.Reset)
        }
        checks++

        val oversized = Regex("\"id\":\"[^\"]*\"").replaceFirst(source, "\"id\":\"import:actor:${"x".repeat(131072)}\"")
        actor(oversized).use { owner ->
            val before = query(owner); check(before.reply.result is ProjectIntents.SessionResult.ReceiptUnavailable)
            val committed = completed(prepare(owner, before.current))
            check(committed.reply.result == ProjectIntents.SessionResult.ReceiptUnavailable(true))
            check(committed.current.revision > before.current.revision)
            val reset = result(owner.resetDocument(committed.current) { input(it, oversized).prepare() }) as ProjectOutcome.ResetWithoutSummary
            check(result(owner.resetDocument(reset.current) { input(it, source).prepare() }) is ProjectOutcome.Reset)
            refused(prepare(owner, reset.current), ProjectRefusal.STALE)
        }
        checks++
        // Exhaust the real handle registry while a native mutation owns its reserved
        // reply slot. A missing optional host guard must not erase a confirmed edit.
        val saturate = AtomicBoolean(false); val inCommit = CountDownLatch(1); val commit = CountDownLatch(1)
        val held = mutableListOf<ProjectSelectionInput>()
        val largeLocal = Regex("\"id\":\"[^\"]*\"").replaceFirst(local, "\"id\":\"import:actor:${"x".repeat(131072)}\"")
        actor(largeLocal, resolver = LocalTimestampResolver { value ->
            if (saturate.get()) { inCommit.countDown(); waitIgnoringInterrupt(commit) }; value
        }).use { owner ->
            val before = query(owner); saturate.set(true)
            val operation = prepare(owner, before.current)
            await(inCommit)
            try {
                while (true) try { held.add(ProjectSelectionInput()) }
                catch (failure: IllegalStateException) { check(failure.message == "resource_limit"); break }
                check(held.size > 4000)
                commit.countDown()
                val confirmed = completed(operation)
                check(confirmed.reply.result == ProjectIntents.SessionResult.ReceiptUnavailable(true))
                check(confirmed.authority == null)
            } finally { commit.countDown(); held.forEach { it.close() } }
            check(query(owner).current.revision > before.current.revision)
        }
        checks++
        // Document adoption consumes its input handle and reserves effects before
        // publication. An optional summary query must not erase that completion
        // when those effects occupy the registry's last available slot.
        for (reset in listOf(false, true)) actor(source).use { owner ->
            val before = query(owner)
            val captured = mutableListOf<ProjectSelectionInput>()
            val producer: (ProjectPreparation) -> ProjectDocument = { scope ->
                val document = scope.own(input(scope, source).prepare())
                while (true) try { captured.add(ProjectSelectionInput()) }
                catch (failure: IllegalStateException) { check(failure.message == "resource_limit"); break }
                check(captured.size > 4000)
                document
            }
            try {
                val outcome = result(if (reset) owner.resetDocument(before.current, producer) else owner.openDocument(producer))
                if (reset) {
                    check(outcome is ProjectOutcome.ResetWithoutSummary && outcome.projection == ProjectProjection.DELIVERED && outcome.authority == null)
                } else {
                    check(outcome is ProjectOutcome.OpenedWithoutSummary && outcome.projection == ProjectProjection.DELIVERED && outcome.authority == null)
                }
            } finally { captured.forEach { it.close() } }
            val after = query(owner)
            check(after.current.revision > before.current.revision && state(after).history.dirtyCategories.isEmpty())
            check(state(completed(prepare(owner, after.current))).changed)
        }
        checks++
        return checks
    }

    /** Independent TS 70-instance trace; compare the complete receipt and ordered
     * effects through the actor, then undo/redo the entire batch as one history entry. */
    @JvmStatic fun captured(source: String, payload: String, asset: ByteArray, expectedReply: String, expectedEffects: LongArray): Long {
        val expected = (ProjectIntents.decodeSessionReply(expectedReply).result as ProjectIntents.SessionResult.Acknowledged).value
        val bytes = payload.toByteArray(Charsets.UTF_8)
        val raw = AtomicReference<ProjectSession>(); val effects = mutableListOf<Long>()
        actor(source, raw, { values -> for (i in 0 until values.count()) effects.add(values.kind(i).toLong()) }, asset = asset).use { owner ->
            val before = query(owner)
            val committed = completed(prepare(owner, before.current, bytes))
            check(state(committed) == expected && effects == expectedEffects.toList())
            noCharge(raw.get())
            val undone = completed(owner.submit(ProjectIntents.SessionOperation.Undo(state(committed).guard)))
            check(state(undone).guard.semanticHash == state(before).guard.semanticHash && state(undone).history.redoCount == 1L)
            val redone = completed(owner.submit(ProjectIntents.SessionOperation.Redo(state(undone).guard)))
            check(state(redone).guard.semanticHash == expected.guard.semanticHash && state(redone).history.undoCount == 1L)
            noCharge(raw.get())
        }
        return 1
    }
}
