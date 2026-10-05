package dev.orcaxr.core

import org.json.JSONArray
import org.json.JSONObject

internal sealed interface GcodeRequestShape {
    data object Number : GcodeRequestShape
    data object U8 : GcodeRequestShape
    data object U16 : GcodeRequestShape
    data object U32 : GcodeRequestShape
    data object Boolean : GcodeRequestShape
    data object String : GcodeRequestShape
    data object Text : GcodeRequestShape
    data object Range : GcodeRequestShape
    data object Window : GcodeRequestShape
    data class Array(val item: GcodeRequestShape) : GcodeRequestShape
    data class Literal(val value: kotlin.String) : GcodeRequestShape
    data class Field(val shape: GcodeRequestShape, val optional: kotlin.Boolean, val nullable: kotlin.Boolean)
    data class Object(val fields: Map<kotlin.String, Field>) : GcodeRequestShape
}

/** Generated field tables inspect raw JSON values before any coercing getter.
 * Semantic validation stays in the Rust computation, including its error codes. */
internal object GcodeRequestValidation {
    fun validate(shape: GcodeRequestShape, value: JSONObject, active: () -> Unit) {
        var remaining = GcodeRequests.MAX_VALIDATION_NODES
        fun number(value: Any?, maximum: Long? = null): Boolean {
            if (value !is Number) return false
            val n = value.toDouble()
            return n.isFinite() && (maximum == null || n % 1.0 == 0.0 && n in 0.0..maximum.toDouble())
        }
        fun visit(shape: GcodeRequestShape, value: Any?) {
            if (remaining and 4095 == 0) active()
            require(--remaining >= 0) { "resource_limit" }
            when (shape) {
                GcodeRequestShape.Number -> require(number(value))
                GcodeRequestShape.U8 -> require(number(value, 255))
                GcodeRequestShape.U16 -> require(number(value, 65535))
                GcodeRequestShape.U32 -> require(number(value, 4294967295L))
                GcodeRequestShape.Boolean -> require(value is Boolean)
                GcodeRequestShape.String -> require(value is String && value.length <= GcodeRequests.MAX_VIEW_BYTES)
                is GcodeRequestShape.Literal -> require(value == shape.value)
                is GcodeRequestShape.Object -> {
                    require(value is JSONObject && value.length() <= shape.fields.size)
                    for (key in value.keys()) require(shape.fields.containsKey(key))
                    for ((key, field) in shape.fields) {
                        if (!value.has(key)) require(field.optional)
                        else {
                            val entry = value.get(key)
                            if (!(field.nullable && entry === JSONObject.NULL)) visit(field.shape, entry)
                        }
                    }
                }
                else -> {
                    require(value is JSONArray && value.length() <= remaining)
                    val item = when (shape) {
                        GcodeRequestShape.Text -> GcodeRequestShape.U16
                        GcodeRequestShape.Range -> {
                            require(value.length() == 2); GcodeRequestShape.Number
                        }
                        GcodeRequestShape.Window -> {
                            require(value.length() == 0 || value.length() == 2); GcodeRequestShape.U32
                        }
                        is GcodeRequestShape.Array -> shape.item
                        else -> error("Unknown generated request shape")
                    }
                    for (i in 0 until value.length()) visit(item, value.get(i))
                    if (shape == GcodeRequestShape.Window && value.length() == 2)
                        require(value.getLong(0) <= value.getLong(1))
                }
            }
        }
        active(); visit(shape, value); active()
    }
}
