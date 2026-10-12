// Volume-role references from the production browser: the semantic object
// editor's role choices (`volumeRoleEditor.ts`) and the conversion command's
// decisions (`inspectVolumeRoleConversion` in `semanticVolumeCommands.ts`),
// through `volumeRoleEditorExchange.ts`. States derive from the browser
// fixture (whose mesh the bindings upload): an object holding every role —
// model parts painted on each paint channel (and on refinement roots alone),
// with and without local filaments, the last model part of an object, a
// negative volume, modifiers with and without filaments, a support blocker
// and enforcer — with empty, non-ASCII, emoji and lone-surrogate names, an
// object on a second plate, and the state after the browser's command
// converted a part (its volumes re-sorted into Orca's role order). Every
// volume's projection, its decision for every role and for role texts Orca
// lacks, unknown volumes, each conversion's words for every role and several
// names, and malformed requests. Replayed by Rust, WASM in Node and Chrome,
// and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { seededRandom, UuidIdSource } from "../../web/src/project/domain/ids.ts";
import { emptyFacetAnnotations } from "../../web/src/project/domain/model.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { CommandBus } from "../../web/src/project/history/commandBus.ts";
import { ConvertVolumeRoleCommand, ORCA_VOLUME_ROLE_ORDER } from "../../web/src/project/objects/semanticVolumeCommands.ts";
import {
  volumeRoleDecisionExchange,
  volumeRoleEditorExchange,
  volumeRoleMessagesExchange,
} from "../../web/src/project/objects/volumeRoleEditorExchange.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { ProjectStore } from "../../web/src/project/store.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
const clone = (value) => structuredClone(value);

// --- States ------------------------------------------------------------------------------------

const fixture = createProjectFixture();
const ids = new UuidIdSource(seededRandom(0x7013));
const rich = clone(fixture.state);
const [physical0, physical1] = rich.filaments.physical;
const body = rich.plates[0].objects[0];
body.name = "Assemblée";
const template = body.volumes[0];
const volume = (name, role, change = (v) => v) => {
  const v = clone(template);
  v.id = ids.next("volume");
  v.name = name;
  v.role = role;
  v.config = {};
  v.annotations = emptyFacetAnnotations(template.source.topologyRevision);
  delete v.filamentId;
  change(v);
  return v;
};
const paint = (channel, value) => (v) => {
  v.annotations[channel] = [{ triangles: [0], value }];
};
const refinedOnly = (v) => {
  v.annotations.refinement = {
    color: {
      version: 2,
      triangleCount: 1,
      splits: [
        {
          triangle: 0,
          node: {
            kind: "split",
            splitSides: 1,
            specialSide: 0,
            children: [
              { kind: "leaf", state: { kind: "assigned", value: physical0.id } },
              { kind: "leaf", state: { kind: "assigned", value: physical1.id } },
            ],
          },
        },
      ],
    },
  };
};
const filament = (id) => (v) => {
  v.filamentId = id;
};
body.volumes = [
  template,
  volume("Arm", "model", filament(physical1.id)),
  volume("", "model", paint("support", "enforce")),
  volume("Seam ✓", "model", paint("seam", "avoid")),
  volume("Fuzzy", "model", paint("fuzzySkin", true)),
  volume("Brim", "model", paint("brim", false)),
  volume("Refined", "model", refinedOnly),
  volume("Painted arm", "model", (v) => {
    paint("color", physical1.id)(v);
    filament(physical0.id)(v);
  }),
  volume("Cutter", "negative-volume"),
  volume("Tune \ud800", "parameter-modifier", filament(physical0.id)),
  volume("Tune", "parameter-modifier"),
  volume("Blocker", "support-blocker"),
  volume("Enforcer 😀", "support-enforcer"),
];
// A second object whose only model part carries a filament, with a modifier.
const solo = clone(body);
solo.id = ids.next("object");
solo.name = "";
solo.instances = [{ ...clone(body.instances[0]), id: ids.next("instance") }];
solo.layerRanges = [];
solo.volumes = [volume("Solo", "model", filament(physical1.id)), volume("Side", "parameter-modifier")];
rich.plates[0].objects.push(solo);
// A second plate's object: one model part and a negative volume.
const second = {
  ...clone(rich.plates[0]),
  id: ids.next("plate"),
  name: "Plate 2",
  order: 1,
  objects: [
    {
      ...clone(solo),
      id: ids.next("object"),
      name: "Far",
      instances: [{ ...clone(body.instances[0]), id: ids.next("instance") }],
      volumes: [volume("Far part", "model"), volume("Far cutter", "negative-volume")],
    },
  ],
};
rich.plates.push(second);
assertValidProjectState(rich);

// The browser's command converts parts; its volumes re-sort into Orca's order.
const converted = (() => {
  const project = new ProjectStore(clone(rich));
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
  bus.execute(new ConvertVolumeRoleCommand(body.volumes[1].id, "parameter-modifier"));
  bus.execute(new ConvertVolumeRoleCommand(body.volumes[11].id, "model"));
  bus.execute(new ConvertVolumeRoleCommand(second.objects[0].volumes[1].id, "support-blocker"));
  return project.getSnapshot().state;
})();
assert.deepEqual(
  converted.plates[0].objects[0].volumes.map((v) => v.role),
  [...converted.plates[0].objects[0].volumes.map((v) => v.role)].sort(
    (a, b) => ORCA_VOLUME_ROLE_ORDER.indexOf(a) - ORCA_VOLUME_ROLE_ORDER.indexOf(b),
  ),
);

const named = { fixture: fixture.state, rich, converted };
const states = Object.entries(named).map(([name, state]) => {
  const snapshot = new ProjectStore(state).getSnapshot();
  return { name, stateJson: json(snapshot.state), revision: snapshot.revision, hash: snapshot.hash };
});

// --- Cases -------------------------------------------------------------------------------------

const unknownVolume = "00000000-0000-4000-8000-0000000000cc";
const oddRoles = ["auxiliary-volume", "", "Model", "negative_volume", ' "quoted" \\ ', "\ud800x", "modèle"];
const projections = [];
const decisions = [];
for (const [name, state] of Object.entries(named)) {
  const volumes = state.plates.flatMap((p) => p.objects.flatMap((o) => o.volumes));
  for (const v of [...volumes.map((v) => v.id), unknownVolume]) {
    const requestJson = json({ volumeId: v });
    projections.push({ state: name, requestJson, replyJson: volumeRoleEditorExchange(state, requestJson) });
    for (const role of name === "rich" || v === unknownVolume ? [...ORCA_VOLUME_ROLE_ORDER, ...oddRoles] : ORCA_VOLUME_ROLE_ORDER) {
      const request = json({ role, volumeId: v });
      decisions.push({ state: name, requestJson: request, replyJson: volumeRoleDecisionExchange(state, request) });
    }
  }
}
const messages = [];
for (const role of ORCA_VOLUME_ROLE_ORDER)
  for (const volumeName of ["Body", "", "Pièce été", "Tune \ud800", "Enforcer 😀"]) {
    const requestJson = json({ role, volumeName });
    messages.push({ requestJson, replyJson: volumeRoleMessagesExchange(requestJson) });
  }
const refusals = [
  { exchange: "projection", request: json({ volumeId: 3 }) },
  { exchange: "projection", request: json({ volumeId: null }) },
  { exchange: "projection", request: json({}) },
  { exchange: "projection", request: json({ objectId: "x", volumeId: "x" }) },
  { exchange: "projection", request: "[]" },
  { exchange: "projection", request: "not json" },
  { exchange: "decision", request: json({ volumeId: "x" }) },
  { exchange: "decision", request: json({ role: 1, volumeId: "x" }) },
  { exchange: "decision", request: json({ role: "model", volumeId: ["x"] }) },
  { exchange: "messages", request: json({ role: "auxiliary-volume", volumeName: "x" }) },
  { exchange: "messages", request: json({ role: "model" }) },
  { exchange: "messages", request: json({ role: "model", volumeName: 7 }) },
];
for (const r of refusals)
  assert.throws(
    () =>
      ({
        projection: () => volumeRoleEditorExchange(rich, r.request),
        decision: () => volumeRoleDecisionExchange(rich, r.request),
        messages: () => volumeRoleMessagesExchange(r.request),
      })[r.exchange](),
    /invalid_request/,
    `${r.exchange} ${r.request}`,
  );

// --- Output ------------------------------------------------------------------------------------

const sources = [
  "tools/cross-platform/volume-role-vectors.mjs",
  "web/src/project/objects/volumeRoleEditor.ts",
  "web/src/project/objects/volumeRoleEditorExchange.ts",
  "web/src/project/objects/semanticVolumeCommands.ts",
  "web/src/project/domain/facetRefinement.ts",
  "web/src/ui/dom/SemanticObjectEditor.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
      states,
      assets: [{ descriptorJson: json(fixture.asset.descriptor), bytes: Array.from(fixture.asset.bytes) }],
      projections,
      decisions,
      messages,
      refusals,
    },
    null,
    2,
  ) + "\n";
const path = new URL("testdata/cross-platform/volume-role-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Volume role reference drift");
const allowed = decisions.filter((d) => d.replyJson.startsWith('{"allowed":true')).length;
console.log(
  `volume roles: ${states.length} states, ${projections.length} projections, ${decisions.length} decisions ` +
    `(${allowed} allowed), ${messages.length} messages, ${refusals.length} refusals`,
);
