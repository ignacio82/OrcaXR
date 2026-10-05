package dev.orcaxr.core

import android.util.JsonReader
import android.util.JsonToken
import java.io.IOException
import java.io.StringReader
import org.json.JSONArray
import org.json.JSONObject

/** Bounded, strict parsing before shape validation. JSONObject's string parser
 * accepts non-JSON forms; its typed getters also coerce values. */
internal object GcodeJson {
    fun parse(text: String, active: () -> Unit = {}): Any {
        active()
        require(text.length in 2..GcodeLayout.MAX_METADATA_BYTES && !text.startsWith('\uFEFF'))
        // Some platform JsonReader revisions accept literal controls inside
        // quoted strings even with leniency disabled. Enforce JSON escaping.
        var quoted = false
        var escaped = false
        for (index in text.indices) {
            if (index and 4095 == 0) active()
            val character = text[index]
            if (character.code < 32) require(!quoted && character in "\t\r\n")
            if (quoted) {
                if (escaped) escaped = false
                else if (character == '\\') escaped = true
                else if (character == '"') quoted = false
            } else if (character == '"') quoted = true
        }
        var remaining = GcodeMetadata.MAX_VALIDATION_NODES
        fun read(reader: JsonReader, depth: Int): Any {
            if (remaining and 4095 == 0) active()
            require(depth <= 16 && --remaining >= 0) { "Invalid shared G-code metadata" }
            return when (reader.peek()) {
                JsonToken.BEGIN_OBJECT -> {
                    val result = JSONObject()
                    reader.beginObject()
                    while (reader.hasNext()) {
                        val key = reader.nextName()
                        require(!result.has(key)) { "Invalid shared G-code metadata" }
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
                    require(number != null && number.isFinite()) { "Invalid shared G-code metadata" }
                    number
                }
                JsonToken.BOOLEAN -> reader.nextBoolean()
                JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
                else -> throw IllegalArgumentException("Invalid shared G-code metadata")
            }
        }
        try {
            JsonReader(StringReader(text)).use { reader ->
                reader.isLenient = false
                val result = read(reader, 0)
                require(reader.peek() == JsonToken.END_DOCUMENT) { "Invalid shared G-code metadata" }
                active()
                return result
            }
        } catch (_: IOException) {
            throw IllegalArgumentException("Invalid shared G-code metadata")
        }
    }

    fun objectValue(text: String, active: () -> Unit = {}): JSONObject = parse(text, active) as? JSONObject
        ?: throw IllegalArgumentException("Invalid shared G-code metadata")

    fun arrayValue(text: String, active: () -> Unit = {}): JSONArray = parse(text, active) as? JSONArray
        ?: throw IllegalArgumentException("Invalid shared G-code metadata")
}
