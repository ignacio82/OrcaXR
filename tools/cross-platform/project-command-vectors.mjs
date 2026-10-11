// Independent command/history authority: execute the production TypeScript bus
// and prepared commands. Never consume Rust output as expected behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ProjectStore } from "../../web/src/project/store.ts";
import { SelectionStore } from "../../web/src/project/selection.ts";
import { CommandBus } from "../../web/src/project/history/commandBus.ts";
import { prepareProjectIntent, prepareProjectBatch } from "../../web/src/project/PreparedProjectCommands.ts";
import { InMemoryAssetRepository, assetBundleFingerprint } from "../../web/src/project/assets.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { canonicalStringify, cloneJson } from "../../web/src/project/domain/canonical.ts";
import { encodeIndexedMeshAsset } from "../../web/src/project/meshCodec.ts";
import { createFullSpectrumMixedFilament } from "../../web/src/project/filaments/fullSpectrumRecipe.ts";
process.env.TZ = "UTC";
const root = new URL("../../", import.meta.url);
const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const read = p => readFileSync(new URL(p, root), "utf8");
const contents = [], traces = [];
const ref = r => r.kind === "project" ? r : { kind: r.kind, id: units(r.id) };
const refs = s => ({ refs: s.refs.map(ref), primary: s.primary ? ref(s.primary) : null });
const history = h => ({ ...h, undoLabel: h.undoLabel === undefined ? null : units(h.undoLabel), redoLabel: h.redoLabel === undefined ? null : units(h.redoLabel) });
function snapshot(s) {
  const text = canonicalStringify(s.state);
  let content = contents.indexOf(text);
  if (content < 0) { content = contents.length; contents.push(text); }
  return { revision: s.revision, hash: s.hash, content };
}
const add = (id, name = "New", order = 1, activate = true) => ({ addPlate: { plateId: units(id), name: units(name), order, activate } });
const rename = (id, name) => ({ renamePlate: { plateId: units(id), name: units(name) } });
const activate = id => ({ activatePlate: { plateId: units(id) } });
const del = id => ({ deletePlate: { plateId: units(id) } });
const printable = (id, value) => ({ setPlatePrintable: { plateId: units(id), printable: value } });
const reorder = ids => ({ reorderPlates: { plateIds: ids.map(units) } });
function duplicate(state, sourceId, suffix) {
  const p = state.plates.find(p => p.id === sourceId);
  return { duplicatePlate: {
    sourcePlateId: units(sourceId), plateId: units(`import:duplicate:${suffix}`),
    objects: p.objects.map((o, i) => ({ objectId: units(`import:object:${suffix}-${i}`), volumeIds: o.volumes.map((_, j) => units(`import:volume:${suffix}-${i}-${j}`)), instanceIds: o.instances.map((_, j) => units(`import:instance:${suffix}-${i}-${j}`)), layerRangeIds: o.layerRanges.map((_, j) => units(`import:range:${suffix}-${i}-${j}`)) })),
    customGcodeIds: state.customGcode.filter(c => c.scope === "plate" && c.plateId === sourceId).map((_, i) => units(`import:gcode:${suffix}-${i}`)),
    thumbnailIds: state.thumbnails.filter(t => t.plateId === sourceId).map((_, i) => units(`import:thumbnail:${suffix}-${i}`)),
  } };
}
function scenario(name, options, mutate, work) {
  const f = createProjectFixture(); mutate(f.state, f);
  const project = new ProjectStore(f.state), selection = new SelectionStore(), assets = new InMemoryAssetRepository();
  assets.put(f.asset.descriptor, f.asset.bytes);
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
        case "intent": bus.execute(prepareProjectIntent(JSON.parse(operation.json)), { coalesce: operation.coalesce }); break;
        case "batch": { const p = prepareProjectBatch(JSON.parse(operation.json)); bus.transaction(p.label, () => { for (const c of p.commands) bus.execute(c); }); break; }
        case "undo": result = bus.undo(); break;
        case "redo": result = bus.redo(); break;
        case "checkpoint": bus.markCheckpoint(); break;
        case "clear": bus.clearHistory({ markCheckpoint: operation.mark }); break;
        case "selection": selection.set(operation.refs.map(r => ({ ...r, ...(r.id ? { id: String.fromCharCode(...r.id) } : {}) }))); break;
        default: throw new Error("unknown operation");
      }
    } catch (e) { error = units(e.message); }
    const after = observe();
    steps.push({ operation, result, error, effects: [...effects], ...after });
    for (const [s, expected] of retained) assert.equal(canonicalStringify(s.state), expected);
  }
  const execute = (c, coalesce = true) => run({ kind: "intent", json: JSON.stringify({ version: 1, command: c }), coalesce });
  const batch = (commands, label = "Plate transaction") => run({ kind: "batch", json: JSON.stringify({ version: 1, label: units(label), commands }) });
  work({ execute, batch, run, state: () => project.getSnapshot().state, snapshot: () => project.getSnapshot(), ids: f.ids });
  traces.push({ name, options, stateJson: canonicalStringify(f.state), asset: { descriptorJson: canonicalStringify(f.asset.descriptor), bytes: [...f.asset.bytes] }, initial, steps });
}
const noop = () => {};
scenario("lifecycle-unicode-and-failures", {}, s => {
  const p = s.plates[0]; p.name = 'Name\\"\u0000\ud800😀';
  p.foreign = JSON.parse('{"__proto__":{"opaque":"\\udfff"},"2":2,"10":10}');
  p.objects[0].foreign = { retained: [0, false, "😀"] };
  p.objects[0].volumes[0].annotations.foreign = { retained: "paint" };
  s.customGcode = [
    { id: "import:gcode:global", scope: "project", trigger: "before-plate", code: "M400" },
    { id: "import:gcode:a", scope: "plate", plateId: p.id, trigger: "before-plate", code: "M400\n;\ud800", foreign: { opaque: true } },
    { id: "import:gcode:middle", scope: "project", trigger: "after-plate", code: "; middle" },
    { id: "import:gcode:b", scope: "plate", plateId: p.id, trigger: "after-plate", code: "; tail" },
  ];
  s.thumbnails = [{ id: "import:thumbnail:a", plateId: p.id, assetId: s.sourceAssets[0].id, width: 1, height: 1, foreign: "preserve" }];
}, ({ execute, batch, run, state, ids }) => {
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "checkpoint" }); run({ kind: "checkpoint" });
  execute(activate(ids.plate)); execute(rename(ids.plate, state().plates[0].name)); execute(printable(ids.plate, true)); execute(reorder([ids.plate]));
  execute(rename(ids.plate, "\ufeff \n")); execute(reorder([ids.plate, ids.plate])); execute(rename("bad", "name"));
  execute(del("import:missing:plate"));
  for (const c of [rename("import:missing:plate", "new"), printable("import:missing:plate", false), activate("import:missing:plate"), reorder(["import:missing:plate"])]) execute(c);
  execute(add(ids.plate)); execute(add(ids.object));
  const p2 = "import:plate:\u0000\ud800";
  execute(add(p2, "😀 second", 4, false)); execute(reorder([ids.plate]));
  run({ kind: "selection", refs: [{ kind: "object", id: units(ids.object) }, { kind: "plate", id: units(p2) }] });
  execute(activate(p2)); execute(rename(p2, "\u0085")); execute(printable(p2, false));
  run({ kind: "checkpoint" }); run({ kind: "undo" }); run({ kind: "redo" });
  execute(reorder([p2, ids.plate])); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" });
  execute(duplicate(state(), ids.plate, "ok"));
  run({ kind: "undo" }); run({ kind: "redo" }); execute(del("import:duplicate:ok")); run({ kind: "undo" });
  const plan = duplicate(state(), ids.plate, "bad");
  for (const mutate of [p => p.objects.pop(), p => p.objects[0].volumeIds.pop(), p => p.objects[0].instanceIds.pop(), p => p.objects[0].layerRangeIds.pop(), p => p.customGcodeIds.pop(), p => p.thumbnailIds.pop(), p => p.objects[0].objectId = p.plateId, p => p.plateId = units(ids.project), p => p.customGcodeIds[0] = units(ids.asset), p => p.thumbnailIds[0] = units(ids.physical0)]) {
    const changed = cloneJson(plan); mutate(changed.duplicatePlate); execute(changed);
  }
  batch([]); batch([activate(state().activePlateId)]);
  batch([rename(p2, "atomic😀"), printable(p2, true), activate(p2)], "Unicode transaction\ud800");
  run({ kind: "undo" }); run({ kind: "redo" });
  batch([rename(p2, "must roll back"), activate("import:missing:plate")]);
  batch([rename(p2, "never applied"), rename(p2, " ")]);
  batch([], "\ufeff");
  run({ kind: "clear", mark: false }); run({ kind: "undo" }); run({ kind: "checkpoint" }); run({ kind: "clear", mark: true });
});
scenario("sparse-orders-and-blank-source", {}, s => { s.plates[0].order = 9; }, ({ execute, run, state, ids }) => {
  execute(duplicate(state(), ids.plate, "sparse")); execute(reorder([ids.plate]));
  execute(add("import:plate:blank", " \ufeff", 10)); execute(duplicate(state(), "import:plate:blank", "blank"));
  execute(reorder(["import:plate:blank", ids.plate])); run({ kind: "undo" });
  execute(duplicate(state(), ids.plate, "normalized")); run({ kind: "undo" }); run({ kind: "redo" });
});
scenario("plate-limit", {}, noop, ({ execute, run, state, ids }) => {
  for (let i = 1; i < 36; i++) execute(add(`import:plate:${i}`, `Plate ${i}`, i));
  execute(add("import:plate:overflow")); execute(duplicate(state(), ids.plate, "overflow"));
  execute(del("import:plate:35")); run({ kind: "undo" }); run({ kind: "redo" });
});
for (const options of [{ maxEntries: 2 }, { maxEstimatedBytes: 1 }, { maxEstimatedBytes: 6000 }, { maxEntries: 0, maxEstimatedBytes: 0 }]) {
  scenario(`retention-${JSON.stringify(options)}`, options, noop, ({ execute, run, state, ids }) => {
    execute(add("import:plate:retained")); execute(rename(ids.plate, "Renamed"));
    execute(duplicate(state(), ids.plate, "retained")); execute(del("import:duplicate:retained"));
    run({ kind: "checkpoint" }); for (let i = 0; i < 6; i++) run({ kind: "undo" }); for (let i = 0; i < 6; i++) run({ kind: "redo" });
    run({ kind: "clear", mark: false }); run({ kind: "checkpoint" });
  });
}
scenario("deterministic-mixed-trace", { maxEntries: 7, maxEstimatedBytes: 20000 }, noop, ({ execute, batch, run, state }) => {
  let seed = 0x11abc; const rand = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let i = 0; i < 240; i++) {
    const s = state(), p = s.plates[rand() % s.plates.length];
    switch (rand() % 12) {
      case 0: execute(add(`import:random:${i}`, `Random ${i}`, rand() % 20, !!(rand() % 2))); break;
      case 1: execute(rename(p.id, `Name ${i % 4}😀`)); break;
      case 2: execute(printable(p.id, !!(rand() % 2))); break;
      case 3: execute(activate(p.id)); break;
      case 4: execute(del(p.id)); break;
      case 5: execute(reorder([...s.plates].sort((a, b) => b.order - a.order).map(p => p.id))); break;
      case 6: execute(duplicate(s, p.id, `random-${i}`)); break;
      case 7: run({ kind: "undo" }); break;
      case 8: run({ kind: "redo" }); break;
      case 9: run({ kind: "checkpoint" }); break;
      case 10: batch([rename(p.id, `Batch ${i}`), activate(i % 2 ? "import:missing:plate" : p.id)]); break;
      case 11: run({ kind: "clear", mark: !!(rand() % 2) }); break;
    }
  }
});
// Qualify the exact UTF-16 retention boundary, including a nested canonical
// sourceFingerprint string with quotes, backslashes, NUL and lone surrogates.
const retentionState = s => { s.plates[0].name = 'Escaped\\\"\u0000\ud800😀'; };
const probeFixture = createProjectFixture(); retentionState(probeFixture.state);
const probeProject = new ProjectStore(probeFixture.state);
const probeBus = new CommandBus({ project: probeProject, selection: new SelectionStore(), assets: new InMemoryAssetRepository() });
const probeCommand = prepareProjectIntent({ version: 1, command: duplicate(probeFixture.state, probeFixture.ids.plate, "boundary") });
probeBus.execute(probeCommand);
const duplicateBytes = probeCommand.estimateBytes();
for (const delta of [-1, 0, 1]) {
  scenario(`exact-retention-${duplicateBytes + delta}`, { maxEstimatedBytes: duplicateBytes + delta }, retentionState, ({ execute, run, state, ids }) => {
    execute(duplicate(state(), ids.plate, "boundary"));
    execute(rename(ids.plate, "following change"));
    run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "redo" });
  });
}
const editName = (kind, id, name) => ({[`rename${kind}`]: {[`${kind.toLowerCase()}Id`]: units(id), name: units(name)}});
const transformAt = x => ({translationMm:[x, -2.5, 0],rotation:[0, 0, 0, 1],scale:[1, -1, 0.5]});
const transformOne = (id, x, gesture = 'default') => ({setInstanceTransform:{instanceId:units(id), transform:transformAt(x),gestureId:units(gesture)}});
const transformMany = (ids, x, gesture = 'gesture') => ({setInstanceTransforms:{changes:ids.map(id => ({instanceId:units(id),transform:transformAt(x)})),gestureId:units(gesture)}});
const instancePrintable = (id, value) => ({setInstancePrintable:{instanceId:units(id),printable:value}});
const editFixture = s => {
  const o = s.plates[0].objects[0];
  o.instances.push({...cloneJson(o.instances[0]),id:'import:instance:\u0000\ud800',name:''});
  o.instances[0].transform.foreign = {keptBySingle:true};
  o.instances[1].transform.foreign = {droppedByBatch:true};
  o.volumes[0].foreign = {data:'unchanged😀'};
};
scenario('object-names-printability-and-rollback', {}, editFixture, ({execute,batch,run,state,ids}) => {
  run({kind:'selection',refs:[{kind:'instance',id:units(ids.instance)},{kind:'volume',id:units(ids.volume)}]});
  for (const [kind,id] of [['Object',ids.object],['Volume',ids.volume],['Instance',ids.instance]]) {
    for (const name of ['', '\ufeff\n ', '\u0085', ' \u0000\udfff😀 ', ' trimmed ']) execute(editName(kind,id,name));
    execute(editName(kind,id,'trimmed'));
    run({kind:'undo'});run({kind:'redo'});run({kind:'checkpoint'});
    execute(editName(kind,'bad','new'));
    execute(editName(kind,'import:missing:entity','new'));
  }
  execute(editName('Instance','import:instance:\u0000\ud800','named'));
  run({kind:'undo'});run({kind:'redo'});
  execute(instancePrintable(ids.instance,true)); execute(instancePrintable(ids.instance,false));
  execute(instancePrintable(ids.instance,false));run({kind:'undo'});run({kind:'redo'});
  execute(instancePrintable('import:missing:instance',true));
  batch([editName('Object',ids.object,'rolled back'),editName('Volume','import:missing:volume','fail')],'Failed edits');
  batch([editName('Object',ids.object,'never applied'),editName('Instance',ids.instance,'\ufeff')]);
  batch([editName('Object',ids.object,'assembly'),editName('Volume',ids.volume,'part'),editName('Instance',ids.instance,'copy'),instancePrintable(ids.instance,true)],'Edit labels');
  run({kind:'undo'});run({kind:'redo'});
  execute(editName('Object',ids.object,'wide name '+ '😀'.repeat(1000)));
  run({kind:'undo'});
});
for (const single of [true,false]) {
  scenario(single ? 'single-transform-gestures' : 'batch-transform-gestures', {}, editFixture, ({execute,batch,run,state,ids}) => {
    const second='import:instance:\u0000\ud800';
    const edit=(x,g='gesture')=>single?transformOne(ids.instance,x,g):transformMany([ids.instance,second],x,g);
    execute(edit(1));execute(edit(2));execute(edit(2));execute(edit(3));
    run({kind:'undo'});run({kind:'redo'});run({kind:'checkpoint'});
    execute(edit(4));run({kind:'undo'});run({kind:'redo'});
    execute(edit(5,'separate'));execute(edit(6,'separate'),false);
    run({kind:'undo'});run({kind:'undo'});execute(edit(7,'separate'));run({kind:'redo'});
    const invalid=edit(8); (single?invalid.setInstanceTransform.transform:invalid.setInstanceTransforms.changes[0].transform).scale[0]=0;
    execute(invalid);run({kind:'undo'});run({kind:'redo'});
    execute(single?transformOne('import:missing:instance',9):transformMany([ids.instance,'import:missing:instance'],9));
    execute(edit(10,''));
    batch([edit(11),editName('Object','import:missing:object','fail')]);
    batch([edit(12),editName('Object',ids.object,'transformed')],'Transform and name');
    execute(edit(13));run({kind:'undo'});run({kind:'undo'});run({kind:'redo'});run({kind:'redo'});
    if (!single) {
      execute(transformMany([second,ids.instance],14));execute(transformMany([ids.instance,second],15));
      execute(transformMany([],1));execute(transformMany([ids.instance,ids.instance],1));
      execute(transformMany(['bad'],1));execute(transformMany([second],20));
      run({kind:'undo'});run({kind:'redo'});
    }
  });
}
// Legacy single-command keys use delimiters. Preserve their collision behavior
// until an independently reviewed TypeScript semantic change removes it.
scenario('legacy-single-transform-key-collision', {}, s=>{
  const o=s.plates[0].objects[0];
  o.instances=[{...o.instances[0],id:'import:i:a'},{...cloneJson(o.instances[0]),id:'import:i:a:b'}];
}, ({execute,run})=>{
  execute(transformOne('import:i:a',1,'b:c'));execute(transformOne('import:i:a:b',2,'c'));
  run({kind:'undo'});run({kind:'redo'});
});
for (const maxEstimatedBytes of [255,256,257,511,512,513,600,900]) {
  scenario(`transform-retention-${maxEstimatedBytes}`,{maxEstimatedBytes},editFixture,({execute,run,ids})=>{
    execute(transformOne(ids.instance,1));execute(transformOne(ids.instance,2,'new'));
    execute(transformMany([ids.instance,'import:instance:\u0000\ud800'],3));
    execute(transformMany([ids.instance,'import:instance:\u0000\ud800'],4));
    for(let i=0;i<4;i++)run({kind:'undo'});
    for(let i=0;i<4;i++)run({kind:'redo'});
  });
}

// Object lifecycle references deliberately execute the original browser commands.
const absent = () => ({absent:{}});
const optional = v => v === undefined ? absent() : {value:units(v)};
const deleteObject = id => ({deleteObject:{objectId:units(id)}});
const deleteInstance = id => ({deleteInstance:{instanceId:units(id)}});
const clearPlate = id => ({deletePlateObjects:{plateId:units(id)}});
const moveObject = (id,p) => ({moveObjectToPlate:{objectId:units(id),destinationPlateId:units(p)}});
function independentIds(o,suffix) {
  return {objectId:units(`import:object:${suffix}`),volumeIds:o.volumes.map((_,i)=>units(`import:volume:${suffix}:${i}`)),instanceIds:o.instances.map((_,i)=>units(`import:instance:${suffix}:${i}`)),layerRangeIds:o.layerRanges.map((_,i)=>units(`import:range:${suffix}:${i}`))};
}
function duplicateObject(o,suffix,destination,name) {
  return {duplicateObject:{sourceObjectId:units(o.id),ids:independentIds(o,suffix),destinationPlateId:optional(destination),name:optional(name)}};
}
function convertInstance(o,source,suffix,name) {
  const {instanceIds,...ids}=independentIds(o,suffix);
  return {convertInstanceToObject:{instanceId:units(source),ids:{...ids,instanceId:instanceIds[0]},name:optional(name)}};
}
function lifecycleFixture(s) {
  editFixture(s);
  const original=s.plates[0].objects[0];
  original.name='Model\\"\u0000\ud800😀';
  original.foreign=JSON.parse('{"__proto__":{"owned":"\\udfff"},"10":10,"2":2}');
  original.instances[0].foreign={undoRetains:true};
  original.instances[0].extensionData={retainedByDuplicate:true};
  original.instances.push({...cloneJson(original.instances[0]),id:'import:instance:third',name:' third '});
  for (let i=0;i<2;i++) {
    const object=cloneJson(original);
    object.id=`import:object:neighbor${i}`;
    object.volumes.forEach((v,j)=>v.id=`import:volume:neighbor${i}:${j}`);
    object.layerRanges.forEach((v,j)=>v.id=`import:range:neighbor${i}:${j}`);
    object.instances=[{...object.instances[0],id:`import:instance:neighbor${i}`}];
    s.plates[0].objects.push(object);
  }
}
for (const selected of ['object','volume','instance','layer-range','unrelated-primary','unrelated-only','none']) {
  scenario(`object-delete-selection-${selected}`,{},lifecycleFixture,({execute,run,state,ids})=>{
    const selectedId={object:ids.object,volume:ids.volume,instance:ids.instance,'layer-range':ids.range}[selected];
    const unrelated={kind:'instance',id:units('import:instance:neighbor1')};
    run({kind:'selection',refs:selectedId?[unrelated,{kind:selected,id:units(selectedId)}]:selected==='none'?[]:selected==='unrelated-only'?[unrelated]:[{kind:'object',id:units(ids.object)},unrelated]});
    execute(deleteObject(ids.object)); run({kind:'undo'});run({kind:'redo'});
    execute(deleteObject('import:object:neighbor1'));run({kind:'undo'});run({kind:'redo'});
    execute(deleteObject('import:object:neighbor0'));run({kind:'undo'});run({kind:'redo'});
    assert.equal(state().plates[0].objects.length,0);
    execute(deleteObject(ids.object));execute(deleteObject('bad'));
    for(let i=0;i<3;i++)run({kind:'undo'});
    assert.equal(state().plates[0].objects.length,3);
  });
}
scenario('plate-objects-empty-history-and-atomic-rollback',{},lifecycleFixture,({execute,batch,run,state,ids})=>{
  run({kind:'selection',refs:[{kind:'instance',id:units(ids.instance)}]});
  execute(clearPlate(ids.plate));execute(clearPlate(ids.plate));
  run({kind:'undo'});run({kind:'undo'});run({kind:'redo'});run({kind:'redo'});
  run({kind:'undo'});run({kind:'undo'});
  batch([clearPlate(ids.plate),deleteObject(ids.object)],'Rollback cleared plate');
  assert.equal(state().plates[0].objects.length,3);
  batch([deleteObject(ids.object),clearPlate(ids.plate)],'Delete all in order');
  run({kind:'undo'});run({kind:'redo'});run({kind:'checkpoint'});
  execute(clearPlate('import:missing:plate'));execute(clearPlate('bad'));
});
for (const which of ['first','middle','last']) {
  scenario(`instance-delete-${which}`,{},lifecycleFixture,({execute,batch,run,state,ids})=>{
    const id=which==='first'?ids.instance:which==='middle'?'import:instance:\u0000\ud800':'import:instance:third';
    run({kind:'selection',refs:[{kind:'volume',id:units(ids.volume)},{kind:'instance',id:units(id)}]});
    execute(deleteInstance(id));run({kind:'undo'});run({kind:'redo'});
    const other=state().plates[0].objects[0].instances[0].id;
    // A removed nonprimary selection must not displace the volume selection.
    run({kind:'selection',refs:[{kind:'instance',id:units(other)},{kind:'volume',id:units(ids.volume)}]});
    execute(deleteInstance(other));
    execute(deleteInstance(state().plates[0].objects[0].instances[0].id));
    execute(deleteInstance(id));execute(deleteInstance('bad'));
    run({kind:'undo'});run({kind:'undo'});
    batch([deleteInstance(id),deleteInstance(id)],'Rollback instance deletion');
  });
}
scenario('object-duplicate-move-collisions-and-rollback',{},lifecycleFixture,({execute,batch,run,state,ids})=>{
  const source=()=>state().plates.flatMap(p=>p.objects).find(o=>o.id===ids.object);
  const destination='import:plate:destination';execute(add(destination,'Other',1,false));
  for (const name of [undefined,'\ufeff trimmed 😀 \n','\u0085','\u0000\ud800','', ' \ufeff\n']) {
    const plan=duplicateObject(source(),'duplicate',undefined,name);
    const before=canonicalStringify(state());execute(plan);
    if(name!=='' && name!==' \ufeff\n') {run({kind:'undo'});assert.equal(canonicalStringify(state()),before);run({kind:'redo'});run({kind:'undo'});}
  }
  for (const change of [p=>p.ids.volumeIds.pop(),p=>p.ids.instanceIds.pop(),p=>p.ids.layerRangeIds.pop(),p=>p.ids.volumeIds.push(units('import:volume:excess')),p=>p.ids.volumeIds[0]=p.ids.objectId,p=>p.ids.instanceIds[0]=p.ids.volumeIds[0],p=>p.ids.objectId=units(ids.project),p=>p.ids.volumeIds[0]=units(ids.asset),p=>p.ids.layerRangeIds[0]=units(ids.physical0),p=>p.sourceObjectId=units('import:missing:object'),p=>p.destinationPlateId=optional('import:missing:plate'),p=>p.ids.objectId=units('bad'),p=>p.destinationPlateId=optional('bad')]) {
    const plan=duplicateObject(source(),'invalid');change(plan.duplicateObject);execute(plan);
  }
  execute(duplicateObject(source(),'remote',destination));
  assert.equal(state().plates[1].objects[0].id,'import:object:remote');
  run({kind:'undo'});run({kind:'redo'});
  execute(moveObject(ids.object,ids.plate));execute(moveObject('import:missing:object',destination));execute(moveObject(ids.object,'import:missing:plate'));
  execute(moveObject(ids.object,destination));run({kind:'undo'});run({kind:'redo'});
  execute(moveObject(ids.object,destination));
  run({kind:'undo'});
  batch([moveObject(ids.object,destination),deleteObject('import:missing:object')],'Rollback moved object');
  batch([duplicateObject(source(),'batch',destination),deleteObject(ids.object)],'Duplicate and delete');
  run({kind:'undo'});run({kind:'redo'});run({kind:'undo'});
  batch([deleteObject(ids.object),duplicateObject(source(),'late')],'Deleted source refuses duplicate');
  batch([moveObject(ids.object,destination),moveObject(ids.object,ids.plate)],'Round-trip move');
  run({kind:'undo'});run({kind:'redo'});
});
for (const name of [undefined,'','  ','\u0000\ud800😀']) {
  scenario(`instance-independent-name-${JSON.stringify(name)}`,{},lifecycleFixture,({execute,batch,run,state,ids})=>{
    const original=state().plates[0].objects[0];
    const before=canonicalStringify(state());
    const plan=convertInstance(original,ids.instance,'independent',name);
    execute(plan);
    const converted=state().plates[0].objects.find(o=>o.id==='import:object:independent');
    if(converted) {
      assert.equal(converted.instances[0].foreign,undefined);
      assert.equal(converted.instances[0].extensionData,undefined);
      assert.deepEqual(converted.instances[0].transform,original.instances[0].transform);
      run({kind:'undo'});assert.equal(canonicalStringify(state()),before);run({kind:'redo'});run({kind:'undo'});
    }
    for(const change of [p=>p.ids.volumeIds.pop(),p=>p.ids.layerRangeIds.pop(),p=>p.ids.objectId=units(ids.asset),p=>p.ids.instanceId=p.ids.objectId,p=>p.instanceId=units('import:missing:instance'),p=>p.ids.instanceId=units('bad')]) {
      const bad=convertInstance(original,ids.instance,'invalid');change(bad.convertInstanceToObject);execute(bad);
    }
    execute(convertInstance(state().plates[0].objects[1],'import:instance:neighbor0','sole'));
    // Absent and empty source names differ; preserve explicit empty names.
    execute(convertInstance(original,'import:instance:\u0000\ud800','empty-source'));
    run({kind:'undo'});
    execute(convertInstance(original,'import:instance:third','named-source'));
    run({kind:'undo'});
    batch([convertInstance(original,ids.instance,'batch'),deleteInstance(ids.instance)],'Rollback converted instance');
    assert.equal(canonicalStringify(state()),before);
  });
}
// Exact UTF-16 retention thresholds include escaped extras and supplementary text.
const retentionFixture=createProjectFixture();lifecycleFixture(retentionFixture.state);
const retainedObject=retentionFixture.state.plates[0].objects[0];
const lifecycleSizes=[1,canonicalStringify(retainedObject).length,canonicalStringify(retainedObject.instances[0]).length,canonicalStringify(retentionFixture.state.plates[0].objects).length];
for(const size of lifecycleSizes)for(const delta of [-1,0,1]) {
  const maxEstimatedBytes=Math.max(1,size+delta);
  scenario(`object-retention-${size}-${delta}`,{maxEstimatedBytes},lifecycleFixture,({execute,run,state,ids})=>{
    execute(deleteInstance(ids.instance));execute(deleteObject(ids.object));execute(clearPlate(ids.plate));
    execute(clearPlate(ids.plate));
    for(let i=0;i<5;i++)run({kind:'undo'});
    for(let i=0;i<5;i++)run({kind:'redo'});
    run({kind:'clear',mark:false});
  });
}

// Layer ranges: lifecycle, bounds edits, split/merge rules and selection repair.
const addRange = (objectId, id, minZMm, maxZMm) => ({ addLayerRange: { objectId: units(objectId), layerRangeId: units(id), minZMm, maxZMm } });
const optionalZ = (value) => (value === undefined ? { absent: {} } : { value });
const editRange = (objectId, id, minZMm, maxZMm) => ({ editLayerRangeBounds: { objectId: units(objectId), layerRangeId: units(id), minZMm: optionalZ(minZMm), maxZMm: optionalZ(maxZMm) } });
const splitRange = (objectId, id, splitZMm, upper) => ({ splitLayerRange: { objectId: units(objectId), layerRangeId: units(id), splitZMm, upperRangeId: units(upper) } });
const mergeRanges = (objectId, first, second) => ({ mergeLayerRanges: { objectId: units(objectId), firstRangeId: units(first), secondRangeId: units(second) } });
const deleteRange = (objectId, id) => ({ deleteLayerRange: { objectId: units(objectId), layerRangeId: units(id) } });
scenario("layer-ranges", {}, s => {
  const o = s.plates[0].objects[0];
  o.layerRanges = [
    { id: "import:range:b", minZMm: 1, maxZMm: 2.5, config: { layer_height: 0.1 } },
    { id: "import:range:a", minZMm: 0.2, maxZMm: 1, config: { layer_height: 0.1 }, foreign: { kept: "\ud800" } },
    { id: "import:range:c", minZMm: 3, maxZMm: 4, config: {}, filamentId: s.filaments.physical[0].id },
    { id: "import:range:d", minZMm: 4, maxZMm: 5, config: {}, filamentId: s.filaments.physical[1].id },
  ];
}, ({ execute, batch, run, ids }) => {
  const o = ids.object;
  execute(addRange(o, "import:range:new", 6, 7.25));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [addRange(o, "import:range:x", 4.5, 5.5), addRange(o, "import:range:x", -1, 0.1), addRange(o, "import:range:x", 2, 2),
    addRange(o, "import:range:a", 8, 9), addRange(o, ids.plate, 8, 9), addRange(o, "bad", 8, 9), addRange("import:missing:object", "import:range:x", 8, 9),
    addRange(o, "import:range:x", 0.1 + 0.2, 0.3), addRange(o, "import:range:x", 1e308, 1.7976931348623157e308)])
    execute(bad);
  execute(editRange(o, "import:range:new", 5.5)); execute(editRange(o, "import:range:new", undefined, 8));
  execute(editRange(o, "import:range:new", 5.5, 8)); execute(editRange(o, "import:range:new"));
  for (const bad of [editRange(o, "import:range:new", 4.9), editRange(o, "import:range:new", 9, 8), editRange(o, "import:range:missing", 1, 2), editRange("import:missing:object", "import:range:new", 1)])
    execute(bad);
  execute(splitRange(o, "import:range:b", 1.75, "import:range:b-upper"));
  for (const bad of [splitRange(o, "import:range:b", 1, "import:range:y"), splitRange(o, "import:range:b", 1.75, "import:range:y"), splitRange(o, "import:range:a", 0.5, "import:range:b-upper"), splitRange(o, "import:range:a", 0.5, "bad")])
    execute(bad);
  execute(mergeRanges(o, "import:range:b-upper", "import:range:b"));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [mergeRanges(o, "import:range:a", "import:range:a"), mergeRanges(o, "import:range:b", "import:range:c"), mergeRanges(o, "import:range:c", "import:range:d"),
    mergeRanges(o, "import:range:a", "import:range:new"), mergeRanges(o, "import:range:missing", "import:range:a"), mergeRanges(o, "import:range:a", "import:range:missing")])
    execute(bad);
  execute(mergeRanges(o, "import:range:a", "import:range:b"));
  run({ kind: "selection", refs: [{ kind: "layer-range", id: units("import:range:c") }, { kind: "object", id: units(o) }] });
  execute(deleteRange(o, "import:range:c"));
  run({ kind: "selection", refs: [{ kind: "object", id: units(o) }, { kind: "layer-range", id: units("import:range:new") }] });
  execute(deleteRange(o, "import:range:new"));
  run({ kind: "undo" }); run({ kind: "undo" });
  execute(deleteRange(o, "import:range:missing"));
  for (const id of ["import:range:a", "import:range:c", "import:range:d"]) {
    run({ kind: "selection", refs: [{ kind: "layer-range", id: units(id) }] });
    execute(deleteRange(o, id));
  }
  run({ kind: "selection", refs: [{ kind: "layer-range", id: units("import:range:new") }] });
  execute(deleteRange(o, "import:range:new"));
  batch([addRange(o, "import:range:t1", 0, 1), addRange(o, "import:range:t2", 1, 2), mergeRanges(o, "import:range:t1", "import:range:t2")], "Layer range transaction");
  batch([addRange(o, "import:range:t3", 10, 11), addRange(o, "import:range:t4", 10.5, 12)], "Rolled back layer ranges");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const optionalValue = (value, wrap = v => v) => (value === undefined ? { absent: {} } : { value: wrap(value) });
// undefined keeps a field, null clears it.
const patchValue = (value, wrap = v => v) => (value === undefined ? { keep: {} } : value === null ? { clear: {} } : { value: wrap(value) });
const addEvent = (plateId, id, eventType, topZMm, o = {}) => ({ addLayerEvent: { customGcodeId: units(id), plateId: units(plateId), eventType, topZMm,
  toolIndex: optionalValue(o.toolIndex), filamentId: optionalValue(o.filamentId, units), color: optionalValue(o.color, units), message: optionalValue(o.message, units), code: optionalValue(o.code, units) } });
const editEvent = (id, o = {}) => ({ editLayerEvent: { customGcodeId: units(id), eventType: optionalValue(o.eventType), topZMm: optionalValue(o.topZMm),
  toolIndex: patchValue(o.toolIndex), filamentId: patchValue(o.filamentId, units), color: patchValue(o.color, units), message: patchValue(o.message, units), code: optionalValue(o.code, units) } });
const deleteEvent = id => ({ deleteLayerEvent: { customGcodeId: units(id) } });
scenario("layer-events", {}, s => {
  const plateId = s.plates[0].id;
  s.customGcode = [
    { id: "import:gcode:hook", scope: "project", trigger: "before-plate", code: "M117 start" },
    { id: "import:gcode:pause", scope: "plate", plateId, trigger: "before-layer", code: "", layerEvent: { type: "pause", topZMm: 2, message: "Insert magnets", foreign: { kept: "\ud800" } }, foreign: [1, "😀"] },
    { id: "import:gcode:color", scope: "plate", plateId, trigger: "before-layer", code: "", layerEvent: { type: "color-change", topZMm: 3.2, toolIndex: 2, filamentId: s.filaments.physical[1].id, color: "#FF0000" } },
  ];
}, ({ execute, batch, run, ids, state }) => {
  const p = ids.plate, { physical, mixed } = state().filaments;
  execute(addEvent(p, "import:gcode:new-pause", "pause", 5, { message: "Swap nozzle 😀" }));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(addEvent(p, "import:gcode:new-color", "colorChange", 6, { toolIndex: 1, filamentId: physical[0].id, color: "#00FF00" }));
  execute(addEvent(p, "import:gcode:custom", "custom", 7, { code: "G4 S1\nM400" }));
  execute(addEvent(p, "import:gcode:template", "template", 8, { code: "dropped: not custom" }));
  execute(addEvent(p, "import:gcode:tool", "toolChange", 9, { toolIndex: 3, filamentId: mixed[0].id }));
  execute(addEvent(p, "import:gcode:odd-pause", "pause", 9.5, { toolIndex: 1.5 }));
  execute(addEvent(p, "import:gcode:unknown-filament", "pause", 9.75, { filamentId: "import:filament:missing" }));
  for (const bad of [addEvent(p, "import:gcode:pause", "pause", 11), addEvent(p, "import:gcode:hook", "pause", 11), addEvent(p, p, "pause", 11),
    addEvent(p, "bad", "pause", 11), addEvent("bad", "import:gcode:x", "pause", 11), addEvent(p, "import:gcode:x", "pause", 11, { filamentId: "bad" }),
    addEvent("import:plate:missing", "import:gcode:x", "pause", 11), addEvent(p, "import:gcode:x", "pause", 0), addEvent(p, "import:gcode:x", "pause", -1),
    addEvent(p, "import:gcode:x", "pause", 10000.5), addEvent(p, "import:gcode:x", "pause", 2), addEvent(p, "import:gcode:x", "pause", 2.00004),
    addEvent(p, "import:gcode:x", "pause", 2.00005), addEvent(p, "import:gcode:x", "custom", 11), addEvent(p, "import:gcode:x", "custom", 11, { code: "  ﻿ \n" }),
    addEvent(p, "import:gcode:x", "colorChange", 11), addEvent(p, "import:gcode:x", "toolChange", 11, { toolIndex: 0 }),
    addEvent(p, "import:gcode:x", "colorChange", 11, { toolIndex: 1.5 }), addEvent(p, "import:gcode:x", "custom", 0, { toolIndex: 0 })])
    execute(bad);
  execute(addEvent(p, "import:gcode:boundary", "pause", 10000));
  execute(editEvent("import:gcode:color"));
  execute(editEvent("import:gcode:pause"));
  execute(editEvent("import:gcode:pause", { topZMm: 2.5, message: null, color: "#123456" }));
  execute(editEvent("import:gcode:pause", { eventType: "custom", code: "M600" }));
  execute(editEvent("import:gcode:pause", { eventType: "pause" }));
  execute(editEvent("import:gcode:pause", { code: "dropped" }));
  execute(editEvent("import:gcode:custom", { code: "G4 S2" }));
  for (const bad of [editEvent("import:gcode:missing", { topZMm: 3 }), editEvent("import:gcode:hook", { topZMm: 3 }), editEvent("bad"),
    editEvent("import:gcode:tool", { toolIndex: null }), editEvent("import:gcode:tool", { topZMm: 7 }), editEvent("import:gcode:tool", { topZMm: 0 }),
    editEvent("import:gcode:custom", { code: "" }), editEvent("import:gcode:tool", { eventType: "custom" }), editEvent("import:gcode:tool", { filamentId: "bad" })])
    execute(bad);
  execute(editEvent("import:gcode:color", { eventType: "pause" }));
  execute(editEvent("import:gcode:color", { eventType: "toolChange", toolIndex: 4, filamentId: null, color: null, message: "Tool 4" }));
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" });
  execute(deleteEvent("import:gcode:template"));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [deleteEvent("import:gcode:hook"), deleteEvent("import:gcode:missing"), deleteEvent("bad")]) execute(bad);
  execute(add("import:plate:events", "Events", 7, false));
  execute(addEvent("import:plate:events", "import:gcode:other-plate", "pause", 5));
  execute(del("import:plate:events"));
  run({ kind: "undo" });
  batch([addEvent(p, "import:gcode:b1", "pause", 12), editEvent("import:gcode:b1", { topZMm: 12.5, message: "batched" }), deleteEvent("import:gcode:custom")], "Layer event transaction");
  batch([addEvent(p, "import:gcode:b2", "pause", 13), addEvent(p, "import:gcode:b3", "pause", 13)], "Rolled back layer events");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const ear = (positionMm, headFrontRadiusMm) => ({ positionMm, headFrontRadiusMm });
const addEar = (objectId, positionMm, radius) => ({ addBrimEar: { objectId: units(objectId), ear: ear(positionMm, radius) } });
const addEars = (objectId, ears) => ({ addBrimEars: { objectId: units(objectId), ears } });
const removeEar = (objectId, index) => ({ removeBrimEar: { objectId: units(objectId), index } });
const clearEars = objectId => ({ clearBrimEars: { objectId: units(objectId) } });
scenario("brim-ears", {}, s => {
  const first = s.plates[0].objects[0];
  first.brimEars = [{ positionMm: [1, 2, 0], headFrontRadiusMm: 3, foreign: { kept: "\ud800" } }];
  const second = JSON.parse(JSON.stringify(first));
  Object.assign(second, { id: "import:object:second", layerRanges: [], brimEars: [] });
  second.volumes[0].id = "import:volume:second"; second.instances[0].id = "import:instance:second";
  s.plates[0].objects.push(second);
}, ({ execute, batch, run, ids }) => {
  const o = ids.object, second = "import:object:second";
  execute(addEar(o, [5, -2.5, 0.25], 2));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(addEar(o, [0, 0, 0], 0.1)); execute(addEar(o, [-0, 1e-300, 1e300], 20));
  for (const bad of [addEar(o, [0, 0, 0], 0.0999), addEar(o, [0, 0, 0], 20.0001), addEar(o, [0, 0, 0], -1),
    addEar("import:missing:object", [0, 0, 0], 1), addEar("bad", [0, 0, 0], 1)])
    execute(bad);
  execute(addEars(o, [ear([7, 7, 0], 1.5), ear([8, 8, 0], 2.5)]));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [addEars(o, []), addEars(o, [ear([1, 1, 0], 1), ear([2, 2, 0], 25)]), addEars("import:missing:object", [ear([1, 1, 0], 1)])])
    execute(bad);
  execute(removeEar(o, 0));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [removeEar(o, 99), removeEar(o, 9007199254740991), removeEar(second, 0), removeEar("import:missing:object", 0)])
    execute(bad);
  execute(addEar(second, [3, 3, 0], 1));
  run({ kind: "undo" });
  execute(clearEars(second));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(clearEars(o));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(clearEars(o));
  run({ kind: "undo" });
  execute(addEars(second, [ear([4, 4, 0], 1)]));
  execute(removeEar(second, 0));
  run({ kind: "undo" }); run({ kind: "undo" });
  batch([addEar(o, [9, 9, 0], 1), removeEar(o, 0), clearEars(second)], "Brim ear transaction");
  batch([addEar(o, [10, 10, 0], 1), removeEar(second, 5)], "Rolled back brim ears");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const limits = (o = {}) => ({ layerHeightMm: 0.2, minLayerHeightMm: 0.08, maxLayerHeightMm: 0.28, firstObjectLayerHeightMm: 0.2, firstObjectLayerHeightFixed: true, ...o });
const heightParameters = (o = {}, objectHeightMm = 20) => ({ limits: limits(o), objectHeightMm });
const adjustHeight = (objectId, zMm, thicknessDeltaMm, bandWidthMm, action, parameters = heightParameters()) =>
  ({ adjustLayerHeightProfile: { objectId: units(objectId), parameters, zMm, thicknessDeltaMm, bandWidthMm, action } });
const smoothHeight = (objectId, radius, keepMin = false, parameters = heightParameters()) =>
  ({ smoothLayerHeightProfile: { objectId: units(objectId), parameters, radius, keepMin } });
const adaptiveHeight = (objectId, qualityFactor, o = {}) => ({ adaptiveLayerHeightProfile: { objectId: units(objectId), limits: limits(o), qualityFactor } });
const resetHeight = objectId => ({ resetLayerHeightProfile: { objectId: units(objectId) } });
/** A shallow cone over a fan base: many equal Z spans, which exercises the
 * adaptive face ordering. */
const coneAsset = id => {
  const positions = [0, 0, 0], indices = [], segments = 24;
  for (let i = 0; i < segments; i += 1) positions.push(Math.cos(i / segments * Math.PI * 2) * 60, Math.sin(i / segments * Math.PI * 2) * 60, 0);
  positions.push(0, 0, 20);
  for (let i = 0; i < segments; i += 1) { const a = 1 + i, b = 1 + (i + 1) % segments; indices.push(0, b, a, a, b, segments + 1); }
  return encodeIndexedMeshAsset({ id, positions, indices });
};
const cloneObject = (object, suffix, extra) => {
  const copy = JSON.parse(JSON.stringify(object));
  Object.assign(copy, { id: `import:object:${suffix}`, layerRanges: [], ...extra });
  copy.volumes[0].id = `import:volume:${suffix}`; copy.instances[0].id = `import:instance:${suffix}`;
  return copy;
};
scenario("layer-heights", {}, (s, f) => {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const first = s.plates[0].objects[0];
  first.volumes[0].source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  s.plates[0].objects.push(cloneObject(first, "short", { layerHeightProfile: [0, 0.2] }),
    cloneObject(first, "extreme", { layerHeightProfile: [0, 0.2, 10, 1e308, 20, -1e308] }),
    cloneObject(first, "imported", { layerHeightProfile: [0, 0.2, 5, 0.12, 15, 0.26, 20, 0.2] }));
}, ({ execute, batch, run, ids }) => {
  const o = ids.object;
  execute(adjustHeight(o, 8, 0.05, 3, "increase"));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(adjustHeight(o, 12, 0.04, 2, "decrease"));
  execute(adjustHeight(o, 8, 0.02, 3, "reduce"));
  execute(adjustHeight(o, 10, 0.05, 4, "smooth"));
  execute(adjustHeight(o, 25, 0.05, 3, "increase"));
  execute(adjustHeight(o, 0.1, 0.05, 3, "increase"));
  execute(adjustHeight(o, 5, 1, 3, "increase")); execute(adjustHeight(o, 5, 1, 3, "increase"));
  execute(adjustHeight(o, 6, -0.03, 3, "increase")); execute(adjustHeight(o, 7, 0.05, 0, "increase"));
  execute(adjustHeight(o, 9, 0.05, -2, "decrease")); execute(adjustHeight(o, 19.95, 0.05, 1e6, "increase"));
  execute(adjustHeight(o, 0.5, 0.05, 4, "smooth", heightParameters({ firstObjectLayerHeightFixed: false })));
  execute(adjustHeight(o, 20, 0.05, 2, "reduce"));
  execute(smoothHeight(o, 5)); execute(smoothHeight(o, 5, true)); execute(smoothHeight(o, 0)); execute(smoothHeight(o, 2.7)); execute(smoothHeight(o, -3));
  execute(smoothHeight(o, 100, false, heightParameters({ firstObjectLayerHeightFixed: false })));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const factor of [0.5, 0, 1, 0.25, 0.75]) execute(adaptiveHeight(o, factor));
  execute(adaptiveHeight(o, 0.5, { firstObjectLayerHeightFixed: false, firstObjectLayerHeightMm: 0.3 }));
  execute(adaptiveHeight(o, 0.5, { minLayerHeightMm: 0.05, maxLayerHeightMm: 0.35 }));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(resetHeight(o));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(resetHeight(o));
  for (const bad of [adjustHeight("import:missing:object", 5, 0.05, 3, "increase"), adjustHeight("bad", 5, 0.05, 3, "increase"),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({ minLayerHeightMm: 0 })),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({ maxLayerHeightMm: 0.05 })),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({}, 0)),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({ firstObjectLayerHeightMm: 0 })),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({ layerHeightMm: -0.2 })),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({}, 10000.5)),
    adjustHeight(o, 5, 0.05, 3, "increase", heightParameters({ minLayerHeightMm: 1e-6 })),
    smoothHeight(o, 101), smoothHeight(o, 1e300), adaptiveHeight(o, 1.5), adaptiveHeight(o, -0.1),
    adaptiveHeight(o, 0.5, { firstObjectLayerHeightMm: -1 }), adaptiveHeight("import:missing:object", 0.5), resetHeight("import:missing:object"),
    adjustHeight("import:object:short", 5, 0.05, 3, "increase"), smoothHeight("import:object:short", 5)])
    execute(bad);
  execute(adjustHeight("import:object:extreme", 10, 0.05, 3, "increase"));
  execute(adjustHeight("import:object:extreme", 5, 0.05, 3, "smooth"));
  execute(smoothHeight("import:object:extreme", 2));
  execute(adjustHeight("import:object:imported", 10, 0.05, 6, "smooth"));
  execute(smoothHeight("import:object:imported", 3, true));
  execute(resetHeight("import:object:imported"));
  run({ kind: "undo" });
  batch([adjustHeight(o, 8, 0.05, 3, "increase"), smoothHeight(o, 4), adaptiveHeight(o, 0.6)], "Layer height transaction");
  batch([adjustHeight(o, 8, 0.05, 3, "increase"), adaptiveHeight(o, 2)], "Rolled back layer heights");
  run({ kind: "undo" }); run({ kind: "redo" });
});
scenario("layer-heights-flat-mesh", {}, noop, ({ execute, run, ids }) => {
  // The fixture's single flat triangle has no Z span: adaptive falls back to 20 mm.
  execute(adaptiveHeight(ids.object, 0.5, { firstObjectLayerHeightFixed: false }));
  execute(adaptiveHeight(ids.object, 0.1));
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" });
});

const optionalId = id => (id === null ? { absent: {} } : { value: units(id) });
const assignment = (target, filamentId) => ({ target, filamentId: optionalId(filamentId) });
const objectTarget = objectId => ({ object: { objectId: units(objectId) } });
const volumeTarget = (objectId, volumeId) => ({ volume: { objectId: units(objectId), volumeId: units(volumeId) } });
const rangeTarget = (objectId, layerRangeId) => ({ layerRange: { objectId: units(objectId), layerRangeId: units(layerRangeId) } });
const assignFilaments = assignments => ({ setFilamentAssignments: { assignments } });
const objectFilament = (objectId, filamentId) => ({ setObjectFilament: { objectId: units(objectId), filamentId: optionalId(filamentId) } });
const volumeFilament = (objectId, volumeId, filamentId) => ({ setVolumeFilament: { objectId: units(objectId), volumeId: units(volumeId), filamentId: optionalId(filamentId) } });
const rangeFilament = (objectId, layerRangeId, filamentId) => ({ setLayerRangeFilament: { objectId: units(objectId), layerRangeId: units(layerRangeId), filamentId: optionalId(filamentId) } });
const remapFilaments = (sourceIds, destinationId) => ({ remapFilaments: { sourceIds: sourceIds.map(units), destinationId: units(destinationId) } });
const filamentEnabled = (filamentId, enabled, reason) => ({ setFilamentEnabled: { filamentId: units(filamentId), enabled, reason: optionalValue(reason, units) } });
const printerSlot = (toolId, color, material, o = {}) => ({ toolId, color: units(color), material: units(material), subType: optionalValue(o.subType, units), vendor: optionalValue(o.vendor, units) });
const syncFilaments = (slots, newFilamentIds) => ({ syncPhysicalFilaments: { slots, newFilamentIds: newFilamentIds === undefined ? { absent: {} } : { value: newFilamentIds.map(units) } } });
const facetLeaf = value => ({ kind: "leaf", state: value === undefined ? { kind: "unpainted" } : { kind: "assigned", value } });
const facetSplit = children => ({ kind: "split", splitSides: children.length - 1, specialSide: 0, children });
scenario("filaments", {}, (s, f) => {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const [p0, p1] = s.filaments.physical.map(p => p.id), mixed = s.filaments.mixed[0].id;
  const first = s.plates[0].objects[0], volume = first.volumes[0];
  volume.source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  volume.filamentId = p1;
  first.layerRanges[0].filamentId = p1;
  // A recipe-free tool: remapping it onto p0 collapses splits and merges groups.
  const third = "import:filament:third";
  volume.annotations.color = [{ value: p0, triangles: [1, 2, 3] }, { value: mixed, triangles: [4] }, { value: third, triangles: [5, 6] }, { value: p1, triangles: [9] }];
  volume.annotations.refinement = { color: { version: 2, triangleCount: 48, splits: [
    { triangle: 0, node: facetSplit([facetLeaf(p0), facetLeaf(third)]) },
    { triangle: 7, node: facetSplit([facetLeaf(third), facetLeaf()]) },
    { triangle: 8, node: facetSplit([facetLeaf(mixed), facetLeaf(p0), facetLeaf(third)]) },
    { triangle: 10, node: facetSplit([facetSplit([facetLeaf(third), facetLeaf(p0)]), facetLeaf(p0)]) },
  ] } };
  volume.extensionData = { "orcaxr:sourceMaterial": { color: "", name: "Imported" }, kept: [1, "😀"] };
  const second = cloneObject(first, "second", {});
  delete second.filamentId;
  second.volumes[0].filamentId = p0;
  second.volumes[0].annotations = { ...second.volumes[0].annotations, color: [{ value: p1, triangles: [0] }] };
  delete second.volumes[0].annotations.refinement;
  second.volumes[0].extensionData = { "orcaxr:sourceMaterial": "legacy", "orcaxr:originalFilamentColors": ["#123456"] };
  s.plates[0].objects.push(second);
  s.plates[0].wipeTower = { enabled: true, positionMm: [10, 20], rotationDeg: 0, filamentId: p1 };
  s.printer.toolCount = 4;
  s.filaments.physical.push({ id: third, name: "Head 4 PLA", toolId: 3, material: "PLA", color: "#ffff00", config: {}, enabled: true });
  s.filaments.physical.push({ id: "import:filament:disabled", name: "Spare PETG", toolId: 2, material: "PETG", color: "#00ff00", config: {}, enabled: false,
    extensionData: { orcaxrFilamentLifecycle: { state: "disabled", reason: "user", semantics: "tombstone-preserve-references" }, kept: true } });
  s.filaments.mixed.push({ id: "import:mixed:gradient", name: "Gradient", displayColor: "#808080",
    components: [{ filamentId: p0, weight: 1 }, { filamentId: p1, weight: 2 }],
    distribution: { mode: "gradient", startWeights: [1, 0.25], endWeights: [0, 1] }, config: {}, enabled: true });
}, ({ execute, batch, run, ids, state }) => {
  const o = ids.object, v = ids.volume, r = ids.range, second = "import:object:second", secondVolume = "import:volume:second";
  const [p0, p1] = state().filaments.physical.map(p => p.id), mixed = state().filaments.mixed[0].id, spare = "import:filament:disabled";
  execute(objectFilament(o, p1));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(objectFilament(o, p1));
  execute(objectFilament(o, null)); execute(objectFilament(o, mixed));
  execute(volumeFilament(o, v, p0)); execute(volumeFilament(o, v, null));
  execute(rangeFilament(o, r, p0)); execute(rangeFilament(o, r, null));
  for (const bad of [volumeFilament(o, secondVolume, p0), volumeFilament(o, "import:volume:missing", p0), objectFilament(o, spare),
    objectFilament(o, "import:filament:missing"), objectFilament("import:object:missing", p0), rangeFilament(second, r, p0),
    rangeFilament(o, "import:range:missing", p0), objectFilament("bad", p0), objectFilament(o, "bad"),
    assignFilaments([assignment(objectTarget(o), p0), assignment(objectTarget(o), p1)])])
    execute(bad);
  execute(assignFilaments([]));
  execute(assignFilaments([assignment(objectTarget(o), p0), assignment(volumeTarget(second, secondVolume), p1), assignment(rangeTarget(o, r), null)]));
  execute(assignFilaments([assignment(volumeTarget(o, v), p1)]));
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "redo" });
  execute(remapFilaments([p1], p0));
  execute(remapFilaments(["import:filament:third"], p0));
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" });
  execute(remapFilaments([mixed], p1));
  run({ kind: "undo" });
  for (const bad of [remapFilaments([], p0), remapFilaments([p1, p1], p0), remapFilaments([p0], p0), remapFilaments([p1], spare),
    remapFilaments(["import:filament:missing"], p0), remapFilaments([p1], mixed), remapFilaments([p0, "bad"], p1)])
    execute(bad);
  execute(remapFilaments([spare], p0));
  execute(filamentEnabled(spare, true)); execute(filamentEnabled(spare, true));
  execute(filamentEnabled(p1, false)); execute(filamentEnabled(p1, false, "printer-missing")); execute(filamentEnabled(p1, true));
  execute(filamentEnabled(mixed, false, "")); execute(filamentEnabled("import:mixed:gradient", false));
  execute(filamentEnabled("import:filament:missing", true));
  run({ kind: "undo" }); run({ kind: "undo" });
  const slots = [printerSlot(0, "#1E88E5", "PLA", { subType: "Matte", vendor: "Snapmaker" }), printerSlot(1, "#000000", "PETG", { vendor: "  " }),
    printerSlot(5, "#E2DEDB", "PLA", { subType: "SnapSpeed" })];
  execute(syncFilaments(slots));
  run({ kind: "undo" });
  execute(syncFilaments(slots, ["import:filament:adopt-5", "import:filament:unused"]));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(syncFilaments(slots, ["import:filament:adopt-5-again"]));
  for (const bad of [syncFilaments([printerSlot(0, "#12345", "PLA")]), syncFilaments([printerSlot(9007199254740991, "red", "PLA")]),
    syncFilaments([printerSlot(3, "#abcdef", " \n")]), syncFilaments([printerSlot(6, "#abcdef", "PLA"), printerSlot(7, "#abcdef", "PLA")], ["import:filament:only-one"]),
    syncFilaments([printerSlot(6, "#abcdef", "PLA")], [p0]), syncFilaments([printerSlot(6, "#abcdef", "PLA")], ["bad"])])
    execute(bad);
  batch([objectFilament(o, "import:filament:third"), remapFilaments(["import:filament:third"], p0), filamentEnabled("import:filament:third", false)], "Filament transaction");
  batch([objectFilament(o, p0), filamentEnabled("import:filament:missing", false)], "Rolled back filaments");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const jsonText = value => units(JSON.stringify(value));
const mixedComponentInput = c => ({ filamentId: units(c.filamentId), weight: c.weight });
const distributionInput = d => d.mode === "ratio" ? { ratio: {} } : d.mode === "cycle" ? { cycle: { cycleLengthMm: optionalValue(d.cycleLengthMm) } }
  : d.mode === "match" ? { match: { targetColor: units(d.targetColor) } }
  : { gradient: { startZMm: optionalValue(d.startZMm), endZMm: optionalValue(d.endZMm), startWeights: d.startWeights, endWeights: d.endWeights } };
const UI_MODES = { "-1": "legacy", 0: "ui0", 1: "ui1", 2: "ui2", 3: "ui3" }, DISTRIBUTION_MODES = { 0: "m0", 2: "m2" };
const fullSpectrumInput = f => ({ upstreamStableId: units(f.upstreamStableId), uiMode: UI_MODES[f.uiMode], componentAId: units(f.componentAId), componentBId: units(f.componentBId),
  ratioA: f.ratioA, ratioB: f.ratioB, mixBPercent: f.mixBPercent, manualPatternGroups: f.manualPatternGroups.map(g => g.map(units)),
  gradientComponentIds: f.gradientComponentIds.map(units), gradientComponentWeights: f.gradientComponentWeights, distributionMode: DISTRIBUTION_MODES[f.distributionMode],
  localZMaxSublayers: f.localZMaxSublayers, gradientEnabled: f.gradientEnabled, gradientStart: f.gradientStart, gradientEnd: f.gradientEnd,
  componentASurfaceOffsetMm: f.componentASurfaceOffsetMm, componentBSurfaceOffsetMm: f.componentBSurfaceOffsetMm, deleted: f.deleted, custom: f.custom, originAuto: f.originAuto });
const mixedInput = (m, o = {}) => ({ mixedFilamentId: units(m.id), name: units(m.name), displayColor: units(m.displayColor), components: m.components.map(mixedComponentInput),
  distribution: distributionInput(m.distribution), fullSpectrum: m.fullSpectrum ? { value: fullSpectrumInput(m.fullSpectrum) } : { absent: {} },
  configJson: o.configText !== undefined ? units(o.configText) : jsonText(m.config), enabled: m.enabled,
  extensionDataJson: m.extensionData ? { value: jsonText(m.extensionData) } : { absent: {} } });
const addMixed = (m, o) => ({ addMixedFilament: { filament: mixedInput(m, o) } });
const editMixed = (id, o = {}) => ({ editMixedFilament: { mixedFilamentId: units(id), name: optionalValue(o.name, units), displayColor: optionalValue(o.displayColor, units),
  components: optionalValue(o.components, cs => cs.map(mixedComponentInput)), distribution: optionalValue(o.distribution, distributionInput),
  fullSpectrum: optionalValue(o.fullSpectrum, fullSpectrumInput), configJson: optionalValue(o.config, v => (typeof v === "string" ? units(v) : jsonText(v))) } });
const duplicateMixed = (source, duplicate, name) => ({ duplicateMixedFilament: { sourceId: units(source), duplicateId: units(duplicate), name: optionalValue(name, units) } });
const mixedEnabled = (id, enabled, reason) => ({ setMixedFilamentEnabled: { mixedFilamentId: units(id), enabled, reason: optionalValue(reason, units) } });
const tombstoneMixed = (id, reason) => ({ tombstoneMixedFilament: { mixedFilamentId: units(id), reason: optionalValue(reason, units) } });
const removeMixed = id => ({ removeMixedFilament: { mixedFilamentId: units(id) } });
scenario("mixed-filaments", {}, (s, f) => {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const [p0, p1] = s.filaments.physical.map(p => p.id), purple = s.filaments.mixed[0].id;
  const volume = s.plates[0].objects[0].volumes[0];
  volume.source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  s.printer.toolCount = 4;
  s.filaments.physical.push({ id: "import:filament:third", name: "Head 3 PLA", toolId: 2, material: "PLA", color: "#ffff00", config: {}, enabled: true },
    { id: "import:filament:off", name: "Head 4 PLA", toolId: 3, material: "PLA", color: "#00ffff", config: {}, enabled: false });
  s.filaments.mixed.push(createFullSpectrumMixedFilament("import:mixed:fs", s.filaments.physical, { mode: "ratio", name: "Sunset", displayColor: "#ff8800",
    componentFilamentIds: [p0, p1], mixBPercent: 30 }));
  s.filaments.mixed.push({ id: "import:mixed:gradient", name: "Fade", displayColor: "#808080", components: [{ filamentId: p0, weight: 1 }, { filamentId: p1, weight: 1 }],
    distribution: { mode: "gradient", startZMm: 1, endZMm: 9, startWeights: [1, 0], endWeights: [0, 1] }, config: { note: "kept" }, enabled: true,
    extensionData: { kept: true } });
  s.filaments.mixed.push({ id: "import:mixed:unused", name: "Spare mix", displayColor: "#123456", components: [{ filamentId: p0, weight: 1 }, { filamentId: "import:filament:third", weight: 3 }],
    distribution: { mode: "ratio" }, config: {}, enabled: true });
  volume.annotations.color = [{ value: p0, triangles: [1] }, { value: purple, triangles: [0, 2] }];
  volume.annotations.refinement = { color: { version: 2, triangleCount: 48, splits: [
    { triangle: 3, node: facetSplit([facetLeaf(p1), facetSplit([facetLeaf("import:mixed:gradient"), facetLeaf()])]) },
  ] } };
  s.plates[0].objects[0].layerRanges[0].filamentId = "import:mixed:gradient";
}, ({ execute, batch, run, ids, state }) => {
  const [p0, p1] = state().filaments.physical.map(p => p.id), purple = state().filaments.mixed[0].id, third = "import:filament:third";
  const teal = { id: "import:mixed:teal", name: "Teal", displayColor: "#008080", components: [{ filamentId: p0, weight: 2 }, { filamentId: third, weight: 1 }],
    distribution: { mode: "ratio" }, config: { mixed_filament_ratio: 2, ["__proto__"]: { kept: 1 } }, enabled: true, extensionData: { kept: [1, "😀"] } };
  execute(addMixed(teal));
  run({ kind: "undo" }); run({ kind: "redo" });
  const cycle = createFullSpectrumMixedFilament("import:mixed:fs-cycle", state().filaments.physical, { mode: "cycle", name: " Stripes ", displayColor: "#AABBCCDD",
    manualPatternGroups: [[p0], [p1, third]] });
  execute(addMixed(cycle));
  const ok = (o) => ({ ...teal, id: "import:mixed:x", ...o });
  const deep = n => (n === 0 ? 1 : [deep(n - 1)]);
  for (const bad of [addMixed(ok({ id: purple })), addMixed(ok({ id: ids.plate })), addMixed(ok({ id: "bad" })),
    addMixed(ok({ components: [{ filamentId: p0, weight: 1 }, { filamentId: p0, weight: 2 }] })),
    addMixed(ok({ components: [{ filamentId: p0, weight: 1 }, { filamentId: "import:filament:missing", weight: 2 }] })),
    addMixed(ok({ components: [{ filamentId: p0, weight: 1 }, { filamentId: "import:filament:off", weight: 2 }] })),
    addMixed(ok({ components: [{ filamentId: p0, weight: 1 }, { filamentId: purple, weight: 2 }] })),
    addMixed(ok({ components: [{ filamentId: p0, weight: 1 }] })), addMixed(ok({ components: [{ filamentId: p0, weight: 0 }, { filamentId: p1, weight: 0 }] })),
    addMixed(ok({ name: " \n" })), addMixed(ok({ displayColor: "" })), addMixed(ok({ distribution: { mode: "cycle", cycleLengthMm: 0 } })),
    addMixed(ok({ distribution: { mode: "match", targetColor: "  " } })),
    addMixed(ok({ distribution: { mode: "gradient", startWeights: [1], endWeights: [0, 1] } })),
    addMixed(ok({ distribution: { mode: "gradient", startWeights: [1, -1], endWeights: [0, 1] } })),
    addMixed(ok({ distribution: { mode: "gradient", startWeights: [0, 0], endWeights: [0, 1] } })),
    addMixed(ok({ distribution: { mode: "gradient", startZMm: 2, startWeights: [1, 0], endWeights: [0, 1] } })),
    addMixed(ok({ distribution: { mode: "gradient", startZMm: 5, endZMm: 5, startWeights: [1, 0], endWeights: [0, 1] } })),
    addMixed(ok({}), { configText: "{" }), addMixed(ok({}), { configText: "[1]" }), addMixed(ok({}), { configText: "1e400" }),
    addMixed(ok({}), { configText: JSON.stringify({ a: deep(16) }) }), addMixed(ok({}), { configText: JSON.stringify({ a: deep(64) }) }), addMixed(ok({}), { configText: '{"a":"\ud800"}' }),
    addMixed(ok({}), { configText: '{"a":1,"a":2}' })])
    execute(bad);
  execute(addMixed(ok({ id: "import:mixed:deep" }), { configText: JSON.stringify({ a: deep(15) }) }));
  execute(addMixed(ok({ id: "import:mixed:escaped" }), { configText: '{"a":"\\ud800","b":-0,"c":1E2}' }));
  execute(editMixed("import:mixed:teal", { name: "  Deep teal  ", displayColor: " #004040 " }));
  execute(editMixed("import:mixed:teal", { name: "Deep teal" }));
  execute(editMixed("import:mixed:teal", { components: [{ filamentId: p1, weight: 1 }, { filamentId: third, weight: 4 }], distribution: { mode: "cycle", cycleLengthMm: 2.5 } }));
  execute(editMixed("import:mixed:teal", { fullSpectrum: state().filaments.mixed.find(m => m.id === "import:mixed:fs").fullSpectrum, config: "{\"z\":[true,null]}" }));
  run({ kind: "undo" });
  for (const bad of [editMixed("import:mixed:teal", { name: " " }), editMixed("import:mixed:teal", { displayColor: "\t" }), editMixed("import:mixed:missing", { name: "X" }),
    editMixed("import:mixed:teal", { components: [{ filamentId: p0, weight: 1 }, { filamentId: p0, weight: 1 }] }), editMixed("import:mixed:teal", { config: "null" }),
    editMixed("import:mixed:teal", { distribution: { mode: "gradient", startWeights: [1, 2, 3], endWeights: [1, 2, 3] } })])
    execute(bad);
  execute(duplicateMixed("import:mixed:fs", "import:mixed:fs-copy"));
  execute(duplicateMixed("import:mixed:teal", "import:mixed:teal-copy", "  Second teal "));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [duplicateMixed("import:mixed:teal", "import:mixed:x", "  "), duplicateMixed("import:mixed:teal", purple), duplicateMixed("import:mixed:missing", "import:mixed:x"),
    duplicateMixed("import:mixed:teal", "bad")])
    execute(bad);
  execute(mixedEnabled("import:mixed:teal", false)); execute(mixedEnabled("import:mixed:teal", true));
  execute(mixedEnabled("import:mixed:gradient", false, "printer-missing")); execute(mixedEnabled("import:mixed:gradient", true)); execute(mixedEnabled("import:mixed:gradient", true));
  execute(tombstoneMixed("import:mixed:fs")); execute(tombstoneMixed("import:mixed:fs-copy", "replaced"));
  execute(mixedEnabled("import:mixed:fs", true));
  execute(filamentEnabled(third, false));
  execute(mixedEnabled("import:mixed:teal", false)); execute(mixedEnabled("import:mixed:teal", true));
  run({ kind: "undo" }); run({ kind: "undo" });
  execute(mixedEnabled("import:mixed:missing", true)); execute(tombstoneMixed("import:mixed:missing"));
  run({ kind: "selection", refs: [{ kind: "filament", id: units("import:mixed:unused") }, { kind: "object", id: units(ids.object) }] });
  execute(removeMixed("import:mixed:unused"));
  run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [removeMixed(purple), removeMixed("import:mixed:gradient"), removeMixed("import:mixed:missing"), removeMixed("bad")]) execute(bad);
  batch([addMixed({ ...teal, id: "import:mixed:batch" }), editMixed("import:mixed:batch", { name: "Batched" }), duplicateMixed("import:mixed:batch", "import:mixed:batch-copy")], "Mixed filament transaction");
  batch([removeMixed("import:mixed:batch-copy"), removeMixed(purple)], "Rolled back mixed filaments");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const settingsGuard = snap => ({ sourceRevision: snap.revision, sourceHash: units(snap.hash) });
const projectOverrides = (guard, inherited, overrides) => ({ setProjectSettingsOverrides: { guard, inheritedConfigJson: typeof inherited === "string" ? units(inherited) : jsonText(inherited),
  overridesJson: typeof overrides === "string" ? units(overrides) : jsonText(overrides) } });
const scopedOverrides = (guard, target, overrides) => ({ setScopedOverrides: { guard, target, overridesJson: typeof overrides === "string" ? units(overrides) : jsonText(overrides) } });
const plateScope = id => ({ plate: { plateId: units(id) } });
const objectScope = id => ({ object: { objectId: units(id) } });
const partScope = id => ({ part: { volumeId: units(id) } });
const rangeScope = id => ({ layerRange: { layerRangeId: units(id) } });
scenario("settings-overrides", {}, s => {
  s.plates[0].config = { curr_bed_type: "Textured PEI Plate" };
  // A key this scope does not own is preserved verbatim on every write.
  s.plates[0].objects[0].config = { brim_width: 5, nozzle_diameter: [0.4] };
}, ({ execute, batch, run, ids, state, snapshot }) => {
  const initial = settingsGuard(snapshot()), inherited = state().config;
  execute(projectOverrides(settingsGuard(snapshot()), inherited, { sparse_infill_density: 25, wall_loops: 4 }));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(projectOverrides(settingsGuard(snapshot()), inherited, { sparse_infill_density: 25, wall_loops: 4 }));
  // Each failure publishes a rollback revision, so every guard is read when its
  // intent runs.
  const current = () => settingsGuard(snapshot());
  for (const bad of [() => projectOverrides(initial, inherited, {}), () => projectOverrides({ ...current(), sourceHash: units("fnv1a64:0000000000000000") }, inherited, {}),
    () => projectOverrides(current(), inherited, { " ": 1 }), () => projectOverrides(current(), { "": 1 }, {}),
    () => projectOverrides(current(), inherited, "{"), () => projectOverrides(current(), "[]", {}),
    () => projectOverrides(current(), inherited, JSON.stringify({ a: [[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]] }))])
    execute(bad());
  execute(projectOverrides(settingsGuard(snapshot()), { ...inherited, layer_height: 0.2 }, {}));
  execute(scopedOverrides(settingsGuard(snapshot()), plateScope(ids.plate), { curr_bed_type: "Cool Plate" }));
  execute(scopedOverrides(settingsGuard(snapshot()), objectScope(ids.object), { brim_width: 3, wall_loops: 2 }));
  execute(scopedOverrides(settingsGuard(snapshot()), partScope(ids.volume), { wall_loops: 5 }));
  execute(scopedOverrides(settingsGuard(snapshot()), rangeScope(ids.range), { layer_height: 0.16 }));
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "redo" });
  execute(scopedOverrides(settingsGuard(snapshot()), rangeScope(ids.range), { layer_height: 0.16 }));
  execute(scopedOverrides(settingsGuard(snapshot()), objectScope(ids.object), {}));
  for (const bad of [() => scopedOverrides(current(), partScope(ids.volume), { brim_width: 1 }),
    () => scopedOverrides(current(), rangeScope(ids.range), { curr_bed_type: "x", brim_width: 1, layer_height: 0.1 }),
    () => scopedOverrides(initial, plateScope(ids.plate), {}), () => scopedOverrides(current(), plateScope("import:plate:missing"), {}),
    () => scopedOverrides(current(), rangeScope("import:range:missing"), {}), () => scopedOverrides(current(), partScope("bad"), {}),
    () => scopedOverrides(current(), objectScope(ids.object), "null")])
    execute(bad());
  batch([scopedOverrides(settingsGuard(snapshot()), plateScope(ids.plate), { curr_bed_type: "Smooth PEI Plate" }), add("import:plate:settings", "Settings", 3, false)], "Settings transaction");
  batch([scopedOverrides(settingsGuard(snapshot()), plateScope(ids.plate), { curr_bed_type: "Engineering Plate" }), scopedOverrides(settingsGuard(snapshot()), objectScope(ids.object), { wall_loops: 9 })], "Stale settings transaction");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const convertRole = (volumeId, role) => ({ convertVolumeRole: { volumeId: units(volumeId), role } });
scenario("volume-roles", {}, (s) => {
  const object = s.plates[0].objects[0], base = object.volumes[0];
  const [p0, p1] = s.filaments.physical.map(p => p.id);
  const unpainted = { topologyRevision: 0, color: [], support: [], seam: [], fuzzySkin: [], brim: [] };
  const volume = (id, role, extra = {}) => {
    const copy = JSON.parse(JSON.stringify(base));
    delete copy.filamentId;
    return { ...copy, id, name: id, role, annotations: { ...unpainted }, ...extra };
  };
  object.volumes = [base, volume("import:volume:part2", "model", { filamentId: p0 }), volume("import:volume:negative", "negative-volume"),
    volume("import:volume:modifier", "parameter-modifier", { filamentId: p1 }), volume("import:volume:blocker", "support-blocker")];
  s.plates[0].objects.push(cloneObject(object, "single", { volumes: [volume("import:volume:single", "model")] }));
}, ({ execute, batch, run, ids }) => {
  execute(convertRole("import:volume:part2", "negativeVolume"));
  execute(volumeFilament(ids.object, "import:volume:part2", null));
  execute(convertRole("import:volume:part2", "negativeVolume"));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(convertRole(ids.volume, "parameterModifier"));
  execute(convertRole("import:volume:modifier", "model"));
  execute(convertRole(ids.volume, "parameterModifier"));
  execute(convertRole("import:volume:blocker", "supportBlocker"));
  execute(convertRole("import:volume:blocker", "supportEnforcer"));
  execute(convertRole("import:volume:negative", "model"));
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" });
  for (const bad of [convertRole("import:volume:single", "supportEnforcer"), convertRole("import:volume:missing", "model"), convertRole("bad", "model")])
    execute(bad);
  batch([convertRole("import:volume:part2", "model"), convertRole("import:volume:blocker", "parameterModifier")], "Role transaction");
  batch([convertRole("import:volume:blocker", "negativeVolume"), convertRole("import:volume:single", "negativeVolume")], "Rolled back roles");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const facetGuard = (snap, volumeId, o = {}) => {
  const volume = snap.state.plates.flatMap(p => p.objects).flatMap(o => o.volumes).find(v => v.id === volumeId);
  return { revision: snap.revision, hash: units(snap.hash), volumeId: units(volumeId), topologyRevision: volume ? volume.source.topologyRevision : 0,
    triangleCount: volume ? volume.source.triangleCount : 1, ...o };
};
const strokeRanges = ranges => ranges.map(([start, endExclusive]) => ({ start, endExclusive }));
const paintStroke = (guard, channel, ranges, value, label) => ({ facetStroke: { guard, channel,
  operation: { paint: { ranges: strokeRanges(ranges), value: typeof value === "string" ? { text: units(value) } : { flag: value } } }, label: optionalValue(label, units) } });
const eraseStroke = (guard, channel, ranges) => ({ facetStroke: { guard, channel, operation: { erase: { ranges: strokeRanges(ranges) } }, label: { absent: {} } } });
const resetStroke = (guard, channel) => ({ facetStroke: { guard, channel, operation: { reset: {} }, label: { absent: {} } } });
scenario("facet-strokes", {}, (s, f) => {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const [p0, p1] = s.filaments.physical.map(p => p.id);
  const object = s.plates[0].objects[0], volume = object.volumes[0];
  volume.source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  volume.annotations = { topologyRevision: 0, color: [{ value: p1, triangles: [30, 31] }], support: [{ value: "block", triangles: [40] }],
    seam: [], fuzzySkin: [], brim: [],
    refinement: { color: { version: 2, triangleCount: 48, splits: [{ triangle: 3, node: facetSplit([facetLeaf(p0), facetLeaf(p1)]) },
      { triangle: 25, node: facetSplit([facetLeaf(p0), facetLeaf()]) }] } } };
  const modifier = JSON.parse(JSON.stringify(volume));
  Object.assign(modifier, { id: "import:volume:modifier", name: "Modifier", role: "parameter-modifier",
    annotations: { topologyRevision: 0, color: [], support: [], seam: [], fuzzySkin: [], brim: [] } });
  delete modifier.filamentId;
  object.volumes.push(modifier);
}, ({ execute, batch, run, ids, state, snapshot }) => {
  const [p0, p1] = state().filaments.physical.map(p => p.id), v = ids.volume;
  const g = (o) => facetGuard(snapshot(), v, o);
  execute(paintStroke(g(), "color", [[0, 5]], p0));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(paintStroke(g(), "color", [[20, 22], [3, 8], [6, 7]], p1, "Paint the band"));
  execute(eraseStroke(g(), "color", [[2, 4]]));
  execute(paintStroke(g(), "support", [[10, 12]], "enforce"));
  execute(paintStroke(g(), "seam", [[12, 14]], "avoid"));
  execute(paintStroke(g(), "fuzzySkin", [[14, 15]], true));
  execute(paintStroke(g(), "brim", [[15, 17]], false));
  execute(eraseStroke(g(), "seam", [[40, 42]]));
  execute(paintStroke(g(), "support", [[10, 12]], "enforce"));
  execute(eraseStroke(g(), "support", []));
  const stale = g();
  execute(resetStroke(g(), "color"));
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" });
  for (const bad of [() => paintStroke(g(), "color", [[0, 1]], "import:filament:missing"), () => paintStroke(g(), "support", [[0, 1]], "bogus"),
    () => paintStroke(g(), "fuzzySkin", [[0, 1]], false), () => paintStroke(g(), "brim", [[0, 1]], "true"),
    () => paintStroke(g(), "color", [[5, 5]], p0), () => paintStroke(g(), "color", [[5, 5], [40, 49]], p0),
    () => paintStroke(stale, "color", [[0, 1]], p0), () => paintStroke(g({ topologyRevision: 1 }), "color", [[0, 1]], p0),
    () => paintStroke(g({ triangleCount: 47 }), "color", [[0, 1]], p0), () => paintStroke(facetGuard(snapshot(), "import:volume:modifier"), "color", [[0, 1]], p0),
    () => paintStroke(g({ volumeId: units("import:volume:missing") }), "color", [[0, 1]], p0), () => paintStroke(g({ volumeId: units("bad") }), "color", [[0, 1]], p0)])
    execute(bad());
  batch([paintStroke(g(), "seam", [[20, 21]], "prefer"), convertRole("import:volume:modifier", "supportBlocker")], "Stroke transaction");
  batch([paintStroke(g(), "seam", [[22, 23]], "prefer"), paintStroke(g(), "seam", [[23, 24]], "avoid")], "Stale stroke transaction");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const renameProject = name => ({ renameProject: { name: units(name) } });
const wipeTowerInput = (enabled, positionMm, rotationDeg, filamentId) => ({ enabled, positionMm, rotationDeg, filamentId: filamentId === undefined ? { absent: {} } : { value: units(filamentId) } });
const setWipeTower = (plateId, tower, label) => ({ setPlateWipeTower: { plateId: units(plateId), wipeTower: tower === undefined ? { absent: {} } : { value: tower }, label: optionalValue(label, units) } });
const reconcile = (guard, filaments, label) => ({ reconcileAutoPairs: { guard, filaments: filaments.map(f => mixedInput(f)), label: optionalValue(label, units) } });
scenario("project-plate-reconcile", {}, noop, ({ execute, batch, run, ids, state, snapshot }) => {
  const [p0, p1] = state().filaments.physical.map(p => p.id);
  execute(renameProject("Workshop build 😀"));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(renameProject("Workshop build 😀"));
  execute(renameProject("  "));
  execute(setWipeTower(ids.plate, wipeTowerInput(true, [120, 80], 15, p0)));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(setWipeTower(ids.plate, wipeTowerInput(true, [120, 80], 15, p0)));
  execute(setWipeTower(ids.plate, wipeTowerInput(false, [10, -5.5], 0)));
  execute(setWipeTower(ids.plate, wipeTowerInput(true, [1, 2], 90, p1), "Move the tower"));
  execute(setWipeTower(ids.plate, undefined));
  run({ kind: "undo" });
  for (const bad of [setWipeTower("import:plate:missing", undefined), setWipeTower("bad", undefined),
    setWipeTower(ids.plate, wipeTowerInput(true, [0, 0], 0, "bad")), setWipeTower(ids.plate, wipeTowerInput(true, [0, 0], 0, "import:filament:missing"))])
    execute(bad);
  const current = () => settingsGuard(snapshot());
  const auto = createFullSpectrumMixedFilament("import:mixed:auto", state().filaments.physical, { mode: "ratio", name: "Auto pair", displayColor: "#7F007F",
    componentFilamentIds: [p0, p1], mixBPercent: 50 });
  const existing = () => state().filaments.mixed;
  execute(reconcile(current(), [...existing(), auto]));
  run({ kind: "undo" }); run({ kind: "redo" });
  execute(reconcile(current(), existing()));
  execute(reconcile(current(), [auto], "Drop manual pairs"));
  const stale = settingsGuard(snapshot());
  execute(renameProject("Moved on"));
  for (const bad of [() => reconcile(stale, existing()), () => reconcile(current(), [{ ...auto, components: [{ filamentId: p0, weight: 1 }] }])])
    execute(bad());
  batch([renameProject("Batched"), setWipeTower(ids.plate, wipeTowerInput(true, [50, 50], 45))], "Project transaction");
  batch([renameProject("Rolled back"), setWipeTower("import:plate:missing", undefined)], "Rolled back project");
  run({ kind: "undo" }); run({ kind: "redo" });
});

const colorMapping = (sourceColor, destination, sources) => ({ sourceColor: units(sourceColor), destinationFilamentId: units(destination),
  sourceFilamentIds: sources === undefined ? { absent: {} } : { value: sources.map(units) } });
const recreateColors = (mappings, o = {}) => ({ recreateModelColors: { mappings, newMixedFilaments: (o.mixed ?? []).map(m => mixedInput(m)),
  printerSlots: o.slots ?? [], candidateTools: (o.candidates ?? []).map(([toolId, id]) => ({ toolId, filamentId: units(id) })),
  newFilamentIds: o.ids === undefined ? { absent: {} } : { value: o.ids.map(units) } } });
scenario("recreate-model-colors", {}, (s, f) => {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const [p0, p1] = s.filaments.physical.map(p => p.id), purple = s.filaments.mixed[0].id;
  const object = s.plates[0].objects[0], volume = object.volumes[0];
  volume.source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  volume.filamentId = p0;
  volume.annotations.color = [{ value: p0, triangles: [1, 2] }, { value: purple, triangles: [0] }, { value: p1, triangles: [5] }];
  volume.annotations.refinement = { color: { version: 2, triangleCount: 48, splits: [{ triangle: 3, node: facetSplit([facetLeaf(p0), facetLeaf(p1)]) }] } };
  volume.extensionData = { "orcaxr:sourceMaterial": { color: " #ff0000 ", name: "Red" }, "orcaxr:originalFilamentColors": { [p1]: "#00ff00" } };
  object.layerRanges[0].filamentId = p0;
  s.plates[0].wipeTower = { enabled: true, positionMm: [5, 5], rotationDeg: 0, filamentId: p0 };
  s.extensionData = { "orcaxr:originalFilamentColors": { [p0]: "#FF0000" } };
}, ({ execute, run, state }) => {
  const [p0, p1] = state().filaments.physical.map(p => p.id);
  execute(recreateColors([colorMapping("#FF0000", p1, [p0])]));
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" });
  execute(recreateColors([colorMapping("00ff00", p0), colorMapping("#0000FF", p1, [p1])]));
  run({ kind: "undo" });
  const slots = [printerSlot(0, "#ff0000", "PLA", { vendor: "Elegoo", subType: "Matte" }), printerSlot(2, " #12ab34 ", "PETG"), printerSlot(3, "teal", "PLA")];
  execute(recreateColors([colorMapping("#12AB34", "import:filament:adopt-2", [p1])], { slots, ids: ["import:filament:adopt-2"], candidates: [[3, "import:filament:candidate-3"]] }));
  run({ kind: "undo" }); run({ kind: "redo" });
  run({ kind: "undo" });
  const blend = { id: "import:mixed:recreated", name: "Recreated blend", displayColor: "#7F7F00", components: [{ filamentId: p0, weight: 1 }, { filamentId: p1, weight: 1 }],
    distribution: { mode: "ratio" }, config: {}, enabled: true };
  execute(recreateColors([colorMapping("#FF0000", blend.id, [p0]), colorMapping("#00FF00", blend.id)], { mixed: [blend] }));
  run({ kind: "undo" });
  execute(recreateColors([colorMapping("#ABCDEF", p0)]));
  for (const bad of [recreateColors([colorMapping("#FF0000", "import:filament:missing", [p0])]),
    recreateColors([colorMapping("#FF0000", p1)], { slots: [printerSlot(5, "#000000", "PLA"), printerSlot(6, "#000000", "PLA")], ids: ["import:filament:only"] }),
    recreateColors([colorMapping("#FF0000", "bad")])])
    execute(bad);
});

// Split to objects: the revision/hash guard, every identity and source refusal,
// instance offset transfer through non-unit quaternions and mirrored scales,
// selection remapping, and whole-state undo/redo.
const separateVolumes = (guard, objectId, identities) => ({ separateObjectVolumes: { guard, objectId: units(objectId),
  identities: identities.map(([sourceVolumeId, id, instanceIds]) => ({ sourceVolumeId: units(sourceVolumeId), objectId: units(id), instanceIds: instanceIds.map(units) })) } });
const splitIdentities = (object, suffix) => object.volumes.map((v, i) => [v.id, `import:object:${suffix}${i}`, object.instances.map((_, j) => `import:instance:${suffix}${i}-${j}`)]);
const splitSource = (template, suffix, mutate) => {
  const object = cloneJson(template);
  Object.assign(object, { id: `import:object:${suffix}`, layerRanges: [] });
  object.volumes = object.volumes.slice(0, 2).map((v, i) => ({ ...v, id: `import:volume:${suffix}${i}` }));
  object.instances = [{ ...object.instances[0], id: `import:instance:${suffix}` }];
  delete object.brimEars; delete object.foreign;
  mutate(object);
  return object;
};
function splitFixture(s, f) {
  f.asset = coneAsset(f.ids.asset);
  s.sourceAssets = s.sourceAssets.map(a => (a.id === f.asset.descriptor.id ? f.asset.descriptor : a));
  const object = s.plates[0].objects[0], body = object.volumes[0];
  body.source.triangleCount = f.asset.descriptor.mesh.triangleCount;
  body.transform = { translationMm: [3, -4, 5], rotation: [0.1, 0.2, 0.3, 0.9], scale: [1, 2, 0.5] };
  object.volumes.push(
    { ...cloneJson(body), id: "import:volume:wing", name: "Wing", filamentId: f.ids.physical1, config: { sparse_infill_density: 40, wall_loops: 5 },
      transform: { translationMm: [-7.25, 0.001, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, extensionData: { "orcaxr:note": "kept" } },
    { ...cloneJson(body), id: "import:volume:cap", name: "Cap\\\"\u0000\ud800😀", config: {}, transform: { translationMm: [0, 0, 12.5], rotation: [0, 0, 0, 2], scale: [-1, 1, 1] } });
  object.layerRanges = [];
  object.extensionData = {};
  object.brimEars = [{ positionMm: [1, 2, 0], headFrontRadiusMm: 1 }];
  object.foreign = { dropped: true };
  object.instances[0].transform = { translationMm: [100, 50, 0], rotation: [0, 0, 0.3826834323650898, 0.9238795325112867], scale: [1.5, 1.5, 1.5] };
  object.instances.push({ id: "import:instance:second", name: "Second", transform: { translationMm: [-20, 10, 1], rotation: [1, 1, 1, 1], scale: [1, -1, 2] }, printable: false, extensionData: { kept: 1 } });
  s.plates[0].objects.push(
    splitSource(object, "single", o => { o.volumes.length = 1; }),
    splitSource(object, "modifier", o => { o.volumes[1].role = "parameter-modifier"; o.volumes[1].annotations = { ...o.volumes[1].annotations, color: [] }; }),
    splitSource(object, "ranged", o => { o.layerRanges = [{ id: "import:range:ranged", minZMm: 0, maxZMm: 5, config: {} }]; }),
    splitSource(object, "extended", o => { o.extensionData = { "orcaxr:owner": "host" }; }),
    splitSource(object, "far", o => { o.volumes[1].transform = { translationMm: [1e308, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }; o.instances[0].transform.scale = [10, 10, 10]; }));
}
scenario("split-to-objects", {}, splitFixture, ({ execute, run, state, snapshot, ids }) => {
  const guard = () => settingsGuard(snapshot());
  const objectAt = id => state().plates[0].objects.find(o => o.id === id);
  const fresh = splitIdentities(objectAt(ids.object), "split");
  const edit = (index, change) => fresh.map((identity, i) => (i === index ? change(cloneJson(identity)) : identity));
  run({ kind: "selection", refs: [{ kind: "object", id: units(ids.object) }, { kind: "plate", id: units(ids.plate) }, { kind: "volume", id: units("import:volume:wing") },
    { kind: "instance", id: units("import:instance:modifier") }, { kind: "instance", id: units("import:instance:second") }] });
  execute(separateVolumes({ ...guard(), sourceRevision: snapshot().revision + 1 }, ids.object, fresh));
  execute(separateVolumes({ ...guard(), sourceHash: units("fnv1a64:0000000000000000") }, ids.object, fresh));
  execute(separateVolumes(guard(), "import:object:missing", fresh));
  execute(separateVolumes(guard(), ids.object, fresh.slice(0, 2)));
  execute(separateVolumes(guard(), ids.object, [fresh[1], fresh[0], fresh[2]]));
  execute(separateVolumes(guard(), ids.object, edit(1, i => [i[0], "import:object:modifier", i[2]])));
  execute(separateVolumes(guard(), ids.object, edit(2, i => [i[0], fresh[0][1], i[2]])));
  execute(separateVolumes(guard(), ids.object, edit(0, i => [i[0], i[1], i[2].slice(1)])));
  execute(separateVolumes(guard(), ids.object, edit(1, i => [i[0], i[1], ["import:instance:second", i[2][1]]])));
  execute(separateVolumes(guard(), ids.object, edit(0, i => [i[0], i[1], [i[1], i[2][1]]])));
  execute(separateVolumes(guard(), ids.object, edit(2, i => [i[0], i[1], [i[2][0], fresh[1][2][1]]])));
  execute(separateVolumes(guard(), ids.object, edit(0, i => [i[0], "bad", i[2]])));
  for (const suffix of ["single", "modifier", "ranged", "extended", "far"])
    execute(separateVolumes(guard(), `import:object:${suffix}`, splitIdentities(objectAt(`import:object:${suffix}`), `${suffix}-out`)));
  const before = guard();
  execute(separateVolumes(before, ids.object, fresh));
  assert.equal(state().plates[0].objects.length, 8);
  run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "undo" }); run({ kind: "redo" });
  execute(separateVolumes(before, ids.object, fresh));
  execute(separateVolumes(guard(), ids.object, fresh));
  execute(separateVolumes(guard(), "import:object:split1", splitIdentities(objectAt("import:object:split1"), "again")));
  run({ kind: "undo" });
  run({ kind: "selection", refs: [] });
  execute(separateVolumes(guard(), ids.object, splitIdentities(objectAt(ids.object), "again")));
  run({ kind: "undo" }); run({ kind: "redo" });
});
// History retention charges the escaped source fingerprint, the identities and
// both whole states: with a following rename, an exact budget keeps the split
// and one unit less evicts it.
const splitProbe = createProjectFixture(); splitFixture(splitProbe.state, splitProbe);
const splitStore = new ProjectStore(splitProbe.state);
const splitBus = new CommandBus({ project: splitStore, selection: new SelectionStore(), assets: new InMemoryAssetRepository() });
const splitCommand = prepareProjectIntent({ version: 1, command: separateVolumes(settingsGuard(splitStore.getSnapshot()), splitProbe.ids.object, splitIdentities(splitProbe.state.plates[0].objects[0], "split")) });
splitBus.execute(splitCommand);
const splitRename = prepareProjectIntent({ version: 1, command: rename(splitProbe.ids.plate, "After split") });
splitBus.execute(splitRename);
const splitBytes = splitCommand.estimateBytes() + Math.max(1, splitRename.estimateBytes?.() ?? 1);
for (const [label, budget] of [["exact", splitBytes], ["short", splitBytes - 1]])
  scenario(`split-to-objects-retention-${label}`, { maxEstimatedBytes: budget }, splitFixture, ({ execute, run, state, snapshot, ids }) => {
    execute(separateVolumes(settingsGuard(snapshot()), ids.object, splitIdentities(state().plates[0].objects[0], "split")));
    execute(rename(ids.plate, "After split"));
    assert.equal(state().plates[0].objects.length, 8);
    run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" }); run({ kind: "redo" });
  });
// An import's provenance (`orcaxr:importSource`, as a model import and a geometry
// merge write it) is copied to every promoted object; an unknown key beside it
// still refuses the promotion.
const provenance = (filename, extra) => ({ "orcaxr:importSource": { filename, ...extra, importedAt: "2026-10-10T00:00:00.000Z" } });
scenario("split-to-objects-provenance", {}, (s, f) => {
  splitFixture(s, f);
  const object = s.plates[0].objects[0];
  s.plates[0].objects.push(
    splitSource(object, "imported", o => { o.extensionData = provenance("pair.stl", { format: "stl", unit: "mm" }); }),
    splitSource(object, "merged", o => { o.extensionData = provenance("parts.3mf", { format: "project-3mf", mode: "geometry-only" }); }),
    splitSource(object, "mixed", o => { o.extensionData = { ...provenance("pair.stl", { format: "stl", unit: "mm" }), "orcaxr:owner": "host" }; }));
}, ({ execute, run, state, snapshot }) => {
  const objectAt = id => state().plates[0].objects.find(o => o.id === id);
  for (const suffix of ["mixed", "imported", "merged"])
    execute(separateVolumes(settingsGuard(snapshot()), `import:object:${suffix}`, splitIdentities(objectAt(`import:object:${suffix}`), `${suffix}-out`)));
  assert.ok(objectAt("import:object:mixed"), "an unknown key refuses the promotion");
  for (const [suffix, expected] of [["imported", provenance("pair.stl", { format: "stl", unit: "mm" })], ["merged", provenance("parts.3mf", { format: "project-3mf", mode: "geometry-only" })]])
    for (const i of [0, 1]) assert.deepEqual(objectAt(`import:object:${suffix}-out${i}`).extensionData, expected, `${suffix} ${i}`);
  run({ kind: "undo" }); run({ kind: "undo" }); run({ kind: "redo" });
});
scenario("split-to-objects-small-facets", {}, s => {
  const object = s.plates[0].objects[0];
  object.volumes.push({ ...cloneJson(object.volumes[0]), id: "import:volume:second", name: "Second" });
  s.plates[0].objects.push(splitSource(object, "modifier", o => { o.volumes[0].role = "negative-volume"; o.volumes[0].annotations = { ...o.volumes[0].annotations, color: [] }; }));
}, ({ execute, state, snapshot, ids }) => {
  for (const object of state().plates[0].objects)
    execute(separateVolumes(settingsGuard(snapshot()), object.id, splitIdentities(object, `${object.id.split(":")[2]}-out`)));
  assert.equal(state().plates[0].objects.length, 2);
  void ids;
});
const sources = ["tools/cross-platform/project-command-vectors.mjs", "web/src/project/commands.ts", "web/src/project/objects/commands.ts", "web/src/project/objects/transformCommands.ts", "web/src/project/objects/layerRangeCommands.ts", "web/src/project/layerEventCommands.ts", "web/src/project/objects/brimEarCommands.ts", "web/src/project/objects/layerHeightCommands.ts", "web/src/project/objects/layerHeightProfile.ts", "web/src/project/meshCodec.ts", "web/src/project/filaments/recreateModelColors.ts", "web/src/project/objects/splitToObjectsCommands.ts", "web/src/project/filaments/autoPairReconciliation.ts", "web/src/project/annotations/FacetAnnotationStrokeCommand.ts", "web/src/project/annotations/sparse.ts", "web/src/project/annotations/types.ts", "web/src/project/objects/semanticVolumeCommands.ts", "web/src/project/settingsOverrides.ts", "web/src/project/scopedOverrides.ts", "web/src/project/domain/settingScopes.ts", "web/src/project/filaments/commands.ts", "web/src/project/filaments/mixedCommands.ts", "web/src/project/filaments/fullSpectrumRecipe.ts", "web/src/project/domain/facetRefinement.ts", "web/src/project/domain/selectors.ts", "web/src/project/PreparedProjectCommands.ts", "web/src/project/history/command.ts", "web/src/project/history/commandBus.ts", "web/src/project/store.ts", "web/src/project/selection.ts", "web/src/project/assets.ts", "web/src/project/domain/canonical.ts", "web/src/project/domain/model.ts", "web/src/project/domain/ids.ts", "web/src/project/domain/validation.ts", "web/src/project/__tests__/fixtures.ts", "contracts/generated/project-intents.ts", "contracts/runtime/project-intents.ts", "contracts/project-intents.json"];
const output = JSON.stringify({ schemaVersion: 1, sources: sources.map(path => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })), contents, traces }, null, 2) + "\n";
const path = new URL("testdata/cross-platform/project-command-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Project command/history reference drift");
console.log(`Project command references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} complete contents`);
