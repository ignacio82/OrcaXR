// The generated settings panel and the height-range editor through a binding
// (`settings-panel-vectors.json`): open each browser-authored project, capture
// it, open each node's settings editor and drive its panel — views, rows,
// drafts, states, applies and the intents they become — then the scoped
// panel's target texts and the height-range projections, checks and
// messages, each compared byte for byte with the browser's replies, and every
// malformed request refused. Runs unchanged over WASM and over the JNI
// bridge. `policies` are the binding's trailing editor arguments: a collator
// and a search folder.
export function replaySettingsPanel(core, fixture, layout, generation, policies) {
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
  const counts = {
    panelViews: 0,
    panelRows: 0,
    panelEdits: 0,
    panelStates: 0,
    panelApplies: 0,
    panelIntents: 0,
    targetTexts: 0,
    rangeProjections: 0,
    rangeChecks: 0,
    panelRefusals: 0,
  };
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
      const declared = JSON.parse(state.stateJson).sourceAssets.map((d) => d.id);
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
    return upload.open(Float64Array.from(generation));
  };
  const l = fixture.layerRanges;
  for (const state of fixture.states) {
    const session = open(state);
    const capture = session.snapshot();
    try {
      eq(capture.revision(), state.revision, `${state.name} revision`);
      eq(capture.hash(), state.hash, `${state.name} hash`);
      for (const s of fixture.sessions.filter((s) => s.state === state.name)) {
        const label = `${state.name} ${s.target}`;
        const editor = capture.settings_editor(s.requestJson, ...policies);
        try {
          s.steps.forEach((step, i) => {
            const at = `${label} step ${i} ${step.kind}`;
            switch (step.kind) {
              case "view":
                eq(editor.panel_view(step.requestJson), step.replyJson, at);
                counts.panelViews++;
                break;
              case "row":
                eq(editor.panel_row(step.requestJson), step.replyJson, at);
                counts.panelRows++;
                break;
              case "edit":
                eq(editor.panel_edit(step.requestJson), step.replyJson, at);
                counts.panelEdits++;
                break;
              case "state":
                eq(editor.panel_state(), step.replyJson, at);
                counts.panelStates++;
                break;
              case "apply":
                eq(editor.panel_apply(), step.replyJson, at);
                counts.panelApplies++;
                if (step.intentJson !== undefined) {
                  eq(editor.intent(), step.intentJson, `${at} intent`);
                  counts.panelIntents++;
                }
                break;
              case "cancel":
                editor.panel_cancel();
                break;
              default:
                fail(`${at}: unknown step`);
            }
          });
        } finally {
          editor.free();
        }
      }
      for (const c of l.projections.filter((c) => c.state === state.name)) {
        eq(capture.layer_range_editor(c.requestJson), c.replyJson, `${state.name} projection ${c.requestJson}`);
        counts.rangeProjections++;
      }
      if (state.name === "rich")
        for (const r of l.refusals.filter((r) => r.exchange === "projection")) {
          refuses(() => capture.layer_range_editor(r.request), `projection ${r.request}`);
          counts.panelRefusals++;
        }
    } finally {
      capture.free();
      session.free();
    }
  }
  // Panel refusals on a fresh editor of the first session's node.
  {
    const first = fixture.sessions[0];
    const session = open(fixture.states.find((s) => s.name === first.state));
    const capture = session.snapshot();
    try {
      for (const r of fixture.refusals) {
        if (r.exchange === "targetText") {
          refuses(() => core.settings_target_text(r.request), `targetText ${r.request}`);
        } else {
          const editor = capture.settings_editor(first.requestJson, ...policies);
          try {
            refuses(
              () =>
                ({
                  view: () => editor.panel_view(r.request),
                  row: () => editor.panel_row(r.request),
                  edit: () => editor.panel_edit(r.request),
                })[r.exchange](),
              `${r.exchange} ${r.request}`,
            );
          } finally {
            editor.free();
          }
        }
        counts.panelRefusals++;
      }
    } finally {
      capture.free();
      session.free();
    }
  }
  for (const c of fixture.targetTexts) {
    eq(core.settings_target_text(c.requestJson), c.replyJson, `target text ${c.requestJson}`);
    counts.targetTexts++;
  }
  for (const [kind, exchange] of [
    ["bounds", (r) => core.layer_range_bounds(r)],
    ["splits", (r) => core.layer_range_split(r)],
    ["messages", (r) => core.layer_range_messages(r)],
  ])
    for (const c of l[kind]) {
      eq(exchange(c.requestJson), c.replyJson, `${kind} ${c.requestJson}`);
      counts.rangeChecks++;
    }
  for (const r of l.refusals.filter((r) => r.exchange !== "projection")) {
    refuses(
      () =>
        ({
          bounds: () => core.layer_range_bounds(r.request),
          split: () => core.layer_range_split(r.request),
          messages: () => core.layer_range_messages(r.request),
        })[r.exchange](),
      `${r.exchange} ${r.request}`,
    );
    counts.panelRefusals++;
  }
  return counts;
}
