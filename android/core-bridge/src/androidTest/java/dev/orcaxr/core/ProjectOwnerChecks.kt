package dev.orcaxr.core

import java.time.ZoneId
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Shared host-JVM/device checks of production owners with real JNI and close races.
 * Input documents come from the independent TypeScript fixture producer. */
object ProjectOwnerChecks {
    @JvmStatic fun documentChecks(source: String): Long {
        fun input() = upload(source, ProjectTimeZone(ZoneId.of("UTC"))).also { it.sealDocument(); check(it.assetCount() == 0L) }
        fun document() = input().use { it.prepare() }
        fun session() = input().use { it.open(longArrayOf(0, 1, 2, 3)) }
        var passed = 0L
        session().use { s ->
            val input = input(); val prepared = input.prepare()
            refused("closed") { input.assetCount() }; input.close()
            s.beginOpen().use { ticket ->
                s.finishOpen(ticket, prepared).close()
                refused("closed") { prepared.reference() }
                check(!s.isOpenCurrent(ticket)); passed++
            }
            s.beginOpen().use { old -> s.beginOpen().use { newer ->
                check(!s.isOpenCurrent(old)); check(s.cancelOpen(newer))
                val doc=document(); refused("stale") { s.finishOpen(old, doc) }
                refused("closed") { doc.reference() }; passed++
            } }
            s.beginOpen().use { pending -> s.captureGuard().use { guard ->
                s.acknowledgeCheckpoint(guard).close()
                check(s.isOpenCurrent(pending))
                s.finishOpen(pending, document()).close(); passed++
            } }
            s.beginOpen().use { pending -> s.captureGuard().use { guard ->
                s.resetDocument(guard, document()).close()
                check(!s.isOpenCurrent(pending)); check(!s.isCurrent(guard)); passed++
            } }
            session().use { foreign -> foreign.beginOpen().use { ticket ->
                val doc=document(); refused("stale") { s.finishOpen(ticket, doc) }
                check(foreign.isOpenCurrent(ticket)); refused("closed") { doc.reference() }; passed++
            } }
            val ticket=s.beginOpen(); ticket.close()
            val doc=document(); refused("closed") { s.finishOpen(ticket, doc) }
            refused("closed") { doc.reference() }; passed++
        }
        val s=session(); val ticket=s.beginOpen(); val doc=document()
        s.close(); refused("closed") { s.finishOpen(ticket, doc) }
        refused("closed") { doc.reference() }; ticket.close(); passed++
        return passed
    }

    @JvmStatic fun clipboardChecks(source: String, payload: String, mesh: ByteArray, svg: ByteArray): Long {
        fun session(): ProjectSession = upload(source, ProjectTimeZone(ZoneId.of("UTC"))).use { u ->
            u.sealDocument(); check(u.assetCount() == 3L)
            listOf(mesh, svg, svg).forEachIndexed { i, bytes ->
                check(u.beginAsset(i.toLong()) == bytes.size.toLong()); u.appendAsset(0, bytes); u.finishAsset()
            }
            u.open(longArrayOf(0, 1, 2, 3))
        }
        val bytes = payload.toByteArray(Charsets.UTF_8)
        val options = ProjectStagingInputOptions(bytes.size.toLong(), 100_000, 1_000_000, 1024, 128, 100, 4_000_000, 64, 16_777_216)
        val captureLimits = ProjectStagingClipboardOptions(2, (mesh.size + svg.size).toLong())
        fun copy(s: ProjectSession, guard: ProjectGuard): ProjectClipboard = s.snapshot().use { snapshot -> snapshot.query().use { root ->
            root.children(QueryRelation.PLATES, 4096).use { plates -> plates.node(0).use { plate ->
                plate.children(QueryRelation.OBJECTS, 0).use { objects -> objects.node(0).use { node -> s.captureClipboard(guard, node, captureLimits) } }
            } }
        } }
        fun ready(s: ProjectSession, guard: ProjectGuard, c: ProjectClipboard): ProjectCommandUpload {
            val input = s.clipboardUpload(guard, c, bytes.size.toLong(), options)
            try { input.append(0, bytes); input.seal(); return input }
            catch (failure: Throwable) { input.close(); throw failure }
        }
        fun wire(id: Long, operation: ProjectIntents.SessionOperation) = ProjectIntents.encodeSessionRequest(ProjectIntents.SessionRequest(1, listOf(0, 1, 2, 3), id, operation))
        var passed = 0L
        session().use { s ->
            s.configureStaging(ProjectStagingPoolOptions(4, 100, 8_000_000, 16_777_216))
            s.captureGuard().use { guard ->
                val c = copy(s, guard)
                check(c.info() == ProjectClipboardInfo(2, 1, 1, 2, (mesh.size + svg.size).toLong()))
                c.close(); c.close(); refused("closed") { c.info() }; passed++
                copy(s, guard).use { captured ->
                    session().use { other -> other.captureGuard().use { foreign ->
                        refused("foreign_clipboard") { other.clipboardUpload(foreign, captured, bytes.size.toLong(), options) }
                    } }
                }; passed++
                val detached = copy(s, guard)
                val input = s.clipboardUpload(guard, detached, bytes.size.toLong(), options)
                detached.close()
                input.append(0, bytes); input.seal()
                s.submit(wire(1, ProjectIntents.SessionOperation.Hello(ProjectIntents.Hello(1, 1, 1, 1))))!!.use { it.effects().close() }
                s.stageCommands(input).use { staged -> check(s.submit(wire(2, ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(staged.id)))) == null) }
                s.runNext()!!.use { reply -> check(reply.wire().contains("\"acknowledged\"")); reply.effects().close() }
                s.history().use { check(it.count(true) == 1L) }; passed++
            }
            s.captureGuard().use { guard -> copy(s, guard).use { c ->
                val input = ready(s, guard, c)
                s.acknowledgeCheckpoint(guard).close()
                refused("stale") { s.stageCommands(input) }; refused("closed") { input.units() }
                check(c.info().assets == 2L); passed++
            } }
            s.captureGuard().use { guard ->
                val entered = CountDownLatch(1); val resume = CountDownLatch(1)
                var returned = 0L
                val late = object : ProjectHandle(NativeProject.selectionInputNew()) {
                    fun result(): ProjectClipboard = read {
                        val result = copy(s, guard); returned = result.reference()
                        entered.countDown(); await(resume); result
                    }
                }
                val failure = AtomicReference<Throwable?>()
                val worker = Thread { try { late.result().close() } catch (caught: Throwable) { failure.set(caught) } }.also { it.isDaemon = true; it.start() }
                try { await(entered); late.close() } finally { resume.countDown() }
                worker.join(10_000)
                check(!worker.isAlive && failure.get()?.message == "closed")
                refused("closed") { NativeProject.clipboardInfo(returned) }
                val replacements = (0 until ProjectStaging.MAX_CLIPBOARDS).map { copy(s, guard) }
                try { refused("resource_limit") { copy(s, guard) } }
                finally { replacements.forEach { it.close() } }
                passed++
            }
        }
        session().use { s -> s.captureGuard().use { guard -> copy(s, guard).use { c ->
            s.close(); check(c.info().assets == 2L)
            refused("closed") { s.clipboardUpload(guard, c, bytes.size.toLong(), options) }
            passed++
        } } }
        check(passed == 6L)
        return passed
    }
    @JvmStatic fun stagingChecks(source: String, payload: String): Long {
        fun session(): ProjectSession = upload(source, ProjectTimeZone(ZoneId.of("UTC"))).use { u ->
            u.sealDocument(); u.open(longArrayOf(0, 1, 2, 3))
        }
        val bytes = payload.toByteArray(Charsets.UTF_8)
        val options = ProjectStagingInputOptions(bytes.size.toLong(), 100_000, 1_000_000, 1024, 128, 100, 4_000_000, 64, 16_777_216)
        val limits = ProjectStagingPoolOptions(4, 100, 8_000_000, 16_777_216)
        fun ready(s: ProjectSession, guard: ProjectGuard): ProjectCommandUpload {
            val input = s.commandUpload(guard, bytes.size.toLong(), options)
            try { for (start in bytes.indices step 97) input.append(start.toLong(), bytes.copyOfRange(start, minOf(start + 97, bytes.size))); input.seal(); return input }
            catch (failure: Throwable) { input.close(); throw failure }
        }
        fun encode(id: Long, operation: ProjectIntents.SessionOperation) = ProjectIntents.encodeSessionRequest(
            ProjectIntents.SessionRequest(1, listOf(0, 1, 2, 3), id, operation))
        var passed = 0L
        session().use { s ->
            s.captureGuard().use { guard ->
                val refusedInput = ready(s, guard)
                refused("resource_limit") { s.stageCommands(refusedInput) }
                refused("closed") { refusedInput.units() }; passed++
                s.configureStaging(limits)
                s.stageCommands(ready(s, guard)).use { staged ->
                    check(staged.id > 0 && s.stagingUsage().resources == 1L)
                }
                check(s.stagingUsage().resources == 0L); passed++
                s.submit(encode(1, ProjectIntents.SessionOperation.Hello(ProjectIntents.Hello(1, 1, 1, 1))))!!.use { reply -> reply.effects().close() }
                s.stageCommands(ready(s, guard)).use { staged ->
                    check(s.submit(encode(2, ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(staged.id)))) == null)
                }
                check(s.stagingUsage().resources == 1L)
                s.runNext()!!.use { reply -> check(reply.wire().contains("\"acknowledged\"")); reply.effects().close() }
                check(s.stagingUsage().resources == 0L)
                s.history().use { check(it.count(true) == 1L) }; passed++
            }
            s.captureGuard().use { guard ->
                val stale = ready(s, guard)
                s.acknowledgeCheckpoint(guard).close()
                refused("stale") { s.stageCommands(stale) }; refused("closed") { stale.commandCount() }; passed++
            }
            s.captureGuard().use { guard ->
                session().use { other ->
                    val foreign = ready(s, guard)
                    refused("stale") { other.stageCommands(foreign) }; refused("closed") { foreign.units() }; passed++
                }
            }
        }
        session().use { s ->
            s.captureGuard().use { guard ->
                val input = ready(s, guard); s.close()
                refused("closed") { s.stageCommands(input) }; refused("closed") { input.units() }; passed++
            }
        }
        session().use { s ->
            s.configureStaging(limits)
            s.captureGuard().use { guard ->
                val held = ArrayList<ProjectCommandUpload>()
                try {
                    repeat(ProjectStaging.MAX_PREPARATIONS) { held.add(ready(s, guard)) }
                    refused("resource_limit") { ready(s, guard) }
                } finally { held.forEach { it.close() } }
                val prepared = ready(s, guard)
                val staged = s.stageCommands(prepared)
                refused("closed") { prepared.units() }
                s.close(); staged.close(); staged.close(); refused("closed") { staged.id }; passed++
            }
        }
        check(passed == 7L)
        return passed
    }
    @JvmStatic fun stagedReference(id: Long, release: Boolean): String {
        val reference = ProjectIntents.StagedReference(id)
        val operation = if (release) ProjectIntents.SessionOperation.ReleaseStaged(reference)
            else ProjectIntents.SessionOperation.ExecuteStaged(reference)
        return ProjectIntents.encodeSessionRequest(ProjectIntents.SessionRequest(
            1, listOf(0, 1, 2147483648, 4294967295), 1, operation))
    }
    @JvmStatic fun intentLifecycle(kind: Int, present: Boolean): String {
        val id = "import:instance:\u0000\ud800".map { it.code }
        val name = if (present) ProjectIntents.OptionalText.Value(listOf(0, 0xdfff, 0xd83d, 0xde00))
            else ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
        val destination = if (present) ProjectIntents.OptionalPlate.Value(id)
            else ProjectIntents.OptionalPlate.Absent(ProjectIntents.Empty)
        val ids = ProjectIntents.DuplicateObject(id, listOf(id), listOf(id), listOf(id))
        val command = when (kind) {
            0 -> ProjectIntents.Command.DeleteObject(ProjectIntents.DeleteObject(id))
            1 -> ProjectIntents.Command.DeletePlateObjects(ProjectIntents.DeletePlateObjects(id))
            2 -> ProjectIntents.Command.DeleteInstance(ProjectIntents.DeleteInstance(id))
            3 -> ProjectIntents.Command.MoveObjectToPlate(ProjectIntents.MoveObjectToPlate(id, id))
            4 -> ProjectIntents.Command.DuplicateObject(ProjectIntents.DuplicateObjectEdit(id, ids, destination, name))
            5 -> ProjectIntents.Command.ConvertInstanceToObject(ProjectIntents.ConvertInstanceToObject(
                id, ProjectIntents.IndependentInstanceIds(id, listOf(id), id, listOf(id)), name))
            else -> error("unknown test case")
        }
        return ProjectIntents.encodeIntent(ProjectIntents.Intent(1, command))
    }
    /** Exercise the real generated Kotlin writer on a JVM without Android's
     * JsonReader. Android decoder/instrumentation qualification is separate. */
    @JvmStatic fun intentNumbers(values: DoubleArray, batch: Boolean): String {
        val numbers = values.toList()
        val transform = ProjectIntents.Transform(numbers.take(3), numbers.drop(3).take(4), numbers.drop(7))
        val id = "import:instance:\u0000\ud800".map { it.code }
        val gesture = "gesture:\udfff".map { it.code }
        val command = if (batch) ProjectIntents.Command.SetInstanceTransforms(
            ProjectIntents.SetInstanceTransforms(listOf(ProjectIntents.InstanceTransform(id, transform)), gesture)
        ) else ProjectIntents.Command.SetInstanceTransform(ProjectIntents.SetInstanceTransform(id, transform, gesture))
        return ProjectIntents.encodeIntent(ProjectIntents.Intent(1, command))
    }
    private fun upload(source: String, resolver: LocalTimestampResolver): ProjectUpload {
        val bytes = source.toByteArray(Charsets.UTF_8)
        val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 4_000_000,
            1024, 128, 10, 16_777_216, 33_554_432, 100, 33_554_432)
        return ProjectUpload(bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM).also { u ->
            try { for (start in bytes.indices step 997) u.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + 997, bytes.size))) }
            catch (failure: Throwable) { u.close(); throw failure }
        }
    }
    private fun refused(code: String, work: () -> Any?) {
        try { work() } catch (failure: IllegalStateException) { check(failure.message == code); return }
        error("Expected owner refusal")
    }
    private fun await(latch: CountDownLatch) { check(latch.await(10, TimeUnit.SECONDS)) { "owner test deadline" } }
    @JvmStatic fun run(source: String, localSource: String): Long {
        val utc = ProjectTimeZone(ZoneId.of("UTC"))
        val input = upload(source, utc)
        input.sealDocument()
        val session = input.open(longArrayOf(1, 2, 3, 4))
        input.close()
        refused("closed") { input.assetCount() }
        val guard = session.captureGuard()
        val selected = ProjectSelectionInput()
        selected.add(ProjectHost.SELECT_PROJECT, charArrayOf())
        session.select(guard, selected).use { check(it.count() == 1L) }
        refused("closed") { selected.add(ProjectHost.SELECT_PROJECT, charArrayOf()) }
        val selection = session.selection()
        check(selection.count() == 1L && selection.kind(0) == ProjectHost.SELECT_PROJECT)
        session.acknowledgeCheckpoint(guard).close()
        check(!session.isCurrent(guard) && session.isExportCurrent(guard))
        val snapshot = session.snapshot()
        val query = snapshot.query()
        check(query.metadata().kind == QueryKind.PROJECT)
        val plates = query.children(QueryRelation.PLATES, 1)
        val projectedPlate = plates.node(0)
        check(plates.page(0, 1).rows.single().kind == QueryKind.PLATE)
        query.close(); plates.close()
        val hash = snapshot.hash()
        val bytes = snapshot.exportJson(8_388_608)
        val owned = bytes.read(0, minOf(bytes.length(), 65536))
        val saved = owned.copyOf()
        session.close(); session.close(); guard.close()
        refused("closed") { session.snapshot() }
        check(snapshot.hash() == hash && selection.count() == 1L)
        snapshot.close(); selection.close(); bytes.close()
        check(projectedPlate.metadata().kind == QueryKind.PLATE)
        projectedPlate.snapshot().use { check(it.hash() == hash) }
        projectedPlate.close()
        check(owned.contentEquals(saved))

        val invalid = upload(source, utc)
        invalid.sealDocument()
        try { invalid.open(longArrayOf(1, 2, 3)) } catch (_: IllegalArgumentException) { }
        refused("closed") { invalid.assetCount() }

        upload(localSource) { throw IllegalStateException("PRIVATE timezone details") }.use {
            refused("timestamp_service") { it.sealDocument() }
        }
        var reentries = 0
        lateinit var reentrant: ProjectUpload
        reentrant = upload(localSource) { value ->
            refused("busy_or_failed") { reentrant.assetCount() }
            reentries++; value
        }
        reentrant.use { it.sealDocument() }
        check(reentries == 2)

        val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val cancelled = upload(localSource) { value -> entered.countDown(); await(resume); value }
        val worker = Thread {
            try { cancelled.sealDocument() } catch (caught: Throwable) { failure.set(caught) }
        }.also { it.isDaemon = true; it.start() }
        try { await(entered); cancelled.close() } finally { resume.countDown() }
        worker.join(10_000)
        check(!worker.isAlive && failure.get()?.message == "closed")

        val ready = CountDownLatch(1); val returnResult = CountDownLatch(1)
        var returned = 0L
        val late = object : ProjectHandle(NativeProject.selectionInputNew()) {
            fun result(): ProjectSelectionInput = read {
                val result = ProjectSelectionInput(); returned = result.reference()
                ready.countDown(); await(returnResult); result
            }
        }
        failure.set(null)
        val reader = Thread {
            try { late.result().close() } catch (caught: Throwable) { failure.set(caught) }
        }.also { it.isDaemon = true; it.start() }
        try { await(ready); late.close() } finally { returnResult.countDown() }
        reader.join(10_000)
        check(!reader.isAlive && failure.get()?.message == "closed")
        refused("closed") { NativeProject.selectionInputAdd(returned, ProjectHost.SELECT_PROJECT, charArrayOf()) }

        // All closing paths must release the four document admission slots.
        val replacements = (0..3).map { upload(source, utc) }
        try { refused("resource_limit") { upload(source, utc) } }
        finally { replacements.forEach { it.close() } }
        return 9
    }
}
