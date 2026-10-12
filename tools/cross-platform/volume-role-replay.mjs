// The volume-role editor through a binding (`volume-role-vectors.json`): each
// recorded state opened as a real session with its mesh uploaded, whose
// captured project answers every part's role choices and the conversion
// command's decision for every role (and role texts Orca lacks) byte for byte
// with the browser; each conversion's words; every malformed request refused.
// Runs unchanged over WASM in Node and a browser worker, and over the JNI
// bridge.
export function replayVolumeRoles(core, fixture, layout, generation) {
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
  const counts = { projections: 0, decisions: 0, messages: 0, refusals: 0 };
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
        const bytes = Uint8Array.from(asset.bytes);
        eq(upload.begin_asset(i), bytes.length, `${state.name} asset length`);
        upload.append_asset(0, bytes);
        upload.finish_asset();
      }
    } catch (e) {
      upload.free();
      throw e;
    }
    return upload.open(Float64Array.from(generation));
  };
  for (const state of fixture.states) {
    const session = open(state);
    const captured = session.snapshot();
    try {
      eq(captured.revision(), state.revision, `${state.name} revision`);
      eq(captured.hash(), state.hash, `${state.name} hash`);
      for (const c of fixture.projections.filter((c) => c.state === state.name)) {
        eq(captured.volume_role_editor(c.requestJson), c.replyJson, `${state.name} projection ${c.requestJson}`);
        counts.projections++;
      }
      for (const c of fixture.decisions.filter((c) => c.state === state.name)) {
        eq(captured.volume_role_decision(c.requestJson), c.replyJson, `${state.name} decision ${c.requestJson}`);
        counts.decisions++;
      }
      if (state.name === "rich")
        for (const r of fixture.refusals.filter((r) => r.exchange !== "messages")) {
          refuses(
            () =>
              r.exchange === "projection"
                ? captured.volume_role_editor(r.request)
                : captured.volume_role_decision(r.request),
            `${r.exchange} ${r.request}`,
          );
          counts.refusals++;
        }
    } finally {
      captured.free();
      session.free();
    }
  }
  for (const c of fixture.messages) {
    eq(core.volume_role_messages(c.requestJson), c.replyJson, `messages ${c.requestJson}`);
    counts.messages++;
  }
  for (const r of fixture.refusals.filter((r) => r.exchange === "messages")) {
    refuses(() => core.volume_role_messages(r.request), `messages ${r.request}`);
    counts.refusals++;
  }
  return {
    volumeRoleAnswers: [counts.projections, counts.decisions, counts.messages, counts.refusals],
  };
}
