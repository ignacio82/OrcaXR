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
  const f = createProjectFixture(); mutate(f.state);
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
  work({ execute, batch, run, state: () => project.getSnapshot().state, ids: f.ids });
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

const sources = ["tools/cross-platform/project-command-vectors.mjs", "web/src/project/commands.ts", "web/src/project/objects/commands.ts", "web/src/project/objects/transformCommands.ts", "web/src/project/objects/layerRangeCommands.ts", "web/src/project/PreparedProjectCommands.ts", "web/src/project/history/command.ts", "web/src/project/history/commandBus.ts", "web/src/project/store.ts", "web/src/project/selection.ts", "web/src/project/assets.ts", "web/src/project/domain/canonical.ts", "web/src/project/domain/model.ts", "web/src/project/domain/ids.ts", "web/src/project/domain/validation.ts", "web/src/project/__tests__/fixtures.ts", "contracts/generated/project-intents.ts", "contracts/runtime/project-intents.ts", "contracts/project-intents.json"];
const output = JSON.stringify({ schemaVersion: 1, sources: sources.map(path => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })), contents, traces }, null, 2) + "\n";
const path = new URL("testdata/cross-platform/project-command-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Project command/history reference drift");
console.log(`Project command references: ${traces.length} traces, ${traces.reduce((n, t) => n + t.steps.length, 0)} steps, ${contents.length} complete contents`);
