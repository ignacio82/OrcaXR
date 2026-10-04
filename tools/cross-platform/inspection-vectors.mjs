// Capture production inspection calls and retain independent playback expectations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  inspectGcode,
  stepGcodeInspection,
  buildGcodePlaybackSequence,
} from "../../web/src/slicer/GcodeInspectionModel.ts";
import {
  parseRichGcodeModel,
  indexRichGcodeLayers,
  parseRichGcodeLayerWindow,
} from "../../web/src/slicer/RichGcodeModel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "web/package.json"));
const ts = require("typescript");
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (array) =>
  array.map((unit) => String.fromCharCode(unit)).join("");
const snapshot = (value) => {
  if (value instanceof Float32Array)
    return {
      $f32: Array.from(
        new Uint32Array(value.buffer, value.byteOffset, value.length),
      ),
    };
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          key === "roles" && Array.isArray(value)
            ? value.map(units)
            : ["message", "color", "text", "gcodeSource"].includes(key) &&
                typeof value === "string"
              ? units(value)
              : snapshot(value),
        ]),
    );
  return value;
};
const models = [],
  modelIds = new Map(),
  vectors = new Map(),
  states = new WeakMap();
function capture(model, request = {}) {
  const saved = snapshot(model),
    key = JSON.stringify(saved);
  if (!modelIds.has(key)) {
    modelIds.set(key, models.length);
    models.push(saved);
  }
  const input = { model: modelIds.get(key), request: snapshot(request) };
  try {
    const state = inspectGcode(model, request);
    const existing = vectors.get(JSON.stringify(input));
    if (existing) {
      assert.deepEqual(existing.expected, snapshot(state));
      states.set(state, existing);
      return state;
    }
    const vector = {
      ...input,
      expected: snapshot(state),
      steps: [],
      playback: [],
    };
    vectors.set(JSON.stringify(input), vector);
    states.set(state, vector);
    for (const direction of [-1, 1])
      for (const wrap of [false, true]) {
        vector.steps.push({
          direction,
          wrap,
          expected: stepGcodeInspection(state, direction, wrap) ?? null,
        });
        for (const includeCurrent of [false, true]) {
          const options = { direction, wrap, includeCurrent, maxFrames: 12 };
          vector.playback.push({
            options,
            expected: snapshot(buildGcodePlaybackSequence(state, options)),
          });
        }
      }
    return state;
  } catch (error) {
    assert.equal(error?.name, "GcodeInspectionError");
    vectors.set(JSON.stringify(input), { ...input, error: error.code });
    throw error;
  }
}
function capturePlayback(state, options) {
  const owner = states.get(state);
  assert.ok(owner);
  try {
    const result = buildGcodePlaybackSequence(state, options);
    owner.playback.push({ options, expected: snapshot(result) });
    return result;
  } catch (error) {
    assert.equal(error?.name, "GcodeInspectionError");
    owner.playback.push({ options, error: error.code });
    throw error;
  }
}
function captureStep(state, direction, wrap = false) {
  const owner = states.get(state);
  assert.ok(owner);
  try {
    const result = stepGcodeInspection(state, direction, wrap);
    owner.steps.push({ direction, wrap, expected: result ?? null });
    return result;
  } catch (error) {
    assert.equal(error?.name, "GcodeInspectionError");
    owner.steps.push({ direction, wrap, error: error.code });
    throw error;
  }
}
const exercise = (model, request) => {
  try {
    return capture(model, request);
  } catch (error) {
    if (error?.name !== "GcodeInspectionError") throw error;
  }
};
const sourcePath = resolve(root, "web/src/slicer/GcodeInspectionModel.ts");
const testPath = resolve(
  root,
  "web/src/slicer/__tests__/gcode-inspection-model.test.ts",
);
const temporary = mkdtempSync(
  resolve(root, "web/node_modules/.orcaxr-inspection-capture-"),
);
const originalLog = console.log;
globalThis.__orcaxrInspection = {
  inspect: capture,
  step: captureStep,
  playback: capturePlayback,
};
try {
  writeFileSync(
    resolve(temporary, "wrapper.mjs"),
    `export * from ${JSON.stringify(pathToFileURL(sourcePath).href)}; export const inspectGcode = globalThis.__orcaxrInspection.inspect; export const stepGcodeInspection = globalThis.__orcaxrInspection.step; export const buildGcodePlaybackSequence = globalThis.__orcaxrInspection.playback;\n`,
  );
  const compiled = ts
    .transpileModule(readFileSync(testPath, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace(
      /from\s+(['"])([^'"]+)\1/g,
      (match, quote, specifier) => {
        let target;
        if (specifier === "../GcodeInspectionModel")
          target = pathToFileURL(resolve(temporary, "wrapper.mjs")).href;
        else if (specifier.startsWith("."))
          target = pathToFileURL(
            resolve(dirname(testPath), specifier + ".ts"),
          ).href;
        else if (!specifier.startsWith("node:"))
          target = pathToFileURL(require.resolve(specifier)).href;
        return target ? `from ${JSON.stringify(target)}` : match;
      },
    );
  writeFileSync(resolve(temporary, "tests.mjs"), compiled);
  console.log = () => {};
  await import(pathToFileURL(resolve(temporary, "tests.mjs")).href);
} finally {
  console.log = originalLog;
  delete globalThis.__orcaxrInspection;
  rmSync(temporary, { recursive: true, force: true });
}

const corpusPath = resolve(root, "testdata/cross-platform/gcode-vectors.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
for (const vector of corpus.vectors) {
  const source = fromUnits(vector.sourceUnits),
    options = { ...vector.options };
  if (options.filamentColors)
    options.filamentColors = options.filamentColors.map(fromUnits);
  const model = parseRichGcodeModel(source, options);
  exercise(model, {});
  exercise(model, {
    gcodeSource: source,
    sourceContextLines: 3,
    showToolMarker: true,
  });
  const index = indexRichGcodeLayers(source, options);
  for (let i = 0; i < index.entries.length; i++) {
    const window = parseRichGcodeLayerWindow(source, index, i, i, options);
    exercise(window, {
      gcodeSource: source,
      sourceContextLines: 1,
      showToolMarker: true,
    });
    exercise(window, {
      layerRange: [0, index.layerCount],
      clampLayerRange: true,
      singleLayer: true,
    });
  }
}
const sources = [
  "",
  "\n",
  ";LAYER_CHANGE\n",
  ";LAYER_CHANGE\n;LAYER_CHANGE\n",
  "\n\nM83\nG1 X1 E1\n\n; PAUSE_PRINTING\n\n",
  "\ufeff; 🐳 \ud800\r\nM83\r\nG1 X1 E1\r\n;LAYER_CHANGE\r\n; 🐳 \udfff\r\nG1 X2 E1\r\n",
  ";" + "x".repeat(4093) + "\ud800🐳\nG1 X1\n",
  "M83\nG1 X-0.0004 Z-0.0006 E1\nG1 X-0.0005 Z-0.0005 E1\n",
  "M83\n;LAYER_CHANGE\nG1 X1 E1\n;LAYER_CHANGE\n;LAYER_CHANGE\nG1 X2 E1\n;LAYER_CHANGE\n",
];
for (const source of sources) {
  const model = parseRichGcodeModel(source);
  const base = exercise(model, {});
  for (const context of [-1, 0, 1, 3, 50, 51, 0.5])
    exercise(model, { gcodeSource: source, sourceContextLines: context });
  for (const range of [
    [0, 0],
    [0, 99],
    [1, 3],
    [3, 1],
    [0.5, 3.5],
  ])
    for (const clamp of [false, true])
      exercise(model, { layerRange: range, clampLayerRange: clamp });
  for (const currentRecord of base.recordIndices)
    exercise(model, {
      currentRecord,
      gcodeSource: source,
      showToolMarker: true,
    });
  for (const request of [
    { currentRecord: -1 },
    { currentRecord: 0.5 },
    { currentRecord: 0xffffffff },
    { moveRange: [-1, 0] },
    { moveRange: [0, 99] },
    { moveRange: [1, 0] },
    { moveRange: [0.5, 0.5] },
    { recordVisibility: new Uint8Array(model.columns.count) },
    { recordVisibility: new Uint8Array(model.columns.count + 1) },
  ])
    exercise(model, request);
}
const base = parseRichGcodeModel("M83\nG1 X1 E1\n; PAUSE_PRINTING\nG1 X2 E1");
for (const [column, value] of [
  ["kind", 3],
  ["kind", 255],
  ["tool", 256],
  ["filament", 4000],
  ["layer", 100],
  ["startX", NaN],
  ["endZ", Infinity],
  ["sourceLine", 0],
  ["sourceLine", 500],
  ["sourceStartOffset", 500],
  ["sourceEndOffset", 500],
  ["pathPointCount", 1],
  ["arcCenterX", 1],
]) {
  const model = structuredClone(base);
  model.columns[column][0] = value;
  exercise(model, {});
}
for (const offset of [1, 100, 0xfffffff0]) {
  const model = structuredClone(base);
  model.recordOffset = offset;
  exercise(model, { currentRecord: offset + 1, showToolMarker: true });
}
for (const options of [
  { direction: 0 },
  { direction: 1, maxFrames: 0 },
  { direction: 1, maxFrames: 1.5 },
  { direction: 1, maxFrames: 100001 },
  { direction: -1, wrap: true, maxFrames: 100000 },
]) {
  const state = capture(base, { currentRecord: 1 });
  try {
    capturePlayback(state, options);
  } catch (error) {
    if (error?.name !== "GcodeInspectionError") throw error;
  }
}
const authority = Object.fromEntries(
  [
    sourcePath,
    testPath,
    corpusPath,
    resolve(root, "web/src/slicer/GcodePathSegments.ts"),
  ].map((path) => [
    path.slice(root.length + 1),
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]),
);
const header = {
  schemaVersion: 1,
  authority,
  provenance:
    "Production inspection tests and synthetic parser/window fixtures; Float32 bits and UTF-16 text; no private models.",
};
const content =
  JSON.stringify(header).slice(0, -1) +
  ',"models":[\n' +
  models.map((model) => JSON.stringify(model)).join(",\n") +
  '\n],"vectors":[\n' +
  [...vectors.values()]
    .map((v, i) => JSON.stringify({ id: `inspection-${i}`, ...v }))
    .join(",\n") +
  "\n]}\n";
const target = resolve(root, "testdata/cross-platform/inspection-vectors.json");
if (process.argv.includes("--write")) writeFileSync(target, content);
else
  assert.equal(
    readFileSync(target, "utf8"),
    content,
    "Inspection reference drift",
  );
console.log(
  `Verified ${vectors.size} inspection cases over ${models.length} models against production TypeScript`,
);
