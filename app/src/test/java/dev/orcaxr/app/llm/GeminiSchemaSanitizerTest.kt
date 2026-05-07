package dev.orcaxr.app.llm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for the H_GEMINI_SCHEMA HTTP 400 (2026-05-08): the field
 * pasted in the actual response from Google AI Studio:
 *
 * ```
 * Unknown name "additionalProperties" at
 *   'tools[0].function_declarations[94]
 *    .parameters.properties[2].value.properties[1].value'
 * ```
 *
 * The previous sanitizer only stripped `additionalProperties` from the
 * top level + immediate first-level children. Schemas in OrcaXR's MCP
 * tool catalog go four levels deep (object → properties → object →
 * properties → object → properties), so deep `additionalProperties:
 * false` defaults survived and Gemini choked.
 *
 * These tests pin the recursive walk so anyone re-introducing a
 * shallow strip would fail CI.
 */
class GeminiSchemaSanitizerTest {

    private val sut = GeminiLlmClient(apiKey = "test-key-not-used")

    @Test
    fun stripsTopLevelAdditionalProperties() {
        val cleaned =
            sut.sanitizeSchemaForGemini(
                JSONObject().apply {
                    put("type", "object")
                    put("additionalProperties", false)
                    put("properties", JSONObject().put("x", JSONObject().put("type", "string")))
                }
            )
        assertFalse(cleaned.has("additionalProperties"))
    }

    @Test
    fun stripsAdditionalPropertiesFourLevelsDeep() {
        // Schema mirrors the path Gemini complained about:
        //   .properties[2].value.properties[1].value.{additionalProperties}
        val schema =
            JSONObject().apply {
                put("type", "object")
                put(
                    "properties",
                    JSONObject().apply {
                        put(
                            "outer",
                            JSONObject().apply {
                                put("type", "object")
                                put(
                                    "properties",
                                    JSONObject().apply {
                                        put(
                                            "middle",
                                            JSONObject().apply {
                                                put("type", "object")
                                                put("additionalProperties", false)
                                                put(
                                                    "properties",
                                                    JSONObject().apply {
                                                        put(
                                                            "inner",
                                                            JSONObject().apply {
                                                                put("type", "object")
                                                                put(
                                                                    "additionalProperties",
                                                                    false,
                                                                )
                                                            },
                                                        )
                                                    },
                                                )
                                            },
                                        )
                                    },
                                )
                            },
                        )
                    },
                )
            }
        val cleaned = sut.sanitizeSchemaForGemini(schema)
        // Top level
        assertFalse("top", cleaned.has("additionalProperties"))
        // 2 levels
        val outer = cleaned.getJSONObject("properties").getJSONObject("outer")
        assertFalse("outer", outer.has("additionalProperties"))
        // 3 levels
        val middle =
            outer
                .getJSONObject("properties")
                .getJSONObject("middle")
        assertFalse("middle", middle.has("additionalProperties"))
        // 4 levels — this is where the field 400 was triggered
        val inner =
            middle
                .getJSONObject("properties")
                .getJSONObject("inner")
        assertFalse("inner (4 deep)", inner.has("additionalProperties"))
    }

    @Test
    fun stripsAdditionalPropertiesInsideArrayItems() {
        val schema =
            JSONObject().apply {
                put("type", "object")
                put(
                    "properties",
                    JSONObject().put(
                        "things",
                        JSONObject().apply {
                            put("type", "array")
                            put(
                                "items",
                                JSONObject().apply {
                                    put("type", "object")
                                    put("additionalProperties", false)
                                },
                            )
                        },
                    ),
                )
            }
        val cleaned = sut.sanitizeSchemaForGemini(schema)
        val items =
            cleaned
                .getJSONObject("properties")
                .getJSONObject("things")
                .getJSONObject("items")
        assertFalse(items.has("additionalProperties"))
    }

    @Test
    fun stripsAdditionalPropertiesInsideOneOf() {
        val schema =
            JSONObject().apply {
                put("type", "object")
                put(
                    "oneOf",
                    org.json.JSONArray().apply {
                        put(
                            JSONObject().apply {
                                put("type", "object")
                                put("additionalProperties", false)
                            }
                        )
                        put(
                            JSONObject().apply {
                                put("type", "object")
                                put("additionalProperties", false)
                            }
                        )
                    },
                )
            }
        val cleaned = sut.sanitizeSchemaForGemini(schema)
        val branches = cleaned.getJSONArray("oneOf")
        for (i in 0 until branches.length()) {
            assertFalse(
                "oneOf[$i]",
                branches.getJSONObject(i).has("additionalProperties"),
            )
        }
    }

    @Test
    fun emptyObjectGetsPlaceholderProperty() {
        val cleaned =
            sut.sanitizeSchemaForGemini(
                JSONObject().put("type", "object").put("additionalProperties", false)
            )
        // Gemini rejects type:object without properties — the sanitizer
        // synthesizes a throwaway field. Pin the contract so a later
        // refactor doesn't drop it.
        assertTrue(cleaned.has("properties"))
        val props = cleaned.getJSONObject("properties")
        assertNotNull(props.optJSONObject("_unused"))
    }

    @Test
    fun stripsSchemaAndDollarRefAndDefinitions() {
        val schema =
            JSONObject().apply {
                put("\$schema", "http://json-schema.org/draft-07/schema")
                put("\$id", "urn:test")
                put(
                    "definitions",
                    JSONObject().put("NameDef", JSONObject().put("type", "string")),
                )
                put("type", "object")
                put(
                    "properties",
                    JSONObject().put(
                        "name",
                        JSONObject().apply {
                            put("\$ref", "#/definitions/NameDef")
                            put("type", "string")
                        },
                    ),
                )
            }
        val cleaned = sut.sanitizeSchemaForGemini(schema)
        assertFalse("\$schema", cleaned.has("\$schema"))
        assertFalse("\$id", cleaned.has("\$id"))
        assertFalse("definitions", cleaned.has("definitions"))
        val name = cleaned.getJSONObject("properties").getJSONObject("name")
        assertFalse("\$ref", name.has("\$ref"))
        assertEquals("type kept", "string", name.getString("type"))
    }

    @Test
    fun doesNotMutateInputSchema() {
        val schema =
            JSONObject().apply {
                put("type", "object")
                put("additionalProperties", false)
            }
        val before = schema.toString()
        sut.sanitizeSchemaForGemini(schema)
        // The original schema is shared with Claude/OpenAI clients that
        // do accept these keys; mutating it would silently downgrade
        // the metadata sent to those providers.
        assertEquals("input untouched", before, schema.toString())
    }
}
