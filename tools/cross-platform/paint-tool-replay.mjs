// The painter's settings and paint colours through a binding
// (`paint-tool-vectors.json`): every sample request's sample or refusal and
// every colour request's colours, compared byte for byte with the browser's
// replies, and every malformed request refused. Runs unchanged over WASM in
// Node and a browser worker, and over the JNI bridge.
export function replayPaintTool(core, fixture) {
  const fail = (label) => {
    throw Error(label);
  };
  const refused = (run, label) => {
    try {
      run();
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      return;
    }
    fail(`${label} was accepted`);
  };
  const counts = { paintToolSamples: 0, paintToolRefusals: 0, paintColorSets: 0 };
  for (const c of [...fixture.samples, ...fixture.errors]) {
    if (core.paint_tool_sample(c.request) !== c.reply) fail(`sample ${c.name}: reply differs`);
    counts.paintToolSamples++;
  }
  for (const request of fixture.malformed) {
    refused(() => core.paint_tool_sample(request), `sample ${request}`);
    counts.paintToolRefusals++;
  }
  for (const c of fixture.colors) {
    if (core.paint_facet_colors(c.request) !== c.reply) fail(`colours ${c.name}: reply differs`);
    counts.paintColorSets++;
  }
  for (const request of fixture.colorRefusals) {
    refused(() => core.paint_facet_colors(request), `colours ${request}`);
    counts.paintToolRefusals++;
  }
  return counts;
}
