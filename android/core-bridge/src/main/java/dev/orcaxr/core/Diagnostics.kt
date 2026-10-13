package dev.orcaxr.core

/**
 * File → Export Diagnostics… (`DiagnosticsBundle.ts` through the shared
 * core's `orcaxr_printer::diagnostics`, the browser's `diagnosticsExchange`):
 * the support bundle a host writes from its own facts — byte for byte the
 * browser's bundle of the same facts — its privacy preview, the events a
 * recorder keeps, and what the core itself states (the catalogue's counts,
 * the engine build the client accepts). Nothing here reaches for a clock,
 * a device or the network; the host supplies every fact.
 */
object Diagnostics {
    /** The file the browser downloads. */
    const val FILENAME = "orcaxr-diagnostics.json"
    const val MEDIA_TYPE = "application/json"

    /** `MAX_LOG_ENTRIES`: the newest events a recorder keeps. */
    const val MAX_LOG_ENTRIES = 200

    enum class Level(internal val wire: String) { INFO("info"), WARNING("warning"), ERROR("error") }

    /** A project's shape (`ProjectSummaryInput`): counts and object names, never geometry. */
    data class ProjectShape(
        val plateCount: Long,
        val objectCount: Long,
        val volumeCount: Long,
        val triangleCount: Long,
        val physicalFilamentCount: Long,
        val mixedFilamentCount: Long,
        val paintedVolumeCount: Long,
        val objectNames: List<String>,
    )

    /** What the core states: the catalogue's actions, the unavailable ones, and the engine build the client accepts. */
    data class Facts(val actionCount: Long, val unavailableCount: Long, val engineCommit: String)

    /** A written bundle: the file, its preview's words, and the events it keeps. */
    data class Bundle(val file: String, val description: String, val logEntries: Int)

    /** The printer's part of a bundle: whether one is set up, whether it is connected, and its job's state. */
    data class Printer(val configured: Boolean, val connected: Boolean, val jobState: String? = null)

    /**
     * The facts a bundle is written from (`DiagnosticsInput`, the parts a
     * host gathers): [log] holds the recorder's kept events ([entry]), oldest first.
     */
    data class Input(
        val appVersion: String,
        val engineCommit: String,
        val route: String,
        val externalAttested: Boolean? = null,
        val userAgent: String,
        val language: String,
        val hardwareConcurrency: Int? = null,
        val printer: Printer? = null,
        val actionCount: Long,
        val unavailableCount: Long,
        val project: ProjectShape? = null,
        val log: List<String> = emptyList(),
    )

    private fun fields(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun count(obj: ProjectJsonObject, key: String) = (obj.get(key) as Number).toLong()
    private fun quote(text: String) = CanonicalJson.quote(text)

    internal fun projectShape(json: String): ProjectShape {
        val obj = fields(json)
        val names = obj.get("objectNames") as ProjectJsonArray
        return ProjectShape(
            count(obj, "plateCount"), count(obj, "objectCount"), count(obj, "volumeCount"), count(obj, "triangleCount"),
            count(obj, "physicalFilamentCount"), count(obj, "mixedFilamentCount"), count(obj, "paintedVolumeCount"),
            List(names.length()) { names.get(it) as String },
        )
    }

    /** What the core states of the catalogue and the engine. */
    fun facts(): Facts {
        val obj = fields(NativeProject.diagnosticsFacts())
        return Facts(count(obj, "actionCount"), count(obj, "unavailableCount"), obj.get("engineCommit") as String)
    }

    /**
     * One event as a recorder keeps it (`diagnosticEntry`): [atMs] since the
     * recorder started, the scope cut to 64 units, the message struck of
     * [secrets] (those of at least 8 units) and the pattern rules — URLs,
     * credential assignments, control runs — and cut to 512. Its JSON, for [Input.log].
     */
    fun entry(atMs: Long, level: Level, scope: String, message: String, secrets: List<String>): String =
        NativeProject.diagnosticEntry(
            "{\"atMs\":$atMs,\"level\":${quote(level.wire)},\"message\":${quote(message)},\"scope\":${quote(scope)}," +
                "\"secrets\":${secrets.joinToString(",", "[", "]") { quote(it) }}}",
        )

    /** The request [input] makes (`diagnosticsBundleExchange`): every object in any order; the core reads the browser's. */
    internal fun request(input: Input, includeModelNames: Boolean): String = buildString {
        append("{\"includeModelNames\":").append(includeModelNames).append(",\"input\":{")
        append("\"appVersion\":").append(quote(input.appVersion))
        append(",\"engine\":{\"commit\":").append(quote(input.engineCommit)).append(",\"route\":").append(quote(input.route))
        input.externalAttested?.let { append(",\"externalAttested\":").append(it) }
        append("},\"browser\":{\"userAgent\":").append(quote(input.userAgent)).append(",\"language\":").append(quote(input.language))
        input.hardwareConcurrency?.let { append(",\"hardwareConcurrency\":").append(it) }
        append("}")
        input.printer?.let { printer ->
            append(",\"printer\":{\"configured\":").append(printer.configured).append(",\"connected\":").append(printer.connected)
            printer.jobState?.let { append(",\"jobState\":").append(quote(it)) }
            append("}")
        }
        append(",\"capabilities\":{\"actionCount\":").append(input.actionCount)
            .append(",\"unavailableCount\":").append(input.unavailableCount).append("}")
        input.project?.let { p ->
            append(",\"project\":{\"plateCount\":").append(p.plateCount).append(",\"objectCount\":").append(p.objectCount)
                .append(",\"volumeCount\":").append(p.volumeCount).append(",\"triangleCount\":").append(p.triangleCount)
                .append(",\"physicalFilamentCount\":").append(p.physicalFilamentCount)
                .append(",\"mixedFilamentCount\":").append(p.mixedFilamentCount)
                .append(",\"paintedVolumeCount\":").append(p.paintedVolumeCount)
                .append(",\"objectNames\":").append(p.objectNames.joinToString(",", "[", "]") { quote(it) }).append("}")
        }
        append(",\"log\":").append(input.log.joinToString(",", "[", "]"))
        append("}}")
    }

    /**
     * The bundle of [input] (`buildDiagnosticsBundle`): the newest
     * [MAX_LOG_ENTRIES] events, object names only with [includeModelNames],
     * everything redacted once more, written as the browser writes it, with
     * the privacy preview's words (`describeDiagnosticsBundle`).
     */
    fun bundle(input: Input, includeModelNames: Boolean = false): Bundle {
        val obj = fields(NativeProject.diagnosticsBundle(request(input, includeModelNames)))
        return Bundle(obj.get("file") as String, obj.get("description") as String, count(obj, "logEntries").toInt())
    }
}
