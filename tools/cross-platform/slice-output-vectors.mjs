// Slice output references from the production browser: what a printer's
// `thumbnails` value asks for (`parseThumbnailList`), a thumbnail block in
// the engine's wire format (`encodeThumbnailBlock`), where the blocks go in
// a G-code (`injectGcodeThumbnails`) — all through `GcodeThumbnailsExchange.ts`
// — the three-quarter camera a plate's picture is framed by (`frameCamera`,
// through `PlateThumbnailExchange.ts`), and which plates a slice of the
// active plate or of every plate slices, or why none (`selectPlateIds` behind
// the workspace's refusal, through `SlicePlanExchange.ts`). Inputs cover the
// bundled printers' values, every JavaScript coercion the list makes
// (`String` of array entries, `split`, `trim`, `\d`, `Number`), block row
// wrapping at every remainder, header markers of every placement, bounds of
// every proportion, the project model corpus's states with plates added,
// emptied and made unprintable, and the production controller's journey of a
// cylinder added on a second plate. Replayed by Rust, by WASM in Node and
// Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  thumbnailBlockExchange,
  thumbnailInjectExchange,
  thumbnailListExchange,
} from "../../web/src/slicer/GcodeThumbnailsExchange.ts";
import { thumbnailViewExchange } from "../../web/src/workspace/PlateThumbnailExchange.ts";
import { slicePlanExchange } from "../../web/src/project/slicing/SlicePlanExchange.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { primitiveFileName, primitiveGeometry } from "../../web/src/project/objects/primitives.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { geometryBedPlacement } from "../../web/src/workspace/geometryPlacement.ts";
import { workspaceBed } from "../../web/src/workspace/WorkspaceBed.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const write = process.argv.includes("--write");

// Seeded, so the corpus is the same every run.
let seed = 0x7b1;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};

function refused(exchange, request, name) {
  assert.throws(() => exchange(request), /invalid_request/, name);
  return { name, request };
}

// --- Thumbnail lists ----------------------------------------------------------------------------
const bundled = new Set();
(function walk(value) {
  if (Array.isArray(value)) value.forEach(walk);
  else if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      if (key === "thumbnails") bundled.add(JSON.stringify(entry));
      walk(entry);
    }
})(JSON.parse(read("web/public/profiles/catalog.json")));
assert.ok(bundled.size >= 2);
const listValues = [
  ...[...bundled].sort().map((text) => JSON.parse(text)),
  "48x48/PNG, 300x300/PNG",
  ["144x144"],
  ["320x320", "160x160"],
  "64x64/JPG",
  "64x64/jpeg",
  "64x64/Jpg",
  "64x64/png",
  "0x48",
  "48x0",
  "1000x48",
  "48x1000",
  "999x999",
  "1x1",
  "48",
  "x48",
  "48x",
  "48X48",
  "48x48x48",
  "48x48/QOI",
  "48x48/BTT_TFT",
  "48x48/ColPic",
  "48x48/_",
  "48x48/png_",
  "48x48/",
  "48x48/P N G",
  "48x48/PNG/PNG",
  "48x48/PNG, 5000x5000, 300x300",
  "48x48,,300x300",
  ",,,",
  " , ",
  "  48 x 48 / png  ",
  "48\tx\t48\t/\tPNG",
  " 48x48 ",
  "﻿48x48　",
  "48 x 48",
  "0048x048",
  "00x48",
  "-48x48",
  "+48x48",
  "4.8x48",
  "1e2x48",
  "0x10x48",
  `${"9".repeat(400)}x5`,
  `5x${"1".repeat(30)}`,
  "４８x48",
  "48x٤٨",
  "\ud800x48",
  "48x48/\ud800",
  "48x48/PNG\n300x300",
  "",
  "   ",
  [],
  [""],
  ["  "],
  [" 48x48 "],
  ["48x48, 300x300"],
  ["48x48/PNG", "300x300/JPG", "5x5/QOI"],
  [48, null, true, false, { a: 1 }, ["1x1", "2x2"], ["3x3"], [null], [[null, "4x4"]]],
  [1e21, 0.1, -0, 4.5e-7],
  48,
  0,
  true,
  null,
  { "48x48": "PNG" },
];
const lists = [];
for (const value of listValues) {
  const request = JSON.stringify({ value });
  lists.push({ request, reply: thumbnailListExchange(request) });
}
lists.push({ request: "{}", reply: thumbnailListExchange("{}") });
const listRefusals = [
  refused(thumbnailListExchange, "", "empty request"),
  refused(thumbnailListExchange, "[]", "array request"),
  refused(thumbnailListExchange, '{"value":1,"extra":2}', "extra key"),
  refused(thumbnailListExchange, "null", "null request"),
];

// --- Thumbnail blocks ---------------------------------------------------------------------------
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (length) => Uint8Array.from({ length }, () => Math.floor(random() * 256));
const blocks = [];
for (const [request, image] of [
  ...[0, 1, 2, 3, 4, 5, 6, 57, 58, 59, 60, 116, 117, 118, 300, 5000].map((length) => [
    { format: "PNG", height: 48, width: 48 },
    bytes(length),
  ]),
  [{ format: "JPG", height: 300, width: 300 }, bytes(1200)],
  [{ format: "PNG", height: 1, width: 999 }, bytes(10)],
  [{ format: "JPG", height: 144, width: 144 }, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
]) {
  const json = JSON.stringify({ image: hex(image), request });
  blocks.push({ request: json, reply: thumbnailBlockExchange(json) });
}
const blockRefusals = [
  refused(thumbnailBlockExchange, '{"image":"0","request":{"format":"PNG","height":4,"width":4}}', "odd hex"),
  refused(thumbnailBlockExchange, '{"image":"AB","request":{"format":"PNG","height":4,"width":4}}', "upper hex"),
  refused(thumbnailBlockExchange, '{"image":"","request":{"format":"QOI","height":4,"width":4}}', "format"),
  refused(thumbnailBlockExchange, '{"image":"","request":{"format":"PNG","height":0,"width":4}}', "zero height"),
  refused(thumbnailBlockExchange, '{"image":"","request":{"format":"PNG","height":4,"width":1000}}', "wide"),
  refused(thumbnailBlockExchange, '{"image":"","request":{"format":"PNG","height":4.5,"width":4}}', "fraction"),
  refused(thumbnailBlockExchange, '{"image":"","request":{"format":"PNG","height":4}}', "missing width"),
  refused(thumbnailBlockExchange, '{"request":{"format":"PNG","height":4,"width":4}}', "missing image"),
];

// --- Injection ----------------------------------------------------------------------------------
const header = "; HEADER_BLOCK_START\n; generated by Snapmaker Orca\n; HEADER_BLOCK_END\n";
const body = "\n; EXECUTABLE_BLOCK_START\nG28\nG1 X1 Y2 E3\n; EXECUTABLE_BLOCK_END\n";
const block = JSON.parse(thumbnailBlockExchange(JSON.stringify({ image: hex(bytes(80)), request: { format: "PNG", height: 48, width: 48 } })));
const large = JSON.parse(thumbnailBlockExchange(JSON.stringify({ image: hex(bytes(900)), request: { format: "PNG", height: 300, width: 300 } })));
const gcodes = [
  header + body,
  header + "G28\n",
  header,
  "; HEADER_BLOCK_END\n",
  "; HEADER_BLOCK_END",
  "; HEADER_BLOCK_END\n\n",
  "; HEADER_BLOCK_END\n\n\n",
  "; HEADER_BLOCK_END\r\n\r\nG28\r\n",
  "; header_block_end\nG28\n",
  ";HEADER_BLOCK_END\nG28\n",
  "G28\n; HEADER_BLOCK_END\nG1\n; HEADER_BLOCK_END\nG2\n",
  "G28\nG1 X1\n",
  "",
  "\n",
  `${header}; THUMBNAIL_BLOCK_START\n; thumbnail begin 1x1 4\n; AAAA\n; thumbnail end\n; THUMBNAIL_BLOCK_END\n${body}`,
  `${header}${body}; THUMBNAIL_BLOCK_START\n`,
  `; THUMBNAIL_BLOCK_START${header}`,
  `${header}; THUMBNAIL_BLOCK_STAR\n${body}`,
  `${header}${body}`.replace("G28", "G28 ; é 😀 ü"),
  `${"G1 X1\n".repeat(500)}; HEADER_BLOCK_END\n\n${"G1 Y1\n".repeat(500)}`,
];
const injections = [];
for (const gcode of gcodes)
  for (const list of [[], [block], [block, large], ["", ""], [""]]) {
    const request = JSON.stringify({ blocks: list, gcode });
    injections.push({ request, reply: thumbnailInjectExchange(request) });
  }
const injectRefusals = [
  refused(thumbnailInjectExchange, '{"blocks":[1],"gcode":""}', "numeric block"),
  refused(thumbnailInjectExchange, '{"blocks":"x","gcode":""}', "text blocks"),
  refused(thumbnailInjectExchange, '{"blocks":[],"gcode":3}', "numeric G-code"),
  refused(thumbnailInjectExchange, '{"gcode":""}', "missing blocks"),
];

// --- Framing ------------------------------------------------------------------------------------
const views = [];
const boxes = [
  [[-1, 0, -1], [1, 2, 1]],
  [[0, 0, 0], [20, 20, 20]],
  [[-135, 0, -135], [135, 250, 135]],
  [[10, 0, -40], [210, 0.4, 160]],
  [[0, 0, 0], [1, 300, 1]],
  [[5, 5, 5], [5, 5, 5]],
  [[0, 0, 0], [1e-5, 1e-5, 1e-5]],
  [[-0.035, 0, -0.035], [0.035, 0.0175, 0.035]],
  [[-1e6, -1e6, -1e6], [1e6, 1e6, 1e6]],
  [[0.1, 0.2, 0.3], [0.7, 0.11, 0.9]],
];
for (const [min, max] of boxes)
  for (const aspect of [1, 2, 0.5, 48 / 48, 300 / 299, 999, 1 / 999, 0.1 + 0.2]) {
    const request = JSON.stringify({ aspect, max, min });
    let reply;
    try {
      reply = thumbnailViewExchange(request);
    } catch {
      continue;
    }
    views.push({ request, reply });
  }
for (let i = 0; i < 60; i += 1) {
  const min = [0, 1, 2].map(() => (random() - 0.5) * 400);
  const max = min.map((value) => value + random() * 300);
  const aspect = 0.2 + random() * 4;
  const request = JSON.stringify({ aspect, max, min });
  views.push({ request, reply: thumbnailViewExchange(request) });
}
const viewRefusals = [
  refused(thumbnailViewExchange, '{"aspect":1,"max":[0,0,0],"min":[1,1,1]}', "empty box"),
  refused(thumbnailViewExchange, '{"aspect":0,"max":[1,1,1],"min":[0,0,0]}', "zero aspect"),
  refused(thumbnailViewExchange, '{"aspect":-1,"max":[1,1,1],"min":[0,0,0]}', "negative aspect"),
  refused(thumbnailViewExchange, '{"aspect":1,"max":[1,1],"min":[0,0,0]}', "short vector"),
  refused(thumbnailViewExchange, '{"aspect":1,"max":[1,1,"1"],"min":[0,0,0]}', "text component"),
  refused(thumbnailViewExchange, '{"aspect":1,"max":[1,1,1]}', "missing min"),
  refused(thumbnailViewExchange, '{"aspect":1,"max":[1,1,1],"min":[0,0,0],"x":1}', "extra key"),
];

// --- Slice plans --------------------------------------------------------------------------------
const model = JSON.parse(read("testdata/cross-platform/project-model-vectors.json"));
// The distribution cases differ from the complete one only in a mixed filament's recipe.
const states = [
  ...model.factories.map((factory) => [`factory:${factory.seed}`, JSON.parse(factory.stateJson)]),
  ...model.cases
    .filter((each) => !each.name.startsWith("distribution-") && each.name !== "unassigned-filament-inheritance")
    .map((each) => [`case:${each.name}`, JSON.parse(each.stateJson)]),
];
const variants = [];
for (const [name, state] of states) {
  variants.push([name, state]);
  if (state.plates.length === 0 || !state.plates.some((plate) => plate.objects.length)) continue;
  const clone = () => structuredClone(state);
  const withEmpty = clone();
  withEmpty.plates.push({ id: "import:plate:empty", name: "Empty", order: 50, printable: true, config: {}, objects: [] });
  variants.push([`${name} + empty plate`, withEmpty]);
  const emptyFirst = clone();
  emptyFirst.plates.push({ id: "import:plate:empty-first", name: "First", order: 0, printable: true, config: {}, objects: [] });
  emptyFirst.plates.forEach((plate) => {
    if (plate.id !== "import:plate:empty-first") plate.order += 1;
  });
  emptyFirst.activePlateId = "import:plate:empty-first";
  variants.push([`${name} + empty active plate`, emptyFirst]);
  const unprintable = clone();
  unprintable.plates.forEach((plate) => (plate.printable = false));
  variants.push([`${name} all unprintable`, unprintable]);
  const activeUnprintable = clone();
  activeUnprintable.plates.find((plate) => plate.id === activeUnprintable.activePlateId).printable = false;
  variants.push([`${name} active unprintable`, activeUnprintable]);
  const emptied = clone();
  emptied.plates.forEach((plate) => (plate.objects = []));
  variants.push([`${name} emptied`, emptied]);
  const reversed = clone();
  reversed.plates.forEach((plate, index) => (plate.order = reversed.plates.length - 1 - index));
  variants.push([`${name} reversed`, reversed]);
}
// The Android outputs smoke's journey on the production controller: a cube, a
// second plate, a cylinder added while it is active (sliced alone), then the
// first plate active again (Slice All Plates slices both).
{
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x2b1a)),
    clock: () => "2026-10-11T00:00:00.000Z",
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  });
  const add = (kind) => {
    const geometry = primitiveGeometry(kind);
    const area = workspaceBed(controller.getSlicingConfiguration().config).areaMm;
    const name = primitiveFileName(kind);
    return controller.importGeometry(geometry, { name, sourceFilename: name, transform: geometryBedPlacement(geometry, area) });
  };
  const state = () => structuredClone(controller.createCanonicalSliceSource().capture().state);
  const first = state().activePlateId;
  await add("cube");
  await controller.addPlate();
  await add("cylinder");
  variants.push(["second plate with a cylinder, active", state()]);
  await controller.activatePlate(first);
  variants.push(["second plate with a cylinder, first plate active", state()]);
  controller.dispose();
}
const plans = [];
for (const [name, state] of variants) {
  if (validateProjectState(state).some((issue) => issue.severity === "error")) continue;
  for (const scope of ["current-plate", "all-plates"]) {
    const request = JSON.stringify({ scope, stateJson: JSON.stringify(state) });
    plans.push({ name: `${name} ${scope}`, request, reply: slicePlanExchange(request) });
  }
}
assert.ok(plans.some((plan) => plan.reply.includes('"refusal"')));
assert.ok(plans.some((plan) => JSON.parse(plan.reply).plateIds?.length > 1));
const planRefusals = [
  refused(slicePlanExchange, '{"scope":"some-plates","stateJson":"{}"}', "unknown scope"),
  refused(slicePlanExchange, '{"scope":"all-plates"}', "missing state"),
  refused(slicePlanExchange, '{"scope":"all-plates","stateJson":"{"}', "malformed state"),
];

const sources = [
  "tools/cross-platform/slice-output-vectors.mjs",
  "web/src/slicer/GcodeThumbnails.ts",
  "web/src/slicer/GcodeThumbnailsExchange.ts",
  "web/src/workspace/PlateThumbnailRenderer.ts",
  "web/src/workspace/PlateThumbnailExchange.ts",
  "web/src/project/slicing/SliceJobCoordinator.ts",
  "web/src/project/slicing/SlicePlanExchange.ts",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/src/project/meshWeld.ts",
];
const corpus = {
  lists,
  listRefusals,
  blocks,
  blockRefusals,
  injections,
  injectRefusals,
  views,
  viewRefusals,
  plans,
  planRefusals,
};
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    ...corpus,
  }) + "\n";
const target = new URL("testdata/cross-platform/slice-output-vectors.json", root);
if (write) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "Slice output reference drift");
console.log(
  `Slice output references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
