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
import { AddObjectCommand, AddObjectWithAssetCommand, ReplaceProjectCommand } from "../../web/src/project/commands.ts";
import { ImportProjectCommand } from "../../web/src/project/import/ImportProjectCommand.ts";
import { AddVolumeCommand } from "../../web/src/project/objects/semanticVolumeCommands.ts";
import { ReplaceVolumeMeshCommand } from "../../web/src/project/objects/topologyCommands.ts";
import { MeshBooleanCommand } from "../../web/src/project/objects/meshBooleanCommands.ts";
import { SplitVolumeToPartsCommand, captureVolumeSplitGuard } from "../../web/src/project/objects/splitCommands.ts";
import { prepareVolumeSplitParts } from "../../web/src/project/objects/splitPreparation.ts";
import { commitPreparedVolumeSplitToObjects } from "../../web/src/project/objects/splitToObjectsCommands.ts";
import { AddSvgPartCommand, EditSvgPartCommand, prepareSvgPart } from "../../web/src/project/objects/svgCommands.ts";
import { AddEmbossTextCommand, EditEmbossTextCommand, prepareEmbossedVolume } from "../../web/src/project/objects/embossCommands.ts";
import { DEFAULT_EMBOSS_FONT_PROPERTY } from "../../web/src/project/objects/emboss.ts";
import { commitFacetRefinement } from "../../web/src/project/annotations/FacetAnnotationStrokeCommand.ts";
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
/** Guards travel with UTF-16 strings, so their exact text reaches both sides. */
const guardTo = g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === "string" ? units(v) : v]));
const guardFrom = g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Array.isArray(v) ? string(v) : v]));
const partsTo = parts => parts.map(p => ({ volumeId: units(p.volumeId), asset: wirePayload(p.asset), transformJson: canonicalStringify(p.transform), sourceTriangleIndices: [...p.sourceTriangleIndices] }));
const partsFrom = parts => parts.map(p => ({ volumeId: string(p.volumeId), asset: payload(p.asset), transform: JSON.parse(p.transformJson), sourceTriangleIndices: p.sourceTriangleIndices }));
const refinementFrom = o => ({ guard: guardFrom(o.guard), channel: o.channel, encoding: { version: 2, roots: JSON.parse(o.rootsJson) }, ...(o.label === null ? {} : { label: string(o.label) }) });
const identitiesTo = identities => identities.map(i => ({ sourceVolumeId: units(i.sourceVolumeId), objectId: units(i.objectId), instanceIds: i.instanceIds.map(units) }));
const identitiesFrom = identities => identities.map(i => ({ sourceVolumeId: string(i.sourceVolumeId), objectId: string(i.objectId), instanceIds: i.instanceIds.map(string) }));
function prepare(c) {
  const record = c.recordJson === undefined ? undefined : JSON.parse(c.recordJson);
  switch (c.kind) {
    case "addObject": return new AddObjectCommand(string(c.plateId), record);
    case "addObjectWithAsset": return new AddObjectWithAssetCommand(string(c.plateId), record, payload(c.asset));
    case "addVolume": return new AddVolumeCommand(string(c.objectId), record, payload(c.asset));
    case "replaceVolumeMesh": return new ReplaceVolumeMeshCommand(guardFrom(c.guard), payload(c.asset));
    case "meshBoolean": return new MeshBooleanCommand(guardFrom(c.guard), payload(c.asset), c.op);
    case "splitVolumeToParts": return new SplitVolumeToPartsCommand(guardFrom(c.guard), partsFrom(c.parts));
    case "replaceProject": return c.label === null ? new ReplaceProjectCommand(JSON.parse(c.stateJson)) : new ReplaceProjectCommand(JSON.parse(c.stateJson), string(c.label));
    case "importProject": return new ImportProjectCommand(JSON.parse(c.stateJson), c.assets.map(payload), string(c.label));
    case "addSvgPart": return new AddSvgPartCommand(placementFrom(c.placement), { asset: payload(c.asset), drawing: payload(c.drawing), mesh: { triangleCount: c.triangleCount }, part: JSON.parse(c.partJson) }, string(c.name));
    case "editSvgPart": return new EditSvgPartCommand(string(c.volumeId), { asset: payload(c.asset), drawing: payload(c.drawing), mesh: { triangleCount: c.triangleCount }, part: JSON.parse(c.partJson) });
    case "addEmbossText": return new AddEmbossTextCommand(placementFrom(c.placement), JSON.parse(c.configurationJson), { asset: payload(c.asset), mesh: { triangleCount: c.triangleCount } });
    case "editEmbossText": return new EditEmbossTextCommand(string(c.volumeId), JSON.parse(c.configurationJson), { asset: payload(c.asset), mesh: { triangleCount: c.triangleCount } });
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
        case "splitToObjects": commitPreparedVolumeSplitToObjects(bus, guardFrom(operation.guard), partsFrom(operation.parts), identitiesFrom(operation.identities)); break;
        case "facetRefinement": commitFacetRefinement(bus, refinementFrom(operation)); break;
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
  work({ execute, intent, batch, run, state: () => project.getSnapshot().state, snapshot: () => project.getSnapshot(), repository: assets, ids: f.ids, fixture: f });
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

const replaceMesh = (guard, asset) => ({ kind: "replaceVolumeMesh", guard: guardTo(guard), asset: wirePayload(asset) });
const meshBoolean = (guard, asset, op = "UNION") => ({ kind: "meshBoolean", guard: guardTo(guard), asset: wirePayload(asset), op });
const topologyGuard = (state, volumeId) => {
  const volume = state.plates.flatMap(p => p.objects).flatMap(o => o.volumes).find(v => v.id === volumeId);
  const descriptor = state.sourceAssets.find(a => a.id === volume.source.assetId);
  return { volumeId, assetId: volume.source.assetId, assetDigest: descriptor.digest, topologyRevision: volume.source.topologyRevision, triangleCount: volume.source.triangleCount };
};
const withMeshDescriptor = (p, edit) => withDescriptor(p, d => edit(d.mesh));
const CORE_FACET_ATTRIBUTES = "https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes";

scenario("replace-volume-mesh", {}, (s, f, extra) => {
  // A second volume shares the fixture mesh, so the first replacement keeps it.
  const object = s.plates[0].objects[0];
  object.volumes.push({ ...cloneJson(object.volumes[0]), id: "import:volume:sharing", name: "Sharing", annotations: { ...object.volumes[0].annotations, color: [] } });
  extra.push(mesh("import:asset:repository-held", 13));
}, ({ execute, run, state, ids, fixture }) => {
  const guard = () => topologyGuard(state(), ids.volume);
  const result = mesh("import:asset:replaced", 21);
  for (const bad of [{ volumeId: "bad" }, { assetId: "bad" }, { assetDigest: " \t" }, { topologyRevision: -1 }, { topologyRevision: 1.5 },
    { topologyRevision: Number.MAX_SAFE_INTEGER }, { topologyRevision: Number.MAX_SAFE_INTEGER + 2 }, { triangleCount: -1 }, { triangleCount: 0.5 }])
    execute(replaceMesh({ ...guard(), ...bad }, result));
  execute(replaceMesh(guard(), withDescriptor(result, d => (d.digest = " "))));
  execute(replaceMesh(guard(), encodeIndexedMeshAsset({ id: "import:asset:empty", positions: [] })));
  execute(replaceMesh(guard(), withMeshDescriptor(result, m => (m.triangleCount = 3))));
  execute(replaceMesh(guard(), withDescriptor(fixture.asset, () => {})));
  for (const stale of [{ volumeId: "import:volume:missing" }, { assetId: "import:asset:other" }, { topologyRevision: 1 }, { triangleCount: 2 }, { assetDigest: "fnv1a64:0000000000000000" }])
    execute(replaceMesh({ ...guard(), ...stale }, result));
  execute(replaceMesh(guard(), mesh("import:asset:repository-held", 13)));
  execute(replaceMesh(guard(), withDescriptor(fixture.asset, d => (d.id = "import:asset:fixture-copy"))));
  execute(replaceMesh(guard(), withDescriptor(mesh("import:asset:repository-held", 13), d => (d.id = "import:asset:repository-copy"))));
  run({ kind: "selection", refs: [{ kind: "volume", id: units(ids.volume) }] });
  execute(replaceMesh(guard(), result));
  run({ kind: "undo" }); run({ kind: "redo" });
  // The sharing volume now holds the last reference; replacing it drops the old mesh.
  const second = mesh("import:asset:replaced-again", 22);
  execute(replaceMesh(topologyGuard(state(), "import:volume:sharing"), second));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (let i = 0; i < 2; i++) run({ kind: "undo" });
  for (let i = 0; i < 2; i++) run({ kind: "redo" });
  execute(replaceMesh(topologyGuard(state(), ids.volume), mesh("import:asset:third", 23)));
  run({ kind: "undo" });
});

/** Target object (fixture) plus an object with two meshes declared after it,
 * and an object with two instances. */
function booleanFixture(s, f, extra) {
  const object = s.plates[0].objects[0], first = mesh("import:asset:other-a", 31), second = mesh("import:asset:other-b", 32);
  s.sourceAssets.push(first.descriptor, second.descriptor);
  extra.push(first, second);
  const part = (id, asset) => ({ ...volumeFor(id, asset), annotations: { ...object.volumes[0].annotations, color: [] } });
  s.plates[0].objects.push({ ...objectFor("other", first), volumes: [part("import:volume:other-a", first), part("import:volume:other-b", second)] });
  s.plates[0].objects.push({ ...objectFor("twins", first), instances: [0, 1, 2].map(i => ({ id: `import:instance:twin-${i}`, transform: { translationMm: [i * 30, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, printable: i !== 1 })) });
  object.volumes[0].transform = { translationMm: [1, 2, 3], rotation: [0, 0, 0.5, 0.5], scale: [2, 2, 2] };
  object.instances[0].transform = { translationMm: [50, 60, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}
const booleanGuard = (state, targetInstanceId, otherInstanceId) => {
  const object = state.plates.flatMap(p => p.objects).find(o => o.instances.some(i => i.id === targetInstanceId));
  const volume = object.volumes[0], descriptor = state.sourceAssets.find(a => a.id === volume.source.assetId);
  return { targetInstanceId, targetVolumeId: volume.id, targetAssetId: volume.source.assetId, targetAssetDigest: descriptor.digest,
    targetTopologyRevision: volume.source.topologyRevision, targetTriangleCount: volume.source.triangleCount, otherInstanceId };
};
scenario("mesh-boolean", {}, booleanFixture, ({ execute, run, state, ids }) => {
  const guard = (other = "import:instance:other") => booleanGuard(state(), ids.instance, other);
  const result = mesh("import:asset:boolean", 41);
  run({ kind: "selection", refs: [{ kind: "instance", id: units("import:instance:other") }, { kind: "volume", id: units(ids.volume) }] });
  execute(meshBoolean({ ...guard(), otherInstanceId: ids.instance }, result));
  for (const bad of [{ targetInstanceId: "bad" }, { targetVolumeId: "bad" }, { targetAssetId: "bad" }, { otherInstanceId: "bad" }, { targetAssetDigest: "" },
    { targetTopologyRevision: -1 }, { targetTriangleCount: 2.5 }])
    execute(meshBoolean({ ...guard(), ...bad }, result));
  execute(meshBoolean(guard(), withDescriptor(result, d => (d.id = guard().targetAssetId))));
  for (const stale of [{ targetInstanceId: "import:instance:missing" }, { targetVolumeId: "import:volume:missing" }, { targetAssetId: "import:asset:other-a" },
    { targetTopologyRevision: 4 }, { targetTriangleCount: 9 }, { targetAssetDigest: "fnv1a64:0000000000000000" }, { otherInstanceId: "import:instance:missing" }])
    execute(meshBoolean({ ...guard(), ...stale }, result));
  execute(meshBoolean(guard(), mesh("import:asset:other-a", 31)));
  execute(meshBoolean(guard(), withDescriptor(mesh("import:asset:other-b", 32), d => (d.id = "import:asset:other-b-copy"))));
  // The other object goes with both of its meshes; undo restores their order.
  execute(meshBoolean(guard(), result, "UNION"));
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" });
  // One of three instances goes; undo puts it back in place.
  execute(meshBoolean(guard("import:instance:twin-1"), mesh("import:asset:boolean-twin", 42), "A_NOT_B"));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(meshBoolean(booleanGuard(state(), "import:instance:twin-0", "import:instance:twin-2"), mesh("import:asset:boolean-pair", 43), "INTERSECTION"));
  run({ kind: "undo" }); run({ kind: "undo" });
});
scenario("mesh-boolean-shared-target-mesh", {}, (s, f, extra) => {
  booleanFixture(s, f, extra);
  // The other object also uses the target's mesh: it is dropped with the target's.
  s.plates[0].objects[1].volumes[1].source = cloneJson(s.plates[0].objects[0].volumes[0].source);
  s.plates[0].objects[1].volumes[1].annotations = { ...s.plates[0].objects[1].volumes[1].annotations, topologyRevision: 0 };
}, ({ execute, run, state, ids }) => {
  execute(meshBoolean(booleanGuard(state(), ids.instance, "import:instance:other"), mesh("import:asset:boolean-shared", 44)));
  run({ kind: "undo" }); run({ kind: "redo" });
});

// Split to parts / split to objects, from the browser's own preparation.
const tetraPositions = (x, y, z, size) => [x, y, z, x + size, y, z, x, y + size, z, x, y, z + size];
const tetraIndices = base => [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3].map(i => i + base);
/** Three shared-edge components; the first two are congruent, so preparation
 * gives them one asset. */
const splitSourceMesh = id => encodeIndexedMeshAsset({ id, positions: [...tetraPositions(0, 0, 0, 10), ...tetraPositions(30, 0, 0, 10), ...tetraPositions(0, 30, 0, 6)],
  indices: [...tetraIndices(0), ...tetraIndices(4), ...tetraIndices(8)] });
/** A tetrahedron plus a lone triangle: one component is below three facets. */
const lonerMesh = id => encodeIndexedMeshAsset({ id, positions: [...tetraPositions(0, 0, 0, 10), 40, 0, 0, 50, 0, 0, 40, 10, 0], indices: [...tetraIndices(0), 4, 5, 6] });
function prepareSplit(state, repository, volumeId, prefix) {
  const guard = captureVolumeSplitGuard(state, volumeId);
  const volume = state.plates.flatMap(p => p.objects).flatMap(o => o.volumes).find(v => v.id === volumeId);
  const assetIds = new Map();
  const parts = prepareVolumeSplitParts({ sourceAsset: repository.get(volume.source.assetId), sourceTransform: volume.transform,
    idsForPart: ({ partIndex, geometryDigest }) => {
      if (!assetIds.has(geometryDigest)) assetIds.set(geometryDigest, `import:asset:${prefix}-${assetIds.size}`);
      return { volumeId: `import:volume:${prefix}-${partIndex}`, assetId: assetIds.get(geometryDigest) };
    } });
  return { guard, parts };
}
const splitParts = (guard, parts) => ({ kind: "splitVolumeToParts", guard: guardTo(guard), parts: partsTo(parts) });
const splitToObjects = (guard, parts, identities) => ({ kind: "splitToObjects", guard: guardTo(guard), parts: partsTo(parts), identities: identitiesTo(identities) });
const reId = (p, id) => withDescriptor(p, d => (d.id = id));
function splitFixture(s, f, extra) {
  f.asset = splitSourceMesh(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const volume = s.plates[0].objects[0].volumes[0];
  volume.source.triangleCount = 12;
  volume.transform = { translationMm: [5, 5, 0], rotation: [0, 0, 0.6, 0.8], scale: [1, 2, 1] };
  volume.extensionData = { "orcaxr:kept": { source: "body" } };
  // A declared payload and a repository-only payload for collision checks.
  const declared = mesh("import:asset:declared-extra", 61), stored = mesh("import:asset:repository-extra", 62);
  s.sourceAssets.push(declared.descriptor);
  extra.push(declared, stored);
}
scenario("split-volume-to-parts", {}, splitFixture, ({ execute, run, intent, state, repository, ids }) => {
  run({ kind: "selection", refs: [{ kind: "instance", id: units(ids.instance) }, { kind: "volume", id: units(ids.volume) }] });
  const { guard, parts } = prepareSplit(state(), repository, ids.volume, "part");
  assert.equal(parts.length, 3);
  assert.equal(parts[0].asset.descriptor.id, parts[1].asset.descriptor.id);
  const editPart = (index, change) => parts.map((p, i) => (i === index ? change({ ...p, asset: payload(wirePayload(p.asset)) }) : p));
  for (const bad of [{ volumeId: "bad" }, { assetId: "bad" }, { assetDigest: " " }, { volumeFingerprint: "" }, { topologyRevision: -1 }, { triangleCount: 0 }])
    execute(splitParts({ ...guard, ...bad }, parts));
  for (const bad of [parts.slice(0, 1), editPart(0, p => ({ ...p, volumeId: "bad" })), editPart(0, p => ({ ...p, volumeId: ids.volume })), editPart(1, p => ({ ...p, volumeId: parts[0].volumeId })),
    editPart(2, p => ({ ...p, transform: { ...p.transform, scale: [1, 0, 1] } })), editPart(2, p => ({ ...p, transform: { ...p.transform, rotation: [0, 0, 0, 1e-7] } })),
    editPart(2, p => ({ ...p, asset: reId(p.asset, ids.asset) })), editPart(2, p => ({ ...p, asset: withDescriptor(p.asset, d => (d.digest = " ")) })),
    editPart(2, p => ({ ...p, asset: encodeIndexedMeshAsset({ id: "import:asset:empty-part", positions: [] }) })), editPart(2, p => ({ ...p, sourceTriangleIndices: p.sourceTriangleIndices.slice(1) })),
    editPart(2, p => ({ ...p, sourceTriangleIndices: [...p.sourceTriangleIndices.slice(1), 12] })), editPart(2, p => ({ ...p, sourceTriangleIndices: [...p.sourceTriangleIndices.slice(1), 1.5] })),
    editPart(2, p => ({ ...p, sourceTriangleIndices: [...p.sourceTriangleIndices.slice(1), parts[0].sourceTriangleIndices[0]] })),
    editPart(1, p => ({ ...p, asset: reId(parts[2].asset, parts[0].asset.descriptor.id) })), editPart(1, p => ({ ...p, asset: reId(p.asset, "import:asset:part-twin") })),
    parts.slice(0, 2), editPart(2, p => ({ ...p, asset: reId(p.asset, parts[0].volumeId) }))])
    execute(splitParts(guard, bad));
  for (const stale of [{ volumeId: "import:volume:missing" }, { topologyRevision: 5 }, { assetDigest: "fnv1a64:0000000000000000" }])
    execute(splitParts({ ...guard, ...stale }, parts));
  intent({ renameVolume: { volumeId: units(ids.volume), name: units("Renamed") } });
  execute(splitParts(guard, parts));
  run({ kind: "undo" });
  for (const bad of [editPart(2, p => ({ ...p, volumeId: ids.object })), editPart(2, p => ({ ...p, asset: reId(p.asset, "import:asset:repository-extra") })),
    editPart(2, p => ({ ...p, asset: reId(p.asset, "import:asset:declared-extra") })), editPart(2, p => ({ ...p, asset: reId(p.asset, ids.instance) })),
    editPart(2, p => ({ ...p, asset: reId(mesh("import:asset:declared-twin", 61), p.asset.descriptor.id) })),
    editPart(2, p => ({ ...p, asset: reId(mesh("import:asset:repository-twin", 62), p.asset.descriptor.id) })),
    editPart(2, p => ({ ...p, sourceTriangleIndices: [...p.sourceTriangleIndices.slice(1), -1] }))])
    execute(splitParts(guard, bad));
  roundtrip(execute, run, splitParts(guard, parts));
  execute(splitParts(guard, parts));
  run({ kind: "undo" }); run({ kind: "redo" });
});
scenario("split-volume-to-parts-shared-source", {}, (s, f, extra) => {
  splitFixture(s, f, extra);
  // A second volume keeps the source mesh, and the third part's mesh is
  // already declared: the split owns only the shared congruent mesh.
  const object = s.plates[0].objects[0];
  object.volumes.push({ ...cloneJson(object.volumes[0]), id: "import:volume:keeper", name: "Keeper", extensionData: { [CORE_FACET_ATTRIBUTES]: { opaque: true } } });
  const probe = createProjectFixture(), store = new InMemoryAssetRepository(), probeExtra = [];
  splitFixture(probe.state, probe, probeExtra);
  store.put(probe.asset.descriptor, probe.asset.bytes);
  const third = prepareSplit(probe.state, store, probe.ids.volume, "part").parts[2].asset;
  s.sourceAssets.push(third.descriptor);
  extra.push(third);
}, ({ execute, run, state, repository, ids }) => {
  execute(splitParts(...Object.values(prepareSplit(state(), repository, "import:volume:keeper", "keeper"))));
  const { guard, parts } = prepareSplit(state(), repository, ids.volume, "part");
  roundtrip(execute, run, splitParts(guard, parts));
  execute(splitParts(guard, parts));
});
scenario("split-volume-to-objects", {}, (s, f, extra) => {
  splitFixture(s, f, extra);
  const object = s.plates[0].objects[0];
  object.layerRanges = [];
  object.instances.push({ ...cloneJson(object.instances[0]), id: "import:instance:second", transform: { translationMm: [80, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const loner = lonerMesh("import:asset:loner");
  s.sourceAssets.push(loner.descriptor);
  extra.push(loner);
  s.plates[0].objects.push({ ...objectFor("loner", loner), volumes: [{ ...volumeFor("import:volume:loner", loner), annotations: { ...object.volumes[0].annotations, color: [] } }] });
  s.plates[0].objects.push({ ...objectFor("pair", f.asset), volumes: ["a", "b"].map(k => ({ ...volumeFor(`import:volume:pair-${k}`, f.asset), annotations: { ...object.volumes[0].annotations, color: [] } })) });
}, ({ run, state, repository, ids }) => {
  const objectsOf = (prefix, n, instances) => Array.from({ length: n }, (_, i) => ({ sourceVolumeId: `import:volume:${prefix}-${i}`, objectId: `import:object:${prefix}-out-${i}`,
    instanceIds: instances.map((_, j) => `import:instance:${prefix}-out-${i}-${j}`) }));
  const source = state().plates[0].objects[0];
  run({ kind: "selection", refs: [{ kind: "object", id: units(ids.object) }, { kind: "instance", id: units("import:instance:second") }] });
  const { guard, parts } = prepareSplit(state(), repository, ids.volume, "part");
  const identities = objectsOf("part", 3, source.instances);
  run(splitToObjects({ ...guard, volumeId: "import:volume:missing" }, parts, identities));
  const pair = prepareSplit(state(), repository, "import:volume:pair-a", "pair");
  run(splitToObjects(pair.guard, pair.parts, objectsOf("pair", 3, [0])));
  const loner = prepareSplit(state(), repository, "import:volume:loner", "loner");
  run(splitToObjects(loner.guard, loner.parts, objectsOf("loner", 2, [0])));
  run(splitToObjects(guard, [parts[0], { ...parts[1], volumeId: parts[0].volumeId }, parts[2]], identities));
  run(splitToObjects(guard, parts, identities.slice(0, 2)));
  run(splitToObjects(guard, parts, identities.map((identity, i) => (i === 1 ? { ...identity, objectId: ids.object } : identity))));
  run(splitToObjects(guard, parts, identities));
  assert.equal(state().plates[0].objects.length, 5);
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" });
});

// SVG parts and embossed text, cut by the browser's own preparation.
const SQUARE_GLYPH = { advance: 1000, contours: [{ points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }] };
const squareFont = { unitsPerEm: 1000, outline: () => SQUARE_GLYPH };
const recipe = (text, o = {}) => ({ text, styleName: "Fixture", fontDescriptor: "fixture.ttf", fontDescriptorType: "file_name", font: DEFAULT_EMBOSS_FONT_PROPERTY,
  projection: { depthMm: 2, useSurface: false }, ...o });
const SVG = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}"/><circle cx="2" cy="2" r="1"/></svg>`;
const placementTo = p => ({ objectId: units(p.objectId), volumeId: units(p.volumeId), assetId: units(p.assetId), transformJson: canonicalStringify(p.transform) });
const placementFrom = p => ({ objectId: string(p.objectId), volumeId: string(p.volumeId), assetId: string(p.assetId), transform: JSON.parse(p.transformJson) });
const cutSvg = (suffix, o = {}) => prepareSvgPart(o.source ?? SVG(20, 10), { fileName: o.fileName ?? `${suffix}.svg`, volumeId: `import:volume:${suffix}`, assetId: o.assetId ?? `import:asset:${suffix}`,
  drawingAssetId: o.drawingAssetId ?? `import:asset:${suffix}-drawing`, depthMm: o.depthMm ?? 2, ...(o.widthMm ? { widthMm: o.widthMm } : {}) });
const addSvg = (placement, prepared, name) => ({ kind: "addSvgPart", placement: placementTo(placement), asset: wirePayload(prepared.asset), drawing: wirePayload(prepared.drawing),
  triangleCount: prepared.mesh.triangleCount, partJson: canonicalStringify(prepared.part), name: units(name) });
const editSvg = (volumeId, prepared) => ({ kind: "editSvgPart", volumeId: units(volumeId), asset: wirePayload(prepared.asset), drawing: wirePayload(prepared.drawing),
  triangleCount: prepared.mesh.triangleCount, partJson: canonicalStringify(prepared.part) });
const addText = (placement, configuration, prepared) => ({ kind: "addEmbossText", placement: placementTo(placement), configurationJson: canonicalStringify(configuration),
  asset: wirePayload(prepared.asset), triangleCount: prepared.mesh.triangleCount });
const editText = (volumeId, configuration, prepared) => ({ kind: "editEmbossText", volumeId: units(volumeId), configurationJson: canonicalStringify(configuration),
  asset: wirePayload(prepared.asset), triangleCount: prepared.mesh.triangleCount });
const placed = (objectId, suffix, assetId = `import:asset:${suffix}`) => ({ objectId, volumeId: `import:volume:${suffix}`, assetId, transform: { translationMm: [0, 0, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });

scenario("svg-parts", {}, (s, f, extra) => {
  extra.push(mesh("import:asset:svg-conflict", 71));
}, ({ execute, run, ids }) => {
  const logo = cutSvg("logo");
  roundtrip(execute, run, addSvg(placed(ids.object, "logo"), logo, "  Logo  "));
  execute(addSvg(placed(ids.object, "logo"), logo, " \n "));
  execute(addSvg(placed(ids.object, "mismatch"), cutSvg("mismatch-cut"), "Mismatch"));
  execute(addSvg(placed("import:object:missing", "orphan"), cutSvg("orphan"), "Orphan"));
  execute(addSvg(placed(ids.object, "logo"), cutSvg("logo"), "Again"));
  execute(addSvg(placed(ids.object, "reused", ids.asset), cutSvg("reused", { assetId: ids.asset }), "Reused"));
  execute(addSvg(placed(ids.object, "conflict", "import:asset:svg-conflict"), cutSvg("conflict", { assetId: "import:asset:svg-conflict" }), "Conflict"));
  const wider = cutSvg("logo", { assetId: "import:asset:logo-wide", widthMm: 40, depthMm: 3 });
  roundtrip(execute, run, editSvg("import:volume:logo", wider));
  execute(editSvg("import:volume:logo", wider));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(editSvg(ids.volume, wider));
  execute(editSvg("import:volume:missing", wider));
  // A re-cut to a mesh another volume still uses keeps that mesh declared.
  execute(addSvg(placed(ids.object, "twin", "import:asset:twin-mesh"), cutSvg("twin", { assetId: "import:asset:twin-mesh", drawingAssetId: "import:asset:twin-drawing" }), "Twin"));
  execute(editSvg("import:volume:twin", cutSvg("logo", { assetId: "import:asset:logo-wide", widthMm: 40, depthMm: 3 })));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (let i = 0; i < 3; i++) run({ kind: "undo" });
});
scenario("emboss-text", {}, () => {}, ({ execute, run, ids }) => {
  const hello = recipe("  Hello world  \nsecond line");
  const cut = (configuration, assetId) => prepareEmbossedVolume(configuration, squareFont, assetId);
  roundtrip(execute, run, addText(placed(ids.object, "hello"), hello, cut(hello, "import:asset:hello")));
  execute(addText(placed(ids.object, "hello"), hello, cut(hello, "import:asset:hello")));
  const long = recipe("😀".repeat(40));
  execute(addText(placed(ids.object, "long"), long, cut(long, "import:asset:long")));
  const blank = recipe(" \nbody");
  execute(addText(placed(ids.object, "blank"), blank, cut(recipe("X"), "import:asset:blank")));
  execute(addText(placed(ids.object, "empty"), hello, { asset: mesh("import:asset:empty", 72), mesh: { triangleCount: 0 } }));
  execute(addText(placed(ids.object, "mismatch"), hello, cut(hello, "import:asset:other")));
  execute(addText(placed(ids.object, "duplicate", "import:asset:hello"), hello, cut(recipe("Dup"), "import:asset:hello")));
  execute(addText(placed("import:object:missing", "orphan"), hello, cut(hello, "import:asset:orphan")));
  const goodbye = recipe("Goodbye");
  roundtrip(execute, run, editText("import:volume:hello", goodbye, cut(goodbye, "import:asset:goodbye")));
  execute(editText("import:volume:hello", goodbye, cut(goodbye, "import:asset:goodbye")));
  execute(editText("import:volume:hello", goodbye, { asset: mesh("import:asset:none", 73), mesh: { triangleCount: 0 } }));
  execute(editText(ids.volume, goodbye, cut(goodbye, "import:asset:not-text")));
  execute(editText("import:volume:missing", goodbye, cut(goodbye, "import:asset:missing-text")));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (let i = 0; i < 4; i++) run({ kind: "undo" });
});

// Whole-project replacement: validated on apply, selection pruned both ways.
const replaceProject = (next, label = null) => ({ kind: "replaceProject", stateJson: canonicalStringify(next), label: label === null ? null : units(label) });
const replacedState = (state, edit) => { const next = cloneJson(state); edit(next); return next; };
scenario("replace-project", {}, () => {}, ({ execute, run, state, ids }) => {
  run({ kind: "selection", refs: [{ kind: "plate", id: units(ids.plate) }, { kind: "object", id: units(ids.object) }, { kind: "instance", id: units(ids.instance) }] });
  const emptied = replacedState(state(), next => { next.name = "Emptied\u0000\ud800"; next.plates[0].objects = []; next.config = { ...next.config, layer_height: 0.16 }; });
  roundtrip(execute, run, replaceProject(emptied));
  run({ kind: "redo" });
  execute(replaceProject(replacedState(state(), next => (next.activePlateId = "import:plate:missing"))));
  execute(replaceProject(replacedState(state(), next => (next.name = "Configured")), "Update project configuration"));
  run({ kind: "undo" }); run({ kind: "undo" });
  execute(replaceProject(state(), "Same project"));
  run({ kind: "undo" });
});

// Refined facet commits: dense per-facet roots collapsed into whole-facet
// assignments and split trees, checked against the live state first.
/** A shallow cone over a fan base: 48 facets to refine. */
const coneAsset = id => {
  const positions = [0, 0, 0], indices = [], segments = 24;
  for (let i = 0; i < segments; i += 1) positions.push(Math.cos(i / segments * Math.PI * 2) * 60, Math.sin(i / segments * Math.PI * 2) * 60, 0);
  positions.push(0, 0, 20);
  for (let i = 0; i < segments; i += 1) { const a = 1 + i, b = 1 + (i + 1) % segments; indices.push(0, b, a, a, b, segments + 1); }
  return encodeIndexedMeshAsset({ id, positions, indices });
};
const unpaintedLeaf = { kind: "leaf", state: { kind: "unpainted" } };
const paintLeaf = value => ({ kind: "leaf", state: { kind: "assigned", value } });
const splitNode = (children, splitSides = children.length - 1, specialSide = 0) => ({ kind: "split", splitSides, specialSide, children });
const refine = (guard, channel, roots, label = null) => ({ kind: "facetRefinement", guard: guardTo(guard), channel, rootsJson: JSON.stringify(roots), label: label === null ? null : units(label) });
scenario("facet-refinement", {}, (s, f) => {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const object = s.plates[0].objects[0], body = object.volumes[0];
  body.source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  body.annotations = { topologyRevision: 0, color: [{ value: f.ids.physical0, triangles: [1, 2] }], support: [], seam: [], fuzzySkin: [], brim: [] };
  object.volumes.push({ ...cloneJson(body), id: "import:volume:refine-modifier", name: "Modifier", role: "parameter-modifier", annotations: { ...body.annotations, color: [] } });
}, ({ run, snapshot, state, ids }) => {
  const guard = (volumeId = ids.volume) => {
    const volume = state().plates[0].objects[0].volumes.find(v => v.id === volumeId);
    return { revision: snapshot().revision, hash: snapshot().hash, volumeId, topologyRevision: volume.source.topologyRevision, triangleCount: volume.source.triangleCount };
  };
  const [p0, p1] = state().filaments.physical.map(p => p.id), mixed = state().filaments.mixed[0].id;
  const color = Array.from({ length: 48 }, (_, i) =>
    i % 3 === 0 ? paintLeaf(p0) : i % 3 === 1 ? splitNode([paintLeaf(p0), paintLeaf(mixed)]) : i === 2 ? splitNode([paintLeaf(p1), paintLeaf(p1), paintLeaf(p1)]) : unpaintedLeaf);
  run({ kind: "selection", refs: [{ kind: "volume", id: units(ids.volume) }] });
  run(refine({ ...guard(), revision: guard().revision + 1 }, "color", color));
  run(refine({ ...guard(), volumeId: "import:volume:missing" }, "color", color));
  run(refine({ ...guard(), topologyRevision: 5 }, "color", color));
  run(refine(guard("import:volume:refine-modifier"), "color", color));
  run(refine(guard(), "color", color.slice(1)));
  run(refine(guard(), "color", color.map((root, i) => (i === 4 ? splitNode([paintLeaf(p0), paintLeaf("import:filament:missing")]) : root))));
  run(refine(guard(), "color", color.map((root, i) => (i === 3 ? paintLeaf("import:filament:missing") : root))));
  run(refine(guard(), "color", color));
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" }); run({ kind: "redo" });
  run(refine(guard(), "color", color));
  run(refine(guard(), "seam", Array.from({ length: 48 }, (_, i) => (i < 8 ? splitNode([paintLeaf("prefer"), paintLeaf("avoid")], 1, 1) : i < 12 ? paintLeaf("avoid") : unpaintedLeaf)), "Refine seams"));
  run(refine(guard(), "support", Array.from({ length: 48 }, (_, i) => (i % 2 ? paintLeaf("enforce") : splitNode([paintLeaf("block"), unpaintedLeaf, unpaintedLeaf, paintLeaf("block")], 3, 0)))));
  run(refine(guard(), "brim", Array.from({ length: 48 }, (_, i) => (i < 6 ? paintLeaf(i % 2 === 0) : unpaintedLeaf))));
  run(refine(guard(), "fuzzySkin", Array.from({ length: 48 }, (_, i) => (i < 3 ? paintLeaf(true) : i === 3 ? paintLeaf(false) : unpaintedLeaf))));
  run(refine(guard(), "color", Array.from({ length: 48 }, () => unpaintedLeaf)));
  for (let i = 0; i < 4; i++) run({ kind: "undo" });
});

// History charges the canonical record plus the payload bytes; a following
// rename moves each across the boundary.
const probe = createProjectFixture();
const probeAsset = mesh("import:asset:retained");
const probeObject = objectFor("retained", probeAsset), probeVolume = volumeFor("import:volume:retained-part", probeAsset);
const objectBytes = prepare(addObjectWithAsset(probe.ids.plate, probeObject, probeAsset)).estimateBytes();
const volumeBytes = prepare(addVolume(probe.ids.object, probeVolume, probeAsset)).estimateBytes();
assert.equal(objectBytes, canonicalStringify(probeObject).length + probeAsset.bytes.length);
const probeRun = (fixture, command) => {
  const project = new ProjectStore(fixture.state), assets = new InMemoryAssetRepository();
  for (const p of [fixture.asset, ...(fixture.extra ?? [])]) assets.put(p.descriptor, p.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets }), prepared = prepare(command(fixture.ids, project.getSnapshot().state));
  bus.execute(prepared);
  return prepared.estimateBytes();
};
const booleanProbe = createProjectFixture(); booleanProbe.extra = []; booleanFixture(booleanProbe.state, booleanProbe, booleanProbe.extra);
const replaceCommand = (ids, state) => replaceMesh(topologyGuard(state, ids.volume), mesh("import:asset:retained-mesh", 51));
const booleanCommand = (ids, state) => meshBoolean(booleanGuard(state, ids.instance, "import:instance:other"), mesh("import:asset:retained-boolean", 52));
const replaceBytes = probeRun(createProjectFixture(), replaceCommand), booleanBytes = probeRun(booleanProbe, booleanCommand);
const splitProbe = createProjectFixture(); splitProbe.extra = []; splitFixture(splitProbe.state, splitProbe, splitProbe.extra);
const splitCommand = (ids, state) => {
  const store = new InMemoryAssetRepository();
  for (const p of [splitProbe.asset, ...splitProbe.extra]) store.put(p.descriptor, p.bytes);
  const { guard, parts } = prepareSplit(state, store, ids.volume, "part");
  return splitParts(guard, parts);
};
const splitBytes = probeRun(splitProbe, splitCommand);
// Whole-project import: the next project and its complete asset set as one
// entry; selection cleared; a duplicate asset, or one the state declares but
// the set lacks, is refused before anything changes.
const importProject = (next, assets, label = "Import next.3mf") => ({ kind: "importProject", stateJson: canonicalStringify(next), assets: assets.map(wirePayload), label: units(label) });
scenario("import-project", {}, () => {}, ({ execute, run, state, ids }) => {
  run({ kind: "selection", refs: [{ kind: "object", id: units(ids.object) }] });
  const fresh = mesh("import:asset:imported", 12);
  const imported = replacedState(state(), next => {
    next.name = "Imported\u0000\ud800";
    next.sourceAssets = [fresh.descriptor];
    next.plates[0].objects = next.plates[0].objects.map(object => ({
      ...object,
      volumes: object.volumes.map(volume => ({ ...volume, source: { ...volume.source, assetId: fresh.descriptor.id, triangleCount: 4 }, annotations: { ...volume.annotations, color: [] } })),
    }));
  });
  roundtrip(execute, run, importProject(imported, [fresh]));
  run({ kind: "redo" });
  // The same import again is a fresh entry, not a no-op.
  execute(importProject(imported, [fresh], "Import again.3mf"));
  // Refused, changing nothing.
  execute(importProject(imported, [fresh, fresh], "Import duplicate.3mf"));
  execute(importProject(imported, [], "Import missing.3mf"));
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" });
});
const replaceProjectCommand = (ids, state) => replaceProject(replacedState(state, next => (next.name = "Retained replacement")));
const replaceProjectBytes = probeRun(createProjectFixture(), replaceProjectCommand);
for (const [label, bytes, command, mutate] of [["object", objectBytes, ids => addObjectWithAsset(ids.plate, probeObject, probeAsset)], ["volume", volumeBytes, ids => addVolume(ids.object, probeVolume, probeAsset)],
  ["replace", replaceBytes, (ids, state) => replaceCommand(ids, state)], ["boolean", booleanBytes, (ids, state) => booleanCommand(ids, state), booleanFixture],
  ["split", splitBytes, (ids, state) => splitCommand(ids, state), splitFixture], ["project", replaceProjectBytes, (ids, state) => replaceProjectCommand(ids, state)]])
  for (const delta of [0, -1])
    scenario(`asset-retention-${label}-${delta}`, { maxEstimatedBytes: bytes + 1 + delta }, mutate ?? (() => {}), ({ execute, intent, run, ids, state }) => {
      execute(command(ids, state()));
      intent({ renamePlate: { plateId: units(ids.plate), name: units("Following") } });
      run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "redo" });
    });

const sources = ["tools/cross-platform/project-asset-command-vectors.mjs", "web/src/project/commands.ts", "web/src/project/objects/semanticVolumeCommands.ts",
  "web/src/project/objects/topologyCommands.ts", "web/src/project/objects/meshBooleanCommands.ts", "web/src/project/objects/splitCommands.ts",
  "web/src/project/objects/splitPreparation.ts", "web/src/project/objects/splitToObjectsCommands.ts", "web/src/project/objects/svgCommands.ts",
  "web/src/project/objects/embossCommands.ts", "web/src/project/objects/emboss.ts", "web/src/project/annotations/FacetAnnotationStrokeCommand.ts",
  "web/src/project/domain/facetRefinement.ts", "web/src/project/PreparedProjectCommands.ts",
  "web/src/project/history/command.ts", "web/src/project/history/commandBus.ts", "web/src/project/store.ts", "web/src/project/selection.ts", "web/src/project/assets.ts", "web/src/project/meshCodec.ts",
  "web/src/project/domain/canonical.ts", "web/src/project/domain/model.ts", "web/src/project/domain/ids.ts", "web/src/project/domain/validation.ts", "web/src/project/__tests__/fixtures.ts"];
const output = JSON.stringify({ schemaVersion: 1, sources: sources.map(path => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })), contents, traces }, null, 2) + "\n";
const path = new URL("testdata/cross-platform/project-asset-command-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Asset command reference drift");
console.log(`Asset command references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} complete contents`);
