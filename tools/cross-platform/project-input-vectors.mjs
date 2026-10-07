// Independent JSON.parse/canonical authority for staged native document input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const inputs = new Set([
  "", " ", "null", "nullnull", "true0", "false false", "[true,false,null]",
  "0", "-0", "-0.0", "1e-400", "1e400", "-1e400", "1E+0003", "01", "-01",
  "1.", "1e", "1e+", "1e-", "--1", "+1", "NaN", "Infinity", ".1",
  "[]", "{}", "[[]]", "{\"\":{}}", "[1,]", "{\"x\":1,}", "[1 2]",
  "[1true]", "{1:2}", "{\"x\" 1}", "{\"x\":1 \"y\":2}", "[}", "{]",
  '"\\uD800\\uDC00\\udfff\\ud800"', '"🐳é漢字"', '"\\u0000"',
  '{"__proto__":{"x":1},"__proto__":{"y":2},"same":[1],"same":null}',
  '"\\u000g"', '"\\a"', '"\\u123"', '"\\"', '"', '"\u0000"', '\ufeff{}',
]);
const canonical = JSON.parse(read("testdata/cross-platform/canonical-vectors.json"));
for (const c of [...canonical.vectors, ...canonical.invalid]) inputs.add(c.input);
// Mutated authored documents cover lexical/structural interactions independently
// of native state machines. JavaScript determines validity and canonical output.
const bases = ['{"a":[1,-2.5e+2,true,false,null,"🐳\\ud800"]}',
  '[{},[],{"\\u0000":"\\\\\\\"\\b\\f\\n\\r\\t\\/"}]',
  '{"z":1,"z":2,"__proto__":3}', '1.2345678901234567e-123'];
const replacements = ['', ' ', ',', ':', '0', '1', '-', '+', '.', 'e', '[', ']', '{', '}', '"', '\\', '\n'];
for (const source of bases) {
  for (let i = 0; i < source.length; i++) {
    // Raw lone surrogates cannot be represented by the UTF-8 document boundary;
    // explicit escaped surrogates are covered separately.
    if (source.charCodeAt(i) >= 0xd800 && source.charCodeAt(i) <= 0xdfff) continue;
    for (const replacement of replacements) inputs.add(source.slice(0, i) + replacement + source.slice(i + 1));
  }
}
const cases = [...inputs].map((input, id) => {
  let expected;
  try { expected = { canonical: canonicalStringify(JSON.parse(input)) }; }
  catch { expected = { rejected: true }; }
  return { id, input, ...expected };
});
const sources = ["tools/cross-platform/project-input-vectors.mjs", "web/src/project/domain/canonical.ts",
  "testdata/cross-platform/canonical-vectors.json"];
const result = JSON.stringify({schemaVersion:1, sources:sources.map(path => ({path,
  sha256:createHash("sha256").update(read(path)).digest("hex")})), cases}, null, 2) + "\n";
const output = new URL("testdata/cross-platform/project-input-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(output, result);
else assert.equal(readFileSync(output, "utf8"), result, "Project input reference drift");
console.log(`Project input references: ${cases.length} cases; ${cases.filter(c => !c.rejected).length} accepted`);
