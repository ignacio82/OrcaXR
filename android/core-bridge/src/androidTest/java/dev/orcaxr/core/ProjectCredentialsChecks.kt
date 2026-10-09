package dev.orcaxr.core

/** The remembered credentials record through the Kotlin wrapper: every
 * stored record of the browser's corpus loads, and every record saves, as the
 * browser's do. */
object ProjectCredentialsChecks {
    /** [script] lines: `loads\t<stored text, or - for none>\t<record>` and
     * `saves\t<record>\t<stored text, or - for none>`. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val columns = line.split("\t")
            val label = "credentials_${columns[0]}_$checks"
            val text = { value: String -> value.takeIf { it != "-" } }
            when (columns[0]) {
                "loads" -> check(RememberedCredentialsPolicy.load(text(columns[1])) == ProjectIntents.decodeRememberedCredentials(columns[2])) { label }
                "saves" -> {
                    val record = ProjectIntents.decodeRememberedCredentials(columns[1])
                    check(RememberedCredentialsPolicy.save(record) == text(columns[2])) { label }
                }
                else -> error("unknown script entry ${columns[0]}")
            }
            checks++
        }
        return checks
    }
}
