// The virtual filament library through a binding (`virtual-filament-vectors.json`):
// each recorded state opened as a real session with its mesh uploaded, whose
// captured project answers its library and every library edit's step (or
// refusal) byte for byte with the browser; the author dialog's exchanges —
// opening fields, validations, the triangle picker and the pinned Match
// search — answered over the recorded libraries; and every malformed request
// refused. Runs unchanged over WASM in Node and a browser worker, and over
// the JNI bridge.
export function replayVirtualFilaments(core, fixture, layout, generation) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refusedReply = (reply) => reply.startsWith('{"error"');
  const counts = { libraries: 0, dialogs: 0, validations: 0, triangles: 0, searches: 0, edits: 0, refused: 0, malformed: 0 };
  const open = (stateJson) => {
    const source = encode.encode(stateJson);
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
      for (const [i, declared] of JSON.parse(stateJson).sourceAssets.entries()) {
        const asset = fixture.assets.find((a) => JSON.parse(a.descriptorJson).id === declared.id);
        const bytes = Uint8Array.from(asset.bytes);
        eq(upload.begin_asset(i), bytes.length, "asset length");
        upload.append_asset(0, bytes);
        upload.finish_asset();
      }
    } catch (e) {
      upload.free();
      throw e;
    }
    return upload.open(Float64Array.from(generation));
  };
  const refuses = (call, label) => {
    let refused = false;
    try {
      call();
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`${label} was accepted`);
    counts.malformed++;
  };
  const sessionExchanges = new Set(["library", "mutation"]);
  for (const [name, stateJson] of Object.entries(fixture.states)) {
    const session = open(stateJson);
    const captured = session.snapshot();
    try {
      for (const [i, c] of fixture.libraries.entries()) {
        if (c.state !== name) continue;
        const reply = captured.virtual_filament_library(c.requestJson);
        eq(reply, c.replyJson, `${name} library ${i}`);
        counts.libraries++;
        if (refusedReply(reply)) counts.refused++;
      }
      for (const [i, c] of fixture.mutations.entries()) {
        if (c.state !== name) continue;
        const reply = captured.virtual_filament_mutation(c.requestJson);
        eq(reply, c.replyJson, `${name} edit ${i}`);
        counts.edits++;
        if (refusedReply(reply)) counts.refused++;
      }
      if (name === "rich") {
        for (const [i, r] of fixture.refusals.entries()) {
          if (!sessionExchanges.has(r.exchange)) continue;
          refuses(
            () =>
              r.exchange === "library"
                ? captured.virtual_filament_library(r.requestJson)
                : captured.virtual_filament_mutation(r.requestJson),
            `malformed ${i}`,
          );
        }
      }
    } finally {
      captured.free();
      session.free();
    }
  }
  for (const [i, c] of fixture.defaults.entries()) {
    eq(core.virtual_filament_form_defaults(c.requestJson), c.replyJson, `dialog ${i}`);
    counts.dialogs++;
  }
  for (const [i, c] of fixture.validations.entries()) {
    eq(core.virtual_filament_form(c.requestJson), c.replyJson, `validation ${i}`);
    counts.validations++;
  }
  for (const [i, c] of fixture.triangles.entries()) {
    eq(core.virtual_filament_triangle(c.requestJson), c.replyJson, `triangle ${i}`);
    counts.triangles++;
  }
  for (const [i, c] of fixture.matchSearches.entries()) {
    eq(core.virtual_filament_match_search(c.requestJson), c.replyJson, `search ${i}`);
    counts.searches++;
  }
  const pure = {
    defaults: core.virtual_filament_form_defaults,
    form: core.virtual_filament_form,
    triangle: core.virtual_filament_triangle,
    search: core.virtual_filament_match_search,
  };
  for (const [i, r] of fixture.refusals.entries()) {
    if (sessionExchanges.has(r.exchange)) continue;
    refuses(() => pure[r.exchange](r.requestJson), `malformed ${i}`);
  }
  return {
    virtualFilamentAnswers: [
      counts.libraries,
      counts.dialogs,
      counts.validations,
      counts.triangles,
      counts.searches,
      counts.edits,
      counts.refused,
      counts.malformed,
    ],
  };
}
