package dev.orcaxr.core

/**
 * File → Export Diagnostics… through the Kotlin owner, over JNI: the facts the
 * core states, every recorded event of the browser's corpus
 * (`diagnostics-vectors.json`) a host can record (whole milliseconds) kept as
 * the browser keeps it, and every bundle of an Android host's facts written
 * from a [Diagnostics.Input] — its file, preview and kept events the browser's.
 */
object DiagnosticsChecks {
    private fun obj(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun has(o: ProjectJsonObject, key: String) = o.keys().asSequence().any { it == key }
    private fun strings(value: Any?) = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
    private fun long(o: ProjectJsonObject, key: String) = (o.get(key) as Number).toLong()

    @JvmStatic fun run(corpus: String): Long {
        var checks = 0L
        val fixture = obj(corpus)
        val facts = obj(fixture.get("factsJson") as String)
        check(Diagnostics.facts() == Diagnostics.Facts(long(facts, "actionCount"), long(facts, "unavailableCount"), facts.get("engineCommit") as String)); checks++

        val entries = fixture.get("entries") as ProjectJsonArray
        for (i in 0 until entries.length()) {
            val case = entries.get(i) as ProjectJsonObject
            val request = obj(case.get("requestJson") as String)
            val at = (request.get("atMs") as Number).toDouble()
            if (at != Math.floor(at) || at > Long.MAX_VALUE) continue
            val level = Diagnostics.Level.entries.single { it.wire == request.get("level") }
            val kept = Diagnostics.entry(at.toLong(), level, request.get("scope") as String, request.get("message") as String, strings(request.get("secrets")))
            check(kept == case.get("replyJson")) { "entry ${case.get("requestJson")}" }; checks++
        }

        val bundles = fixture.get("bundles") as ProjectJsonArray
        for (i in 0 until bundles.length()) {
            val case = bundles.get(i) as ProjectJsonObject
            if (!(case.get("name") as String).startsWith("android host")) continue
            val request = obj(case.get("requestJson") as String)
            val input = request.get("input") as ProjectJsonObject
            val engine = input.get("engine") as ProjectJsonObject
            val browser = input.get("browser") as ProjectJsonObject
            val capabilities = input.get("capabilities") as ProjectJsonObject
            val printer = if (has(input, "printer")) input.get("printer") as ProjectJsonObject else null
            val project = if (has(input, "project")) input.get("project") as ProjectJsonObject else null
            val log = input.get("log") as ProjectJsonArray
            val built = Diagnostics.Input(
                appVersion = input.get("appVersion") as String,
                engineCommit = engine.get("commit") as String,
                route = engine.get("route") as String,
                externalAttested = if (has(engine, "externalAttested")) engine.get("externalAttested") as Boolean else null,
                userAgent = browser.get("userAgent") as String,
                language = browser.get("language") as String,
                hardwareConcurrency = if (has(browser, "hardwareConcurrency")) long(browser, "hardwareConcurrency").toInt() else null,
                printer = printer?.let {
                    Diagnostics.Printer(it.get("configured") as Boolean, it.get("connected") as Boolean, if (has(it, "jobState")) it.get("jobState") as String else null)
                },
                actionCount = long(capabilities, "actionCount"),
                unavailableCount = long(capabilities, "unavailableCount"),
                project = project?.let {
                    Diagnostics.ProjectShape(
                        long(it, "plateCount"), long(it, "objectCount"), long(it, "volumeCount"), long(it, "triangleCount"),
                        long(it, "physicalFilamentCount"), long(it, "mixedFilamentCount"), long(it, "paintedVolumeCount"),
                        strings(it.get("objectNames")),
                    )
                },
                log = List(log.length()) { n ->
                    val e = log.get(n) as ProjectJsonObject
                    "{\"atMs\":${long(e, "atMs")},\"level\":${CanonicalJson.quote(e.get("level") as String)}," +
                        "\"message\":${CanonicalJson.quote(e.get("message") as String)},\"scope\":${CanonicalJson.quote(e.get("scope") as String)}}"
                },
            )
            val reply = obj(case.get("replyJson") as String)
            val bundle = Diagnostics.bundle(built, request.get("includeModelNames") as Boolean)
            check(bundle == Diagnostics.Bundle(reply.get("file") as String, reply.get("description") as String, long(reply, "logEntries").toInt())) {
                "bundle ${case.get("name")}"
            }
            checks++
        }
        return checks
    }
}
