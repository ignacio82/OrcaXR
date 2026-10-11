// Workspace bed references from the production browser (`WorkspaceBed.ts`
// through `WorkspaceBedExchange.ts`): the bed size the workspace draws and
// maps (`bedSizeFromProfile` over `printable_area` as flattened text), the
// printable rectangle (`printableAreaRect`), the printable height, the
// placement area and build volume models are placed in and scaled into (the
// slice preflight's own reading of the area and height from engine strings,
// else the workspace's, else the bed from its corner) and a plate wipe
// tower's arrange keep-out. Inputs cover
// the bundled printers' values, every JavaScript coercion these reads make
// (`Number`, `parseFloat`, `String`, `??`, `||`, both separators, hex and
// exponent spellings, whitespace, non-string entries) and malformed requests,
// and the beds of opened projects. Replayed by Rust, by WASM in Node and
// Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { EditorSession } from "../../web/src/project/session.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { workspaceBedExchange } from "../../web/src/workspace/WorkspaceBedExchange.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));

// The bundled printers' values, read from the catalog the app ships.
const catalog = JSON.parse(read("web/public/profiles/catalog.json"));
const bundled = { printable_area: new Set(), printable_height: new Set(), prime_tower_width: new Set() };
(function walk(value) {
  if (Array.isArray(value)) value.forEach(walk);
  else if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      if (key in bundled) bundled[key].add(JSON.stringify(entry));
      walk(entry);
    }
})(catalog);
const values = (key) => [...bundled[key]].sort().map((text) => JSON.parse(text));
assert.ok(values("printable_area").length >= 2 && values("printable_height").length >= 2);

const cases = [];
const refusals = [];
function bed(name, config, wipeTower = null) {
  const request = JSON.stringify({ config, wipeTower });
  cases.push({ name, request, reply: workspaceBedExchange(request) });
}
function refuse(name, request) {
  assert.throws(() => workspaceBedExchange(request), /invalid_request/, name);
  refusals.push({ name, request });
}

// The bundled printers, as their profiles and as an opened project hold them.
for (const area of values("printable_area")) {
  for (const height of values("printable_height")) bed(`bundled ${area[1]} ${height}`, { printable_area: area, printable_height: height });
  bed(`bundled ${area[1]} as text`, { printable_area: area.join(",") });
}
bed("no configuration", {});
bed("null area and height", { printable_area: null, printable_height: null });
bed("empty area list", { printable_area: [] });
bed("empty area text", { printable_area: "" });
bed("numeric area", { printable_area: 5 });
bed("object area", { printable_area: { a: "0x0" } });
bed("non-string entries", { printable_area: ["0x0", 5, "300x300"] });
bed("null entry", { printable_area: ["0x0", null] });
bed("semicolons", { printable_area: "0x0;200x0;200x200;0x200" });
bed("mixed separators", { printable_area: "0x0,220x0;220x210,0x210" });
bed("negative origin", { printable_area: ["-10x-10", "190x-10", "190x190", "-10x190"] });
bed("all negative", { printable_area: ["-50x-50", "-10x-50", "-10x-10"] });
bed("upper-case X", { printable_area: "0X0,300X0,300X300,0X300" });
bed("hex coordinates", { printable_area: "0x0,0x1A0,0x10" });
bed("whitespace", { printable_area: " 0 x 0 , 250 x 0, 250 x 210 , 0 x 210" });
bed("tabs and no-break space", { printable_area: ["\t0x0", "180x0 ", "180x 175"] });
bed("exponents", { printable_area: "0x0,2.5e2x0,2.5e2x2e2,0x2e2" });
bed("leading dots", { printable_area: ".5x.5,300.x.5,300.x200." });
bed("infinite coordinate", { printable_area: "0x0,Infinityx0,1e400x300" });
bed("degenerate rectangle", { printable_area: "0x0,0x0" });
bed("zero width", { printable_area: ["0x0", "0x200"] });
bed("one point", { printable_area: "300x200" });
bed("bare x", { printable_area: "x5,5x" });
bed("three parts", { printable_area: "0x0x9,240x0x9,240x235x9" });
bed("lone surrogate", { printable_area: ["\ud800x5", "100x100", "0x0"] });
bed("huge coordinates", { printable_area: ["0x0", "1e300x1e300"] });
bed("plate keys elsewhere", { bed_shape: "0x0,500x500", printable_area: "0x0,180x180" });
// The placement area and volume: the preflight's rectangle and height first.
bed("far offset area", { printable_area: ["180x150", "300x150", "300x260", "180x260"], printable_height: "100" });
bed("closing repeat", { printable_area: "0x0,200x0,200x200,0x200,0x0", printable_height: "200" });
bed("clockwise rectangle", { printable_area: "10x10,10x210,230x210,230x10", printable_height: "180" });
bed("signed corners", { printable_area: ["+0.5x+1", "270.5x+1", "270.5x271", "+0.5x271"], printable_height: "+250" });
bed("negative zero corners", { printable_area: "-0x-0,200x-0,200x200,-0x200", printable_height: "200" });
bed("padded corners", { printable_area: [" 5x5", "205x5 ", "205x205", "5x205"], printable_height: " 120 " });
bed("diamond polygon", { printable_area: "-100x0,0x-100,100x0,0x100", printable_height: "250mm" });
bed("trapezoid", { printable_area: "0x0,200x0,150x200,50x200", printable_height: "200" });
bed("five corners", { printable_area: "0x0,100x0,200x0,200x200,0x200", printable_height: "200" });
bed("rectangle and garbage height", { printable_area: "0x0,220x0,220x220,0x220", printable_height: "abc" });
bed("garbage area with height", { printable_area: "garbage", printable_height: "150" });
// printable_height as scale-to-fit reads it.
for (const [name, height] of [
  ["number", 250],
  ["text with unit", " 42mm"],
  ["list", ["300", "200"]],
  ["numeric list", [250, 300]],
  ["empty list", []],
  ["null in list", [null]],
  ["garbage", "abc"],
  ["negative", "-5"],
  ["zero", "0"],
  ["exponent", "1e2"],
  ["hex", "0x10"],
  ["infinite", "Infinity"],
  ["boolean", true],
  ["object", { a: 1 }],
  ["leading dot", ".5"],
  ["plus sign", "+180.5"],
]) {
  bed(`height ${name}`, { printable_area: "0x0,220x0,220x220,0x220", printable_height: height });
}
// A plate wipe tower's keep-out.
const tower = (x, y, extra = {}) => ({ enabled: true, positionMm: [x, y], rotationDeg: 0, ...extra });
bed("no tower", { prime_tower_width: "35" }, null);
bed("disabled tower", { prime_tower_width: "35" }, { ...tower(10, 20), enabled: false });
for (const width of values("prime_tower_width")) bed(`tower ${width}`, { prime_tower_width: width }, tower(200, 210));
for (const [name, config] of [
  ["no width", {}],
  ["wipe tower width", { wipe_tower_width: 40 }],
  ["null prime width", { prime_tower_width: null, wipe_tower_width: "50" }],
  ["zero width", { prime_tower_width: "0" }],
  ["empty width", { prime_tower_width: "" }],
  ["garbage width", { prime_tower_width: "abc" }],
  ["list width", { prime_tower_width: ["45"] }],
  ["two-item list width", { prime_tower_width: ["45", "50"] }],
  ["negative width", { prime_tower_width: "-5" }],
  ["boolean width", { prime_tower_width: true }],
  ["object width", { prime_tower_width: {} }],
  ["padded width", { prime_tower_width: " 12 " }],
  ["hex width", { prime_tower_width: "0x20" }],
  ["infinite width", { prime_tower_width: "Infinity" }],
  ["negative infinite width", { prime_tower_width: "-Infinity" }],
  ["overflowing width", { prime_tower_width: "1e400" }],
]) {
  bed(`tower ${name}`, config, tower(-5.5, 12.25, { rotationDeg: 90, filamentId: "physical:1" }));
}
bed("tower at its far edge", { prime_tower_width: 1e308 }, tower(1e308, -1e308));

refuse("not JSON", "{");
refuse("not an object", "[]");
refuse("missing tower", JSON.stringify({ config: {} }));
refuse("missing config", JSON.stringify({ wipeTower: null }));
refuse("extra field", JSON.stringify({ config: {}, wipeTower: null, plate: 1 }));
refuse("config list", JSON.stringify({ config: [], wipeTower: null }));
refuse("config null", JSON.stringify({ config: null, wipeTower: null }));
refuse("tower list", JSON.stringify({ config: {}, wipeTower: [] }));
refuse("tower missing position", JSON.stringify({ config: {}, wipeTower: { enabled: true, rotationDeg: 0 } }));
refuse("tower short position", JSON.stringify({ config: {}, wipeTower: { enabled: true, positionMm: [1], rotationDeg: 0 } }));
refuse("tower text position", JSON.stringify({ config: {}, wipeTower: { enabled: true, positionMm: ["1", 2], rotationDeg: 0 } }));
refuse("tower text enabled", JSON.stringify({ config: {}, wipeTower: { enabled: "yes", positionMm: [1, 2], rotationDeg: 0 } }));
refuse("tower numeric filament", JSON.stringify({ config: {}, wipeTower: { enabled: true, positionMm: [1, 2], rotationDeg: 0, filamentId: 3 } }));
refuse("tower unknown field", JSON.stringify({ config: {}, wipeTower: { enabled: true, positionMm: [1, 2], rotationDeg: 0, width: 3 } }));

// Projects: the bed the workspace reads from an opened project — its base
// profile when it records one, else its configuration
// (`getSlicingConfiguration().config`) — with each plate's tower, an unknown
// plate's and none.
const states = [];
const u1 = ["0.5x1", "270.5x1", "270.5x271", "0.5x271"];
const serializer = new Bbs3mfProjectSerializer();
async function project(name, edit) {
  const ids = new UuidIdSource(seededRandom(0xbed + states.length));
  const state = createEmptyProject({ idSource: ids, now: "2026-10-10T00:00:00.000Z" });
  state.plates.push({ id: ids.next("plate"), name: "Plate 2", order: 1, printable: true, config: {}, objects: [] });
  edit(state);
  assertValidProjectState(state);
  const source = new EditorSession({ initialState: state, assets: new InMemoryAssetRepository(), serializer });
  const { serialized } = await source.serializeSnapshot(undefined, { purpose: "manual" });
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(1)),
    clock: () => "2026-10-10T00:00:00.000Z",
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [200, 200], worldUnitsPerMm: 0.00175 },
    projectSerializer: serializer,
  });
  assert.deepEqual(await controller.openCanonical3mf(serialized.bytes), []);
  assert.equal(controller.captureProjectExportGuard().semanticHash, source.captureExportGuard().semanticHash);
  const config = controller.getSlicingConfiguration().config;
  const beds = [...state.plates.map((plate) => plate.id), "import:plate:missing", null].map((plateId) => {
    const wipeTower = plateId === null ? undefined : controller.getPlateWipeTower(plateId);
    return {
      request: JSON.stringify({ plateId }),
      reply: workspaceBedExchange(JSON.stringify({ config, wipeTower: wipeTower ?? null })),
    };
  });
  states.push({ name, stateJson: canonicalStringify(state), beds });
}
await project("fresh", (state) => {
  state.config = { printable_area: ["0x0", "200x0", "200x200", "0x200"] };
});
await project("towers", (state) => {
  state.config = { printable_area: u1, printable_height: "250", prime_tower_width: "35" };
  state.plates[0].wipeTower = { enabled: true, positionMm: [10, 20], rotationDeg: 90 };
  state.plates[1].wipeTower = { enabled: false, positionMm: [100, 120], rotationDeg: 0 };
});
await project("base profile", (state) => {
  const base = { printable_area: "0x0,256x0,256x256,0x256", printable_height: "256", wipe_tower_width: "45" };
  const overrides = { printable_area: u1, printable_height: "180" };
  state.settingsBaseConfig = base;
  state.settingsOverrides = overrides;
  state.config = { ...base, ...overrides };
  state.plates[1].wipeTower = { enabled: true, positionMm: [-3, 7.5], rotationDeg: 0 };
});

const sources = [
  "tools/cross-platform/workspace-bed-vectors.mjs",
  "web/src/workspace/WorkspaceBed.ts",
  "web/src/workspace/WorkspaceBedExchange.ts",
  "web/src/workspace/ProfilePreflightConstraints.ts",
  "web/src/workspace/AuthoredSlicingTarget.ts",
  "web/src/settings/configSerialization.ts",
  "web/src/slicer/ProfileLoader.ts",
  "web/src/project/objects/wipeTowerPlacement.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/workspace/CanonicalWorkspaceController.ts",
  "web/public/profiles/catalog.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    cases,
    refusals,
    states,
  }) + "\n";
const path = new URL("testdata/cross-platform/workspace-bed-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Workspace bed reference drift");
const keepOuts = cases.filter((c) => !c.reply.includes('"keepOut":null')).length;
const areas = cases.filter((c) => !c.reply.includes('"printableArea":null')).length;
const volumes = cases.filter((c) => !c.reply.includes('"volumeMm":null')).length;
console.log(
  `Workspace bed references: ${cases.length} beds (${areas} printable areas, ${volumes} build volumes, ${keepOuts} keep-outs), ` +
    `${refusals.length} refusals, ${states.length} projects (${states.flatMap((p) => p.beds).length} plate beds)`,
);
