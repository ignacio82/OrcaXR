// Independent TypeScript expectations for the actual source-owned session API.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  parseRichGcodeModel,
  indexRichGcodeLayers,
  parseRichGcodeLayerWindow,
} from "../../web/src/slicer/RichGcodeModel.ts";
import {
  projectGcodePreview,
  GCODE_PREVIEW_MODES,
} from "../../web/src/slicer/GcodePreviewModel.ts";
import {
  inspectGcode,
  buildGcodePlaybackSequence,
} from "../../web/src/slicer/GcodeInspectionModel.ts";
const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const string = (u) => u.map((n) => String.fromCharCode(n)).join("");
function snapshot(value) {
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
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [
          k,
          ["message", "text", "provenance", "layerTimeProvenance"].includes(
            k,
          ) && typeof v === "string"
            ? units(v)
            : snapshot(v),
        ]),
    );
  return value;
}
const vectors = [];
function capture(
  vector,
  model,
  source,
  window,
  operation,
  request,
  extra = {},
) {
  const wire = snapshot(request);
  if (wire.layerTimes) {
    wire.layerTimes.secondsByLayerBits = wire.layerTimes.secondsByLayer.$f32;
    delete wire.layerTimes.secondsByLayer;
  }
  const input = { version: 1, window, operation, request: wire, ...extra };
  const item = { request: input };
  try {
    if (operation === "preview")
      item.expected = snapshot(projectGcodePreview(model, request));
    else {
      const state = inspectGcode(model, {
        ...request,
        ...(extra.includeSource ? { gcodeSource: source } : {}),
      });
      item.expected = snapshot(
        operation === "inspection"
          ? state
          : buildGcodePlaybackSequence(state, extra.playback),
      );
    }
  } catch (error) {
    assert.ok(
      ["GcodeInspectionError", "GcodePreviewProjectionError"].includes(
        error?.name,
      ),
    );
    item.error = error.code;
  }
  vector.views.push(item);
}
function sourceVector(id, sourceUnits, options) {
  const source = string(sourceUnits);
  const bounded = {
    ...options,
    limits: {
      ...options.limits,
      records: Math.min(options.limits?.records ?? 240000, 240000),
    },
  };
  const tsOptions = { ...bounded };
  if (tsOptions.filamentColors)
    tsOptions.filamentColors = tsOptions.filamentColors.map(string);
  const vector = { id, sourceUnits, options: bounded, views: [] };
  vectors.push(vector);
  const index = indexRichGcodeLayers(source, tsOptions);
  const whole = parseRichGcodeModel(source, tsOptions);
  function captureWindow(model, window) {
    const times = {
      secondsByLayer: Float32Array.from(
        { length: model.layerCount },
        (_, i) => i + 0.125,
      ),
      provenance: "processor:🐳\ud800",
    };
    for (const mode of window.length
      ? ["FeatureType", "LayerTimeLog"]
      : GCODE_PREVIEW_MODES.map((m) => m.id))
      capture(vector, model, source, window, "preview", {
        mode,
        layerTimes: times,
      });
    capture(vector, model, source, window, "inspection", {});
    const request = { showToolMarker: true, sourceContextLines: 3 };
    capture(vector, model, source, window, "inspection", request, {
      includeSource: true,
    });
    capture(vector, model, source, window, "inspection", {
      layerRange: [0, model.layerCount],
      clampLayerRange: true,
      singleLayer: true,
    });
    for (const direction of [-1, 1])
      capture(vector, model, source, window, "playback", request, {
        includeSource: true,
        playback: {
          direction,
          wrap: true,
          includeCurrent: true,
          maxFrames: 12,
        },
      });
  }
  captureWindow(whole, []);
  for (let i = 0; i < index.entries.length; i++)
    captureWindow(parseRichGcodeLayerWindow(source, index, i, i, tsOptions), [
      i,
      i,
    ]);
  // Revisit whole after other windows: results must not depend on the last query.
  capture(vector, whole, source, [], "preview", { mode: "Feedrate" });
  return { vector, source, whole };
}
const parser = JSON.parse(read("testdata/cross-platform/gcode-vectors.json"));
for (const v of parser.vectors) sourceVector(v.id, v.sourceUnits, v.options);
const { vector, whole, source } = sourceVector(
  "view-extremes",
  units(
    "M83\n;TYPE:Outer wall\nG1 X1 E1 F60\n;LAYER_CHANGE\nG1 X2 E1 F120\n; PAUSE_PRINTING",
  ),
  { filamentColors: [units("#abcdef")] },
);
let seed = 0x9737f4a1;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
for (let i = 0; i < 128; i++)
  capture(vector, whole, source, [], "preview", {
    mode: "LayerTimeLog",
    layerTimes: {
      secondsByLayer: new Float32Array(
        new Uint32Array([
          1 + (random() % 0x7f7fffff),
          1 + (random() % 0x7f7fffff),
        ]).buffer,
      ),
      provenance: "processor:float32-extremes",
    },
  });
for (const request of [
  { mode: "unknown" },
  { mode: "Tool", valueRange: [0, 1] },
  { mode: "Feedrate", recordRange: [1, 2] },
  { mode: "Feedrate", recordRange: [0.5, 1] },
  { mode: "Feedrate", maxProjectedRecords: 1 },
  { mode: "Tool", roleVisibility: new Uint8Array(20).fill(2) },
  {
    mode: "LayerTimeLog",
    layerTimes: {
      secondsByLayer: new Float32Array([1, NaN]),
      provenance: "processor:missing",
    },
  },
  {
    mode: "LayerTimeLog",
    layerTimes: {
      secondsByLayer: new Float32Array([Infinity, 1]),
      provenance: "processor:missing",
    },
  },
  { mode: "Feedrate", valueRange: [9999, 10000] },
  { mode: "Tool", eventVisibility: new Uint8Array(14) },
])
  capture(vector, whole, source, [], "preview", request);
for (const request of [
  { currentRecord: 0.5 },
  { moveRange: [2, 1] },
  { recordVisibility: new Uint8Array(whole.columns.count) },
  { sourceContextLines: 51 },
])
  capture(vector, whole, source, [], "inspection", request, {
    includeSource: true,
  });
for (const playback of [
  { direction: 0 },
  { direction: 1, maxFrames: 100001 },
  { direction: -1, wrap: true, maxFrames: 100000 },
])
  capture(vector, whole, source, [], "playback", {}, { playback });
sourceVector(
  "view-unicode",
  units(
    "\ufeff; 🐳 \ud800\r\nM83\r\nG1 X1 E1\r\n;LAYER_CHANGE\r\n; 🐳 \udfff\r\nG1 X2 E1\r\n",
  ),
  {},
);
const files = [
  "web/src/slicer/GcodePreviewModel.ts",
  "web/src/slicer/GcodeInspectionModel.ts",
  "web/src/slicer/RichGcodeModel.ts",
  "web/src/slicer/GcodePathSegments.ts",
  "testdata/cross-platform/gcode-vectors.json",
];
const header = {
  schemaVersion: 1,
  authority: Object.fromEntries(
    files.map((p) => [p, createHash("sha256").update(read(p)).digest("hex")]),
  ),
  provenance:
    "Independent production TypeScript on session-owned synthetic sources and explicit windows; Float32 bits and UTF-16 text.",
};
const content =
  JSON.stringify(header).slice(0, -1) +
  ',"vectors":[\n' +
  vectors.map((v) => JSON.stringify(v)).join(",\n") +
  "\n]}\n";
const target = new URL("testdata/cross-platform/view-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, content);
else
  assert.equal(
    readFileSync(target, "utf8"),
    content,
    "View binding reference drift",
  );
console.log(
  `Verified ${vectors.reduce((n, v) => n + v.views.length, 0)} session view cases over ${vectors.length} sources`,
);
