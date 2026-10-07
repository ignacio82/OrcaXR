package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProjectSessionTest {
    private fun fixture(name: String): JSONObject = JSONObject(
        InstrumentationRegistry.getInstrumentation().context.assets.open(name)
            .bufferedReader().use { it.readText() })
    private fun base(): String = fixture("project-model-vectors.json")
        .getJSONArray("factories").getJSONObject(0).getString("stateJson")
    private fun timestamps(source: String, value: CharArray): String {
        // Preserve every UTF-16 unit before UTF-8 transfer, including unpaired
        // surrogates. A JVM UTF-8 encoder alone would substitute such units.
        val quoted = buildString {
            append('"')
            for (unit in value) { append("\\u"); append(unit.code.toString(16).padStart(4, '0')) }
            append('"')
        }
        val fields = Regex("\"(createdAt|updatedAt)\":\"[^\"]*\"")
        check(fields.findAll(source).count() == 2)
        return fields.replace(source) { "\"${it.groupValues[1]}\":$quoted" }
    }
    @Test fun kotlinOwnershipAndCancellationCrossRealJni() {
        val source = base()
        val local = timestamps(source, "2026-10-05T12:00:00".toCharArray())
        assertEquals(9L, ProjectOwnerChecks.run(source, local))
    }
    @Test fun stagedCommandUploadOwnershipCrossesRealJni() {
        val command = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(
            "import:plate:kotlin-upload".map { it.code }, listOf(78, 101, 119), 1.0, true))
        val intent = ProjectIntents.encodeIntent(ProjectIntents.Intent(1, command))
        val input = "[${ProjectStaging.VERSION},[${ProjectStaging.WORK_SINGLE},[${ProjectStaging.COMMAND_INTENT},${JSONObject.quote(intent)}]]]"
        assertEquals(7L, ProjectOwnerChecks.stagingChecks(base(), input))
    }
    @Test fun actorPreparationCrossesRealJni() { assertEquals(16L, ProjectActorPreparationChecks.run(base())) }
    @Test fun actorExportMatchesBrowserBytesAndOwnsSaveHandoff() {
        val data = fixture("project-export-vectors.json")
        val assets = data.getJSONArray("assets")
        fun bytes(index: Int): ByteArray = assets.getJSONObject(index).getJSONArray("bytes").let { values -> ByteArray(values.length()) { values.getInt(it).toByte() } }
        assertEquals(13L, ProjectActorExportChecks.run(data.getString("source"), data.getString("canonical"), bytes(0), bytes(1), data.getString("empty"), data.getString("large"), data.getString("largeCanonical")))
    }
    @Test fun actorCapturedTransactionCrossesRealJni() {
        val traces = fixture("project-staged-session-vectors.json").getJSONArray("traces")
        val trace = (0 until traces.length()).map { traces.getJSONObject(it) }
            .single { it.getString("name") == "captured:capture-batches-exceed-small-wire-command-count" }
        val steps = trace.getJSONArray("steps")
        val work = steps.getJSONObject(1).getJSONArray("actions").getJSONObject(0).getJSONObject("work")
        fun text(units: JSONArray) = String(CharArray(units.length()) { units.getInt(it).toChar() })
        val commands = work.getJSONArray("commands")
        val encoded = JSONArray()
        for (i in 0 until commands.length()) {
            val command = commands.getJSONObject(i)
            check(command.getString("kind") == "instance")
            encoded.put(JSONArray().put(ProjectStaging.COMMAND_CREATE_INSTANCE).put(text(command.getJSONArray("objectId")))
                .put(JSONObject(command.getString("recordJson"))).put(if (command.has("index")) command.get("index") else JSONObject.NULL))
        }
        val payload = JSONArray().put(ProjectStaging.VERSION).put(JSONArray().put(ProjectStaging.WORK_TRANSACTION)
            .put(text(work.getJSONArray("label"))).put(encoded)).toString().flatMap { unit ->
                if (unit.code > 127) "\\u${unit.code.toString(16).padStart(4, '0')}".toList() else listOf(unit)
            }.joinToString("")
        val asset = trace.getJSONObject("asset").getJSONArray("bytes")
        val expected = steps.getJSONObject(2)
        val effects = expected.getJSONArray("effects")
        val kinds = listOf("project", "selection", "history")
        assertEquals(1L, ProjectActorPreparationChecks.captured(trace.getString("stateJson"), payload,
            ByteArray(asset.length()) { asset.getInt(it).toByte() }, expected.getJSONArray("replies").getJSONObject(0).toString(),
            LongArray(effects.length()) { kinds.indexOf(effects.getJSONObject(it).getString("kind")).toLong() }))
    }
    @Test fun actorSchedulingCrossesRealJni() { assertEquals(12L, ProjectActorChecks.run(base())) }
    private fun archiveCase(): Pair<ByteArray, Long> {
        val cases = fixture("foreign-import-vectors.json").getJSONArray("cases")
        val case = (0 until cases.length()).map { cases.getJSONObject(it) }.single { it.getString("name") == "bbs-model/16/plates-2-16" }
        return java.util.Base64.getDecoder().decode(case.getString("archiveBase64")) to
            case.getJSONObject("expected").getJSONArray("warnings").length().toLong()
    }
    @Test fun actorArchiveOpenAndSaveCrossRealJni() {
        val (archive, warnings) = archiveCase()
        assertEquals(7L, ProjectActorArchiveChecks.run(base(), archive, warnings))
    }
    @Test fun actorModelImportCrossesRealJni() {
        val cases = fixture("model-import-vectors.json").getJSONArray("cases")
        fun bytes(name: String) = (0 until cases.length()).map { cases.getJSONObject(it) }.single { it.getString("name") == name }
            .let { java.util.Base64.getDecoder().decode(it.getString("bytesBase64")) }
        assertEquals(7L, ProjectActorImportChecks.run(base(), bytes("stl-binary/cube"), bytes("obj/mtllib-unresolved"), bytes("detect/step")))
    }
    @Test fun providerDocumentOpenAndSaveCrossRealJni() {
        val (archive, warnings) = archiveCase()
        assertEquals(6L, ProjectDocumentChecks.run(base(), archive, warnings))
    }
    @Test fun contentResolverDocumentsTruncateAndReopen() {
        val (archive, warnings) = archiveCase()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = java.io.File(context.cacheDir, "provider-check.3mf")
        try {
            file.writeBytes(archive + ByteArray(4096) { 7 }) // A longer stale document.
            val document = ContentProjectDocument(context.contentResolver, android.net.Uri.fromFile(file))
            document.openOutput().use { it.write(archive) }
            assertEquals(archive.size.toLong(), file.length()) // Truncating write.
            ProjectPreparation().use { scope ->
                val imported = ProjectDocuments.prepare(scope, document, ProjectActorArchiveChecks.browserEquivalent,
                    LocalTimestampResolver { it }, ProjectIntegerProfile.CHROMIUM)
                assertEquals(ProjectArchiveFormat.FOREIGN, imported.format())
                assertEquals(warnings, imported.warningCount())
            }
        } finally { file.delete() }
    }
    @Test fun documentOwnershipCrossesRealJni() { assertEquals(7L, ProjectOwnerChecks.documentChecks(base())) }
    @Test fun clipboardOwnershipCrossesRealJni() {
        val capture = fixture("project-clipboard-vectors.json")
            .getJSONArray("traces").getJSONObject(0).getJSONObject("clipboard")
        val source = capture.getString("stateJson")
        val objectRecord = JSONObject(source).getJSONArray("plates").getJSONObject(0)
            .getJSONArray("objects").getJSONObject(0)
        fun ids(field: String, kind: String): JSONArray = JSONArray().apply {
            repeat(objectRecord.getJSONArray(field).length()) { put("import:$kind:android-copy-$it") }
        }
        val command = JSONArray().put(ProjectStaging.COMMAND_CLIPBOARD_PASTE)
            .put("import:object:android-copy").put(ids("volumes", "volume"))
            .put(ids("instances", "instance")).put(ids("layerRanges", "range")).put(JSONObject.NULL)
        val input = JSONArray().put(ProjectStaging.VERSION)
            .put(JSONArray().put(ProjectStaging.WORK_SINGLE).put(command)).toString()
        val assets = capture.getJSONArray("assets")
        fun bytes(index: Int): ByteArray = assets.getJSONObject(index).getJSONArray("bytes").let { values ->
            ByteArray(values.length()) { values.getInt(it).toByte() }
        }
        assertEquals(6L, ProjectOwnerChecks.clipboardChecks(source, input, bytes(0), bytes(1)))
        assertEquals(13L, ProjectActorClipboardChecks.run(source, input, bytes(0), bytes(1)))
    }
    @Test fun actorClipboardMatchesIndependentBrowserFixtures() {
        val traces = fixture("project-staged-session-vectors.json").getJSONArray("traces")
        for (name in listOf("clipboard:roundtrip", "clipboard:sorted-projection")) {
            val trace = (0 until traces.length()).map { traces.getJSONObject(it) }.single { it.getString("name") == name }
            val steps = trace.getJSONArray("steps")
            val copy = steps.getJSONObject(0).getJSONArray("actions").getJSONObject(2)
            val command = steps.getJSONObject(1).getJSONArray("actions").getJSONObject(0).getJSONObject("work").getJSONObject("single")
            val ids = command.getJSONObject("ids")
            fun text(units: JSONArray): String = CharArray(units.length()) { units.getInt(it).toChar() }.concatToString()
            fun list(field: String): JSONArray = ids.getJSONArray(field).let { array ->
                JSONArray().apply { repeat(array.length()) { put(text(array.getJSONArray(it))) } }
            }
            val input = JSONArray().put(ProjectStaging.VERSION).put(JSONArray().put(ProjectStaging.WORK_SINGLE).put(
                JSONArray().put(ProjectStaging.COMMAND_CLIPBOARD_PASTE).put(text(ids.getJSONArray("objectId")))
                    .put(list("volumeIds")).put(list("instanceIds")).put(list("layerRangeIds"))
                    .put(if (command.isNull("destination")) JSONObject.NULL else text(command.getJSONArray("destination")))
            )).toString()
            val expected = steps.getJSONObject(3)
            val effects = expected.getJSONArray("effects")
            val kinds = listOf("project", "selection", "history")
            val assets = trace.getJSONArray("assets")
            fun bytes(index: Int): ByteArray = assets.getJSONObject(index).getJSONArray("bytes").let { values -> ByteArray(values.length()) { values.getInt(it).toByte() } }
            assertEquals(1L, ProjectActorClipboardChecks.replay(trace.getString("stateJson"), input, bytes(0), bytes(1), copy.optLong("queryPlate", copy.getLong("plate")),
                expected.getJSONArray("replies").getJSONObject(0).toString(), LongArray(effects.length()) { kinds.indexOf(effects.getJSONObject(it).getString("kind")).toLong() }))
        }
    }
    @Test fun timestampSyntaxAndTimezoneRulesMatchBrowserReferences() {
        val source = base()
        val corpus = fixture("validation-value-vectors.json")
        val zones = corpus.getJSONArray("zones")
        val cases = corpus.getJSONArray("timestamps")
        for (profile in ProjectIntegerProfile.entries) for (z in 0 until zones.length()) {
            val resolver = ProjectTimeZone(ZoneId.of(zones.getJSONObject(z).getString("name")))
            for (i in 0 until cases.length()) {
                val case = cases.getJSONObject(i)
                val units = case.getJSONArray("units")
                val bytes = timestamps(source, CharArray(units.length()) { units.getInt(it).toChar() }).toByteArray(Charsets.UTF_8)
                val options = ProjectHostOptions(bytes.size.toLong(), 1_000_000, 4_000_000,
                    1024, 128, 10, 16_777_216, 33_554_432, 100, 33_554_432)
                var valid = false
                ProjectUpload(bytes.size.toLong(), options, resolver, profile).use { upload ->
                    for (start in bytes.indices step 65536) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + 65536, bytes.size)))
                    try { upload.sealDocument(); valid = true }
                    catch (failure: IllegalStateException) { assertEquals("invalid_document", failure.message) }
                }
                assertEquals("Timestamp case $i / $z / $profile", !case.getJSONArray("smi${profile.bits}").isNull(z), valid)
            }
        }
        val local = corpus.getJSONArray("localTimes")
        for (i in 0 until local.length()) {
            val case = local.getJSONObject(i)
            val results = case.getJSONArray("zones")
            for (z in 0 until results.length()) {
                val result = results.getJSONObject(z)
                assertEquals(result.getLong("smi31"), ProjectTimeZone(ZoneId.of(result.getString("zone"))).resolve(case.getLong("civil")))
            }
        }
    }
}
