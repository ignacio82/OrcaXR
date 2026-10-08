// The capability projection through a binding: open each browser-authored
// trace state as a real project session, select, run the acknowledged edit,
// and compare every capability page with the TypeScript authority's own
// encoding. Runs unchanged over WASM in Node and a browser worker, and over
// the JNI bridge.
export function replayCapabilities(core, fixture, layout) {
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
  const refuses = (fn, label) => {
    let rejected = false;
    try {
      fn();
    } catch {
      rejected = true;
    }
    if (!rejected) fail(label);
  };
  let pages = 0,
    refusals = 0;
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
      for (const phase of state.phases) {
        const label = `${state.name} ${phase.name}`;
        if (phase.selection) {
          const guard = session.capture_guard(),
            input = new core.ProjectSelectionInput();
          try {
            for (const r of phase.selection.refs)
              input.add(
                layout.selectionKinds.indexOf(r.kind),
                Uint16Array.from(r.id ?? []),
              );
          } catch (e) {
            input.free();
            guard.free();
            throw e;
          }
          try {
            session.select(guard, input, phase.selection.primary).free();
          } finally {
            guard.free();
          }
        }
        for (const [i, request] of (phase.requests ?? []).entries()) {
          const reply = session.submit(request) ?? session.run_next();
          eq(same(reply.wire()), same(phase.replies[i]), `${label} reply ${i}`);
        }
        for (const q of phase.queries) {
          eq(session.capabilities(q.requestJson), q.replyJson, `${label} page`);
          pages++;
        }
        const request = JSON.parse(phase.queries[0].requestJson);
        refuses(
          () =>
            session.capabilities(
              JSON.stringify({
                ...request,
                query: { page: { start: 0, count: 65 } },
              }),
            ),
          `${label} oversized page`,
        );
        refuses(
          () =>
            session.capabilities(
              JSON.stringify({
                ...request,
                query: {
                  actions: { ids: Array.from({ length: 65 }, () => [97]) },
                },
              }),
            ),
          `${label} oversized name list`,
        );
        refuses(
          () =>
            session.capabilities(
              JSON.stringify({ ...request, surface: "dom-menu" }),
            ),
          `${label} surface`,
        );
        refusals += 3;
      }
    } finally {
      session.free();
    }
  }
  return { capabilityPages: pages, capabilityRefusals: refusals };
}
