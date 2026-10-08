// The Objects tree through a binding: open each browser-authored project,
// capture it, and compare every page, selection and refusal with the
// browser's own encodings. Runs unchanged over WASM in Node and a browser
// worker, and over the JNI bridge. `folder` folds non-ASCII search text as
// the host would; without it such text is refused. The model-vector states
// carry no assets and are replayed by Rust alone.
export function replayObjectTree(core, fixture, layout, generation, folder) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  let pages = 0,
    selections = 0,
    ignored = 0,
    refusals = 0,
    states = 0;
  for (const [index, state] of fixture.states.entries()) {
    if (state.revision === undefined) continue;
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
      const declared = JSON.parse(state.stateJson).sourceAssets.map(
        (d) => d.id,
      );
      eq(upload.asset_count(), declared.length, `${state.name} asset count`);
      for (const [i, id] of declared.entries()) {
        const asset = fixture.assets.find(
          (a) => JSON.parse(a.descriptorJson).id === id,
        );
        const bytes = Uint8Array.from(asset.bytes);
        eq(upload.begin_asset(i), bytes.length, `${state.name} asset length`);
        upload.append_asset(0, bytes);
        upload.finish_asset();
      }
    } catch (e) {
      upload.free();
      throw e;
    }
    const session = upload.open(Float64Array.from(generation));
    const capture = session.snapshot();
    try {
      eq(capture.revision(), state.revision, `${state.name} revision`);
      eq(capture.hash(), state.hash, `${state.name} hash`);
      for (const [n, c] of fixture.cases.entries()) {
        if (c.state !== index) continue;
        const label = `${state.name} case ${n}`;
        if (c.replyJson !== undefined) {
          eq(capture.object_tree(c.requestJson, folder), c.replyJson, label);
          if (c.replyJson.startsWith('{"page"')) pages++;
          else if (c.replyJson.startsWith('{"selected"')) selections++;
          else ignored++;
        } else {
          let refusal;
          try {
            capture.object_tree(c.requestJson, folder);
          } catch (e) {
            refusal = String(e?.message ?? e);
          }
          if (!refusal?.includes(c.refusal))
            fail(`${label}: ${refusal} does not refuse ${c.refusal}`);
          refusals++;
        }
      }
      // Without a folder, a non-ASCII filter is refused rather than guessed.
      const nonAscii = fixture.cases.find(
        (c) =>
          c.state === index &&
          c.replyJson !== undefined &&
          JSON.parse(c.requestJson).filterQuery.some((u) => u > 127),
      );
      if (nonAscii) {
        let refusal;
        try {
          capture.object_tree(nonAscii.requestJson, undefined);
        } catch (e) {
          refusal = String(e?.message ?? e);
        }
        if (!refusal?.includes("non_ascii_search"))
          fail(`${state.name}: ${refusal} does not refuse non_ascii_search`);
        refusals++;
      }
      states++;
    } finally {
      capture.free();
      session.free();
    }
  }
  return {
    objectTreeStates: states,
    objectTreePages: pages,
    objectTreeSelections: selections,
    objectTreeIgnored: ignored,
    objectTreeRefusals: refusals,
  };
}
