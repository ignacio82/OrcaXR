import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const schema = JSON.parse(
  readFileSync(new URL("contracts/gcode-metadata.json", root)),
);
assert.deepEqual(
  Object.keys(schema).sort(),
  ["schemaVersion", "description", "maxValidationNodes", "definitions"].sort(),
);
assert.equal(schema.schemaVersion, 1);
assert.ok(
  Number.isSafeInteger(schema.maxValidationNodes) &&
    schema.maxValidationNodes > 0 &&
    schema.maxValidationNodes <= 8 * 1024 * 1024,
);
const definitions = schema.definitions;
const keys = new Map();
function verify(node, ancestors = []) {
  const base = ["optional", "nullable"];
  if (node.ref) {
    assert.ok(definitions[node.ref]);
    assert.ok(!ancestors.includes(node.ref), "Recursive schema");
    verify(definitions[node.ref], [...ancestors, node.ref]);
    base.push("ref");
  } else if (node.enum) {
    assert.ok(
      node.enum.length > 0 &&
        node.enum.every((v) => typeof v === "string" || Number.isFinite(v)),
    );
    base.push("enum");
  } else {
    base.push("type");
    switch (node.type) {
      case "number":
        base.push("integer", "min", "max");
        break;
      case "string":
        assert.ok(Number.isSafeInteger(node.maxLength) && node.maxLength >= 0);
        base.push("maxLength");
        break;
      case "boolean":
        break;
      case "array":
        assert.ok(
          Number.isSafeInteger(node.minLength) &&
            node.minLength >= 0 &&
            Number.isSafeInteger(node.maxLength) &&
            node.maxLength >= node.minLength,
        );
        verify(node.items, ancestors);
        base.push("items", "minLength", "maxLength");
        break;
      case "object":
        for (const [key, child] of Object.entries(node.fields)) {
          assert.match(key, /^[a-z][A-Za-z0-9]*$/);
          verify(child, ancestors);
        }
        base.push("fields");
        break;
      default:
        assert.fail("Unsupported metadata schema");
    }
  }
  assert.ok(
    Object.keys(node).every((k) => base.includes(k)),
    "Unknown schema constraint",
  );
  for (const key of ["optional", "nullable", "integer"])
    if (key in node) assert.equal(typeof node[key], "boolean");
  for (const key of ["min", "max"])
    if (key in node) assert.ok(Number.isFinite(node[key]));
  if ("min" in node && "max" in node) assert.ok(node.min <= node.max);
}
for (const [name, node] of Object.entries(definitions)) {
  assert.match(name, /^[A-Z][A-Za-z]+$/);
  verify(node, [name]);
}
function type(node) {
  let t;
  if (node.ref) t = `Gcode${node.ref}Metadata`;
  else if (node.enum) t = node.enum.map(JSON.stringify).join(" | ");
  else if (node.type === "object")
    t =
      "{" +
      Object.entries(node.fields)
        .map(([k, v]) => `readonly ${k}${v.optional ? "?" : ""}: ${type(v)};`)
        .join("") +
      "}";
  else if (node.type === "array")
    t =
      node.minLength === node.maxLength && node.maxLength <= 4
        ? `readonly [${Array.from({ length: node.maxLength }, () => type(node.items)).join(",")}]`
        : `readonly (${type(node.items)})[]`;
  else t = node.type;
  return node.nullable ? `(${t}) | null` : t;
}
let index = 0;
function expr(node, variable) {
  let result;
  if (node.ref) result = `valid${node.ref}(${variable},budget)`;
  else if (node.enum)
    result =
      "(" +
      node.enum.map((v) => `${variable}===${JSON.stringify(v)}`).join("||") +
      ")";
  else
    switch (node.type) {
      case "number":
        result = `typeof ${variable}==='number'&&Number.${node.integer ? "isSafeInteger" : "isFinite"}(${variable})`;
        if ("min" in node) result += `&&${variable}>=${node.min}`;
        if ("max" in node) result += `&&${variable}<=${node.max}`;
        break;
      case "boolean":
        result = `typeof ${variable}==='boolean'`;
        break;
      case "string":
        result = `typeof ${variable}==='string'&&${variable}.length<=${node.maxLength}`;
        break;
      case "array": {
        const id = `item${index++}`;
        result = `Array.isArray(${variable})&&${variable}.length>=${node.minLength}&&${variable}.length<=${node.maxLength}&&${variable}.every((${id}:unknown)=>--budget.n>=0&&(${expr(node.items, id)}))`;
        break;
      }
      case "object": {
        const id = "keys" + index++;
        keys.set(id, Object.keys(node.fields));
        result = `record(${variable})&&Object.keys(${variable}).every(k=>${id}.has(k))`;
        for (const [key, child] of Object.entries(node.fields)) {
          if (!child.optional)
            result += `&&Object.hasOwn(${variable},${JSON.stringify(key)})`;
          result += `&&(${expr(child, `${variable}.${key}`)})`;
        }
        break;
      }
    }
  if (node.nullable) result = `(${variable}===null||(${result}))`;
  if (node.optional) result = `(${variable}===undefined||(${result}))`;
  return result;
}
let types = "",
  functions = "";
for (const [name, node] of Object.entries(definitions)) {
  types += `export type Gcode${name}Metadata = ${type(node)};\n`;
  functions += `function valid${name}(v:unknown,budget:Budget):v is Gcode${name}Metadata {return --budget.n>=0&&(${expr(node, "v")});}\n`;
}
const output =
  "// Generated by tools/cross-platform/generate-gcode-metadata.mjs. Do not edit.\n" +
  types +
  'type Budget={n:number};\nfunction record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==="object"&&!Array.isArray(v);}\n' +
  [...keys]
    .map(
      ([id, list]) => `const ${id}=new Set<string>(${JSON.stringify(list)});\n`,
    )
    .join("") +
  functions +
  "export interface GcodeMetadataTypes {\n" +
  Object.keys(definitions)
    .map((k) => `${k}:Gcode${k}Metadata;`)
    .join("\n") +
  "\n}\n" +
  "const validators={" +
  Object.keys(definitions)
    .map((k) => `${k}:valid${k}`)
    .join(",") +
  "};\n" +
  `export function validateGcodeMetadata<K extends keyof GcodeMetadataTypes>(kind:K,value:unknown): asserts value is GcodeMetadataTypes[K] {if(!validators[kind](value,{n:${schema.maxValidationNodes}})) throw new Error('Invalid shared G-code metadata');}\n`;
const target = new URL("contracts/generated/gcode-metadata.ts", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else
  assert.equal(
    readFileSync(target, "utf8"),
    output,
    "G-code metadata validator drift",
  );

// Android's JSON getters coerce strings and numbers. Validate raw values before
// any getter is used, with the same field/array budget as the browser guard.
const kotlinKeys = new Map();
let kotlinIndex = 0;
const kotlinString = (value) => JSON.stringify(value).replaceAll("$", "\\$");
const kotlinNumber = (value) =>
  Number.isInteger(value) ? `${value}.0` : String(value);
function kotlinExpr(node, value) {
  let result;
  if (node.ref) result = `valid${node.ref}(${value}, budget)`;
  else if (node.enum)
    result =
      "(" +
      node.enum
        .map((item) =>
          typeof item === "string"
            ? `${value} == ${kotlinString(item)}`
            : `numberEquals(${value}, ${kotlinNumber(item)})`,
        )
        .join(" || ") +
      ")";
  else
    switch (node.type) {
      case "number":
        result = `number(${value}, ${node.integer ?? false}, ${"min" in node ? kotlinNumber(node.min) : "Double.NEGATIVE_INFINITY"}, ${"max" in node ? kotlinNumber(node.max) : "Double.POSITIVE_INFINITY"})`;
        break;
      case "string":
        result = `string(${value}, ${node.maxLength})`;
        break;
      case "boolean":
        result = `${value} is Boolean`;
        break;
      case "array": {
        const item = `item${kotlinIndex++}`;
        result = `array(${value}, budget, ${node.minLength}, ${node.maxLength}) { ${item} -> ${kotlinExpr(node.items, item)} }`;
        break;
      }
      case "object": {
        const object = `object${kotlinIndex++}`,
          id = `keys${kotlinIndex++}`;
        kotlinKeys.set(id, Object.keys(node.fields));
        const conditions = Object.entries(node.fields).map(
          ([key, child]) =>
            `(${kotlinExpr(child, `field(${object}, ${kotlinString(key)})`)})`,
        );
        result = `record(${value}, ${id}) { ${object} -> ${conditions.join(" && ") || "true"} }`;
        break;
      }
    }
  if (node.nullable) result = `(${value} === JSONObject.NULL || (${result}))`;
  if (node.optional) result = `(${value} === Missing || (${result}))`;
  return result;
}
const kotlinFunctions = Object.entries(definitions)
  .map(
    ([name, node]) =>
      `    private fun valid${name}(v: Any?, budget: Budget): Boolean = budget.take() && (${kotlinExpr(node, "v")})\n`,
  )
  .join("");
const kotlinOutput = `// Generated by tools/cross-platform/generate-gcode-metadata.mjs. Do not edit.
package dev.orcaxr.core

import org.json.JSONArray
import org.json.JSONObject

internal object GcodeMetadata {
    const val MAX_VALIDATION_NODES = ${schema.maxValidationNodes}
    enum class Kind { ${Object.keys(definitions).join(", ")} }
    private object Missing
    private class Budget(val active: () -> Unit, var remaining: Int = MAX_VALIDATION_NODES) {
        fun take(): Boolean {
            if (remaining and 4095 == 0) active()
            return --remaining >= 0
        }
    }
    private fun field(value: JSONObject, key: String): Any? = if (value.has(key)) value.get(key) else Missing
    private fun numberEquals(value: Any?, expected: Double): Boolean = value is Number && value.toDouble() == expected
    private fun number(value: Any?, integer: Boolean, min: Double, max: Double): Boolean {
        if (value !is Number) return false
        val number = value.toDouble()
        return number.isFinite() && number >= min && number <= max &&
            (!integer || (number % 1.0 == 0.0 && kotlin.math.abs(number) <= 9007199254740991.0))
    }
    private fun string(value: Any?, maximum: Int): Boolean = value is String && value.length <= maximum
    private inline fun array(value: Any?, budget: Budget, min: Int, max: Int, test: (Any?) -> Boolean): Boolean {
        if (value !is JSONArray || value.length() !in min..max) return false
        for (index in 0 until value.length()) if (!budget.take() || !test(value.get(index))) return false
        return true
    }
    private inline fun record(value: Any?, keys: Set<String>, test: (JSONObject) -> Boolean): Boolean {
        if (value !is JSONObject || value.length() > keys.size) return false
        val actual = value.keys()
        while (actual.hasNext()) if (actual.next() !in keys) return false
        return test(value)
    }
${[...kotlinKeys].map(([id, fields]) => `    private val ${id} = setOf<String>(${fields.map(kotlinString).join(", ")})\n`).join("")}${kotlinFunctions}
    fun validate(kind: Kind, value: Any?, active: () -> Unit = {}) {
        active()
        val budget = Budget(active)
        require(when (kind) {
${Object.keys(definitions)
  .map((name) => `            Kind.${name} -> valid${name}(value, budget)`)
  .join("\n")}
        }) { "Invalid shared G-code metadata" }
        active()
    }
}
`;
const kotlinTarget = new URL(
  "android/core-bridge/src/main/java/dev/orcaxr/core/GcodeMetadata.kt",
  root,
);
if (process.argv.includes("--write")) writeFileSync(kotlinTarget, kotlinOutput);
else
  assert.equal(
    readFileSync(kotlinTarget, "utf8"),
    kotlinOutput,
    "Kotlin G-code metadata validator drift",
  );
console.log(
  `Verified ${Object.keys(definitions).length} bounded G-code metadata validators for TypeScript and Kotlin`,
);
