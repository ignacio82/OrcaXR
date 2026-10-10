package dev.orcaxr.core

/** Catalog profiles turned into the project's slicing configuration through
 * the Kotlin wrapper: every choice, match and selection answers the
 * browser's reply; every configuration and next state, fed forward as a host
 * feeds them, hashes to the browser's; a new workspace's default selection
 * is the browser's; and live choices staged on real sessions commit the
 * browser's state as one undoable "Update slicing configuration" entry, or
 * refuse with its message. */
object ProjectSlicingConfigurationChecks {
    private fun sha256(text: String) = java.security.MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private val limits = ProfileCatalogLimits(8L shl 20, 1L shl 20, 8L shl 20, 64, 64)
    private val utc = LocalTimestampResolver { it }
    private fun obj(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun ProjectJsonObject.has(key: String) = keys().asSequence().any { it == key }
    private fun ProjectJsonObject.text(key: String): String? = if (has(key)) get(key) as String else null
    private fun words(json: String) = (CanonicalJson.read(json) as ProjectJsonArray).let { list -> DoubleArray(list.length()) { list.get(it) as Double } }
    private fun policy(json: String) = obj(json).let { value ->
        val counts = value.get("confirmedCounts") as ProjectJsonArray
        AutoPairPolicy(value.get("enabled") as Boolean, List(counts.length()) { (counts.get(it) as Double).toInt() })
    }
    private fun live(json: String) = SlicingConfigurations.Json.live(obj(json))
    private fun upload(scope: ProjectPreparation, bytes: ByteArray): ProfileCatalog {
        val upload = scope.own(ProfileCatalogUpload(bytes.size.toLong(), limits))
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
            upload.append(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
        return scope.own(upload.build())
    }

    /** [script] holds one case per line: `T\t<state name>\t<state>`,
     * `C\t<catalog>\t<request>\t<reply>`, `M\t<request>\t<reply>`,
     * `S\t<catalog>\t<ids|names|default>\t<request>\t<reply>`,
     * `G\t<catalog>\t<live>\t<state name>\t<expected>` (`{"configurationSha256"}`,
     * `{"none":true}` or the refusal), `N\t<state:name|after:index>\t<index:n|json>\t<auto pairs>\t<words>\t<expected>`
     * (`{"stateSha256"}`, `{"unchanged":true}` or the refusal; a JSON configuration
     * follows `json:`) and `K\t<catalog>\t<state name>\t<live>\t<auto pairs>\t<words>\t<expected>`. */
    @JvmStatic fun run(bundled: ByteArray, synthetic: String, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val catalogs = mapOf("bundled" to upload(scope, bundled), "synthetic" to upload(scope, synthetic.toByteArray(Charsets.UTF_8)))
            val states = mutableMapOf<String, String>()
            val configurations = mutableListOf<String?>()
            val nextStates = mutableListOf<String?>()
            for ((index, line) in script.split("\n").withIndex()) {
                val entry = line.split("\t")
                val label = "slicing_${entry[0]}_$index"
                when (entry[0]) {
                    "T" -> states[entry[1]] = entry[2]
                    "C" -> {
                        val request = obj(entry[2])
                        val choices = catalogs.getValue(entry[1]).slicingChoices(request.text("machinePresetId"), request.text("processPresetId"))
                        check(choices == SlicingConfigurations.Json.choices(entry[3])) { label }
                        checks++
                    }
                    "M" -> {
                        val request = obj(entry[1])
                        val options = request.get("options") as ProjectJsonArray
                        val match = SlicingConfigurations.match(
                            List(options.length()) { SlicingConfigurations.Json.option(options.get(it) as ProjectJsonObject) },
                            request.get("query") as String,
                        )
                        check(match == (obj(entry[2]).get("option") as? ProjectJsonObject)?.let(SlicingConfigurations.Json::option)) { label }
                        checks++
                    }
                    "S" -> {
                        val catalog = catalogs.getValue(entry[1])
                        val request = obj(entry[3])
                        val current = SlicingConfigurations.Json.live(request.get("live") as ProjectJsonObject)
                        val selection = when (entry[2]) {
                            "ids" -> {
                                val wanted = request.get("request") as ProjectJsonObject
                                val filaments = if (wanted.has("filamentPresetIds")) (wanted.get("filamentPresetIds") as ProjectJsonArray).let { ids ->
                                    List(ids.length()) { ids.get(it) as? String }
                                } else null
                                catalog.selectPresets(current, wanted.text("machinePresetId"), wanted.text("processPresetId"), filaments)
                            }
                            "names" -> catalog.selectByNames(current, request.get("machine") as String, request.get("process") as String, request.get("filament") as String)
                            else -> catalog.defaultSelection(current)
                        }
                        check(selection == SlicingConfigurations.Json.selection(entry[4])) { label }
                        checks++
                        if (entry[2] == "default" && current == LiveSlicingChoice.EMPTY.copy(palette = current.palette)) {
                            // A new workspace starts where the browser's does.
                            check(current.palette == LiveSlicingChoice.DEFAULT_PALETTE) { "$label palette" }
                            check(catalog.defaultSelection(LiveSlicingChoice.EMPTY) == selection) { "$label empty" }
                            checks++
                        }
                    }
                    "G" -> {
                        val configuration = catalogs.getValue(entry[1]).slicingConfiguration(live(entry[2]), states.getValue(entry[3]), utc, ProjectIntegerProfile.NODE)
                        val expected = obj(entry[4])
                        configurations.add(
                            when (configuration) {
                                is SlicingConfiguration.Configured -> {
                                    check(sha256(configuration.configurationJson) == expected.text("configurationSha256")) { label }
                                    configuration.configurationJson
                                }
                                SlicingConfiguration.NoProfile -> { check(expected.has("none")) { label }; null }
                                is SlicingConfiguration.Refused -> {
                                    check(configuration.code == expected.text("error") && configuration.message == expected.text("message")) { label }
                                    null
                                }
                            },
                        )
                        checks++
                    }
                    "N" -> {
                        val state = if (entry[1].startsWith("state:")) states.getValue(entry[1].removePrefix("state:"))
                            else checkNotNull(nextStates[entry[1].removePrefix("after:").toInt()]) { label }
                        val configuration = if (entry[2].startsWith("index:")) checkNotNull(configurations[entry[2].removePrefix("index:").toInt()]) { label }
                            else entry[2].removePrefix("json:")
                        val next = SlicingConfigurations.nextState(state, configuration, policy(entry[3]), words(entry[4]), utc, ProjectIntegerProfile.NODE)
                        val expected = obj(entry[5])
                        nextStates.add(
                            when (next) {
                                is NextSlicingState.Changed -> {
                                    check(sha256(next.stateJson) == expected.text("stateSha256")) { label }
                                    next.stateJson
                                }
                                NextSlicingState.Unchanged -> { check(expected.has("unchanged")) { label }; null }
                                is NextSlicingState.Refused -> {
                                    check(next.code == expected.text("error") && next.message == expected.text("message")) { "$label $next" }
                                    null
                                }
                            },
                        )
                        checks++
                    }
                    "K" -> checks += commit(catalogs.getValue(entry[1]), states.getValue(entry[2]), live(entry[3]), policy(entry[4]), words(entry[5]), obj(entry[6]), label)
                    else -> error("unknown script entry ${entry[0]}")
                }
            }
        }
        return checks
    }

    /** The live choice staged on a session opened from [state], executed and undone. */
    private fun commit(
        catalog: ProfileCatalog,
        state: String,
        live: LiveSlicingChoice,
        policy: AutoPairPolicy,
        words: DoubleArray,
        expected: ProjectJsonObject,
        label: String,
    ): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = state.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 2_000_000, 1024, 128, 0, 16_777_216, 33_554_432, 16, 67_108_864), utc, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument()
            val session = scope.own(upload.open(longArrayOf(1, 2, 3, 4)))
            var sequence = 0L
            fun submit(operation: ProjectIntents.SessionOperation): ProjectIntents.SessionResult {
                sequence++
                val request = ProjectIntents.encodeSessionRequest(ProjectIntents.SessionRequest(1, listOf(1, 2, 3, 4), sequence, operation))
                return (session.submit(request) ?: session.runNext())!!.use { reply ->
                    ProjectIntents.decodeSessionReply(reply.wire().also { reply.effects().close() }).result
                }
            }
            fun hash() = session.snapshot().use { it.hash() }
            check(submit(ProjectIntents.SessionOperation.Hello(ProjectIntents.Hello(1, 1, 1, 1))) is ProjectIntents.SessionResult.Welcome)
            session.configureStaging(ProjectStagingPoolOptions(4, 4, 64_000_000, 0))
            val before = hash()
            when (val stage = session.stageSlicingConfiguration(catalog, live, policy, words)) {
                is SlicingStage.Staged -> {
                    stage.input.use { input ->
                        val result = submit(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(input.id)))
                        check((result as? ProjectIntents.SessionResult.Acknowledged)?.value?.changed == true) { "$label $result" }
                    }
                    check(hash() == expected.text("stateHash")) { "$label state" }
                    session.history().use { history ->
                        check(history.hasLabel(true) && String(history.label(true, 0, history.labelLength(true))) == "Update slicing configuration") { "$label undo label" }
                    }
                    val guard = (submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)) as ProjectIntents.SessionResult.Acknowledged).value.guard
                    check(submit(ProjectIntents.SessionOperation.Undo(guard)) is ProjectIntents.SessionResult.Acknowledged) { "$label undo" }
                    check(hash() == before) { "$label undone" }
                    checks += 2
                }
                SlicingStage.Unchanged -> {
                    check(expected.has("unchanged") && hash() == before) { label }
                    checks++
                }
                is SlicingStage.Refused -> {
                    check(stage.code == expected.text("error") && stage.message == expected.text("message") && hash() == before) { "$label $stage" }
                    checks++
                }
            }
        }
        return checks
    }
}
