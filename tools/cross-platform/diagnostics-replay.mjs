// File → Export Diagnostics… through a binding (`diagnostics-vectors.json`):
// every bundle request answered with the browser's file, preview and kept
// entries, every recorded event as the browser's recorder keeps it, the
// facts a bundle states, and every malformed request refused. Runs unchanged
// over WASM in Node and a browser worker, and over the JNI bridge. The
// project shapes are replayed with the model exports, on their sessions.
export function replayDiagnostics(core, fixture) {
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (run, label) => {
    let refused = false;
    try {
      run();
    } catch {
      refused = true;
    }
    if (!refused) fail(`${label} was not refused`);
  };
  for (const c of fixture.bundles) eq(core.diagnostics_bundle(c.requestJson), c.replyJson, `bundle ${c.name}`);
  for (const r of fixture.bundleRefusals) refuses(() => core.diagnostics_bundle(r), `bundle ${r}`);
  for (const c of fixture.entries) eq(core.diagnostic_entry(c.requestJson), c.replyJson, `entry ${c.requestJson}`);
  for (const r of fixture.entryRefusals) refuses(() => core.diagnostic_entry(r), `entry ${r}`);
  eq(core.diagnostics_facts(), fixture.factsJson, "facts");
  return {
    diagnosticsAnswers: [
      fixture.bundles.length,
      fixture.bundleRefusals.length,
      fixture.entries.length,
      fixture.entryRefusals.length,
    ],
  };
}
