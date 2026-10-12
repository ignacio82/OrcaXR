package dev.orcaxr.core

import java.util.Base64

/**
 * What binds a slice's output, through JNI and the Kotlin owner, against the
 * production browser (`slice-sidecar-vectors.json`): every plate's profile
 * snapshot, output binding and external route through the exchanges and the
 * typed owners ([SliceSidecars.profiles], [SliceSidecars.bindingProblem],
 * [SliceSidecars.externalRoute]) — each refusal in the browser's words, each
 * malformed request refused — then this device's route and a sidecar bound
 * to one output, refused when its parts name another; and the engine's
 * totals (`gcode-summary-vectors.json`) streamed through [SliceStatusTally]
 * in several chunkings, read as the browser reads the whole file.
 */
object ProjectSliceSidecarChecks {
    private const val COMMIT = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626"
    private val ARTIFACT = "sha256:" + "ab".repeat(32)
    private val NUMBERS = setOf(
        "lengthMm", "volumeCm3", "weightG", "totalWeightG", "totalCost", "toolChanges", "layerCount", "estimatedSeconds", "firstLayerSeconds",
    )

    private fun text(value: Any?) = value as String

    /**
     * [script] lines: `<section>\t<request>\t<reply>` for the corpus's answers
     * (`profiles`, `bindings`, `routes`), `R\t<section>\t<request>` for its
     * malformed requests. [summaries] lines: name, the artifact (base64), the
     * browser's summary (its numbers spelled as JavaScript spells them).
     */
    @JvmStatic fun run(script: String, summaries: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun refusal(block: () -> Unit): String? = try {
            block()
            null
        } catch (failure: IllegalStateException) {
            failure.message
        }
        fun refusedIn(reply: String): String? = (CanonicalJson.read(reply) as ProjectJsonObject).let { if (it.keys().next() == "error" && it.length() == 1) it.get("error") as String else null }

        // --- The browser's corpus through the exchanges and the typed owners ---
        var typedBindings = 0
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            if (columns[0] == "R") {
                val exchange: (String) -> String = when (columns[1]) {
                    "profileRefusals" -> SliceSidecars.Exchanges::profiles
                    "bindingRefusals" -> SliceSidecars.Exchanges::binding
                    "routeRefusals" -> SliceSidecars.Exchanges::route
                    else -> error("unknown refusal ${columns[1]}")
                }
                check(refusal { exchange(columns[2]) } == "invalid_request", "refused ${columns[1]} ${columns[2].take(80)}")
                continue
            }
            val (section, request, reply) = columns
            val fields = CanonicalJson.read(request) as ProjectJsonObject
            when (section) {
                "profiles" -> {
                    check(SliceSidecars.Exchanges.profiles(request) == reply, "profiles ${request.take(80)}")
                    val stateJson = text(fields.get("stateJson"))
                    val plateId = text(fields.get("plateId"))
                    val refused = refusedIn(reply)
                    if (refused != null) {
                        check(refusal { SliceSidecars.profiles(stateJson, plateId) } == refused, "profiles refused for $plateId")
                    } else {
                        val owned = SliceSidecars.profiles(stateJson, plateId)
                        val answer = CanonicalJson.read(reply) as ProjectJsonObject
                        check(owned.json == reply && owned.effectiveConfigHash == answer.get("effectiveConfigHash") &&
                            owned.references == (answer.get("references") as ProjectJsonArray).length(), "profiles owner for $plateId")
                    }
                }
                "bindings" -> {
                    check(SliceSidecars.Exchanges.binding(request) == reply, "binding ${request.take(80)}")
                    // Every binding the typed owner can carry answers through it too.
                    val binding = fields.get("binding") as? ProjectJsonObject
                    val names = listOf("jobId", "plateId", "sourceHash", "sourceAssetHash", "projectInputHash", "gcodeOutputHash",
                        "effectiveConfigHash", "engineCommit", "engineArtifactHash")
                    val revision = binding?.takeIf { it.length() == 10 }?.let { runCatching { it.get("sourceRevision") }.getOrNull() } as? Double
                    if (binding != null && revision != null && revision % 1.0 == 0.0 && revision >= 0 && revision <= 9007199254740991.0 &&
                        names.all { runCatching { binding.get(it) }.getOrNull() is String }) {
                        val typed = SliceBinding(
                            text(binding.get("jobId")), text(binding.get("plateId")), revision.toLong(), text(binding.get("sourceHash")),
                            text(binding.get("sourceAssetHash")), text(binding.get("projectInputHash")), text(binding.get("gcodeOutputHash")),
                            text(binding.get("effectiveConfigHash")), text(binding.get("engineCommit")), text(binding.get("engineArtifactHash")),
                        )
                        check(SliceSidecars.bindingProblem(typed) == refusedIn(reply), "binding owner ${typed.jobId.take(40)}")
                        typedBindings++
                    }
                }
                "routes" -> {
                    check(SliceSidecars.Exchanges.route(request) == reply, "route ${request.take(80)}")
                    val engine = fields.get("engine") as ProjectJsonObject
                    val endpoint = text(fields.get("endpoint"))
                    val attested = SliceEngine(text(engine.get("commit")), text(engine.get("artifactHash")))
                    val refused = refusedIn(reply)
                    if (refused != null) {
                        check(refusal { SliceSidecars.externalRoute(endpoint, attested) } == refused, "route refused for $endpoint")
                    } else {
                        val route = SliceSidecars.externalRoute(endpoint, attested)
                        check(route.json == reply && route.kind == "external-server" && route.engine == attested, "route owner for $endpoint")
                    }
                }
                else -> error("unknown section $section")
            }
        }
        check(typedBindings > 40, "typed bindings $typedBindings")

        // --- This device's route, and a sidecar bound to one output ---
        val engine = SliceEngine(COMMIT, ARTIFACT)
        val route = SliceSidecars.nativeRoute(engine)
        check(route.id == "slicer-client:android-native:$ARTIFACT" && route.kind == "android-native" && route.engine == engine, "native route")
        check(refusal { SliceSidecars.nativeRoute(SliceEngine("HEAD", ARTIFACT)) } != null, "an unnamed engine names no route")
        val profiles = script.split("\n").first { it.startsWith("profiles\t") && it.contains("\"tool\":") }.split("\t").let { columns ->
            val fields = CanonicalJson.read(columns[1]) as ProjectJsonObject
            SliceSidecars.profiles(text(fields.get("stateJson")), text(fields.get("plateId")))
        }
        val revision = ProjectRevision(7, "fnv1a64:0123456789abcdef", "fnv1a64:fedcba9876543210")
        val binding = SliceBinding.of("slice-1", "plate-1", revision, "01".repeat(32), "02".repeat(32), profiles, route)
        check(binding.sourceRevision == 7L && binding.sourceHash == revision.semanticHash && binding.sourceAssetHash == revision.assetFingerprint &&
            binding.projectInputHash == "sha256:" + "01".repeat(32) && binding.engineArtifactHash == ARTIFACT, "binding of an output")
        check(SliceSidecars.bindingProblem(binding) == null, "the binding is valid")
        val summary = """{"perTool":[{"toolIndex":0,"weightG":1.5,"material":"PLA"}],"layerCount":12.0,"empty":false}"""
        val document = CanonicalJson.read(SliceSidecars.sidecar(binding, profiles, route, 4096, summary, listOf("a warning"))) as ProjectJsonObject
        val statistics = document.get("statistics") as ProjectJsonObject
        check(document.get("schema") == SliceSidecars.SCHEMA && document.get("version") == 1.0, "sidecar schema")
        check((document.get("binding") as ProjectJsonObject).get("gcodeOutputHash") == "sha256:" + "02".repeat(32), "sidecar binding")
        check(statistics.get("route") == "android-native" && statistics.get("gcodeBytes") == 4096.0, "sidecar statistics")
        check(((statistics.get("summary") as ProjectJsonObject).get("layerCount")) == 12.0, "sidecar summary")
        check((document.get("warnings") as ProjectJsonArray).get(0) == "a warning", "sidecar warnings")
        check(SliceSidecars.sidecar(binding, profiles, route, 0, "null", emptyList()).contains("\"summary\":null"), "a summary past the bound")
        check(refusal { SliceSidecars.sidecar(binding.copy(effectiveConfigHash = "sha256:" + "03".repeat(32)), profiles, route, 1, summary, emptyList()) } ==
            "binding.effectiveConfigHash is not the effective configuration the plate was sliced with", "another configuration refused")
        check(refusal { SliceSidecars.sidecar(binding.copy(engineCommit = "0".repeat(40)), profiles, route, 1, summary, emptyList()) } ==
            "binding's engine is not the route's engine", "another engine refused")
        check(refusal { SliceSidecars.sidecar(binding.copy(gcodeOutputHash = "02"), profiles, route, 1, summary, emptyList()) } ==
            "binding.gcodeOutputHash must be a SHA-256 identity", "an unbound output refused")
        check(refusal { SliceSidecars.sidecar(binding, profiles, route, -1, summary, emptyList()) } ==
            "gcodeBytes must be a non-negative safe integer", "a negative length refused")

        // --- The engine's totals, streamed through the tally as the app publishes a file ---
        val decoder = Base64.getDecoder()
        for (line in summaries.split("\n")) {
            val (name, encoded, expected) = line.split("\t")
            val bytes = decoder.decode(encoded)
            val want = CanonicalJson.read(expected) as ProjectJsonObject
            val sizes = if (bytes.size <= 8192) listOf(bytes.size.coerceAtLeast(1), 1, 3, 4093) else listOf(bytes.size, 7, 65_536, 300_001)
            for (size in sizes) {
                val tally = SliceStatusTally()
                tally.use {
                    var at = 0
                    while (at < bytes.size) {
                        val count = minOf(size, bytes.size - at)
                        if (count == 1) it.write(bytes[at].toInt()) else it.write(bytes, at, count)
                        at += count
                    }
                }
                // Kept once the tally is closed, as its figures are.
                check(same(CanonicalJson.read(tally.summaryJson()), want), "summary $name in chunks of $size: ${tally.summaryJson().take(200)}")
            }
        }
        // A colour statement past the metadata bound leaves no summary.
        val oversized = SliceStatusTally()
        oversized.use {
            it.write("; filament_colour = ".toByteArray())
            val run = ByteArray(1 shl 20) { '#'.code.toByte() }
            repeat(9) { _ -> it.write(run, 0, run.size) }
            it.write("\n; total layers count = 3\n".toByteArray())
        }
        check(oversized.summaryJson() == "null" && oversized.figures().layers == "3", "a statement past the bound")
        return checks
    }

    /** The tally's summary against the browser's, whose numbers are JavaScript's spellings. */
    private fun same(actual: Any, expected: Any, key: String? = null): Boolean = when {
        key in NUMBERS -> (actual as? Double) == (expected as? String)?.toDouble()
        actual is ProjectJsonObject && expected is ProjectJsonObject ->
            actual.keys().asSequence().toSet() == expected.keys().asSequence().toSet() &&
                actual.keys().asSequence().all { same(actual.get(it), expected.get(it), it) }
        actual is ProjectJsonArray && expected is ProjectJsonArray ->
            actual.length() == expected.length() && (0 until actual.length()).all { same(actual.get(it), expected.get(it)) }
        else -> actual == expected
    }
}
