// Independent reference: actual TypeScript session, asynchronous facade and
// string endpoint, including groups submitted before the queue may execute.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession, StaleProjectResultError } from "../../web/src/project/session.ts";
import { AsyncEditorSession } from "../../web/src/project/AsyncEditorSession.ts";
import { ProjectSessionEndpoint, wireSessionGuard } from "../../web/src/project/ProjectSessionEndpoint.ts";
import { decodeProjectSessionReply, encodeProjectSessionRequest, encodeProjectSessionReply } from "../../contracts/generated/project-intents.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify, cloneJson } from "../../web/src/project/domain/canonical.ts";
const root = new URL("../../", import.meta.url), read = p => readFileSync(new URL(p, root), "utf8");
process.env.TZ = "UTC";
const commands = JSON.parse(read("testdata/cross-platform/project-command-vectors.json"));
const nonce = [0, 1, 2147483648, 4294967295];
const units = s => Array.from({length:s.length}, (_,i) => s.charCodeAt(i));
const text = u => String.fromCharCode(...u);
const hello = { hello: { minProtocolVersion:1, maxProtocolVersion:1, projectSchemaVersion:1, intentVersion:1 } };
const contents = [], traces = [];
function snapshot(s) {
  const value = canonicalStringify(s.state); let content = contents.indexOf(value);
  if (content < 0) { content = contents.length; contents.push(value); }
  return { revision:s.revision, hash:s.hash, content };
}
const ref = r => r.kind === "project" ? r : {kind:r.kind, id:units(r.id)};
const selectionValue = s => ({refs:s.refs.map(ref), primary:s.primary ? ref(s.primary) : null});
const historyValue = h => ({...h, undoLabel:h.undoLabel === undefined ? null : units(h.undoLabel), redoLabel:h.redoLabel === undefined ? null : units(h.redoLabel)});
async function scenario(name, fixture, work) {
  const state = JSON.parse(fixture.stateJson), assets = new InMemoryAssetRepository();
  assets.put(JSON.parse(fixture.asset.descriptorJson), Uint8Array.from(fixture.asset.bytes));
  const session = new EditorSession({initialState:state, assets, history:fixture.options, serializer:{async serialize(){throw Error("unused")},async deserialize(){throw Error("unused")}}});
  const facade = new AsyncEditorSession(session), endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
  const effects = [], steps = [], saved = new Map(); let sequence = 0;
  const wire = (operation, overrides = {}) => encodeProjectSessionRequest({protocolVersion:1, generation:nonce, requestId:++sequence, operation, ...overrides});
  const guard = () => wireSessionGuard(facade.captureGuard());
  const observe = () => ({snapshot:snapshot(session.project.getSnapshot()), selection:selectionValue(session.selection.getSnapshot()), history:historyValue(session.commands.getHistorySnapshot()), historyRevision:session.commands.getHistoryRevision(), assets:assets.bundleFingerprint()});
  session.project.subscribe(c => effects.push({kind:"project",previous:snapshot(c.previous),current:snapshot(c.current),reason:units(c.reason),dirtyCategories:c.dirtyCategories}));
  session.selection.subscribe((current,previous) => effects.push({kind:"selection",previous:selectionValue(previous),current:selectionValue(current)}));
  session.commands.subscribeHistory((current,previous) => effects.push({kind:"history",previous:historyValue(previous),current:historyValue(current)}));
  const initial = observe();
  async function group(requests, host = []) {
    effects.length = 0;
    const promises = requests.map(r => endpoint.handle(r));
    const hostOutcomes = [];
    for (const op of host) {
      let outcome = null;
      if (op.kind === "checkpoint") session.commands.markCheckpoint();
      else if (op.kind === "selection") session.selection.set(op.refs.map(r => r.kind === "project" ? r : {...r,id:text(r.id)}));
      else if (op.kind === "captureSave") saved.set(op.name,session.captureExportGuard());
      else if (op.kind === "saveCheckpoint") {
        assert.ok(saved.has(op.name));
        try { session.acknowledgeSavedCheckpoint(saved.get(op.name)); outcome="saved"; }
        catch(e) { if (!(e instanceof StaleProjectResultError)) throw e; outcome="stale"; }
      }
      else if (op.kind === "dispose") endpoint.dispose();
      else throw Error("unknown host operation");
      hostOutcomes.push(outcome);
    }
    const replies = (await Promise.all(promises)).map(r => JSON.parse(r));
    steps.push({requests,host,hostOutcomes,replies,effects:[...effects],...observe()});
  }
  await work({wire,guard,group,session,facade});
  traces.push({name, options:fixture.options, stateJson:fixture.stateJson, asset:fixture.asset, initial, steps});
  session.dispose();
}
for (const trace of commands.traces) {
  await scenario(`commands:${trace.name}`, trace, async ({wire,guard,group}) => {
    await group([wire(hello)]);
    for (const step of trace.steps) {
      const op = step.operation;
      if (op.kind === "intent") await group([wire({execute:{guard:guard(),intent:JSON.parse(op.json)}})]);
      else if (op.kind === "batch") await group([wire({transaction:{guard:guard(),batch:JSON.parse(op.json)}})]);
      else if (op.kind === "undo" || op.kind === "redo") await group([wire({[op.kind]:guard()})]);
      else if (op.kind === "checkpoint") await group([], [{kind:"checkpoint"}]);
      else if (op.kind === "selection") await group([], [op]);
      // There is intentionally no clear-history operation in the shared wire
      // protocol; the session's own history follows its actual accepted work.
    }
    await group([wire({query:{}})]); await group([wire({close:{}})]);
  });
}
const base = commands.traces[0];
await scenario("staged-reference-control-without-host-upload", base, async ({wire,group}) => {
  const execute = {executeStaged:{stagedId:1}}, release = {releaseStaged:{stagedId:1}};
  await group([wire(release),wire(execute)]);
  await group([wire(hello)]);
  await group([wire(release),wire(execute)]);
  await group([...Array.from({length:32},()=>wire({query:{}})),wire({releaseStaged:{stagedId:Number.MAX_SAFE_INTEGER}}),wire(execute)]);
  const missing = wire({executeStaged:{stagedId:Number.MAX_SAFE_INTEGER}});
  await group([missing,wire({cancel:{targetRequestId:JSON.parse(missing).requestId}})]);
  await group([wire({close:{}}),wire(release)]);
});
await scenario("object-edit-stale-cancel-and-close", base, async ({wire,guard,group,session}) => {
  await group([wire(hello)]);
  const o = session.project.getSnapshot().state.plates[0].objects[0];
  const transform = {translationMm:[1.25,-2.5,0],rotation:[0,0,0,1],scale:[1,1,-1]};
  const edits = [
    {renameObject:{objectId:units(o.id),name:units('edited object')}},
    {renameVolume:{volumeId:units(o.volumes[0].id),name:units('edited part')}},
    {renameInstance:{instanceId:units(o.instances[0].id),name:units('edited copy')}},
    {setInstancePrintable:{instanceId:units(o.instances[0].id),printable:false}},
    {setInstanceTransform:{instanceId:units(o.instances[0].id),transform,gestureId:units('gesture')}},
    {setInstanceTransforms:{changes:[{instanceId:units(o.instances[0].id),transform}],gestureId:units('gesture')}},
  ];
  for (const command of edits) {
    const operation = () => ({execute:{guard:guard(),intent:{version:1,command}}});
    const stale = operation(); stale.execute.guard.historyRevision++;
    await group([wire(stale)]);
    const cancelled = wire(operation());
    await group([cancelled,wire({cancel:{targetRequestId:JSON.parse(cancelled).requestId}})]);
    await group([wire(operation())]);
    await group([wire({undo:guard()})]);
  }
  await group([wire({execute:{guard:guard(),intent:{version:1,command:edits[4]}}}),wire({close:{}})]);
});
await scenario("handshake-replay-malformed-and-guard-precedence", base, async ({wire,guard,group}) => {
  await group([wire({query:{}}), wire({cancel:{targetRequestId:1}})]);
  await group([wire({...hello,hello:{...hello.hello,intentVersion:2}}), wire(hello,{generation:[1,2,3,4]}), wire(hello,{protocolVersion:2})]);
  const valid = wire(hello); await group([valid]); await group([valid,wire({query:{}},{requestId:1})]);
  const malformed = ["PRIVATE_INVALID_REQUEST",'{"requestId":2,"requestId":2}', wire({query:{}}).replace('"query":{}','"query":[]'), wire({query:{}}).replace('"protocolVersion":1','"protocolVersion":1.0'), wire({query:{}}).replace('"requestId":','"unknown":0,"requestId":')];
  await group(malformed);
  const execute = {execute:{guard:guard(),intent:{version:1,command:{renamePlate:{plateId:guard().projectId,name:units("unknown plate")}}}}};
  for (const [field,value] of [["revision",999],["historyRevision",999],["projectId",units("import:wrong:id")],["semanticHash",units("wrong")],["assetFingerprint",units("wrong")]]) {
    const op = cloneJson(execute); op.execute.guard[field] = value; await group([wire(op)]);
  }
  const badId = cloneJson(execute); badId.execute.guard.projectId = units("bad"); await group([wire(badId)]);
  await group([wire({query:{}})]);
});
await scenario("queue-stale-cancel-close-and-backpressure", base, async ({wire,guard,group,session}) => {
  await group([wire(hello)]);
  const rename = name => ({execute:{guard:guard(),intent:{version:1,command:{renamePlate:{plateId:units(session.project.getSnapshot().state.activePlateId),name:units(name)}}}}});
  await group([wire(rename("first")),wire(rename("stale second")),wire({query:{}})]);
  const cancel = wire(rename("cancelled")), cancelId = JSON.parse(cancel).requestId;
  await group([cancel,wire({cancel:{targetRequestId:cancelId}}),wire({query:{}})]);
  await group([wire({cancel:{targetRequestId:cancelId}})]);
  await group([wire(rename("stale checkpoint")),wire({query:{}})], [{kind:"checkpoint"}]);
  await group([wire(rename("selection changed"))], [{kind:"selection",refs:[{kind:"project"}]}]);
  await group(Array.from({length:34}, () => wire({query:{}})));
  await group([wire(rename("after backpressure"))]);
  const invalid = rename(" "); invalid.execute.guard.revision = 999;
  const bad = wire(invalid), badId = JSON.parse(bad).requestId;
  await group([bad,wire({cancel:{targetRequestId:badId}})]);
  // Rejected preparation occupies an endpoint slot until its promise settles.
  await group(Array.from({length:33}, () => wire(rename(" "))));
  await group([wire(rename("closed pending")),wire({query:{}}),wire({close:{}})]);
  await group([wire({query:{}}),wire({close:{}}),"bad after close",wire(hello,{generation:[4,3,2,1]})]);
});
await scenario("rejected-preparation-survives-close", base, async ({wire,guard,group}) => {
  await group([wire(hello)]);
  const invalid = {execute:{guard:guard(),intent:{version:1,command:{renamePlate:{plateId:units("import:unknown:plate"),name:units(" ")}}}}};
  await group([wire(invalid),wire({close:{}})]);
});
await scenario("host-disposal-keeps-committed-outcome", base, async ({wire,guard,group,session}) => {
  await group([wire(hello)]);
  await group([wire({execute:{guard:guard(),intent:{version:1,command:{renamePlate:{plateId:units(session.project.getSnapshot().state.activePlateId),name:units("committed")}}}}})]);
  await group([wire({query:{}})], [{kind:"dispose"}]);
  await group([wire({query:{}})]);
});
const large = cloneJson(base); const state = JSON.parse(large.stateJson); state.id = "import:large:" + "x".repeat(131072); large.stateJson = canonicalStringify(state);
await scenario("oversized-imported-identity-does-not-block-control", large, async ({wire,group}) => {
  await group([wire(hello)]); await group([wire({query:{}})]); await group([wire({close:{}})]);
});
// Find the protocol node boundary where a valid mutation request fits, but
// its longer history-label acknowledgement does not. Expected completion comes
// from the real endpoint, never a hand-authored simulated error result.
const compactPlate = "import:p:1", newName = "r".repeat(120);
const candidateRequest = length => ({protocolVersion:1,generation:nonce,requestId:2,operation:{execute:{
  guard:{projectId:units("import:limit:"+"x".repeat(length-13)),revision:0,semanticHash:units("fnv1a64:0000000000000000"),assetFingerprint:units("fnv1a64:0000000000000000"),historyRevision:1},
  intent:{version:1,command:{renamePlate:{plateId:units(compactPlate),name:units(newName)}}}
}}});
let lower=130000,upper=131072;
while(lower<upper){const middle=Math.ceil((lower+upper)/2);try{encodeProjectSessionRequest(candidateRequest(middle));lower=middle;}catch{upper=middle-1;}}
const boundaryRequest = candidateRequest(lower);
assert.throws(()=>encodeProjectSessionReply({protocolVersion:1,generation:nonce,requestId:2,result:{acknowledged:{
  guard:boundaryRequest.operation.execute.guard,
  history:{undoCount:1,redoCount:0,undoLabel:{text:units("Rename plate to "+newName),present:true,truncated:false},redoLabel:{text:[],present:false,truncated:false},dirtyCategories:["projectData"]},changed:true
}}}));
const boundary = cloneJson(base), boundaryState = JSON.parse(boundary.stateJson);
boundaryState.id = "import:limit:"+"x".repeat(lower-13);
const oldPlate = boundaryState.activePlateId; boundaryState.activePlateId=compactPlate; boundaryState.plates[0].id=compactPlate;
for(const c of [...boundaryState.customGcode,...boundaryState.thumbnails])if(c.plateId===oldPlate)c.plateId=compactPlate;
boundary.stateJson=canonicalStringify(boundaryState);
await scenario("committed-mutation-with-unavailable-summary",boundary,async({wire,guard,group})=>{
  await group([wire(hello)]);
  await group([wire({execute:{guard:guard(),intent:boundaryRequest.operation.execute.intent}})]);
  await group([wire({query:{}})]);
  await group([wire({undo:guard()})]);
  await group([wire({redo:guard()})]);
  await group([wire({close:{}})]);
});
await scenario("save-acknowledgement-binds-export-not-history",base,async({wire,guard,group,session})=>{
  await group([wire(hello)]);
  await group([], [{kind:"captureSave",name:"save"}]);
  await group([], [{kind:"checkpoint"}]);
  await group([], [{kind:"saveCheckpoint",name:"save"}]);
  const rename = name => ({execute:{guard:guard(),intent:{version:1,command:{renamePlate:{plateId:units(session.project.getSnapshot().state.activePlateId),name:units(name)}}}}});
  await group([wire(rename("changed after capture"))]);
  await group([], [{kind:"saveCheckpoint",name:"save"}]);
  await group([], [{kind:"captureSave",name:"new"}]);
  await group([wire(rename("stale after saved checkpoint"))], [{kind:"saveCheckpoint",name:"new"}]);
  await group([], [{kind:"selection",refs:[{kind:"project"}]},{kind:"saveCheckpoint",name:"new"}]);
  await group([wire({query:{}})]);
});
const bundles = [];
for (const name of ["equal", "missing", "undeclared", "known-metadata", "unknown-metadata", "null-optional", "nested-layout", "foreign-and-signed-zero"]) {
  const state = JSON.parse(base.stateJson), descriptor = JSON.parse(base.asset.descriptorJson);
  if (name === "known-metadata") descriptor.mediaType = "application/changed";
  if (name === "unknown-metadata") descriptor.foreign = { private: "\ud800" };
  if (name === "null-optional") descriptor.sourceFilename = null;
  if (name === "nested-layout") descriptor.mesh.positions.count = 4;
  if (name === "foreign-and-signed-zero") {
    const foreign = JSON.parse('{"__proto__":{"private":"\\ud800"},"2":2,"10":10,"zero":0}');
    state.sourceAssets[0].foreign = cloneJson(foreign); descriptor.foreign = foreign; descriptor.foreign.zero = -0;
  }
  const payloads = name === "missing" ? [] : [{descriptor,bytes:base.asset.bytes}];
  if (name === "undeclared") payloads.push({descriptor:{...descriptor,id:"import:extra:asset"},bytes:base.asset.bytes});
  const assets = new InMemoryAssetRepository();
  for (const a of payloads) assets.put(a.descriptor,Uint8Array.from(a.bytes));
  let error = null;
  try { const session = new EditorSession({initialState:state,assets,serializer:{async serialize(){throw Error("unused")},async deserialize(){throw Error("unused")}}}); session.dispose(); }
  catch (e) { error = units(e.message); }
  bundles.push({name,stateJson:canonicalStringify(state),assets:payloads.map(a=>({descriptorJson:canonicalStringify(a.descriptor),bytes:a.bytes})),error});
}
const sources = ["tools/cross-platform/project-session-vectors.mjs","testdata/cross-platform/project-command-vectors.json","web/src/project/session.ts","web/src/project/AsyncEditorSession.ts","web/src/project/ProjectSessionEndpoint.ts","web/src/project/ProjectSessionClient.ts","web/src/project/PreparedProjectCommands.ts","web/src/project/StagedProjectCommands.ts","web/src/project/commands.ts","web/src/project/history/commandBus.ts","web/src/project/history/command.ts","web/src/project/assets.ts","web/src/project/store.ts","web/src/project/selection.ts","web/src/project/domain/canonical.ts","contracts/generated/project-intents.ts","contracts/runtime/project-intents.ts","contracts/project-intents.json"];
const result = JSON.stringify({schemaVersion:1,generation:nonce,sources:sources.map(path => ({path,sha256:createHash("sha256").update(read(path)).digest("hex")})),contents,traces,bundles},null,2)+"\n";
const output = new URL("testdata/cross-platform/project-session-vectors.json",root);
if (process.argv.includes("--write")) writeFileSync(output,result); else assert.equal(readFileSync(output,"utf8"),result,"Project session reference drift");
console.log(`Project session references: ${traces.length} traces, ${traces.reduce((n,t)=>n+t.steps.length,0)} groups, ${traces.reduce((n,t)=>n+t.steps.reduce((s,g)=>s+g.requests.length,0),0)} requests, ${contents.length} complete contents`);
