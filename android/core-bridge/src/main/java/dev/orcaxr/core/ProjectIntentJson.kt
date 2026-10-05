package dev.orcaxr.core

import android.util.JsonReader
import android.util.JsonToken
import java.io.IOException
import java.io.StringReader
import org.json.JSONArray
import org.json.JSONObject

class InvalidProjectIntent : IllegalArgumentException("Invalid project command intent")

/** Strict, bounded ASCII JSON. User text is carried as UTF-16 integer units. */
internal object ProjectIntentJson {
    fun parse(text: String): Any {
        if (text.length > ProjectIntents.MAX_BYTES || text.any { it.code > 127 }) throw InvalidProjectIntent()
        if (!StrictJsonTokens.valid(text)) throw InvalidProjectIntent()
        var remaining = ProjectIntents.MAX_NODES
        fun read(reader: JsonReader, depth: Int): Any {
            if (--remaining < 0 || depth > ProjectIntents.MAX_DEPTH) throw InvalidProjectIntent()
            return when (reader.peek()) {
                JsonToken.BEGIN_OBJECT -> {
                    val result = JSONObject()
                    reader.beginObject()
                    while (reader.hasNext()) {
                        val key = reader.nextName()
                        if (result.has(key)) throw InvalidProjectIntent()
                        result.put(key, read(reader, depth + 1))
                    }
                    reader.endObject()
                    result
                }
                JsonToken.BEGIN_ARRAY -> {
                    val result = JSONArray()
                    reader.beginArray()
                    while (reader.hasNext()) result.put(read(reader, depth + 1))
                    reader.endArray()
                    result
                }
                JsonToken.STRING -> reader.nextString()
                JsonToken.NUMBER -> {
                    val number = reader.nextString().toDoubleOrNull()
                    if (number == null || !number.isFinite()) throw InvalidProjectIntent()
                    number
                }
                JsonToken.BOOLEAN -> reader.nextBoolean()
                JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
                else -> throw InvalidProjectIntent()
            }
        }
        try {
            return JsonReader(StringReader(text)).use { reader ->
                reader.isLenient = false
                val result = read(reader, 0)
                if (reader.peek() != JsonToken.END_DOCUMENT) throw InvalidProjectIntent()
                result
            }
        } catch (_: IOException) {
            throw InvalidProjectIntent()
        } catch (_: IllegalStateException) {
            throw InvalidProjectIntent()
        } catch (_: NumberFormatException) {
            throw InvalidProjectIntent()
        }
    }

    fun fields(value: Any, names: Set<String>, union: Boolean): JSONObject {
        val obj = value as? JSONObject ?: throw InvalidProjectIntent()
        if (obj.length() != (if (union) 1 else names.size) || obj.keys().asSequence().any { it !in names }) throw InvalidProjectIntent()
        return obj
    }
    fun wholeNumber(value: Any, min: Double, max: Double): Double {
        val number = (value as? Number)?.toDouble() ?: throw InvalidProjectIntent()
        if (!number.isFinite() || number % 1.0 != 0.0 || number < min || number > max) throw InvalidProjectIntent()
        return if (number == 0.0) 0.0 else number
    }
    fun integer(value: Any, min: Long, max: Long): Long = wholeNumber(value, min.toDouble(), max.toDouble()).toLong()
    fun list(value: Any, min: Int, max: Int): JSONArray {
        val array = value as? JSONArray ?: throw InvalidProjectIntent()
        if (array.length() !in min..max) throw InvalidProjectIntent()
        return array
    }
}

/** Bounded writer for generated types; no user strings or raw JSON fragments. */
internal class ProjectIntentWriter {
    private val output = StringBuilder()
    private var remaining = ProjectIntents.MAX_NODES
    private var depth = 0
    private var firstField = true
    private fun node() { if (--remaining < 0 || depth > ProjectIntents.MAX_DEPTH) throw InvalidProjectIntent() }
    private fun add(text: String) {
        if (text.length > ProjectIntents.MAX_BYTES - output.length) throw InvalidProjectIntent()
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
    fun wholeNumber(value: Double, min: Double, max: Double) {
        node(); val number = ProjectIntentJson.wholeNumber(value, min, max); add(number.toString())
    }
    fun integer(value: Long, min: Long, max: Long) {
        node(); if (value !in min..max) throw InvalidProjectIntent(); add(value.toString())
    }
    fun boolean(value: Boolean) { node(); add(value.toString()) }
    fun literal(value: String) { node(); add("\"$value\"") }
}
