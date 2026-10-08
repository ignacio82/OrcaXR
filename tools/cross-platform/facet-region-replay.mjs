// Facet region selection through a binding: open the browser-authored project
// with its two mesh volumes as a real session and answer every request of the
// host's script, comparing each reply with the TypeScript authority's own
// encoding and each refusal with its code. Runs unchanged over WASM in Node
// and a browser worker, and over the JNI bridge.
export function replayFacetRegions(core, fixture, layout) {
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
  let replies = 0,
    refusals = 0;
  try {
    for (const [i, entry] of fixture.script.entries()) {
      if ("refusal" in entry) {
        let refusal;
        try {
          session.facet_region(entry.request);
        } catch (e) {
          refusal = String(e?.message ?? e);
        }
        if (!refusal?.includes(entry.refusal))
          fail(`request ${i}: ${refusal} does not refuse ${entry.refusal}`);
        refusals++;
        continue;
      }
      const reply = session.facet_region(entry.request);
      if (reply !== entry.reply) fail(`request ${i}: reply differs`);
      replies++;
    }
  } finally {
    session.free();
  }
  return { facetRegionReplies: replies, facetRegionRefusals: refusals };
}
