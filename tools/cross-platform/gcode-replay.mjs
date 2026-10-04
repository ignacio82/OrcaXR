// Executed inside the real browser task worker. Expectations come from the
// independent production TypeScript parser, never from another Rust binding.
export async function replayGcode(GcodeSession, memory) {
  const corpus = await (await fetch('/gcode-vectors.json')).json();
  const layout = await (await fetch('/gcode-buffer.json')).json();
  const check = (ok, label) => { if (!ok) throw new Error(label); };
  const same = (a, b, path = '') => {
    if (a && typeof a === 'object') {
      check(b && typeof b === 'object', path);
      check(JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()), `${path}:keys`);
      for (const key of Object.keys(a)) same(a[key], b[key], `${path}.${key}`);
    } else check(Object.is(a, b) || a === b, `${path}: ${a} != ${b}`);
  };
  const decode = bytes => {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    check(bytes.length >= 24 && data.getUint32(0,true) === 0x5047584f && data.getUint32(4,true) === layout.version, 'packet identity');
    const jsonLength = data.getUint32(8,true), records = data.getUint32(12,true), points = data.getUint32(16,true);
    check(bytes.length <= layout.maxPacketBytes && data.getUint32(20,true) === bytes.length, 'packet length');
    check(jsonLength <= layout.maxMetadataBytes && 24 + jsonLength <= bytes.length && records <= layout.maxWindowRecords && points <= layout.maxPathPoints, 'packet bounds');
    const model = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(24,24+jsonLength)));
    let offset = (24+jsonLength+3)&~3;
    const sizes = {u8:1,u16:2,u32:4,i32:4,f32:4}, getters = {u8:'getUint8',u16:'getUint16',u32:'getUint32',i32:'getInt32',f32:'getUint32'};
    for (const [group, fields, count] of [['columns',layout.columns,records],['pathPoints',layout.pathColumns,points]]) {
      model[group] = {count};
      for (const [name, type] of Object.entries(fields)) {
        const values = Array.from({length:count}, (_,i) => data[getters[type]](offset + i*sizes[type],true));
        model[group][name] = type === 'f32' ? {$f32:values} : values;
        offset = (offset + count*sizes[type]+3)&~3;
      }
    }
    check(offset === bytes.length,'trailing packet data');
    return model;
  };
  let windows = 0, packetBytes = 0;
  for (const vector of corpus.vectors) {
    const session = new GcodeSession(layout.version, vector.sourceUnits.length, JSON.stringify(vector.options));
    try {
      // Odd chunks deliberately split surrogate pairs and source lines.
      for (let offset = 0; offset < vector.sourceUnits.length; offset += 4093)
        session.append(offset, new Uint16Array(vector.sourceUnits.slice(offset, offset+4093)));
      const info = JSON.parse(session.seal()), expected = vector.binding;
      const {entries, ...index} = expected.index;
      same(info,{...index,version:layout.version,entryCount:entries.length},`${vector.id}.info`);
      const entriesWithoutCheckpoints = entries.map(({checkpoint,...entry}) => entry);
      same(JSON.parse(session.page(0,layout.maxIndexPageEntries)), entriesWithoutCheckpoints.slice(0,layout.maxIndexPageEntries), `${vector.id}.page`);
      const whole = session.whole(); packetBytes += whole.length;
      same(decode(whole), expected.model, `${vector.id}.whole`);
      for (let entry = 0; entry < entries.length; entry++) {
        const packet = session.window(entry,entry); packetBytes += packet.length;
        same(decode(packet), expected.windows[entry], `${vector.id}.window.${entry}`);
        windows++;
      }
    } finally { session.free(); }
  }
  const refuses = fn => { try { fn(); return false; } catch { return true; } };
  check(refuses(() => new GcodeSession(99,0,'{}')), 'unsupported layout');
  check(refuses(() => new GcodeSession(1.5,0,'{}')), 'fractional layout accepted');
  for (const value of [-1, 0.5, NaN, Infinity, 0x100000000])
    check(refuses(() => new GcodeSession(1,value,'{}')), 'invalid source length accepted');
  for (const value of ['[]','{"limits":[]}'])
    check(refuses(() => new GcodeSession(1,0,value)), 'array-shaped options accepted');
  const session = new GcodeSession(1,3,'{}');
  try {
    check(refuses(() => session.seal()),'incomplete upload accepted');
    check(refuses(() => session.append(1,new Uint16Array([1]))),'out-of-order upload accepted');
    check(refuses(() => session.append(0.5,new Uint16Array([1]))),'fractional offset accepted');
    session.append(0,new Uint16Array([71,49,10]));
    session.seal();
    check(refuses(() => session.append(3,new Uint16Array([]))),'sealed source changed');
    check(refuses(() => session.window(1,0)),'reversed window accepted');
    check(refuses(() => session.page(0,257)),'oversized index page');
    check(refuses(() => session.page(0,0.5)),'fractional page accepted');
  } finally { session.free(); }
  const text = ';LAYER_CHANGE\nG91\n' + 'G1 X1 E1\n'.repeat(300001);
  const units = new Uint16Array(text.length);
  for (let i=0;i<text.length;i++) units[i] = text.charCodeAt(i);
  const memorySamples = [];
  let largePacketBytes = 0;
  for (let cycle=0;cycle<12;cycle++) {
    const owner = new GcodeSession(1,units.length,'{}');
    try {
      for (let offset=0;offset<units.length;offset+=layout.maxChunkUnits) owner.append(offset,units.subarray(offset,offset+layout.maxChunkUnits));
      const info = JSON.parse(owner.seal());
      check(info.complete && info.recordCount === 300002,'large layer index');
      let records = 0;
      for (let entry=0;entry<info.entryCount;entry++) {
        const packet = owner.window(entry,entry);
        const view = new DataView(packet.buffer,packet.byteOffset,packet.byteLength);
        const count = view.getUint32(12,true);
        check(count <= layout.maxWindowRecords,'unbounded large window');
        const metadata = JSON.parse(new TextDecoder().decode(packet.subarray(24,24+view.getUint32(8,true))));
        check(metadata.complete && metadata.recordOffset === records,'large layer record continuity');
        records += count; largePacketBytes += packet.length;
      }
      check(records === 300002,'large layer missing records');
    } finally { owner.free(); }
    memorySamples.push(memory.buffer.byteLength);
  }
  check(memorySamples.slice(6).every(n => n === memorySamples[6]),'G-code WASM memory kept growing after repeated close');
  return {vectors:corpus.vectors.length, windows, packetBytes, largeReopenCycles:12,
    largeRecordsPerCycle:300002, largePacketBytes, wasmLinearMemorySamples:memorySamples};
}
