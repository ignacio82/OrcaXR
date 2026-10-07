// Independent production-browser expectations for the readable G-code
// document: line windows and bounded case-insensitive line search. Sources are
// the production parser corpus plus authored edge cases; every expectation is
// produced by web/src/project/gcode/GcodeDocument.ts. Text is UTF-16 units so
// lone surrogates survive JSON.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { GcodeDocument, MAX_SEARCH_RESULTS } from "../../web/src/project/gcode/GcodeDocument.ts";

const root = new URL("../../", import.meta.url);
const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (list) => String.fromCharCode(...list);
const number = (value) => (Number.isFinite(value) ? value : String(value));
const wellFormed = (text) => text.isWellFormed();
// Well-formed text stays a JSON string; only lone surrogates need unit arrays.
const encoded = (text) => (wellFormed(text) ? text : units(text));

const sources = [];
const parser = JSON.parse(readFileSync(new URL("testdata/cross-platform/gcode-vectors.json", root), "utf8"));
for (const vector of parser.vectors) sources.push({ name: `parser/${vector.id}`, text: fromUnits(vector.sourceUnits) });
for (const [name, text] of [
  ["empty", ""],
  ["newline", "\n"],
  ["two-newlines", "\n\n"],
  ["crlf", "G28\r\nM104 S230\r\n"],
  ["lone-cr-terminator", "G28\r"],
  ["cr-not-newline", "G28\rM104\nG1"],
  ["double-cr", "G28\r\r\nM104"],
  ["line-separators-are-text", "G28 M104 G1\n; end"],
  ["bom", "﻿G28\n;﻿ BOM inside\n"],
  ["dotted-capital-i", `;${"İ".repeat(20)}\nG1 X1\nG1 X2\nG1 X3\nM104 S200\nG1 X4\n`],
  ["sigma", "; ΟΔΟΣ Σ ΣΑ AΣ\nM117 ΣTART\nM117 aς\n"],
  ["kelvin-angstrom", "; K Å k å\nM104\n"],
  ["lone-surrogates", "; a\ud800b\nM117 \udc00Σ\nM117 A\ud800Σ\n; 😀 emoji\n"],
  ["repeated-overlap", "aaa\naa\na\n"],
  ["long-line", `; ${"X".repeat(70_000)}M104 S1\nG28\n`],
]) {
  sources.push({ name: `authored/${name}`, text });
}
const big = [];
for (let index = 0; index < 25_000; index += 1) {
  if (index % 997 === 0) big.push(`; object İstanbul ${index} Σ`);
  else if (index % 251 === 0) big.push(`M104 S${200 + (index % 30)}`);
  else if (index % 5000 === 0) big.push(";LAYER_CHANGE");
  else big.push(`G1 X${(index * 0.37).toFixed(3)} Y${(index * 0.11).toFixed(3)} E${(index * 0.001).toFixed(5)}`);
}
sources.push({ name: "authored/program-25000", text: `${big.join("\r\n")}\r\n` });

const queries = [
  "M104", "m104", " G1 ", "g28", "X1", "x", "Σ", "σ", "ς", "i̇", "İ", "istanbul", "K", "k", "å",
  "\ud800", "\udc00σ", "aa", "a", "", "   ", "\n", "G28\nM104", "E0.0", ";LAYER", "﻿", "BOM",
  " ", "😀", "S1", "M117 ΣTART", "mmm-not-present",
];
const limits = [1, 2, 3, 20, MAX_SEARCH_RESULTS];
const windows = [
  [1, 1], [1, 3], [0, 2], [-5, 2], [2, 2], [1.9, 2.9], [1, 0.5], [1, 0], [1, -1], [100000000, 3],
  [Number.NaN, 2], [1, Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY, 1], [3, 50],
];

const cases = [];
for (const source of sources) {
  const document = new GcodeDocument(source.text);
  const row = {
    name: source.name,
    source: encoded(source.text),
    lineCount: document.lineCount,
    windows: [],
    searches: [],
  };
  for (const [from, count] of windows) {
    if (count === Number.POSITIVE_INFINITY) continue; // unbounded in the browser
    const lines = document.window(from, count);
    if (lines.length > 64) continue;
    row.windows.push({
      from: number(from),
      count: number(count),
      lines: lines.map((line) => ({ number: line.number, text: encoded(line.text) })),
    });
  }
  // Windows near the end of large sources.
  if (document.lineCount > 10) {
    const from = document.lineCount - 2;
    row.windows.push({
      from,
      count: 5,
      lines: document.window(from, 5).map((line) => ({ number: line.number, text: encoded(line.text) })),
    });
  }
  for (const query of queries) {
    for (const limit of limits) {
      const result = document.search(query, limit);
      row.searches.push({ query: encoded(query), limit, lineNumbers: result.lineNumbers, truncated: result.truncated });
    }
    // Exactly as many results as the limit is complete.
    const all = document.search(query, Number.MAX_SAFE_INTEGER);
    if (all.lineNumbers.length > 0 && all.lineNumbers.length <= 600) {
      const exact = document.search(query, all.lineNumbers.length);
      row.searches.push({
        query: encoded(query),
        limit: all.lineNumbers.length,
        lineNumbers: exact.lineNumbers,
        truncated: exact.truncated,
      });
    }
  }
  cases.push(row);
}

const sha = (path) => createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");
const header = JSON.stringify({
  format: 1,
  sources: ["web/src/project/gcode/GcodeDocument.ts", "testdata/cross-platform/gcode-vectors.json"].map((path) => ({
    path,
    sha256: sha(path),
  })),
});
// One compact case per line keeps large unit arrays reviewable as line diffs.
const output = `${header.slice(0, -1)},"cases":[\n${cases.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
const target = new URL("testdata/cross-platform/gcode-document-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "G-code document references are stale; rerun with --write");
console.log(
  JSON.stringify({
    sources: cases.length,
    windows: cases.reduce((n, c) => n + c.windows.length, 0),
    searches: cases.reduce((n, c) => n + c.searches.length, 0),
  }),
);
