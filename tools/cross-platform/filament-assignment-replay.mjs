// Filament assignment through a binding (`filament-assignment-vectors.json`):
// each recorded state opened as a real session with its mesh uploaded, whose
// captured project answers every selection's scopes, unsupported refs and
// offered filaments and every choice's assignments (or refusal) byte for byte
// with the browser, and refuses every malformed request. Runs unchanged over
// WASM in Node and a browser worker, and over the JNI bridge.
export function replayFilamentAssignment(core, fixture, layout, generation) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const counts = { resolutions: 0, assignments: 0, refused: 0, malformed: 0 };
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
  for (const [name, stateJson] of Object.entries(fixture.states)) {
    const session = open(stateJson);
    const captured = session.snapshot();
    try {
      for (const [i, c] of fixture.resolutions.entries()) {
        if (c.state !== name) continue;
        const reply = captured.filament_assignment(c.requestJson);
        eq(reply, c.replyJson, `${name} resolution ${i}`);
        counts.resolutions++;
        if (reply.startsWith('{"error"')) counts.refused++;
      }
      for (const [i, c] of fixture.changes.entries()) {
        if (c.state !== name) continue;
        const reply = captured.filament_assignment_changes(c.requestJson);
        eq(reply, c.replyJson, `${name} assignment ${i}`);
        counts.assignments++;
        if (reply.startsWith('{"error"')) counts.refused++;
      }
      if (name === "rich") {
        for (const [i, r] of fixture.refusals.entries()) {
          let refused = false;
          try {
            if (r.exchange === "resolve") captured.filament_assignment(r.requestJson);
            else captured.filament_assignment_changes(r.requestJson);
          } catch (e) {
            if (!String(e?.message ?? e).includes("invalid_request")) throw e;
            refused = true;
          }
          if (!refused) fail(`malformed ${i} was accepted`);
          counts.malformed++;
        }
      }
    } finally {
      captured.free();
      session.free();
    }
  }
  return {
    filamentAssignmentAnswers: [counts.resolutions, counts.assignments, counts.refused, counts.malformed],
  };
}
