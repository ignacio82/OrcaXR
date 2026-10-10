package dev.orcaxr.core

/**
 * The typed staged-record writer ([ProjectStagedRecords]) against the browser's
 * staged corpus (`project-staged-session-vectors.json`). [encode] turns a corpus
 * work — instance copies, clipboard pastes, added parts and objects with their
 * payloads, alone or as a transaction — into typed [StagedWork] and
 * writes its records, so the JNI replay stages and executes those bytes and
 * compares every reply, effect and state with the browser's. [run] checks the
 * written bytes against the browser's own encoding and the writer's typed rules.
 */
object ProjectStagedRecordChecks {
    private fun units(value: Any) = (value as ProjectJsonArray).let { list -> String(CharArray(list.length()) { (list.get(it) as Double).toInt().toChar() }) }
    private fun ids(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { units(list.get(it)) } }
    private fun has(value: ProjectJsonObject, key: String) = value.keys().asSequence().any { it == key }
    private fun payload(value: Any): StagedPayload {
        val asset = value as ProjectJsonObject
        val bytes = asset.get("bytes") as ProjectJsonArray
        return StagedPayload(asset.get("descriptorJson") as String, ByteArray(bytes.length()) { (bytes.get(it) as Double).toInt().toByte() })
    }

    /** One corpus command as a typed record; null for a kind the app does not stage. */
    private fun command(value: ProjectJsonObject): StagedCommand? = when {
        has(value, "clipboard") -> {
            val plan = value.get("ids") as ProjectJsonObject
            StagedCommand.ClipboardPaste(
                units(plan.get("objectId")), ids(plan.get("volumeIds")), ids(plan.get("instanceIds")), ids(plan.get("layerRangeIds")),
                if (has(value, "destination")) (value.get("destination") as? ProjectJsonArray)?.let(::units) else null,
            )
        }
        else -> when (value.get("kind")) {
            "instance" -> {
                // A typed index is a whole number: a fractional or huge one stays the browser's own.
                val index = value.get("index") as? Double
                if (index != null && index.toInt().toDouble() != index) null
                else StagedCommand.CreateInstance(units(value.get("objectId")), StagedRecord.of(value.get("recordJson") as String), index?.toInt())
            }
            "addVolume" -> StagedCommand.AddVolume(units(value.get("objectId")), StagedRecord.of(value.get("recordJson") as String), payload(value.get("asset")))
            "addObjectWithAsset" -> StagedCommand.AddObjectWithAsset(units(value.get("plateId")), StagedRecord.of(value.get("recordJson") as String), payload(value.get("asset")))
            else -> null
        }
    }

    /** One corpus work as typed values; null when it carries a command the app does not stage. */
    fun work(json: String): StagedWork? = runCatching {
        val work = CanonicalJson.read(json) as ProjectJsonObject
        when {
            has(work, "single") -> command(work.get("single") as ProjectJsonObject)?.let { StagedWork.Single(it) }
            has(work, "commands") -> {
                val list = work.get("commands") as ProjectJsonArray
                val commands = List(list.length()) { command(list.get(it) as ProjectJsonObject) }
                if (commands.any { it == null }) null else StagedWork.Transaction(units(work.get("label")), commands.filterNotNull())
            }
            else -> null
        }
    }.getOrNull()

    /** The records [ProjectStagedRecords] writes for a corpus work, or null for one it does not stage. */
    @JvmStatic fun encode(json: String): String? = work(json)?.let { String(ProjectStagedRecords.encode(it), Charsets.US_ASCII) }

    /** [script] lines (tab-separated) `W <work> <records>`: the browser's records for a work, non-ASCII escaped. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        for (line in script.split("\n").filter { it.isNotEmpty() }) {
            val (kind, json, expected) = line.split("\t")
            check(kind == "W" && encode(json) == expected, "records $json")
        }
        fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
        // An instance as a bed fill writes it: name only when it has one, every unit kept.
        val turned = ProjectIntents.Transform(listOf(100.5, -0.25, 1e-7), listOf(0.0, 0.0, 0.7071067811865476, 0.7071067811865476), listOf(1.0, 1.0, 2.0))
        check(
            StagedRecord.instance("import:instance:a", turned, false).toString() ==
                "{\"id\":\"import:instance:a\",\"printable\":false,\"transform\":{\"rotation\":[0.0,0.0,0.7071067811865476,0.7071067811865476]," +
                "\"scale\":[1.0,1.0,2.0],\"translationMm\":[100.5,-0.25,1.0E-7]}}",
            "instance_record",
        )
        check(
            StagedRecord.instance("import:instance:b", turned, true, "Ä \"q\" \ud800").toString().contains("\"name\":\"\\u00c4 \\\"q\\\" \\ud800\""),
            "instance_name",
        )
        check(failure { StagedRecord.instance("import:instance:c", turned.copy(scale = listOf(1.0, Double.NaN, 1.0)), true) } == "invalid_record", "instance_nan")
        // Records are one object; text outside ASCII is escaped.
        check(StagedRecord.of(" {\"name\":\"Ä😀\"} ").toString() == "{\"name\":\"\\u00c4\\ud83d\\ude00\"}", "record_ascii")
        for (bad in listOf("[]", "{\"a\":1", "{} {}", "{\"a\":01}", "")) check(failure { StagedRecord.of(bad) } == "invalid_record", "record_refused $bad")
        // Payloads: each ID once, first declaration first; one ID with other bytes is refused.
        val mesh = ByteArray(48) { it.toByte() }
        fun descriptor(id: String, length: Int = 48) = "{\"byteLength\":$length,\"digest\":\"fnv1a64:0\",\"id\":\"$id\",\"kind\":\"mesh\"}"
        val first = StagedPayload(descriptor("import:asset:one"), mesh)
        val second = StagedPayload(descriptor("import:asset:two"), mesh)
        val volume = StagedRecord.of("{\"id\":\"import:volume:v\"}")
        val work = StagedWork.Transaction(
            "Helpers",
            listOf(
                StagedCommand.AddVolume("import:object:o", volume, second),
                StagedCommand.AddVolume("import:object:o", volume, first),
                StagedCommand.AddVolume("import:object:o", volume, StagedPayload(descriptor("import:asset:two"), mesh.copyOf())),
            ),
        )
        check(ProjectStagedRecords.payloads(work).map { it.id } == listOf("import:asset:two", "import:asset:one"), "payload_order")
        val clash = StagedWork.Transaction("Clash", listOf(StagedCommand.AddVolume("o", volume, first), StagedCommand.AddVolume("o", volume, StagedPayload(descriptor("import:asset:one"), ByteArray(48)))))
        check(failure { ProjectStagedRecords.payloads(clash) } == "invalid_payload", "payload_clash")
        check(failure { StagedPayload(descriptor("import:asset:short", 47), mesh) } == "invalid_payload", "payload_length")
        // The kinds and fields of the contract, in order.
        val paste = StagedWork.Single(StagedCommand.ClipboardPaste("import:object:p", listOf("import:volume:p"), listOf("import:instance:p"), emptyList(), "import:plate:\ud800"))
        check(
            String(ProjectStagedRecords.encode(paste), Charsets.US_ASCII) ==
                "[1,[0,[3,\"import:object:p\",[\"import:volume:p\"],[\"import:instance:p\"],[],\"import:plate:\\ud800\"]]]",
            "paste_records",
        )
        check(ProjectStagedRecords.pastes(paste) && !ProjectStagedRecords.pastes(work), "pastes")
        return checks
    }
}
