// Model export references from the production browser: File → Export as one
// STL… and Export all objects as STLs… (`stlExport.ts`: which instances, the
// merged binary STL, the per-instance ZIP with its de-duplicated member
// names, the file names and the export's refusals) and the names every output
// is offered under (`outputNames.ts`, the project serializer's), through
// `modelExportExchange.ts`. States start from the production controller's
// primitives (cube, cylinder, sphere) and pose them: rotations by unnormalized
// quaternions, mirrors (an odd count reverses the winding), non-uniform scale,
// parts with their own transforms, modifiers, support volumes and a negative
// volume the export refuses; names empty, repeated in other cases, with
// controls, reserved characters, compatibility forms NFKC folds, emoji, lone
// surrogates and more than 120 units; selections empty, partial, out of plate
// order, on another plate, unknown and repeated. Each STL case records the
// reply and the file's SHA-256 and length. Replayed by Rust, by WASM in Node
// and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "../../web/node_modules/three/build/three.module.js";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { diagnosticsProjectSummaryOf } from "../../web/src/diagnostics/projectSummary.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import {
  exportNameExchange,
  projectArchiveExportExchange,
  stlExportExchange,
} from "../../web/src/project/objects/modelExportExchange.ts";
import { primitiveFileName, primitiveGeometry } from "../../web/src/project/objects/primitives.ts";
import { ProjectStore } from "../../web/src/project/store.ts";
import { CanonicalWorkspaceController } from "../../web/src/workspace/CanonicalWorkspaceController.ts";
import { geometryBedPlacement } from "../../web/src/workspace/geometryPlacement.ts";
import { workspaceBed } from "../../web/src/workspace/WorkspaceBed.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
const clone = (value) => structuredClone(value);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- Base project: the production controller's primitives ----------------------------------

const ids = new UuidIdSource(seededRandom(0xe5b7));
const controller = CanonicalWorkspaceController.createEmpty({
  idSource: new UuidIdSource(seededRandom(0x57e1)),
  clock: () => "2026-10-12T00:00:00.000Z",
  parent: new THREE.Scene(),
  mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
});
const add = (kind) => {
  const geometry = primitiveGeometry(kind);
  const area = workspaceBed(controller.getSlicingConfiguration().config).areaMm;
  const name = primitiveFileName(kind);
  return controller.importGeometry(geometry, { name, sourceFilename: name, transform: geometryBedPlacement(geometry, area) });
};
await add("cube");
await add("cylinder");
await controller.addPlate();
await add("sphere");
const captured = controller.createCanonicalSliceSource().capture();
const base = clone(captured.state);
const payloads = captured.assets.map((asset) => ({ descriptor: clone(asset.descriptor), bytes: asset.bytes.slice() }));
controller.dispose();
const [plate1, plate2] = base.plates;
base.activePlateId = plate1.id;
// A printer's bed, so every plate has a place in the saved 3MF's build space.
base.config = { ...base.config, printable_area: "0x0,270x0,270x270,0x270" };
const [cube, cylinder] = plate1.objects;
const sphere = plate2.objects[0];

// --- States ------------------------------------------------------------------------------

const instance = (object, name, transform) => ({
  ...clone(object.instances[0]),
  id: ids.next("instance"),
  ...(name === undefined ? {} : { name }),
  transform,
});
const posed = clone(base);
{
  const [c, y] = posed.plates[0].objects;
  c.name = "Bracket v2.stl";
  c.instances[0].transform = {
    translationMm: [40.25, 60.5, 10],
    rotation: [0.3, -0.4, 0.1, 0.8],
    scale: [1.5, 0.5, 2],
  };
  c.instances.push(
    instance(c, "Mirror", { translationMm: [120, 40, 10], rotation: [0, 0, 0, 2], scale: [-1, 1, 1] }),
    instance(c, "", { translationMm: [80, 140, 5], rotation: [0, 0, 0.7071067811865476, 0.7071067811865476], scale: [-1, -1, 1] }),
    instance(c, undefined, { translationMm: [150, 150, 7.5], rotation: [0.5, 0.5, 0.5, 0.5], scale: [1, 1, -0.75] }),
  );
  // A second model part with its own transform, then volumes the STL leaves out.
  const part = {
    ...clone(y.volumes[0]),
    id: ids.next("volume"),
    name: "Peg",
    transform: { translationMm: [3, -2, 4], rotation: [0.2, 0, 0, 1], scale: [0.5, 0.5, 1.25] },
  };
  const modifier = { ...clone(c.volumes[0]), id: ids.next("volume"), name: "Tune", role: "parameter-modifier" };
  const enforcer = { ...clone(c.volumes[0]), id: ids.next("volume"), name: "Enforce", role: "support-enforcer" };
  const blocker = { ...clone(y.volumes[0]), id: ids.next("volume"), name: "Block", role: "support-blocker" };
  y.volumes.push(part, modifier, enforcer, blocker);
  y.name = "Peg ﬁle①";
  y.instances[0].name = "Part";
  y.instances.push(instance(y, "part", y.instances[0].transform), instance(y, "Part_2", y.instances[0].transform));
}
const names = clone(base);
{
  const odd = [
    "\u0001lead\u001f",
    'a<b>:c"d/e\\f|g?h*i',
    "trailing. . ",
    "  spaced  ",
    "Ｆｕｌｌ ｗｉｄｔｈ",
    "Grüße 😀",
    "lone \ud800 surrogate",
    "x".repeat(119) + "😀tail",
    "",
    "MODEL.STL",
    "..",
  ];
  const [c] = names.plates[0].objects;
  c.instances = odd.map((name, i) =>
    instance(c, name, { translationMm: [20 + i * 15, 20 + i * 10, 10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
  );
  names.plates[0].objects[1].name = "";
  names.plates[0].objects[1].instances[0].name = undefined;
  delete names.plates[0].objects[1].instances[0].name;
  names.name = "Projet d'été / v2";
}
const negative = clone(posed);
{
  const y = negative.plates[0].objects[1];
  y.volumes.splice(1, 0, { ...clone(y.volumes[0]), id: ids.next("volume"), name: "Hole", role: "negative-volume" });
}
const second = clone(base);
second.activePlateId = plate2.id;
second.name = ". . .";
const empty = clone(base);
empty.plates[0].objects = [];
empty.name = "\u0007";
const named = { base, posed, names, negative, second, empty };
for (const [name, state] of Object.entries(named)) {
  const errors = validateProjectState(state).filter((issue) => issue.severity === "error");
  assert.deepEqual(errors, [], name);
}
const states = Object.entries(named).map(([name, state]) => {
  const snapshot = new ProjectStore(state).getSnapshot();
  return { name, stateJson: json(snapshot.state), revision: snapshot.revision, hash: snapshot.hash };
});
const assets = new InMemoryAssetRepository();
for (const payload of payloads) assets.put(payload.descriptor, payload.bytes);

// --- STL exports ---------------------------------------------------------------------------

const unknown = "00000000-0000-4000-8000-0000000000ee";
const allInstances = (state) => state.plates.flatMap((p) => p.objects.flatMap((o) => o.instances.map((i) => i.id)));
const stl = [];
for (const [name, state] of Object.entries(named)) {
  const every = allInstances(state);
  const active = state.plates.find((p) => p.id === state.activePlateId).objects.flatMap((o) => o.instances.map((i) => i.id));
  const other = every.filter((id) => !active.includes(id));
  const selections = [
    [],
    active.slice(0, 1),
    active.slice(-1),
    [...active].reverse(),
    active.slice(1, 3),
    [...other, ...active.slice(0, 2)],
    other,
    [unknown],
    [unknown, ...active.slice(0, 1)],
    [...active.slice(0, 1), ...active.slice(0, 1)],
  ];
  for (const archive of [false, true])
    for (const selectedInstanceIds of selections) {
      const requestJson = json({ archive, selectedInstanceIds });
      const { reply, bytes } = stlExportExchange(state, assets, requestJson);
      stl.push({
        state: name,
        requestJson,
        replyJson: reply,
        ...(bytes ? { sha256: digest(bytes), bytes: bytes.length } : {}),
      });
    }
}
assert.ok(stl.some((c) => c.replyJson.includes("canonical CSG")));
assert.ok(stl.some((c) => c.replyJson.includes("No models to export")));
assert.ok(stl.some((c) => c.replyJson.includes("duplicate instance")));
assert.ok(stl.some((c) => c.replyJson.includes("application/zip")));

// --- Export as 3MF… ------------------------------------------------------------------------

// The states above, and the volume-role corpus's (painted parts on every channel, local filaments,
// every role), saved as the browser saves them.
const roles = JSON.parse(read("testdata/cross-platform/volume-role-vectors.json"));
const roleStates = roles.states.map((recorded) => {
  // With a bed, so their second plate has a place in the saved build space.
  const state = JSON.parse(recorded.stateJson);
  state.config = { ...state.config, printable_area: "0x0,270x0,270x270,0x270" };
  const snapshot = new ProjectStore(state).getSnapshot();
  return { name: `roles-${recorded.name}`, stateJson: json(snapshot.state), revision: snapshot.revision, hash: snapshot.hash };
});
// And one as recorded: two plates and no bed, which the serializer refuses.
roleStates.push({ ...roles.states[1], name: "roles-rich-unplaced" });
// The rich and converted states name a part with a lone surrogate, which XML cannot carry (refused);
// with that name representable they save, painted parts, local filaments and every role included.
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
for (const recorded of roleStates.filter((state) => /rich$|converted$/.test(state.name))) {
  const state = JSON.parse(recorded.stateJson);
  for (const object of state.plates.flatMap((plate) => plate.objects))
    for (const volume of object.volumes) volume.name = volume.name.replace(lone, "?");
  const snapshot = new ProjectStore(state).getSnapshot();
  roleStates.push({ name: `${recorded.name}-named`, stateJson: json(snapshot.state), revision: snapshot.revision, hash: snapshot.hash });
}
const roleAssets = roles.assets.map((asset) => ({
  descriptor: JSON.parse(asset.descriptorJson),
  bytes: Uint8Array.from(asset.bytes),
}));
states.push(...roleStates);
payloads.push(...roleAssets);
// Export Diagnostics…'s project shape of each state (`diagnosticsProjectSummaryOf`).
for (const state of states) state.diagnosticsSummaryJson = canonicalStringify(diagnosticsProjectSummaryOf(JSON.parse(state.stateJson)));
const projects = [];
for (const state of states) {
  const parsed = JSON.parse(state.stateJson);
  const snapshot = {
    state: parsed,
    assets: payloads.filter((p) => parsed.sourceAssets.some((d) => d.id === p.descriptor.id)),
    sourceRevision: state.revision,
    sourceHash: state.hash,
  };
  const { reply, bytes } = await projectArchiveExportExchange(snapshot);
  projects.push({ state: state.name, replyJson: reply, ...(bytes ? { sha256: digest(bytes), bytes: bytes.length } : {}) });
}
assert.ok(projects.filter((p) => p.sha256).length >= 6 && projects.some((p) => p.replyJson.includes("refused")));

// --- Names ---------------------------------------------------------------------------------

const nameCases = [
  "Plate 1",
  "plate-2_final.v3",
  "Été 😀 \ud83d",
  "",
  "  ",
  "a\u0000b",
  "Ｆｕｌｌ",
  "ﬁ①",
  "Bracket v2.STL",
  "Bracket.3MF",
  'x<y>:"/\\|?*',
  "dots... ",
  "\u001f\u0001",
  " nbsp　",
  "﻿bom",
  "y".repeat(130),
  "z".repeat(119) + "😀",
  "é",
  "\ud800́",
];
const names_ = [];
for (const kind of ["plate-gcode", "toolpath-obj", "stl", "project"])
  for (const name of [...nameCases, ...(kind.startsWith("plate") || kind.startsWith("tool") ? [null] : [])]) {
    const requestJson = json({ kind, name });
    names_.push({ requestJson, replyJson: exportNameExchange(requestJson) });
  }

const refusals = [
  { exchange: "stl", request: json({ archive: false }) },
  { exchange: "stl", request: json({ archive: 1, selectedInstanceIds: [] }) },
  { exchange: "stl", request: json({ archive: false, selectedInstanceIds: [3] }) },
  { exchange: "stl", request: json({ archive: false, selectedInstanceIds: "x" }) },
  { exchange: "stl", request: json({ archive: false, extra: 1, selectedInstanceIds: [] }) },
  { exchange: "stl", request: "[]" },
  { exchange: "stl", request: "not json" },
  { exchange: "name", request: json({ kind: "stl", name: null }) },
  { exchange: "name", request: json({ kind: "project", name: null }) },
  { exchange: "name", request: json({ kind: "gcode", name: "x" }) },
  { exchange: "name", request: json({ kind: "stl", name: 7 }) },
  { exchange: "name", request: json({ kind: "stl" }) },
];
for (const r of refusals)
  assert.throws(
    () => (r.exchange === "stl" ? stlExportExchange(base, assets, r.request) : exportNameExchange(r.request)),
    /invalid_request/,
    `${r.exchange} ${r.request}`,
  );

// --- Output ------------------------------------------------------------------------------

const sources = [
  "tools/cross-platform/model-export-vectors.mjs",
  "web/src/project/objects/modelExportExchange.ts",
  "web/src/diagnostics/projectSummary.ts",
  "web/src/project/objects/stlExport.ts",
  "web/src/project/outputNames.ts",
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/deterministicZip.ts",
  "web/src/project/meshCodec.ts",
  "testdata/cross-platform/volume-role-vectors.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: digest(read(path)) })),
      states,
      assets: payloads.map((p) => ({ descriptorJson: json(p.descriptor), base64: Buffer.from(p.bytes).toString("base64") })),
      stl,
      projects,
      names: names_,
      refusals,
    },
    null,
    2,
  ) + "\n";
const path = new URL("testdata/cross-platform/model-export-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Model export reference drift");
const files = stl.filter((c) => c.sha256).length;
const saved = projects.filter((p) => p.sha256).length;
console.log(
  `model exports: ${states.length} states, ${stl.length} STL exports (${files} files, ` +
    `${stl.length - files} refused), ${saved} 3MF exports (${projects.length - saved} refused), ` +
    `${names_.length} names, ${refusals.length} refusals`,
);
