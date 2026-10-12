// Drawn parts through a binding: open the project the browser's Emboss and
// SVG part tools made as a real session and ask every part whether it is
// embossed text or an SVG part (and an unknown one), comparing every reply
// with the TypeScript authority's own encoding (`bytes` decodes base64). Runs
// unchanged over WASM in Node and a browser worker, and over the JNI bridge.
export function replayDrawnParts(core, fixture, layout, bytes) {
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const { projectJson, assets, steps } = fixture.parts;
  const source = new TextEncoder().encode(projectJson);
  const options = {
    documentBytes: source.length,
    documentNodes: 1_000_000,
    documentTextUnits: 2_000_000,
    numberBytes: 1024,
    depth: 128,
    assets: assets.length,
    assetBytes: 16 * 1024 * 1024,
    totalAssetBytes: 32 * 1024 * 1024,
    historyEntries: 100,
    historyBytes: 32 * 1024 * 1024,
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
    assets.forEach((asset, position) => {
      const data = bytes(asset.bytes);
      if (upload.begin_asset(position) !== data.length) fail(`asset ${position} length`);
      for (let p = 0; p < data.length; p += layout.maxChunkBytes)
        upload.append_asset(p, data.subarray(p, p + layout.maxChunkBytes));
      upload.finish_asset();
    });
  } catch (e) {
    upload.free();
    throw e;
  }
  const session = upload.open(Float64Array.from([1, 2, 3, 4]));
  const counts = { text: 0, svg: 0, plain: 0, refused: 0 };
  try {
    for (const [i, step] of steps.entries()) {
      const reply = session.drawn_part(step.request);
      eq(reply, step.reply, `part ${i}`);
      const parsed = JSON.parse(reply);
      counts[
        "refused" in parsed ? "refused" : parsed.part.text ? "text" : parsed.part.svg ? "svg" : "plain"
      ]++;
    }
  } finally {
    session.free();
  }
  return {
    drawnText: counts.text,
    drawnSvg: counts.svg,
    drawnPlain: counts.plain,
    drawnRefused: counts.refused,
  };
}
