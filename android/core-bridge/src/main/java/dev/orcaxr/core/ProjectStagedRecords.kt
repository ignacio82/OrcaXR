package dev.orcaxr.core

/**
 * One project record a staged command carries — an instance, a part (volume),
 * an object or an asset descriptor — as its canonical JSON object, exactly as
 * the shared core or the browser wrote it. Text outside ASCII is written as
 * `\u` escapes, so staged input is ASCII whatever the record holds (lone
 * surrogates included).
 */
class StagedRecord private constructor(internal val json: String) {
    override fun equals(other: Any?) = other is StagedRecord && other.json == json
    override fun hashCode() = json.hashCode()
    override fun toString() = json

    companion object {
        private fun ascii(json: String) = buildString(json.length) {
            for (unit in json) if (unit.code < 0x80) append(unit) else append("\\u").append(unit.code.toString(16).padStart(4, '0'))
        }

        /** Records nest no deeper than staged input may (`MAX_SUPPORTED_DEPTH`). */
        private val LIMITS = ProjectIntentLimits(Int.MAX_VALUE, Int.MAX_VALUE, 128)

        /** [json] as one record: a single JSON object without repeated keys, refused otherwise. */
        fun of(json: String): StagedRecord {
            val text = ascii(json.trim())
            val parsed = try { ProjectIntentJson.parse(text, LIMITS) } catch (_: IllegalArgumentException) { null }
            require(parsed is ProjectJsonObject) { "invalid_record" }
            return StagedRecord(text)
        }

        private fun number(value: Double): String {
            require(value.isFinite()) { "invalid_record" }
            return value.toString()
        }
        private fun numbers(values: List<Double>) = values.joinToString(",", "[", "]", transform = ::number)

        /**
         * An instance as the browser's bed fill and instance copy write it
         * (`captureInstanceCommand`): its ID, its name when it has one, its
         * transform and whether it prints.
         */
        fun instance(id: String, transform: ProjectIntents.Transform, printable: Boolean, name: String? = null): StagedRecord {
            require(transform.translationMm.size == 3 && transform.rotation.size == 4 && transform.scale.size == 3) { "invalid_record" }
            val fields = buildList {
                add("\"id\":" + CanonicalJson.quote(id))
                if (name != null) add("\"name\":" + CanonicalJson.quote(name))
                add("\"printable\":$printable")
                add(
                    "\"transform\":{\"rotation\":${numbers(transform.rotation)},\"scale\":${numbers(transform.scale)}" +
                        ",\"translationMm\":${numbers(transform.translationMm)}}",
                )
            }
            return StagedRecord(fields.joinToString(",", "{", "}"))
        }
    }
}

/**
 * A mesh payload a record declares: its canonical descriptor and its bytes,
 * streamed after the records (the browser's `AssetPayload`). The descriptor's
 * `id` and `byteLength` are read here; the session checks the rest.
 */
class StagedPayload(descriptorJson: String, val bytes: ByteArray) {
    val descriptor: StagedRecord = StagedRecord.of(descriptorJson)
    val id: String

    init {
        val fields = CanonicalJson.read(descriptor.json) as ProjectJsonObject
        id = fields.get("id") as String
        require((fields.get("byteLength") as Double) == bytes.size.toDouble()) { "invalid_payload" }
    }
}

/**
 * One staged command record (`contracts/project-staging.json` `commandKinds`)
 * the app stages. Intents travel as session intents instead: a staged intent
 * is charged by its exact browser text, which only the browser's encoder writes.
 */
sealed interface StagedCommand {
    /** `createInstance`: another instance of [objectId] at [index] (last when absent); selects it. */
    data class CreateInstance(val objectId: String, val record: StagedRecord, val index: Int? = null) : StagedCommand

    /**
     * `clipboardPaste`: the clipboard's object pasted under fresh IDs (one per
     * part, instance and height range, in its order) onto [destinationPlateId],
     * or the active plate when absent. Staged through the clipboard's own upload.
     */
    data class ClipboardPaste(
        val objectId: String,
        val volumeIds: List<String>,
        val instanceIds: List<String>,
        val layerRangeIds: List<String>,
        val destinationPlateId: String? = null,
    ) : StagedCommand

    /** `addVolume`: a part of [objectId] and the payload its source names. */
    class AddVolume(val objectId: String, val record: StagedRecord, val payload: StagedPayload) : StagedCommand

    /** `addObjectWithAsset`: an object on [plateId] and the payload its part names. */
    class AddObjectWithAsset(val plateId: String, val record: StagedRecord, val payload: StagedPayload) : StagedCommand
}

/** A staged work: one command, or several as one undoable step labelled [label]. */
sealed interface StagedWork {
    val commands: List<StagedCommand>

    data class Single(val command: StagedCommand) : StagedWork {
        override val commands get() = listOf(command)
    }

    data class Transaction(val label: String, override val commands: List<StagedCommand>) : StagedWork
}

/**
 * The browser's staged records (`StagedProjectCommands.ts` captures, as
 * `project-staged-replay.mjs` writes them for the core) from typed values:
 * `[version, [single, command]]` or `[version, [transaction, label, [commands]]]`,
 * each command `[kind, ...fields]` in the contract's field order. The bytes are
 * ASCII JSON; payloads are declared by descriptor and streamed afterwards, each
 * distinct ID once, in first-declaration order.
 */
object ProjectStagedRecords {
    /** The browser's staged-input bounds (`INSTANCE_INPUT_LIMITS` with `MESH_INPUT_LIMITS`' payloads). */
    fun options(bytes: Long) = ProjectStagingInputOptions(bytes, 1L shl 20, 16L shl 20, 1024, 128, 4096, 16L shl 20, 4096, 512L shl 20)

    private fun text(value: String) = CanonicalJson.quote(value)
    private fun texts(values: List<String>) = values.joinToString(",", "[", "]", transform = ::text)

    private fun command(command: StagedCommand): String = when (command) {
        is StagedCommand.CreateInstance ->
            "[${ProjectStaging.COMMAND_CREATE_INSTANCE},${text(command.objectId)},${command.record.json},${command.index?.toString() ?: "null"}]"
        is StagedCommand.ClipboardPaste ->
            "[${ProjectStaging.COMMAND_CLIPBOARD_PASTE},${text(command.objectId)},${texts(command.volumeIds)},${texts(command.instanceIds)}" +
                ",${texts(command.layerRangeIds)},${command.destinationPlateId?.let(::text) ?: "null"}]"
        is StagedCommand.AddVolume ->
            "[${ProjectStaging.COMMAND_ADD_VOLUME},${text(command.objectId)},${command.record.json},${command.payload.descriptor.json}]"
        is StagedCommand.AddObjectWithAsset ->
            "[${ProjectStaging.COMMAND_ADD_OBJECT_WITH_ASSET},${text(command.plateId)},${command.record.json},${command.payload.descriptor.json}]"
    }

    /** The records of [work] as the bytes a command upload takes. */
    fun encode(work: StagedWork): ByteArray {
        val body = when (work) {
            is StagedWork.Single -> "[${ProjectStaging.WORK_SINGLE},${command(work.command)}]"
            is StagedWork.Transaction -> "[${ProjectStaging.WORK_TRANSACTION},${text(work.label)},${work.commands.joinToString(",", "[", "]", transform = ::command)}]"
        }
        return "[${ProjectStaging.VERSION},$body]".toByteArray(Charsets.US_ASCII)
    }

    /** The payloads [work] declares, each ID once in first-declaration order: the order an upload asks for them. */
    fun payloads(work: StagedWork): List<StagedPayload> {
        val seen = LinkedHashMap<String, StagedPayload>()
        for (command in work.commands) {
            val payload = when (command) {
                is StagedCommand.AddVolume -> command.payload
                is StagedCommand.AddObjectWithAsset -> command.payload
                else -> null
            } ?: continue
            val first = seen.getOrPut(payload.id) { payload }
            require(first === payload || first.descriptor == payload.descriptor && first.bytes.contentEquals(payload.bytes)) { "invalid_payload" }
        }
        return seen.values.toList()
    }

    /** Whether [work] pastes the clipboard: it then stages through [ProjectActor.preparePaste]. */
    fun pastes(work: StagedWork): Boolean = work.commands.any { it is StagedCommand.ClipboardPaste }

    /** Appends [bytes] to [writer] in the upload's chunks. */
    fun write(writer: ProjectCommandWriter, bytes: ByteArray) {
        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
            writer.append(bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
    }

    /** Streams [payloads] into [assets] in the order the upload asks for them. */
    fun stream(assets: ProjectAssetWriter, payloads: List<StagedPayload>) {
        check(assets.count() == payloads.size.toLong()) { "incomplete_input" }
        for ((position, payload) in payloads.withIndex()) {
            check(assets.begin(position.toLong()) == payload.bytes.size.toLong()) { "invalid_payload" }
            for (start in payload.bytes.indices step ProjectHost.MAX_CHUNK_BYTES)
                assets.append(payload.bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, payload.bytes.size)))
            assets.finish()
        }
    }
}
