// Painter references from the production browser: the paint stroke sample a
// pointer hit makes with the painter's settings (`paintSelectionInputs`, the
// workspace painter's mapping, through `PaintToolExchange.ts`) — every tool
// and channel, every parameter below, inside and above the pinned gizmo
// limits and absent, a smart-fill angle that disables edge detection, Gap
// Fill's palette and pinned state orders, splitting brushes and bands,
// clipping planes, overhang gates, and placements — translated, rotated,
// uniformly and non-uniformly scaled and mirrored instances and parts, whose
// transform and bed Z the brush and band measure in — and the painter's
// refusals (a hit off any facet, a placement that is not invertible) — and the
// colours paint draws in (`paintFacetColorsExchange`) for every filament
// library of the paint palette corpus, every channel and every kind of
// state. Malformed requests are refused. Replayed by Rust, by WASM in Node
// and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { paintToolSampleExchange } from "../../web/src/project/painting/PaintToolExchange.ts";
import { paintFacetColorsExchange } from "../../web/src/project/painting/PaintFacets.ts";
import { projectPaintPalette } from "../../web/src/project/painting/paintPalette.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

// xorshift64*, seeded: the corpus is reproducible on any engine.
let seed = 0x9e3779b97f4a7c15n;
const next = () => {
  seed ^= seed >> 12n;
  seed ^= (seed << 25n) & 0xffffffffffffffffn;
  seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const unit = () => Number(next() >> 11n) / 2 ** 53;
const uniform = (low, high) => low + (high - low) * unit();
const pick = (values) => values[Math.floor(unit() * values.length)];
const point = () => [uniform(-60, 60), uniform(-60, 60), uniform(-10, 90)];

const ids = [
  "0c792039-0d6d-4a46-93e8-2bbf4ca9af1e",
  "1089f201-ff94-437e-a01f-1aa18f170be0",
  "de8102d0-aadb-4963-b472-d7613233db91",
];
// Canonical transforms: a turn of [angle] about [axis], then [scale], at [translationMm].
const turn = (axis, angle) => {
  const length = Math.hypot(...axis);
  return [...axis.map((v) => (v / length) * Math.sin(angle / 2)), Math.cos(angle / 2)];
};
const transform = (translationMm = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1]) => ({
  translationMm,
  rotation,
  scale,
});
const identity = transform();
const placements = [
  // A part on the bed as it imports: moved, not turned or scaled.
  { instance: transform([135, 135, 10]), volume: identity },
  // A uniform 200% instance turned about Z: the brush divides by 2 in the part.
  { instance: transform([40.5, -3, 0.25], turn([0, 0, 1], 0.7), [2, 2, 2]), volume: identity },
  // Laid on its side: the band's bed Z runs along the part's Y.
  { instance: transform([20, 30, 12], turn([1, 0, 0], Math.PI / 2)), volume: identity },
  // A non-uniform instance (and mirrored in Z): the brush selects on the bed.
  { instance: transform([0, 0, 0], [0, 0, 0, 1], [1.5, 0.5, -1]), volume: identity },
  // A non-uniform instance turned about Y: the scale stays along the part's axes.
  { instance: transform([60, 60, 5], turn([0, 1, 0], 0.4), [3, 1, 1]), volume: identity },
  // A part turned inside a non-uniform instance: the stretch is off the part's axes.
  { instance: transform([100, 80, 0], [0, 0, 0, 1], [2, 1, 1]), volume: transform([4, -2, 6], turn([0, 0, 1], Math.PI / 4)) },
  // A half-size part offset inside a turned instance.
  { instance: transform([50, 50, 20], turn([1, 1, 0], 0.9)), volume: transform([5, 0, 2], [0, 0, 0, 1], [0.5, 0.5, 0.5]) },
  // A mirrored uniform scale: still the same size every way.
  { instance: transform([10, 10, 0], turn([0, 0, 1], 1.1), [-1.25, 1.25, 1.25]), volume: identity },
  // An unnormalized quaternion, normalized as three.js normalizes it.
  { instance: transform([0, 0, 0], [0, 0, 2, 2], [1, 1, 1]), volume: transform([0, 0, 0], [0, 0, 0, 0], [1, 2, 1]) },
];
// Placements that cannot place a brush: flat, and overflowing.
const unplaceable = [
  { instance: transform([0, 0, 0], [0, 0, 0, 1], [1, 0, 1]), volume: identity },
  { instance: transform([0, 0, 0], [0, 0, 0, 1], [1e200, 1, 1]), volume: transform([0, 0, 0], [0, 0, 0, 1], [1e200, 1, 1]) },
];
const planes = [
  { normal: [0, 0, 1], offset: 12.5 },
  { normal: [0.6, 0, -0.8], offset: -3 },
];

const samples = [];
const errors = [];
function sample(name, request) {
  const text = JSON.stringify(request);
  const reply = paintToolSampleExchange(text);
  (JSON.parse(reply).error ? errors : samples).push({ name, request: text, reply });
}
const hit = (extra = {}) => ({
  triangleIndex: 17,
  localPoint: [1.25, -3.5, 7.75],
  localCameraPosition: [80, -120, 160],
  ...extra,
});
const request = (channel, settings, hitFields = hit(), stateOrder = ids) => ({
  channel,
  hit: hitFields,
  settings,
  stateOrder,
});

// Every tool on every channel with the workspace's defaults.
const channels = ["color", "support", "seam", "fuzzySkin"];
const tools = ["circle", "sphere", "triangle", "fill", "heightRange", "gapFill"];
for (const channel of channels)
  for (const tool of tools)
    sample(`${tool} ${channel}`, request(channel, { tool, radiusMm: 4, smartFillAngleDegrees: 30 }));

// Each parameter absent, at, inside, below and above its limits.
for (const radiusMm of [undefined, 0, 0.1, 0.4, 2.5, 8, 12, -3])
  for (const tool of ["circle", "sphere"])
    sample(`${tool} radius ${radiusMm}`, request("color", { tool, ...(radiusMm === undefined ? {} : { radiusMm }) }));
for (const smartFillAngleDegrees of [undefined, -5, 0, 1e-9, 30, 90, 120])
  sample(
    `fill angle ${smartFillAngleDegrees}`,
    request("color", { tool: "fill", ...(smartFillAngleDegrees === undefined ? {} : { smartFillAngleDegrees }) }),
  );
for (const heightRangeMm of [undefined, 0, 0.05, 0.1, 2, 8, 20])
  sample(
    `band ${heightRangeMm}`,
    request("seam", { tool: "heightRange", ...(heightRangeMm === undefined ? {} : { heightRangeMm }) }),
  );
for (const gapAreaMm2 of [undefined, -1, 0, 0.2, 2, 5, 9])
  for (const channel of ["color", "support", "fuzzySkin"])
    sample(
      `gap ${gapAreaMm2} ${channel}`,
      request(channel, { tool: "gapFill", ...(gapAreaMm2 === undefined ? {} : { gapAreaMm2 }) }),
    );
for (const stateOrder of [[], ids, [...ids].reverse(), ["only"]])
  sample(`gap order ${stateOrder.length}`, request("color", { tool: "gapFill" }, hit(), stateOrder));
for (const highlightByAngleDegrees of [0, -3, 1e-12, 45, 90, 200])
  sample(`overhang ${highlightByAngleDegrees}`, request("support", { tool: "triangle", highlightByAngleDegrees }));
for (const triangleSplitting of [true, false])
  for (const tool of tools)
    sample(
      `${tool} splitting ${triangleSplitting}`,
      request("color", { tool, triangleSplitting }),
    );
for (const [index, clippingPlane] of planes.entries())
  for (const tool of ["circle", "fill"]) sample(`${tool} plane ${index}`, request("color", { tool, clippingPlane }));
for (const [index, placement] of placements.entries()) {
  for (const tool of tools)
    sample(`${tool} placement ${index}`, request("fuzzySkin", { tool, radiusMm: 3 }, hit({ placement })));
  sample(
    `dragged placement ${index}`,
    request("color", { tool: "sphere", radiusMm: 5 }, hit({ placement, previousLocalPoint: [0.5, -2, 6] })),
  );
}

// Dragged brushes carry the previous point; a single tap does not.
sample("dragged circle", request("color", { tool: "circle", radiusMm: 1.5 }, hit({ previousLocalPoint: [1, -3, 7] })));
sample("dragged sphere", request("seam", { tool: "sphere", radiusMm: 6 }, hit({ previousLocalPoint: [0, 0, 0] })));

// Numbers as hosts send them: tiny, huge, negative zero and long fractions.
for (const value of [0.1 + 0.2, 1e-7, -1e-300, 123456789.123, 2 ** 52 + 0.5, -0])
  sample(
    `number ${value}`,
    request("color", { tool: "circle", radiusMm: 3.3 }, hit({ localPoint: [value, -value, value / 3], localCameraPosition: [value, 1, 2] })),
  );
for (const triangleIndex of [0, 1, 4095, 2 ** 31, Number.MAX_SAFE_INTEGER])
  sample(`facet ${triangleIndex}`, request("color", { tool: "triangle" }, hit({ triangleIndex })));

// Seeded combinations of everything above.
for (let n = 0; n < 240; n++) {
  const tool = pick(tools);
  const settings = { tool };
  if (unit() < 0.7) settings.radiusMm = pick([0.2, uniform(0.4, 8), 9, 4]);
  if (unit() < 0.5) settings.smartFillAngleDegrees = pick([0, uniform(0, 90), 95]);
  if (unit() < 0.5) settings.heightRangeMm = pick([0.01, uniform(0.1, 8), 10]);
  if (unit() < 0.5) settings.gapAreaMm2 = pick([-0.5, uniform(0, 5), 7]);
  if (unit() < 0.3) settings.highlightByAngleDegrees = pick([0, uniform(-10, 100)]);
  if (unit() < 0.3) settings.triangleSplitting = unit() < 0.5;
  if (unit() < 0.2) settings.clippingPlane = pick(planes);
  const fields = hit({ triangleIndex: Math.floor(uniform(0, 5000)), localPoint: point(), localCameraPosition: point() });
  if (unit() < 0.6) fields.previousLocalPoint = point();
  if (unit() < 0.5) fields.placement = pick(placements);
  sample(`seeded ${n}`, request(pick(channels), settings, fields, unit() < 0.5 ? ids : []));
}

// The painter's refusals: a hit off any facet, a placement that cannot place a brush.
for (const triangleIndex of [-1, 2.5, -0.5])
  sample(`off facet ${triangleIndex}`, request("color", { tool: "circle" }, hit({ triangleIndex })));
sample("band and bad facet", request("color", { tool: "heightRange" }, hit({ triangleIndex: -2 })));
for (const [index, placement] of unplaceable.entries())
  for (const tool of ["sphere", "heightRange", "triangle"])
    sample(`unplaceable ${index} ${tool}`, request("color", { tool }, hit({ placement })));
assert.equal(errors.length, 10);

// Malformed requests.
const malformed = [
  "",
  "null",
  "[]",
  "{}",
  JSON.stringify({ ...request("color", { tool: "circle" }), extra: 1 }),
  JSON.stringify(request("brim", { tool: "circle" })),
  JSON.stringify(request("color", { tool: "lasso" })),
  JSON.stringify(request("color", {})),
  JSON.stringify(request("color", { tool: "circle", radiusMm: "4" })),
  JSON.stringify(request("color", { tool: "circle", radiusMm: null })),
  JSON.stringify(request("color", { tool: "circle", triangleSplitting: 1 })),
  JSON.stringify(request("color", { tool: "circle", clippingPlane: { normal: [0, 0, 1] } })),
  JSON.stringify(request("color", { tool: "circle", colour: "red" })),
  JSON.stringify(request("color", { tool: "circle" }, { triangleIndex: 1, localPoint: [0, 0, 0] })),
  JSON.stringify(request("color", { tool: "circle" }, hit({ localPoint: [0, 0] }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ localPoint: [0, 0, "1"] }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ triangleIndex: "1" }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ triangleIndex: 2 ** 60 }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ plateZMm: 1 }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ transform: { linear: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], scalingFactors: [1, 1, 1] } }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ placement: null }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ placement: { instance: identity } }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ placement: { instance: identity, volume: identity, plate: 1 } }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ placement: { instance: { ...identity, rotation: [0, 0, 1] }, volume: identity } }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ placement: { instance: { ...identity, scale: [1, 1, null] }, volume: identity } }))),
  JSON.stringify(request("color", { tool: "circle" }, hit({ placement: { instance: { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] }, volume: identity } }))),
  JSON.stringify(request("color", { tool: "circle" }, hit(), [1])),
  JSON.stringify(request("color", { tool: "circle" }, hit(), "ids")),
  '{"channel":"color","hit":{"triangleIndex":1,"localPoint":[1e400,0,0],"localCameraPosition":[0,0,1]},"settings":{"tool":"circle"},"stateOrder":[]}',
];
for (const text of malformed) assert.throws(() => paintToolSampleExchange(text), /invalid_request/);

// The colours paint draws in, for every filament library of the palette corpus.
const palettes = JSON.parse(read("testdata/cross-platform/paint-palette-vectors.json"));
const colors = [];
for (const library of palettes.cases) {
  const filaments = JSON.parse(library.filamentsJson);
  const entries = projectPaintPalette({ filaments }, { includeUnavailable: true }).entries;
  const states = [
    ...entries.filter((entry) => entry.filamentId).map((entry) => entry.filamentId),
    "filament:unknown",
    null,
    true,
    false,
    "enforce",
    "block",
    "prefer",
    "avoid",
    "true",
  ];
  for (const channel of ["color", "support", "seam", "fuzzySkin", "brim"]) {
    const text = JSON.stringify({ channel, filaments, states });
    colors.push({ name: `${library.name} ${channel}`, request: text, reply: paintFacetColorsExchange(text) });
  }
}
const colorRefusals = [
  "{}",
  JSON.stringify({ channel: "paint", filaments: { physical: [], mixed: [] }, states: [] }),
  JSON.stringify({ channel: "color", filaments: { physical: [] }, states: [] }),
  JSON.stringify({ channel: "color", filaments: { physical: [], mixed: [] }, states: [1] }),
  JSON.stringify({ channel: "color", filaments: { physical: [], mixed: [] }, states: [], extra: true }),
];
for (const text of colorRefusals) assert.throws(() => paintFacetColorsExchange(text), /invalid_request/);

const sources = [
  "tools/cross-platform/paint-tool-vectors.mjs",
  "web/src/project/painting/PaintToolExchange.ts",
  "web/src/project/painting/PaintStrokeService.ts",
  "web/src/project/painting/PaintPlacement.ts",
  "web/src/project/picking.ts",
  "web/src/project/painting/PaintFacets.ts",
  "web/src/project/painting/paintOverlayColors.ts",
  "web/src/project/painting/paintPalette.ts",
  "web/src/project/annotations/FacetRegionExchange.ts",
  "contracts/project-intents.json",
  "testdata/cross-platform/paint-palette-vectors.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    samples,
    errors,
    malformed,
    colors,
    colorRefusals,
  }) + "\n";
const path = new URL("testdata/cross-platform/paint-tool-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Paint tool reference drift");
console.log(
  `paint tool: ${samples.length} samples, ${errors.length} refusals, ${malformed.length} malformed; ` +
    `${colors.length} colour sets, ${colorRefusals.length} malformed`,
);
