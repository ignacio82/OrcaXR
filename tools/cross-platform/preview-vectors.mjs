// The shipping TypeScript preview is the independent numerical/semantic oracle.
// Capture calls before tests mutate their results; preserve Float32 bits and UTF-16.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  projectGcodePreview,
  GCODE_PREVIEW_MODES,
} from "../../web/src/slicer/GcodePreviewModel.ts";
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
            : [
                  "message",
                  "color",
                  "provenance",
                  "layerTimeProvenance",
                ].includes(key) && typeof value === "string"
              ? units(value)
              : snapshot(value),
        ]),
    );
  return value;
};
const models = [],
  modelIds = new Map(),
  vectors = new Map();
function capture(model, request) {
  const savedModel = snapshot(model),
    savedRequest = snapshot(request);
  const key = JSON.stringify(savedModel);
  if (!modelIds.has(key)) {
    modelIds.set(key, models.length);
    models.push(savedModel);
  }
  const input = { model: modelIds.get(key), request: savedRequest };
  try {
    const result = projectGcodePreview(model, request);
    vectors.set(JSON.stringify(input), {
      ...input,
      expected: snapshot(result),
    });
    return result;
  } catch (error) {
    assert.equal(error?.name, "GcodePreviewProjectionError");
    vectors.set(JSON.stringify(input), { ...input, error: error.code });
    throw error;
  }
}
const exercise = (model, request) => {
  try {
    capture(model, request);
  } catch (error) {
    if (error?.name !== "GcodePreviewProjectionError") throw error;
  }
};
const sourcePath = resolve(root, "web/src/slicer/GcodePreviewModel.ts");
const testPath = resolve(
  root,
  "web/src/slicer/__tests__/gcode-preview-model.test.ts",
);
const temporary = mkdtempSync(
  resolve(root, "web/node_modules/.orcaxr-preview-capture-"),
);
const originalLog = console.log;
globalThis.__orcaxrCapturePreview = capture;
try {
  writeFileSync(
    resolve(temporary, "wrapper.mjs"),
    `export * from ${JSON.stringify(pathToFileURL(sourcePath).href)}; export const projectGcodePreview = globalThis.__orcaxrCapturePreview;\n`,
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
        if (specifier === "../GcodePreviewModel")
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
  delete globalThis.__orcaxrCapturePreview;
  rmSync(temporary, { recursive: true, force: true });
}

const corpusPath = resolve(root, "testdata/cross-platform/gcode-vectors.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
for (const vector of corpus.vectors) {
  const source = fromUnits(vector.sourceUnits);
  const options = { ...vector.options };
  if (options.filamentColors)
    options.filamentColors = options.filamentColors.map(fromUnits);
  const model = parseRichGcodeModel(source, options);
  const layerTimes = {
    secondsByLayer: Float32Array.from(
      { length: model.layerCount + 1 },
      (_, i) => (i + 1) ** 2.5,
    ),
    provenance: "processor:synthetic-🐳-\ud800",
  };
  for (const { id: mode } of GCODE_PREVIEW_MODES)
    exercise(model, { mode, layerTimes });
  const index = indexRichGcodeLayers(source, options);
  if (index.entries.length > 1) {
    const window = parseRichGcodeLayerWindow(
      source,
      index,
      index.entries.length - 1,
      index.entries.length - 1,
      options,
    );
    for (const mode of ["FeatureType", "LayerTimeLog"])
      exercise(window, { mode, layerTimes });
  }
}

const palette = JSON.parse(
  readFileSync(resolve(root, "contracts/gcode-preview.json"), "utf8"),
);
const allRoles = parseRichGcodeModel(
  "M83\n" +
    palette.roleNames
      .map(
        (role, i) => `;TYPE:${role}\nT${i}\nG1 X${i + 1} E1 F${(i + 1) * 600}`,
      )
      .join("\n"),
  { filamentColors: Array(20).fill("#010203") },
);
for (const { id: mode } of GCODE_PREVIEW_MODES) exercise(allRoles, { mode });
const validRoles = new Uint8Array(20).fill(1);
validRoles[19] = 0;
exercise(allRoles, { mode: "FeatureType", roleVisibility: validRoles });
const missing = parseRichGcodeModel(
  "M83\n" +
    Array.from(
      { length: 80 },
      (_, i) => `;LAYER_CHANGE\n; COLOR_CHANGE,T0,#invalid\nG1 X${i + 1} E1`,
    ).join("\n"),
);
exercise(missing, { mode: "ColorPrint" });
exercise(missing, {
  mode: "LayerTimeLog",
  layerTimes: {
    secondsByLayer: new Float32Array(81),
    provenance: "processor:missing",
  },
});
const base = parseRichGcodeModel(
  "M83\n;TYPE:Outer wall\nG1 X1 E1 F60\n;LAYER_CHANGE\nG1 X2 E1 F120\n; PAUSE_PRINTING",
  { filamentColors: ["#abcdef"] },
);
for (const request of [
  { mode: "unknown" },
  { mode: "Tool", valueRange: [0, 1] },
  { mode: "Feedrate", valueRange: [2, 1] },
  ...[-1, 0, 0.5, 4000001].map((maxProjectedRecords) => ({
    mode: "Feedrate",
    maxProjectedRecords,
  })),
  ...[
    [-1, 0],
    [0, 5],
    [1, 0],
    [0.1, 1],
  ].map((layerRange) => ({ mode: "Feedrate", layerRange })),
  ...[
    [-1, 0],
    [0, 9],
    [1, 0],
    [0.1, 1],
  ].map((recordRange) => ({ mode: "Feedrate", recordRange })),
  { mode: "Tool", roleVisibility: new Uint8Array(20).fill(2) },
  { mode: "Tool", toolVisibility: new Uint8Array(255) },
  ...["", "  \ufeff ", "x".repeat(257)].map((provenance) => ({
    mode: "Feedrate",
    layerTimes: { secondsByLayer: new Float32Array(2), provenance },
  })),
  {
    mode: "LayerTimeLog",
    valueRange: [9999, 10000],
    layerTimes: {
      secondsByLayer: new Float32Array([1, NaN]),
      provenance: "processor:missing",
    },
  },
  { mode: "Feedrate", valueRange: [9999, 10000] },
  { mode: "Tool", eventVisibility: new Uint8Array(14) },
])
  exercise(base, request);
for (const color of [
  "#000000",
  "#333333",
  "#32ff32",
  "#123abF",
  "#ff0000\n",
  "#１２３４５６",
  "\ud800",
]) {
  const model = structuredClone(base);
  model.filaments[0].color = color;
  exercise(model, { mode: "ColorPrint" });
}
for (const number of [
  -1, -0, -0.0000005, 0.0000095, 0.000095, 0.00095, 0.0095, 0.095, 0.125, 1.125,
  99.95, 100.5, 1e21,
]) {
  const model = structuredClone(base);
  model.columns.heightMm[0] = number;
  model.columns.widthMm[0] = number;
  model.columns.volumetricFlowMm3PerSecond[0] = number;
  for (const mode of ["Height", "Width", "VolumetricRate"])
    exercise(model, { mode });
}
for (const [column, value] of [
  ["kind", 3],
  ["kind", 255],
  ["tool", 256],
  ["role", 500],
  ["filament", 4000],
  ["layer", 100],
  ["startX", NaN],
  ["endZ", Infinity],
  ["pathKind", 1],
  ["pathPointCount", 1],
  ["pathPointOffset", 1],
  ["arcCenterX", 1],
]) {
  const model = structuredClone(base);
  model.columns[column][0] = value;
  exercise(model, { mode: "Feedrate" });
}
for (const id of [0, 1, 0xfffffff0]) {
  const model = structuredClone(base);
  model.recordOffset = id;
  exercise(model, { mode: "Feedrate", recordRange: [id + 1, id + 2] });
}
const empty = parseRichGcodeModel("");
for (const { id: mode } of GCODE_PREVIEW_MODES) exercise(empty, { mode });
exercise(empty, { mode: "Feedrate", recordRange: [0, 0] });

// Logarithmic palettes exercise libm behavior over the entire finite Float32
// exponent range, including subnormals. The oracle still computes every result.
let seed = 0x9737f4a1;
const randomBits = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
for (let i = 0; i < 128; i++) {
  const numbers = new Float32Array(
    new Uint32Array([
      1 + (randomBits() % 0x7f7fffff),
      1 + (randomBits() % 0x7f7fffff),
    ]).buffer,
  );
  exercise(base, {
    mode: "LayerTimeLog",
    layerTimes: {
      secondsByLayer: numbers,
      provenance: "processor:float32-extremes",
    },
  });
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
const preamble = {
  schemaVersion: 1,
  authority,
  provenance:
    "Production preview tests and deterministic synthetic/parser inputs; Float32 columns compare by bits; UTF-16 source-derived strings; no private print files.",
};
const content =
  JSON.stringify(preamble).slice(0, -1) +
  ',"models":[\n' +
  models.map((model) => JSON.stringify(model)).join(",\n") +
  '\n],"vectors":[\n' +
  [...vectors.values()]
    .map((vector, i) => JSON.stringify({ id: `preview-${i}`, ...vector }))
    .join(",\n") +
  "\n]}\n";
const target = resolve(root, "testdata/cross-platform/preview-vectors.json");
if (process.argv.includes("--write")) writeFileSync(target, content);
else
  assert.equal(
    readFileSync(target, "utf8"),
    content,
    "Preview reference vectors drifted",
  );
console.log(
  `Verified ${vectors.size} preview projections/rejections over ${models.length} models against production TypeScript`,
);
