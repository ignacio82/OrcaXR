package dev.orcaxr.app.mcp

import org.json.JSONException
import org.json.JSONObject

/**
 * Minimal JSON-RPC 2.0 plumbing for the MCP server. Keeps everything in
 * `org.json` types so we don't pull in another JSON library — the rest
 * of the codebase (PrintersStore, MoonrakerClient, OrcaProfileLoader)
 * already shapes its serialization the same way.
 *
 * Spec reference: https://www.jsonrpc.org/specification.
 */
internal object JsonRpc {

    const val VERSION: String = "2.0"

    // Standard JSON-RPC error codes. -32000..-32099 is the
    // "implementation-defined server error" range; we reserve a couple
    // of slots for MCP-specific failures.
    const val PARSE_ERROR: Int = -32700
    const val INVALID_REQUEST: Int = -32600
    const val METHOD_NOT_FOUND: Int = -32601
    const val INVALID_PARAMS: Int = -32602
    const val INTERNAL_ERROR: Int = -32603

    // MCP application errors. The wire codes here are arbitrary — they
    // just need to live in the implementation-defined band. Pick values
    // an LLM client can pattern-match without ambiguity.
    const val UNAUTHORIZED: Int = -32001
    const val TOOL_FAILED: Int = -32002

    /**
     * One parsed JSON-RPC request. `id` is `null` for notifications
     * (no response expected) and an arbitrary JSON value otherwise — we
     * keep the original `Any?` so we can echo it back in the response
     * unchanged (per spec the id type round-trips: number stays number,
     * string stays string).
     */
    data class Request(
        val id: Any?,
        val method: String,
        val params: JSONObject,
        val isNotification: Boolean,
    )

    /**
     * Parse one JSON-RPC envelope. Throws nothing — the [Result] flavor
     * lets the dispatcher build a proper -32700/-32600 error envelope
     * that still goes back over the wire as a 200.
     */
    fun parse(body: String): Result<Request> {
        val obj = try {
            JSONObject(body)
        } catch (e: JSONException) {
            return Result.failure(InvalidJsonRpc(PARSE_ERROR, "Parse error: ${e.message}"))
        }
        if (obj.optString("jsonrpc") != VERSION) {
            return Result.failure(InvalidJsonRpc(INVALID_REQUEST, "Missing or wrong jsonrpc version"))
        }
        val method = obj.optString("method", "")
        if (method.isBlank()) {
            return Result.failure(InvalidJsonRpc(INVALID_REQUEST, "Missing method"))
        }
        val rawId = if (obj.has("id")) obj.opt("id") else null
        // JSON-RPC 2.0 § 4.1: notifications have NO id field. A request
        // with `"id": null` is technically still a request (the server
        // SHOULD respond) — older clients sometimes use null when they
        // don't care. We treat `has("id") == false` as the only
        // notification signal.
        val isNotification = !obj.has("id")
        // Params is optional. An array is allowed by the spec for
        // positional args but MCP exclusively uses the object form, so
        // we only accept that and reject arrays as INVALID_PARAMS at
        // the dispatch layer rather than silently coercing.
        val params = when (val raw = obj.opt("params")) {
            null -> JSONObject()
            is JSONObject -> raw
            else -> return Result.failure(
                InvalidJsonRpc(INVALID_PARAMS, "params must be an object"),
            )
        }
        return Result.success(Request(rawId, method, params, isNotification))
    }

    /** Successful response envelope, ready to serialize. */
    fun ok(id: Any?, result: JSONObject): JSONObject {
        val out = JSONObject()
        out.put("jsonrpc", VERSION)
        out.put("id", id ?: JSONObject.NULL)
        out.put("result", result)
        return out
    }

    /** Error response envelope. `data` is optional per spec. */
    fun error(id: Any?, code: Int, message: String, data: Any? = null): JSONObject {
        val out = JSONObject()
        out.put("jsonrpc", VERSION)
        out.put("id", id ?: JSONObject.NULL)
        val err = JSONObject()
        err.put("code", code)
        err.put("message", message)
        if (data != null) err.put("data", data)
        out.put("error", err)
        return out
    }

    class InvalidJsonRpc(val code: Int, override val message: String) : Exception(message)
}
