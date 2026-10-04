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
console.log(
  `Verified ${Object.keys(definitions).length} bounded G-code metadata validators`,
);
