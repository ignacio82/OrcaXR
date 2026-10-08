// Surface measurement through a binding: open the browser-authored project as
// a real session, capture each volume, resolve every pick (in every frame,
// with its refusals) and measure every pair, comparing each reply with the
// TypeScript authority's own encoding. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export function replayMeasure(core, fixture, layout) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
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
  const generation = [1, 2, 3, 4];
  const session = upload.open(Float64Array.from(generation));
  const volumes = new Map();
  const counts = {
    captures: 0,
    captureRefusals: 0,
    picks: 0,
    pickRefusals: 0,
    pairs: 0,
    pairRefusals: 0,
  };
  try {
    for (const [i, step] of fixture.steps.entries()) {
      const label = `step ${i}`;
      const refused = step.reply.startsWith('{"refused"');
      if ("capture" in step) {
        const volume = session.measure_volume(step.capture);
        eq(volume.reply(), step.reply, label);
        volumes.get(step.volume)?.free();
        volumes.set(step.volume, volume);
        counts[refused ? "captureRefusals" : "captures"]++;
      } else if ("feature" in step) {
        eq(volumes.get(step.volume).feature(step.feature), step.reply, label);
        counts[refused ? "pickRefusals" : "picks"]++;
      } else {
        eq(core.measure_features(step.measure), step.reply, label);
        counts[refused ? "pairRefusals" : "pairs"]++;
      }
    }
  } finally {
    for (const volume of volumes.values()) volume.free();
    session.free();
  }
  return {
    measureCaptures: counts.captures,
    measureCaptureRefusals: counts.captureRefusals,
    measurePicks: counts.picks,
    measurePickRefusals: counts.pickRefusals,
    measurePairs: counts.pairs,
    measurePairRefusals: counts.pairRefusals,
  };
}
