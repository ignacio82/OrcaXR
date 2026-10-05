package dev.orcaxr.core

/** Bounded ASCII JSON output. Charge escaped characters and numeric digits
 * before appending; source text uses generated UTF-16 unit arrays. */
internal class GcodeRequestWriter(private val maximum: Int) {
    private val output = StringBuilder()
    private var remaining = GcodeRequests.MAX_VALIDATION_NODES
    private var firstField = true
    private fun step() { require(--remaining >= 0) { "resource_limit" } }
    private fun add(value: String) {
        require(value.length <= maximum - output.length) { "resource_limit" }
        output.append(value)
    }
    fun finish(): String = output.toString()
    fun obj(block: () -> Unit) {
        step()
        val parent = firstField
        firstField = true
        add("{"); block(); add("}")
        firstField = parent
    }
    fun field(name: String, block: () -> Unit) {
        if (!firstField) add(",")
        firstField = false
        string(name); add(":"); block()
    }
    fun <T> array(values: List<T>, block: (T) -> Unit) {
        step()
        require(values.size <= remaining) { "resource_limit" }
        add("[")
        values.forEachIndexed { index, value -> if (index != 0) add(","); block(value) }
        add("]")
    }
    fun number(value: Double) {
        step(); require(value.isFinite()) { "invalid_request" }; add(value.toString())
    }
    private fun integer(value: Long, max: Long) {
        step(); require(value in 0..max) { "invalid_request" }; add(value.toString())
    }
    fun u8(value: Int) = integer(value.toLong(), 255)
    fun u16(value: Int) = integer(value.toLong(), 65535)
    fun u32(value: Long) = integer(value, 4294967295L)
    fun boolean(value: Boolean) { step(); add(value.toString()) }
    fun string(value: String) {
        step()
        require(value.length <= maximum - output.length) { "resource_limit" }
        add("\"")
        for (character in value) {
            when {
                character == '\\' -> add("\\\\")
                character == '"' -> add("\\\"")
                character.code in 32..126 -> add(character.toString())
                else -> add("\\u" + character.code.toString(16).padStart(4, '0'))
            }
        }
        add("\"")
    }
    fun range(values: List<Double>) {
        require(values.size == 2) { "invalid_request" }
        array(values) { number(it) }
    }
    fun window(value: GcodeRequests.Window) {
        when (value) {
            GcodeRequests.Window.Whole -> { step(); add("[]") }
            is GcodeRequests.Window.Entries -> {
                require(value.first <= value.last) { "invalid_request" }
                add("["); u32(value.first); add(","); u32(value.last); add("]")
            }
        }
    }
}
