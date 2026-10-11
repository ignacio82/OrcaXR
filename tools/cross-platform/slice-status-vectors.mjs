// Slice status references from the production browser
// (`web/src/slicer/SliceStatus.ts`): what its status line says of a finished
// slice — the artifact's lines (`split('\n').length`) and layers (the engine's
// own stated total, else its layer-change markers) — and the line itself
// (`describeSliceStatus`), size in whole KB as `toFixed(0)` rounds. Inputs are
// parts — text, raw bytes or repeated text — decoded as the browser decodes a
// slice (`TextDecoder`, fatal: every case is valid UTF-8). Numbers are written
// as JavaScript spells them. Replayed by Rust (`orcaxr_gcode::artifact::SliceTally`)
// and, over JNI, by the Kotlin `SliceStatusTally` and `SliceStatus.describe`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  describeSliceStatus,
  sliceStatusFigures,
} from "../../web/src/slicer/SliceStatus.ts";
import { summarizeGcodeArtifact } from "../../web/src/slicer/GcodeArtifactSummary.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const TRAILER = 64 * 1024;
const MARKERS = /; CHANGE_LAYER|;LAYER_CHANGE/g;

const text = (value) => {
  assert.ok(value.isWellFormed());
  return { text: value };
};
const raw = (...bytes) => ({ bytes });
const repeat = (value, times) => ({ repeat: value, times });
const bytesOf = (parts) =>
  Buffer.concat(
    parts.map((part) =>
      part.text !== undefined
        ? Buffer.from(part.text, "utf8")
        : part.bytes !== undefined
          ? Buffer.from(part.bytes)
          : Buffer.from(part.repeat.repeat(part.times), "utf8"),
    ),
  );

const cases = [];
const add = (name, parts) => cases.push({ name, parts });
const layer = (n, marker = ";LAYER_CHANGE") =>
  `${marker}\n;Z:${(n + 1) / 5}\nG1 Z${(n + 1) / 5} F600\nG1 X10 Y10 E0.5\n`;
const layers = (count, marker) =>
  Array.from({ length: count }, (_, n) => layer(n, marker)).join("");
const trailer = (total, config = 0) =>
  [
    "; EXECUTABLE_BLOCK_END",
    "",
    "; filament used [mm] = 120.50",
    "; total filament used [g] = 0.36",
    ...(total === undefined ? [] : [`; total layers count = ${total}`]),
    "; estimated printing time (normal mode) = 4m 5s",
    "",
    "; CONFIG_BLOCK_START",
    ...Array.from(
      { length: config },
      (_, n) => `; setting_${n} = ${"value".repeat(1 + (n % 7))}`,
    ),
    "; CONFIG_BLOCK_END",
    "",
  ].join("\n");

// Real fixtures in the repository.
const fixtures = [
  "testdata/parity/fixtures/reference.gcode",
  "testdata/parity/fixtures/mutations/missing-tool-change.gcode",
];
for (const path of fixtures) add(`fixture/${path.split("/").pop()}`, [raw(...read(path))]);

// The engine's total against its markers.
add("total/agrees-with-markers", [text(layers(12)), text(trailer(12))]);
add("total/counts-differently", [text(layers(3)), text(trailer(5))]);
add("total/zero-is-stated", [text(layers(2)), text(trailer(0))]);
add("total/absent-markers-counted", [text(layers(7)), text(trailer())]);
add("total/both-marker-spellings", [
  text(layers(4)),
  text(layers(3, "; CHANGE_LAYER")),
  text(trailer()),
]);
for (const [n, value] of [
  "2.5",
  "-4",
  "1e3",
  "007",
  " 12 ",
  "NaN",
  "18446744073709551616",
  "9007199254740993",
  "",
].entries()) {
  add(`total/as-written-${n}`, [
    text(layers(3)),
    text(`; total layers count = ${value}\n`),
  ]);
}
add("total/first-line-wins", [
  text(layers(2)),
  text("; total layers count = 8\n; total layers count = 9\n"),
]);
add("total/in-a-large-config-is-past-the-trailer", [
  text(layers(20)),
  text(trailer(20, 4000)),
]);
add("total/just-inside-the-trailer", [
  text("; total layers count = 99\n"),
  repeat("G1 X1.000 Y1.000 E0.01000\n", 10_000),
  text(layers(6)),
  text("; total layers count = 6\n"),
  repeat("\n", TRAILER - 30),
]);
add("total/cut-inside-the-prefix", [
  repeat("G1 X1.000 Y1.000 E0.01000\n", 3000),
  text(layers(2)),
  text("; total layers count = 7\n"),
  repeat("\n", TRAILER - 24),
]);

// Markers as the regular expression finds them: anywhere, never overlapping.
add("markers/inside-lines", [
  text("G1 ;LAYER_CHANGE here\nM117 x; CHANGE_LAYER\n"),
]);
add("markers/near-misses", [
  text(";LAYER_CHANG\n; CHANGE_LAYE\n;layer_change\n;  CHANGE_LAYER\n; LAYER_CHANGE\n"),
]);
add("markers/adjacent", [
  text(";LAYER_CHANGE;LAYER_CHANGE; CHANGE_LAYER\n;; CHANGE_LAYER_CHANGE\n"),
]);
add("markers/prefix-restarts", [
  text(";;LAYER_CHANGE ;; CHANGE_LAYER ;LAYER;LAYER_CHANGE\n"),
]);

// Lines, terminators and encoding.
add("lines/empty-file", []);
add("lines/no-final-break", [text("G28\nG1 X1")]);
add("lines/crlf", [text(layers(2).replaceAll("\n", "\r\n"))]);
add("lines/lone-cr", [text(layers(2).replaceAll("\n", "\r"))]);
add("lines/only-breaks", [repeat("\n", 5)]);
add("encoding/bom", [raw(0xef, 0xbb, 0xbf), text(layers(2)), text(trailer(2))]);
add("encoding/multibyte-text", [
  text("; generated by OrcaXR — ПЛА ✓ \u{1F600}\n"),
  text(layers(3)),
  text("; total layers count = 3\n"),
]);
add("encoding/three-byte-text-before-total", [
  text(layers(2)),
  repeat("€", TRAILER),
  text("\n; total layers count = 4\n"),
]);
add("encoding/total-behind-three-byte-text", [
  text(layers(2)),
  text("; total layers count = 4\n"),
  repeat("€", TRAILER),
]);

// Sizes on the whole-KB boundaries.
for (const size of [511, 512, 513, 1535, 1536, 2560, 4095]) {
  add(`size/${size}`, [repeat(";", size - 14), text(";LAYER_CHANGE\n")]);
}

const sourcePaths = [
  "web/src/slicer/SliceStatus.ts",
  "web/src/slicer/GcodeArtifactSummary.ts",
  ...fixtures,
];
const corpus = cases.map(({ name, parts }, index) => {
  const bytes = bytesOf(parts);
  const gcode = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const figures = sliceStatusFigures(gcode);
  const stated = summarizeGcodeArtifact(gcode).layerCount;
  const elapsedMs = index * 37;
  const warnings = index % 3;
  return {
    name,
    parts,
    bytes: bytes.length,
    lines: figures.lines,
    layers: String(figures.layers),
    statedLayers: stated === undefined ? null : String(stated),
    layerMarkers: (gcode.match(MARKERS) ?? []).length,
    kilobytes: (bytes.length / 1024).toFixed(0),
    status: {
      elapsedMs,
      warnings,
      text: describeSliceStatus({
        elapsedMs,
        byteLength: bytes.length,
        ...figures,
        warnings,
      }),
    },
  };
});

// The corpus must exercise what it claims.
const named = (name) => corpus.find((c) => c.name === name);
assert.equal(named("total/counts-differently").layers, "5");
assert.equal(named("total/counts-differently").layerMarkers, 3);
assert.equal(named("total/zero-is-stated").layers, "0");
assert.equal(named("total/in-a-large-config-is-past-the-trailer").statedLayers, null);
assert.equal(named("total/just-inside-the-trailer").layers, "6");
assert.equal(named("total/cut-inside-the-prefix").statedLayers, null);
assert.equal(named("total/as-written-6").layers, "18446744073709552000");
assert.equal(named("markers/adjacent").layerMarkers, 4);
assert.equal(named("size/512").kilobytes, "1");
assert.equal(named("size/511").kilobytes, "0");
assert.ok(corpus.some((c) => c.status.warnings > 0 && c.status.text.endsWith("warning(s)")));

const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sourcePaths.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    trailerUnits: TRAILER,
    cases: corpus,
  }) + "\n";
const path = new URL("testdata/cross-platform/slice-status-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Slice status reference drift");
console.log(`Slice status references: ${corpus.length} artifacts (${output.length} bytes).`);
