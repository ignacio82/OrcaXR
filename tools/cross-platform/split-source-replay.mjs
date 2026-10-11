// What a split would split, through a binding (`model-tool-vectors.json`'s
// `splitSources`): the recorded project opened as a real session (its document
// and assets), whose captured project answers every request byte for byte as
// the browser's `SplitSourceExchange.ts` did and refuses every malformed one.
// Runs unchanged over WASM in Node and over the JNI bridge; `b64` decodes the
// corpus's base64.
export function replaySplitSources(core, fixture, layout, b64) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const entry = fixture.splitSources;
  const source = encode.encode(entry.stateJson);
  const options = {
    documentBytes: source.length,
    documentNodes: 1_000_000,
    documentTextUnits: 2_000_000,
    numberBytes: 1024,
    depth: 128,
    assets: entry.assets.length,
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
  let session;
  try {
    for (let p = 0; p < source.length; p += layout.maxChunkBytes)
      upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
    upload.seal_document();
    if (upload.asset_count() !== entry.assets.length) fail("split sources: asset count");
    // Assets stream in the order the document declares them.
    const declared = JSON.parse(entry.stateJson).sourceAssets.map((a) => a.id);
    for (const [index, id] of declared.entries()) {
      const asset = entry.assets.find((a) => JSON.parse(a.descriptorJson).id === id);
      const bytes = b64(asset.bytes);
      if (upload.begin_asset(index) !== bytes.length) fail(`split sources: asset ${id} length`);
      for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
        upload.append_asset(p, bytes.subarray(p, p + layout.maxChunkBytes));
      upload.finish_asset();
    }
    session = upload.open(Float64Array.from([1, 2, 3, 4]));
  } catch (e) {
    upload.free();
    throw e;
  }
  let splitSources = 0;
  let splitSourceRefusals = 0;
  try {
    const captured = session.snapshot();
    try {
      for (const c of entry.cases) {
        if (captured.split_source(c.request) !== c.reply) fail(`split source ${c.request}: reply differs`);
        splitSources++;
      }
      for (const r of entry.refusals) {
        let refused = false;
        try {
          captured.split_source(r.request);
        } catch (e) {
          if (!String(e?.message ?? e).includes("invalid_request")) throw e;
          refused = true;
        }
        if (!refused) fail(`split source refusal ${r.name} was accepted`);
        splitSourceRefusals++;
      }
    } finally {
      captured.free();
    }
  } finally {
    session.free();
  }
  return { splitSources, splitSourceRefusals };
}
