// Actual portable Kotlin codecs against independent shared wire fixtures.
// Host JVM execution does not replace Android instrumentation qualification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeProjectIntent, decodeProjectSessionRequest, decodeProjectBatch, decodeProjectSessionReply } from "../../contracts/generated/project-intents.ts";
import { startProjectJni } from "./project-jni-bridge.mjs";
const units = s => Array.from({length:s.length}, (_,i)=>s.charCodeAt(i));
const id = units('import:instance:\u0000\ud800'), gesture = units('gesture:\udfff');
const jvm = startProjectJni();
let accepted=0, refused=0, decoded=0, invalid=0;
let lifecycle=0;
let staged=0, stagedRefused=0;
try {
  const decoders = {Intent:decodeProjectIntent,Batch:decodeProjectBatch,SessionRequest:decodeProjectSessionRequest,SessionReply:decodeProjectSessionReply};
  const {cases} = JSON.parse(readFileSync(new URL('../../testdata/cross-platform/project-intent-vectors.json',import.meta.url),'utf8'));
  for (const test of cases) {
    if (test.expected === null) { assert.throws(()=>jvm.call('intentCodec',test.kind,test.input),undefined,test.label); invalid++; }
    else {
      assert.deepEqual(decoders[test.kind](jvm.call('intentCodec',test.kind,test.input)),test.expected,test.label);
      decoded++;
    }
  }
  // Exercise decoded escape collisions, exact structure, lexical and aggregate
  // budgets through the production codec. The TS decoder is the independent oracle.
  const allUnits=JSON.stringify({version:1,command:{deleteObject:{objectId:Array.from({length:65536},(_,i)=>i)}}});
  assert.deepEqual(decodeProjectIntent(jvm.call('intentCodec','Intent',allUnits)),decodeProjectIntent(allUnits));
  decoded++;
  const valid=cases.filter(test=>test.expected!==null);
  const probes=[
    ...valid.flatMap(test=>[
      {...test,input:' \t\r\n'+test.input+' \r\n'},
      {...test,input:test.input.replace(/"version"/g,'"\\u0076ersion"')},
      {...test,input:test.input+' null'}, {...test,input:test.input.slice(0,-1)+',}'},
      {...test,input:test.input.replace(/:/, '::')}, {...test,input:test.input.replace(/,/, ' ')},
    ]),
    ...['{"version":1,"\\u0076ersion":1,"command":{"undo":{}}}',
      '[', '{"x":}', '[0,]', '{"x":0,}', '{"x" 0}', '{"x": [1 2]}',
      '"\\u0000\\ud800\\udfff"', 'truefalse', '0x1', '1e999', 'NaN',
      '['.repeat(1000)+'0'+']'.repeat(1000),
      '['+'0,'.repeat(131072)+'0]', ' '.repeat(1048577)
    ].map(input=>({kind:'Intent',input}))
  ];
  for (const test of probes) {
    let expected=null;
    try { expected=decoders[test.kind](test.input); } catch {}
    if(expected===null) {assert.throws(()=>jvm.call('intentCodec',test.kind,test.input));invalid++;}
    else {assert.deepEqual(decoders[test.kind](jvm.call('intentCodec',test.kind,test.input)),expected);decoded++;}
  }
  for (const release of [false,true]) {
    for (const stagedId of [1,Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(decodeProjectSessionRequest(jvm.call('stagedReference',stagedId,release)), {
        protocolVersion:1,generation:[0,1,2147483648,4294967295],requestId:1,
        operation:{[release?'releaseStaged':'executeStaged']:{stagedId}},
      });
      staged++;
    }
    for (const id of [0,-1,Number.MAX_SAFE_INTEGER+1]) {
      assert.throws(()=>jvm.call('stagedReference',id,release)); stagedRefused++;
    }
  }
  for (const present of [false,true]) {
    const name=present?{value:[0,0xdfff,0xd83d,0xde00]}:{absent:{}};
    const destinationPlateId=present?{value:id}:{absent:{}};
    const ids={objectId:id,volumeIds:[id],instanceIds:[id],layerRangeIds:[id]};
    const commands=[
      {deleteObject:{objectId:id}}, {deletePlateObjects:{plateId:id}},
      {deleteInstance:{instanceId:id}}, {moveObjectToPlate:{objectId:id,destinationPlateId:id}},
      {duplicateObject:{sourceObjectId:id,ids,destinationPlateId,name}},
      {convertInstanceToObject:{instanceId:id,ids:{objectId:id,volumeIds:[id],instanceId:id,layerRangeIds:[id]},name}},
    ];
    for(const [kind,command] of commands.entries()) {
      assert.deepEqual(decodeProjectIntent(jvm.call('intentLifecycle',kind,present)),{version:1,command});
      lifecycle++;
    }
  }
  for (const batch of [false,true]) {
    for (const number of [0,-0,0.125,-0.125,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,1e100,-1e100,Number.MAX_SAFE_INTEGER+1]) {
      for(let i=0;i<10;i++) {
        const values=[0,0,0,0,0,0,1,1,1,1]; values[i]=number;
        const encoded=jvm.call('intentNumbers',Float64Array.from(values),batch);
        const normalize = values => values.map(v=>v===0?0:v);
        const transform={translationMm:normalize(values.slice(0,3)),rotation:normalize(values.slice(3,7)),scale:normalize(values.slice(7))};
        assert.deepEqual(decodeProjectIntent(encoded),{version:1,command:batch?{setInstanceTransforms:{changes:[{instanceId:id,transform}],gestureId:gesture}}:{setInstanceTransform:{instanceId:id,transform,gestureId:gesture}}});
        accepted++;
      }
    }
    for(const bad of [NaN,Infinity,-Infinity]) for(let i=0;i<10;i++) {
      const values=[0,0,0,0,0,0,1,1,1,1]; values[i]=bad;
      assert.throws(()=>jvm.call('intentNumbers',Float64Array.from(values),batch));refused++;
    }
    for(const length of [0,2,3,6,7,9,11]) {
      assert.throws(()=>jvm.call('intentNumbers',new Float64Array(length),batch));refused++;
    }
  }
} finally { await jvm.close(); }
console.log(`Kotlin transform writers: ${accepted} accepted numeric cases, ${refused} nonfinite/shape refusals`);
console.log(`Kotlin lifecycle writers: ${lifecycle} commands including absent/present UTF-16 options`);
console.log(`Kotlin staged reference writers: ${staged} accepted boundaries, ${stagedRefused} refusals`);

console.log(`Kotlin protocol codecs: ${decoded} accepted round trips, ${invalid} refusals`);
