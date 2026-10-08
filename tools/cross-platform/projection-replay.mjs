// The settings projection and settings sessions through a binding: open each
// browser-authored project, capture it, and compare target pages, node
// snapshots, explanations, session edits, commits and the intents they become
// with the TypeScript authority's own encodings. Runs unchanged over WASM in
// Node and a browser worker, and over the JNI bridge. `policies` are the
// binding's trailing editor arguments: a collator and a search folder.
export function replayProjection(core, fixture, layout, generation, policies) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (fn, label) => {
    let rejected = false;
    try {
      fn();
    } catch {
      rejected = true;
    }
    if (!rejected) fail(label);
  };
  let replies = 0,
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
      const declared = JSON.parse(state.stateJson).sourceAssets.map((d) => d.id);
      eq(upload.asset_count(), declared.length, `${state.name} asset count`);
      for (const [i, id] of declared.entries()) {
        const asset = fixture.assets.find((a) => JSON.parse(a.descriptorJson).id === id);
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
      const w = state.wire;
      for (const palette of w.palettes) {
        eq(capture.paint_palette(palette.requestJson), palette.replyJson, `${state.name} palette`);
        replies++;
      }
      for (const page of w.pages) {
        eq(capture.settings_targets(page.requestJson), page.replyJson, `${state.name} page`);
        replies++;
      }
      for (const s of [...w.snapshots, ...w.unknown]) {
        eq(capture.settings_snapshot(s.requestJson), s.replyJson, `${state.name} snapshot`);
        replies++;
      }
      for (const e of w.explanations) {
        eq(capture.settings_explain(e.requestJson), e.replyJson, `${state.name} explanation`);
        replies++;
      }
      refuses(
        () => capture.settings_targets(JSON.stringify({ start: 0, count: 65 })),
        `${state.name} oversized page`,
      );
      refuses(
        () =>
          capture.settings_snapshot(
            JSON.stringify({ target: { plate: { plateId: [120] } } }),
          ),
        `${state.name} malformed target`,
      );
      refusals += 2;
      for (const s of fixture.sessions.filter((s) => s.state === state.name)) {
        const label = `${state.name} ${s.target} ${s.mode}`;
        const editor = capture.settings_editor(s.requestJson, ...policies);
        try {
          refuses(() => editor.intent(), `${label} intent before commit`);
          refusals++;
          for (const step of s.steps) {
            eq(editor.edit(step.editJson), step.resultJson, `${label} edit`);
            replies++;
          }
          eq(editor.commit(), s.commitJson, `${label} commit`);
          eq(editor.intent(), s.intentJson, `${label} intent`);
          replies += 2;
        } finally {
          editor.free();
        }
      }
    } finally {
      capture.free();
      session.free();
    }
  }
  return { projectionReplies: replies, projectionRefusals: refusals };
}
