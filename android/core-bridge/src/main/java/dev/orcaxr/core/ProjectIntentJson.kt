package dev.orcaxr.core

class InvalidProjectIntent : IllegalArgumentException("Invalid project command intent")

/** The bounds one root's wire text is held to: commands use the schema's, and
 * the bulk tier ([ProjectIntents.BULK]) carries a printer's replies decoded. */
internal class ProjectIntentLimits(val bytes: Int, val nodes: Int, val depth: Int) {
    companion object {
        val DEFAULT = ProjectIntentLimits(ProjectIntents.MAX_BYTES, ProjectIntents.MAX_NODES, ProjectIntents.MAX_DEPTH)
    }
}

/** Strict, bounded ASCII JSON. User text is carried as UTF-16 integer units. */
internal object ProjectIntentJson {
    // Protocol parsing must behave identically on Android and the host JVM.
    // This is deliberately separate from persisted-document last-key-wins JSON.
    fun parse(text: String, limits: ProjectIntentLimits = ProjectIntentLimits.DEFAULT): Any {
        if (text.length > limits.bytes || text.any { it.code > 127 } || !StrictJsonTokens.valid(text)) throw InvalidProjectIntent()
        return Parser(text, limits).parse()
    }

    private object JsonNull
    private class Parser(private val text: String, private val limits: ProjectIntentLimits) {
        private var offset = 0
        private var remaining = limits.nodes
        private fun peek(): Char = text.getOrNull(offset) ?: '\u0000'
        private fun whitespace() { while (peek() in " \t\r\n") offset++ }
        private fun take(character: Char): Boolean {
            if (peek() != character) return false
            offset++
            return true
        }
        private fun requireCharacter(character: Char) { if (!take(character)) throw InvalidProjectIntent() }
        fun parse(): Any {
            val value = read(0)
            whitespace()
            if (offset != text.length) throw InvalidProjectIntent()
            return value
        }
        private fun string(): String {
            requireCharacter('"')
            val value = StringBuilder()
            while (offset < text.length) {
                val character = text[offset++]
                if (character == '"') return value.toString()
                if (character != '\\') value.append(character)
                else when (val escape = text[offset++]) {
                    'u' -> {
                        value.append(text.substring(offset, offset + 4).toInt(16).toChar())
                        offset += 4
                    }
                    'b' -> value.append('\b')
                    'f' -> value.append('\u000c')
                    'n' -> value.append('\n')
                    'r' -> value.append('\r')
                    't' -> value.append('\t')
                    else -> value.append(escape)
                }
            }
            throw InvalidProjectIntent()
        }
        private fun read(depth: Int): Any {
            if (--remaining < 0 || depth > limits.depth) throw InvalidProjectIntent()
            whitespace()
            return when (peek()) {
                '{' -> {
                    offset++
                    whitespace()
                    val entries = linkedMapOf<String, Any>()
                    if (!take('}')) {
                        do {
                            whitespace()
                            val key = string()
                            if (entries.containsKey(key)) throw InvalidProjectIntent()
                            whitespace()
                            requireCharacter(':')
                            entries[key] = read(depth + 1)
                            whitespace()
                        } while (take(','))
                        requireCharacter('}')
                    }
                    ProjectJsonObject(entries)
                }
                '[' -> {
                    offset++
                    whitespace()
                    val entries = arrayListOf<Any>()
                    if (!take(']')) {
                        do { entries.add(read(depth + 1)); whitespace() } while (take(','))
                        requireCharacter(']')
                    }
                    ProjectJsonArray(entries)
                }
                '"' -> string()
                else -> {
                    val start = offset
                    while (offset < text.length && peek() !in " \t\r\n{}[]:,\"") offset++
                    when (val token = text.substring(start, offset)) {
                        "true" -> true
                        "false" -> false
                        "null" -> JsonNull
                        else -> token.toDoubleOrNull()?.takeIf { it.isFinite() } ?: throw InvalidProjectIntent()
                    }
                }
            }
        }
    }

    fun fields(value: Any, names: Set<String>, union: Boolean): ProjectJsonObject {
        val obj = value as? ProjectJsonObject ?: throw InvalidProjectIntent()
        if (obj.length() != (if (union) 1 else names.size) || obj.keys().asSequence().any { it !in names }) throw InvalidProjectIntent()
        return obj
    }
    fun number(value: Any, min: Double, max: Double): Double {
        val number = (value as? Number)?.toDouble() ?: throw InvalidProjectIntent()
        if (!number.isFinite() || number < min || number > max) throw InvalidProjectIntent()
        return if (number == 0.0) 0.0 else number
    }
    fun wholeNumber(value: Any, min: Double, max: Double): Double {
        val number = number(value, min, max)
        if (number % 1.0 != 0.0) throw InvalidProjectIntent()
        return number
    }
    fun integer(value: Any, min: Long, max: Long): Long = wholeNumber(value, min.toDouble(), max.toDouble()).toLong()
    fun list(value: Any, min: Int, max: Int): ProjectJsonArray {
        val array = value as? ProjectJsonArray ?: throw InvalidProjectIntent()
        if (array.length() !in min..max) throw InvalidProjectIntent()
        return array
    }
}

internal class ProjectJsonObject(private val entries: Map<String, Any>) {
    fun get(key: String): Any = entries[key] ?: throw InvalidProjectIntent()
    fun length(): Int = entries.size
    fun keys(): Iterator<String> = entries.keys.iterator()
}
internal class ProjectJsonArray(private val entries: List<Any>) {
    fun get(index: Int): Any = entries[index]
    fun length(): Int = entries.size
}

/** Bounded writer for generated types; no user strings or raw JSON fragments. */
internal class ProjectIntentWriter(private val limits: ProjectIntentLimits = ProjectIntentLimits.DEFAULT) {
    private val output = StringBuilder()
    private var remaining = limits.nodes
    private var depth = 0
    private var firstField = true
    private fun node() { if (--remaining < 0 || depth > limits.depth) throw InvalidProjectIntent() }
    private fun add(text: String) {
        if (text.length > limits.bytes - output.length) throw InvalidProjectIntent()
        output.append(text)
    }
    fun finish(): String = output.toString()
    fun obj(block: () -> Unit) {
        node()
        val parent = firstField
        firstField = true
        add("{"); depth++; block(); depth--; add("}")
        firstField = parent
    }
    fun field(name: String, block: () -> Unit) {
        if (!firstField) add(",")
        firstField = false
        add("\"$name\":"); block()
    }
    fun <T> array(values: List<T>, min: Int, max: Int, block: (T) -> Unit) {
        node()
        if (values.size !in min..max || values.size > remaining) throw InvalidProjectIntent()
        add("["); depth++
        values.forEachIndexed { index, value -> if (index != 0) add(","); block(value) }
        depth--; add("]")
    }
    fun number(value: Double, min: Double, max: Double) {
        node(); val number = ProjectIntentJson.number(value, min, max); add(number.toString())
    }
    fun wholeNumber(value: Double, min: Double, max: Double) {
        node(); val number = ProjectIntentJson.wholeNumber(value, min, max); add(number.toString())
    }
    fun integer(value: Long, min: Long, max: Long) {
        node(); if (value !in min..max) throw InvalidProjectIntent(); add(value.toString())
    }
    fun boolean(value: Boolean) { node(); add(value.toString()) }
    fun literal(value: String) { node(); add("\"$value\"") }
}
