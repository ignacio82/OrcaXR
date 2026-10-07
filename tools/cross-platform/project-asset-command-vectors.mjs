// Independent references for commands that carry whole records and their own
// immutable mesh payloads (add object, add object with asset, add volume). The
// production TypeScript constructors and bus own the expected behavior; Rust
// replays every step, including asset-repository contents and history charges.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ProjectStore } from "../../web/src/project/store.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { CommandBus } from "../../web/src/project/history/commandBus.ts";
import { prepareProjectIntent } from "../../web/src/project/PreparedProjectCommands.ts";
import { AddObjectCommand, AddObjectWithAssetCommand } from "../../web/src/project/commands.ts";
import { AddVolumeCommand } from "../../web/src/project/objects/semanticVolumeCommands.ts";
import { InMemoryAssetRepository, assetBundleFingerprint } from "../../web/src/project/assets.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { canonicalStringify, cloneJson } from "../../web/src/project/domain/canonical.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
process.env.TZ = "UTC";
const root = new URL("../../", import.meta.url);
const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const string = u => String.fromCharCode(...u);
const read = p => readFileSync(new URL(p, root), "utf8");
const contents = [], traces = [];
const ref = r => (r.kind === "project" ? r : { kind: r.kind, id: units(r.id) });
const refs = s => ({ refs: s.refs.map(ref), primary: s.primary ? ref(s.primary) : null });
const history = h => ({ ...h, undoLabel: h.undoLabel === undefined ? null : units(h.undoLabel), redoLabel: h.redoLabel === undefined ? null : units(h.redoLabel) });
function snapshot(s) {
  const json = canonicalStringify(s.state);
  let content = contents.indexOf(json);
  if (content < 0) { content = contents.length; contents.push(json); }
  return { revision: s.revision, hash: s.hash, content };
}
const wirePayload = p => ({ descriptorJson: canonicalStringify(p.descriptor), bytes: [...p.bytes] });
const payload = w => ({ descriptor: JSON.parse(w.descriptorJson), bytes: Uint8Array.from(w.bytes) });
/** The production constructor for one captured record command. */
function prepare(c) {
  const record = JSON.parse(c.recordJson);
  switch (c.kind) {
    case "addObject": return new AddObjectCommand(string(c.plateId), record);
    case "addObjectWithAsset": return new AddObjectWithAssetCommand(string(c.plateId), record, payload(c.asset));
    case "addVolume": return new AddVolumeCommand(string(c.objectId), record, payload(c.asset));
    default: throw new Error("unknown captured kind");
  }
}
function scenario(name, options, mutate, work) {
  const f = createProjectFixture(), extraAssets = [];
  mutate(f.state, f, extraAssets);
  const project = new ProjectStore(f.state), selection = new SelectionStore(), assets = new InMemoryAssetRepository();
  assets.put(f.asset.descriptor, f.asset.bytes);
  for (const extra of extraAssets) assets.put(extra.descriptor, extra.bytes);
  const bus = new CommandBus({ project, selection, assets }, options);
  const effects = [], steps = [];
  project.subscribe(c => effects.push({ kind: "project", previous: snapshot(c.previous), current: snapshot(c.current), reason: units(c.reason), dirtyCategories: c.dirtyCategories }));
  selection.subscribe((current, previous) => effects.push({ kind: "selection", previous: refs(previous), current: refs(current) }));
  bus.subscribeHistory((current, previous) => effects.push({ kind: "history", previous: history(previous), current: history(current) }));
  const observe = () => ({ snapshot: snapshot(project.getSnapshot()), selection: refs(selection.getSnapshot()), history: history(bus.getHistorySnapshot()), historyRevision: bus.getHistoryRevision(), assets: assetBundleFingerprint(assets.list()) });
  const initial = observe();
  const retained = [];
  function run(operation) {
    effects.length = 0; let result = null, error = null;
    const before = project.getSnapshot(); retained.push([before, canonicalStringify(before.state)]);
    try {
      switch (operation.kind) {
        case "asset": bus.execute(prepare(operation.command), { coalesce: true }); break;
        case "assetBatch": { const commands = operation.commands.map(c => (c.intent ? prepareProjectIntent({ version: 1, command: c.intent }) : prepare(c))); bus.transaction(string(operation.label), () => { for (const c of commands) bus.execute(c); }); break; }
        case "intent": bus.execute(prepareProjectIntent(JSON.parse(operation.json)), { coalesce: operation.coalesce }); break;
        case "undo": result = bus.undo(); break;
        case "redo": result = bus.redo(); break;
        case "checkpoint": bus.markCheckpoint(); break;
        case "clear": bus.clearHistory({ markCheckpoint: operation.mark }); break;
        case "selection": selection.set(operation.refs.map(r => ({ ...r, ...(r.id ? { id: string(r.id) } : {}) }))); break;
        default: throw new Error("unknown operation");
      }
    } catch (e) { error = units(e.message); }
    steps.push({ operation, result, error, effects: [...effects], ...observe() });
    for (const [s, expected] of retained) assert.equal(canonicalStringify(s.state), expected);
  }
  const execute = command => run({ kind: "asset", command });
  const intent = command => run({ kind: "intent", json: JSON.stringify({ version: 1, command }), coalesce: true });
  const batch = (commands, label = "Asset transaction") => run({ kind: "assetBatch", commands, label: units(label) });
  work({ execute, intent, batch, run, state: () => project.getSnapshot().state, repository: assets, ids: f.ids, fixture: f });
  traces.push({ name, options, stateJson: canonicalStringify(f.state), asset: wirePayload(f.asset), extraAssets: extraAssets.map(wirePayload), initial, steps });
}

/** A closed tetrahedron, scaled so distinct sizes have distinct digests. */
const mesh = (id, size = 10) => encodeIndexedMeshAsset({ id, positions: [0, 0, 0, size, 0, 0, 0, size, 0, 0, 0, size], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] });
const withDescriptor = (p, edit) => { const descriptor = cloneJson(p.descriptor); edit(descriptor); return { descriptor, bytes: p.bytes }; };
const volumeFor = (id, asset, o = {}) => ({ id, name: o.name ?? "Added part", role: o.role ?? "model", source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: asset.descriptor.mesh.triangleCount },
  transform: { translationMm: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, config: o.config ?? {}, annotations: { topologyRevision: 0, color: [], support: [], seam: [], fuzzySkin: [], brim: [] }, ...(o.extra ?? {}) });
const objectFor = (suffix, asset, o = {}) => ({ id: `import:object:${suffix}`, name: o.name ?? `Added ${suffix}`, config: {}, volumes: [volumeFor(`import:volume:${suffix}`, asset)],
  instances: o.instances ?? [{ id: `import:instance:${suffix}`, transform: { translationMm: [20, 20, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, printable: true }], layerRanges: [], ...(o.extra ?? {}) });
const addObject = (plate, object) => ({ kind: "addObject", plateId: units(plate), recordJson: canonicalStringify(object) });
const addObjectWithAsset = (plate, object, asset) => ({ kind: "addObjectWithAsset", plateId: units(plate), recordJson: canonicalStringify(object), asset: wirePayload(asset) });
const addVolume = (objectId, volume, asset) => ({ kind: "addVolume", objectId: units(objectId), recordJson: canonicalStringify(volume), asset: wirePayload(asset) });
const roundtrip = (execute, run, command) => { execute(command); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" }); };

scenario("add-objects-and-payloads", {}, (s, f, extra) => {
  // A declared descriptor whose payload is missing, and a repository payload
  // the project never declared: both are inconsistent bundles.
  s.sourceAssets.push(mesh("import:asset:declared-only", 3).descriptor);
  extra.push(mesh("import:asset:repository-only", 4));
}, ({ execute, batch, run, intent, ids, fixture, state }) => {
  const fresh = mesh("import:asset:fresh");
  run({ kind: "selection", refs: [{ kind: "volume", id: units(ids.volume) }] });
  roundtrip(execute, run, addObject(ids.plate, objectFor("plain", fixture.asset, { name: "Plain\\\"\u0000\ud800😀", extra: { foreign: { kept: true } } })));
  execute(addObject("import:plate:missing", objectFor("nowhere", fixture.asset)));
  execute(addObject(ids.plate, { ...objectFor("dup", fixture.asset), id: ids.object }));
  execute(addObject(ids.plate, objectFor("empty", fixture.asset, { instances: [] })));
  execute(addObject(ids.plate, objectFor("dangling", fresh)));
  roundtrip(execute, run, addObjectWithAsset(ids.plate, objectFor("fresh", fresh), fresh));
  execute(addObjectWithAsset(ids.plate, objectFor("fresh", fresh), fresh));
  run({ kind: "redo" });
  assert.equal(state().sourceAssets.length, 3);
  execute(addObjectWithAsset(ids.plate, objectFor("unreferenced", fixture.asset), fresh));
  roundtrip(execute, run, addObjectWithAsset(ids.plate, objectFor("declared", fixture.asset), fixture.asset));
  execute(addObjectWithAsset(ids.plate, objectFor("renamed-file", fixture.asset), withDescriptor(fixture.asset, d => (d.sourceFilename = "renamed.stl"))));
  const twin = mesh("import:asset:twin");
  execute(addObjectWithAsset(ids.plate, objectFor("twin", twin), twin));
  const fixtureTwin = withDescriptor(fixture.asset, d => (d.id = "import:asset:fixture-twin"));
  execute(addObjectWithAsset(ids.plate, objectFor("fixture-twin", fixtureTwin), fixtureTwin));
  const declaredOnly = mesh("import:asset:declared-only", 3);
  execute(addObjectWithAsset(ids.plate, objectFor("declared-only", declaredOnly), declaredOnly));
  const repositoryOnly = mesh("import:asset:repository-only", 4);
  execute(addObjectWithAsset(ids.plate, objectFor("repository-only", repositoryOnly), repositoryOnly));
  const repositoryTwin = withDescriptor(repositoryOnly, d => (d.id = "import:asset:repository-twin"));
  execute(addObjectWithAsset(ids.plate, objectFor("repository-twin", repositoryTwin), repositoryTwin));
  const other = mesh("import:asset:other", 7);
  execute(addObjectWithAsset(ids.plate, { ...objectFor("bad-count", other), volumes: [{ ...volumeFor("import:volume:bad-count", other), source: { assetId: other.descriptor.id, topologyRevision: 0, triangleCount: 99 } }] }, other));
  batch([addObjectWithAsset(ids.plate, objectFor("rolled", other), other), { intent: { deleteObject: { objectId: units("import:object:missing") } } }], "Rolled back");
  batch([addObjectWithAsset(ids.plate, objectFor("first", other), other), addObjectWithAsset(ids.plate, objectFor("second", other), other)], "Shared payload");
  run({ kind: "undo" }); run({ kind: "redo" });
  // The second object keeps the shared asset alive when the first is deleted.
  intent({ deleteObject: { objectId: units("import:object:first") } });
  run({ kind: "undo" }); run({ kind: "undo" });
});

scenario("add-volumes-in-role-order", {}, (s, f, extra) => {
  extra.push(mesh("import:asset:conflict", 5));
}, ({ execute, batch, run, ids, fixture }) => {
  run({ kind: "selection", refs: [{ kind: "object", id: units(ids.object) }, { kind: "instance", id: units(ids.instance) }] });
  const modifier = mesh("import:asset:modifier", 6), blocker = mesh("import:asset:blocker", 8), negative = mesh("import:asset:negative", 9);
  roundtrip(execute, run, addVolume(ids.object, volumeFor("import:volume:modifier", modifier, { role: "parameter-modifier", config: { wall_loops: 1 } }), modifier));
  execute(addVolume(ids.object, volumeFor("import:volume:modifier", modifier, { role: "parameter-modifier" }), modifier));
  execute(addVolume(ids.object, volumeFor("import:volume:blocker", blocker, { role: "support-blocker" }), blocker));
  execute(addVolume(ids.object, volumeFor("import:volume:negative", negative, { role: "negative-volume" }), negative));
  execute(addVolume(ids.object, volumeFor("import:volume:enforcer", fixture.asset, { role: "support-enforcer" }), fixture.asset));
  execute(addVolume(ids.object, volumeFor("import:volume:second-part", modifier, { name: "Second part" }), modifier));
  for (let i = 0; i < 5; i++) run({ kind: "undo" });
  for (let i = 0; i < 5; i++) run({ kind: "redo" });
  execute(addVolume("import:object:missing", volumeFor("import:volume:orphan", negative), negative));
  execute(addVolume(ids.object, volumeFor(ids.volume, negative), negative));
  const conflict = mesh("import:asset:conflict", 11);
  execute(addVolume(ids.object, volumeFor("import:volume:conflict", conflict), conflict));
  const counted = mesh("import:asset:counted", 12);
  execute(addVolume(ids.object, { ...volumeFor("import:volume:counted", counted), source: { assetId: counted.descriptor.id, topologyRevision: 0, triangleCount: 1 } }, counted));
  batch([addVolume(ids.object, volumeFor("import:volume:batched", counted), counted), addVolume(ids.object, volumeFor("import:volume:batched", counted), counted)], "Duplicate volumes");
  run({ kind: "selection", refs: [] });
  execute(addVolume(ids.object, volumeFor("import:volume:unselected", counted, { role: "support-enforcer" }), counted));
  run({ kind: "undo" });
  run({ kind: "redo" });
});

// History charges the canonical record plus the payload bytes; a following
// rename moves each across the boundary.
const probe = createProjectFixture();
const probeAsset = mesh("import:asset:retained");
const probeObject = objectFor("retained", probeAsset), probeVolume = volumeFor("import:volume:retained-part", probeAsset);
const objectBytes = prepare(addObjectWithAsset(probe.ids.plate, probeObject, probeAsset)).estimateBytes();
const volumeBytes = prepare(addVolume(probe.ids.object, probeVolume, probeAsset)).estimateBytes();
assert.equal(objectBytes, canonicalStringify(probeObject).length + probeAsset.bytes.length);
for (const [label, bytes, command] of [["object", objectBytes, ids => addObjectWithAsset(ids.plate, probeObject, probeAsset)], ["volume", volumeBytes, ids => addVolume(ids.object, probeVolume, probeAsset)]])
  for (const delta of [0, -1])
    scenario(`asset-retention-${label}-${delta}`, { maxEstimatedBytes: bytes + 1 + delta }, () => {}, ({ execute, intent, run, ids }) => {
      execute(command(ids));
      intent({ renamePlate: { plateId: units(ids.plate), name: units("Following") } });
      run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "redo" });
    });

const sources = ["tools/cross-platform/project-asset-command-vectors.mjs", "web/src/project/commands.ts", "web/src/project/objects/semanticVolumeCommands.ts", "web/src/project/PreparedProjectCommands.ts",
  "web/src/project/history/command.ts", "web/src/project/history/commandBus.ts", "web/src/project/store.ts", "web/src/project/selection.ts", "web/src/project/assets.ts", "web/src/project/meshCodec.ts",
  "web/src/project/domain/canonical.ts", "web/src/project/domain/model.ts", "web/src/project/domain/ids.ts", "web/src/project/domain/validation.ts", "web/src/project/__tests__/fixtures.ts"];
const output = JSON.stringify({ schemaVersion: 1, sources: sources.map(path => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })), contents, traces }, null, 2) + "\n";
const path = new URL("testdata/cross-platform/project-asset-command-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Asset command reference drift");
console.log(`Asset command references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} complete contents`);
