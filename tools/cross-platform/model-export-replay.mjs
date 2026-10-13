// The File menu's model exports through a binding (`model-export-vectors.json`):
// each recorded state opened as a real session with its meshes uploaded, an
// export capture taken under its guard, and every STL export — one merged
// file, or one per instance in the browser's ZIP — answered with the
// browser's reply and the same bytes (length and SHA-256); every output name;
// every malformed request refused. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export async function replayModelExports(core, fixture, layout, generation, sha256, b64) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (fn, label) => {
    let refused = false;
    try {
      fn();
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`${label} was accepted`);
  };
  const counts = { files: 0, refused: 0, names: 0, refusals: 0 };
  const open = (state) => {
    const source = encode.encode(state.stateJson);
    const options = {
      documentBytes: source.length,
      documentNodes: 1_000_000,
      documentTextUnits: 2_000_000,
      numberBytes: 1024,
      depth: 128,
      assets: 16,
      assetBytes: 16 * 1024 * 1024,
      totalAssetBytes: 32 * 1024 * 1024,
      historyEntries: 16,
      historyBytes: 1024 * 1024,
    };
    const upload = new core.ProjectUpload(
      layout.version,
      source.length,
      Float64Array.from(layout.options.map((k) => options[k])),
    );
    try {
      for (let p = 0; p < source.length; p += layout.maxChunkBytes)
        upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
      upload.seal_document();
      for (const [i, declared] of JSON.parse(state.stateJson).sourceAssets.entries()) {
        const asset = fixture.assets.find((a) => JSON.parse(a.descriptorJson).id === declared.id);
        const bytes = Uint8Array.from(b64(asset.base64));
        eq(upload.begin_asset(i), bytes.length, `${state.name} asset length`);
        for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
          upload.append_asset(p, bytes.subarray(p, p + layout.maxChunkBytes));
        upload.finish_asset();
      }
    } catch (e) {
      upload.free();
      throw e;
    }
    return upload.open(Float64Array.from(generation));
  };
  const read = (output) => {
    const length = output.length();
    const bytes = new Uint8Array(length);
    for (let p = 0; p < length; p += layout.maxChunkBytes)
      bytes.set(output.read(p, Math.min(layout.maxChunkBytes, length - p)), p);
    return bytes;
  };
  for (const state of fixture.states) {
    const session = open(state);
    const guard = session.capture_guard();
    const capture = session.capture_export(guard);
    try {
      for (const c of fixture.stl.filter((c) => c.state === state.name)) {
        const output = capture.stl_export(c.requestJson);
        try {
          eq(output.reply(), c.replyJson, `${state.name} STL ${c.requestJson}`);
          const bytes = read(output);
          if (c.sha256) {
            eq(bytes.length, c.bytes, `${state.name} STL length ${c.requestJson}`);
            eq(await sha256(bytes), c.sha256, `${state.name} STL bytes ${c.requestJson}`);
            counts.files++;
          } else {
            eq(bytes.length, 0, `${state.name} refused STL wrote bytes ${c.requestJson}`);
            counts.refused++;
          }
        } finally {
          output.free();
        }
      }
      if (state.name === fixture.states[0].name)
        for (const r of fixture.refusals.filter((r) => r.exchange === "stl")) {
          refuses(() => capture.stl_export(r.request).free(), `stl ${r.request}`);
          counts.refusals++;
        }
    } finally {
      capture.free();
      guard.free();
      session.free();
    }
  }
  for (const c of fixture.names) {
    eq(core.export_name(c.requestJson), c.replyJson, `name ${c.requestJson}`);
    counts.names++;
  }
  for (const r of fixture.refusals.filter((r) => r.exchange === "name")) {
    refuses(() => core.export_name(r.request), `name ${r.request}`);
    counts.refusals++;
  }
  return {
    modelExportAnswers: [counts.files, counts.refused, counts.names, counts.refusals],
  };
}
