// Live slice preflight through a binding: open the browser-authored project,
// freeze it, preflight it and compare every contract reply with the
// TypeScript authority's own encoding. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export function replayPreflights(core, fixture, layout, generation) {
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
  let cases = 0,
    items = 0,
    refusals = 0;
  for (const c of fixture.attestations) {
    const source = encode.encode(c.stateJson);
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
    let session;
    try {
      for (let p = 0; p < source.length; p += layout.maxChunkBytes)
        upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
      upload.seal_document();
      // Payloads follow the document's declaration order.
      const declared = JSON.parse(c.stateJson).sourceAssets.map((d) => d.id);
      eq(upload.asset_count(), declared.length, `${c.name} asset count`);
      for (const [i, id] of declared.entries()) {
        const asset = c.assets.find(
          (a) => JSON.parse(a.descriptorJson).id === id,
        );
        const bytes = Uint8Array.from(asset.bytes);
        eq(upload.begin_asset(i), bytes.length, `${c.name} asset length`);
        upload.append_asset(0, bytes);
        upload.finish_asset();
      }
    } catch (e) {
      upload.free();
      throw e;
    }
    session = upload.open(Float64Array.from(generation));
    const guard = session.capture_guard();
    const capture = session.capture_export(guard);
    try {
      const report = capture.preflight(c.requestJson);
      try {
        eq(report.summary(), c.summaryJson, `${c.name} summary`);
        for (const [read, key] of [
          ["issue", "issueJsons"],
          ["omission", "omissionJsons"],
          ["printable_instance", "instanceJsons"],
          ["used_filament", "filamentJsons"],
        ]) {
          for (const [i, json] of c[key].entries()) {
            eq(report[read](i), json, `${c.name} ${key}[${i}]`);
            items++;
          }
          refuses(
            () => report[read](c[key].length),
            `${c.name} ${read} past end`,
          );
          refusals++;
        }
      } finally {
        report.free();
      }
      // Host budgets refuse the run; they never become project issues.
      const tight = JSON.parse(c.requestJson);
      tight.budget.assets = 0;
      refuses(
        () => capture.preflight(JSON.stringify(tight)),
        `${c.name} budget`,
      );
      refuses(() => capture.preflight("{}"), `${c.name} malformed request`);
      refusals += 2;
    } finally {
      capture.free();
      guard.free();
      session.free();
    }
    cases++;
  }
  return {
    preflightCases: cases,
    preflightItems: items,
    preflightRefusals: refusals,
  };
}
