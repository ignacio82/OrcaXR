// Renderer projection deltas through a binding: open each browser-authored
// state as a real project session, run the host's script — session requests
// and render pages in order — and compare every page and refusal with the
// TypeScript authority's own encoding. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export function replayRender(core, fixture, layout) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const normalize = (v) =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, normalize(v[k])]),
          )
        : v;
  const same = (wire) => JSON.stringify(normalize(JSON.parse(wire)));
  let pages = 0,
    refusals = 0,
    requests = 0;
  for (const state of fixture.states) {
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
      historyEntries: state.options.maxEntries ?? 100,
      historyBytes: state.options.maxEstimatedBytes ?? 32 * 1024 * 1024,
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
      const bytes = Uint8Array.from(state.asset.bytes);
      eq(upload.begin_asset(0), bytes.length, `${state.name} asset length`);
      upload.append_asset(0, bytes);
      upload.finish_asset();
    } catch (e) {
      upload.free();
      throw e;
    }
    const session = upload.open(Float64Array.from(fixture.generation));
    try {
      for (const [i, entry] of state.script.entries()) {
        const label = `${state.name} step ${i}`;
        if ("request" in entry) {
          const reply = session.submit(entry.request) ?? session.run_next();
          eq(same(reply.wire()), same(entry.reply), `${label} reply`);
          requests++;
        } else if ("page" in entry) {
          eq(session.render(entry.render), entry.page, `${label} page`);
          pages++;
        } else {
          let refusal;
          try {
            session.render(entry.render);
          } catch (e) {
            refusal = String(e?.message ?? e);
          }
          if (!refusal?.includes(entry.refusal))
            fail(`${label}: ${refusal} does not refuse ${entry.refusal}`);
          refusals++;
        }
      }
    } finally {
      session.free();
    }
  }
  return {
    renderPages: pages,
    renderRefusals: refusals,
    renderRequests: requests,
  };
}
