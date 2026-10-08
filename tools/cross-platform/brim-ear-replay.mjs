// Brim-ear detection through a binding: open the browser-authored project as a
// real session and answer every detection and stranded check, comparing each
// reply with the TypeScript authority's own encoding. Runs unchanged over WASM
// in Node and a browser worker, and over the JNI bridge.
export function replayBrimEars(core, fixture, layout) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const source = encode.encode(fixture.stateJson);
  const options = {
    documentBytes: source.length,
    documentNodes: 1_000_000,
    documentTextUnits: 2_000_000,
    numberBytes: 1024,
    depth: 128,
    assets: fixture.assets.length,
    assetBytes: 16 * 1024 * 1024,
    totalAssetBytes: 32 * 1024 * 1024,
    historyEntries: 100,
    historyBytes: 32 * 1024 * 1024,
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
    fixture.assets.forEach((asset, position) => {
      const bytes = Uint8Array.from(asset.bytes);
      if (upload.begin_asset(position) !== bytes.length)
        fail(`asset ${position} length`);
      for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
        upload.append_asset(p, bytes.subarray(p, p + layout.maxChunkBytes));
      upload.finish_asset();
    });
  } catch (e) {
    upload.free();
    throw e;
  }
  const session = upload.open(Float64Array.from([1, 2, 3, 4]));
  let brimEarDetections = 0;
  let brimEarStrandedChecks = 0;
  try {
    for (const [i, step] of fixture.steps.entries()) {
      const reply =
        "detect" in step
          ? session.detect_brim_ears(step.detect)
          : session.stranded_brim_ears(step.stranded);
      if (reply !== step.reply) fail(`step ${i}: ${reply} !== ${step.reply}`);
      if ("detect" in step) brimEarDetections++;
      else brimEarStrandedChecks++;
    }
  } finally {
    session.free();
  }
  return { brimEarDetections, brimEarStrandedChecks };
}
